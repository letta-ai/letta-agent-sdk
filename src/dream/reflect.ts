// Batch reflection stage: one session per batch on the reflector agent, each
// editing its own isolated CLONE of the target memory filesystem (taken at a
// shared base revision), so it reconciles new learnings against existing
// memory in place. Nothing here touches the target — the aggregation stage
// reads each batch's diff against the base and synthesizes one edit.
//
// Each batch directory is self-contained:
//   input/            the batch's normalized session transcripts
//   output/           the agent's edited clone of the memory filesystem
//   diff.patch        the batch's changes relative to the base revision
//   trajectory.json   the agent's own run, normalized-v1 (same format as input/)
//   report.json       structured outcome + the agent's final report

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import type { DreamBatch } from "./batching.js";
import { cloneMemoryTree, gitOutput, inspectMemoryTree } from "./clone.js";
import {
  configureMemfsCloneGuard,
  validateMemfsChanges,
  type MemfsWritePolicy,
} from "./memfs.js";
import {
  buildReflectionContinuePrompt,
  buildReflectionUserPrompt,
} from "./prompts.js";
import { runAgentToCompletion } from "./runner.js";
import { normalizeSdkMessages } from "./sdk-messages.js";
import { sessionFileName } from "./select.js";

export interface BatchReflectionResult {
  batchIndex: number;
  /** The reflector agent this batch ran on. */
  agentId: string;
  /** Conversation on the reflector agent this batch ran as. */
  conversationId?: string;
  sessionIds: string[];
  timeRange: { start: string; end: string };
  outputDir: string;
  reportPath: string;
  /** Target memfs revision the batch's clone (and diff.patch) is based on. */
  baseRevision: string;
  success: boolean;
  error?: string;
  /** Commits the agent made past the base revision. */
  commitCount: number;
  /** Uncommitted edits left behind (agent broke protocol; contents on disk). */
  dirty: boolean;
  durationMs: number;
}

export interface RunBatchReflectionsParams {
  client: LettaAgentClient;
  reflectorAgentId: string;
  /** Dream agent whose memfs is being reflected on. */
  parentAgentId: string;
  /** The target memory filesystem batches clone. */
  memoryDir: string;
  runRoot: string;
  batches: DreamBatch[];
  /** sessionKey(session) → normalized-v1 JSON (already serialized). */
  normalizedJsonByKey: Map<string, string>;
  /** Write policy installed on every isolated clone and checked afterward. */
  memfsPolicy: MemfsWritePolicy;
  concurrency: number;
  /** Additional caller instruction, also provided to the aggregation pass. */
  instruction?: string;
  log?: (line: string) => void;
}

async function runOneBatch(
  params: RunBatchReflectionsParams,
  batch: DreamBatch,
): Promise<BatchReflectionResult> {
  const log = params.log ?? (() => {});
  const batchDir = join(params.runRoot, "batches", String(batch.index));
  const inputDir = join(batchDir, "input");
  const outputDir = join(batchDir, "output");
  const reportPath = join(batchDir, "report.json");
  await mkdir(inputDir, { recursive: true });
  const baseRevision = await cloneMemoryTree(params.memoryDir, outputDir);
  const guard = await configureMemfsCloneGuard(
    params.memoryDir,
    outputDir,
    params.memfsPolicy,
  );

  // Stage this batch's normalized sessions into its own input/ directory so
  // the batch is self-contained and the aggregator can consult the original
  // data. Normalization already happened during packing.
  const sessionFileNames: string[] = [];
  for (const session of batch.sessions) {
    const key = `${session.harness}:${session.sessionId}`;
    const json = params.normalizedJsonByKey.get(key);
    if (!json) {
      throw new Error(`No normalized transcript staged for session ${key}`);
    }
    const fileName = sessionFileName(session);
    await writeFile(join(inputDir, fileName), json, "utf-8");
    sessionFileNames.push(fileName);
  }

  const userPrompt = buildReflectionUserPrompt({
    batchIndex: batch.index,
    inputDir,
    sessionFileNames,
    memoryDir: outputDir,
    timeRange: { start: batch.startTime, end: batch.endTime },
    ...(params.instruction ? { instruction: params.instruction } : {}),
  });

  const label = `reflect:batch-${batch.index}`;
  log(
    `[${label}] ${batch.sessions.length} session(s), ~${batch.estTokens} tokens, ` +
      `${batch.startTime} → ${batch.endTime}`,
  );

  // Session startup is the contended phase: concurrent sessions on the shared
  // reflector can collide on its git config lock, and a thundering herd of
  // runtime starts can push the slowest past the request timeout. Both are
  // transient — retry with jitter instead of failing the batch.
  const TRANSIENT_INIT_ERROR =
    /could not lock config file|Timed out waiting for runtime-start/;
  // Scope the session's memory to its clone: the harness's memory guard then
  // applies to the batch's own memory copy rather than being stripped. The
  // EXPLICIT marker distinguishes this deliberate scope from stale leakage.
  const memoryEnv = {
    MEMORY_DIR: outputDir,
    LETTA_MEMORY_DIR: outputDir,
    LETTA_MEMORY_DIR_EXPLICIT: "1",
    // The guard accepts memory clones under this dream agent's state tree
    // only when the worker is explicitly scoped as its child.
    LETTA_PARENT_AGENT_ID: params.parentAgentId,
  };
  let run = await runAgentToCompletion(params.client, {
    agentId: params.reflectorAgentId,
    userPrompt,
    cwd: batchDir,
    label,
    env: memoryEnv,
    skillSources: [],
    onProgress: log,
  });
  for (
    let retry = 0;
    !run.success &&
    run.error !== undefined &&
    TRANSIENT_INIT_ERROR.test(run.error) &&
    retry < 3;
    retry++
  ) {
    const delayMs = 500 + Math.floor(Math.random() * 2000);
    log(`[${label}] transient session-init contention, retrying in ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    run = await runAgentToCompletion(params.client, {
      agentId: params.reflectorAgentId,
      userPrompt,
      cwd: batchDir,
      label,
      env: memoryEnv,
      skillSources: [],
      onProgress: log,
    });
  }

  // The model can end its turn before doing the work (e.g. after narrating a
  // plan). While the clone is completely untouched, nudge the same
  // conversation onward — its survey of the sessions is already in context.
  const passes: { prompt: string; run: typeof run }[] = [
    { prompt: userPrompt, run },
  ];
  const explicitlyNoChanges = () =>
    /\b(no commit|no relevant trajector(?:y|ies)|no durable learnings|nothing (?:to|worth) persist)/i.test(
      run.report,
    );
  for (
    let nudge = 0;
    nudge < 2 && run.success && run.conversationId !== null;
    nudge++
  ) {
    const state = await inspectMemoryTree(outputDir, baseRevision);
    if (state.commitCount > 0 || state.dirty) break;
    // A clean no-op is a valid reflection outcome. In particular, a scoped
    // prompt may require irrelevant transcripts to be skipped without a
    // commit; do not nudge the model into inventing memory in that case.
    if (explicitlyNoChanges()) break;
    const continuePrompt = buildReflectionContinuePrompt({
      memoryDir: outputDir,
    });
    log(`[${label}] turn ended with no memory changes — nudging to continue`);
    run = await runAgentToCompletion(params.client, {
      agentId: params.reflectorAgentId,
      userPrompt: continuePrompt,
      cwd: batchDir,
      label,
      resumeConversationId: run.conversationId,
      env: memoryEnv,
      skillSources: [],
      onProgress: log,
    });
    passes.push({ prompt: continuePrompt, run });
  }

  const records = passes.flatMap(
    (pass) => normalizeSdkMessages(pass.prompt, pass.run.messages) ?? [],
  );
  if (records.length > 0) {
    await writeFile(
      join(batchDir, "trajectory.json"),
      JSON.stringify(records, null, 1),
      "utf-8",
    );
  }
  let { commitCount, dirty } = await inspectMemoryTree(
    outputDir,
    baseRevision,
  );
  if (dirty) {
    // Agents occasionally end without committing their last edits. That tree
    // content is the batch's real output — commit it so diff.patch (the
    // aggregator's primary input) reflects it. `dirty` stays true to record
    // the protocol break.
    try {
      await gitOutput(outputDir, ["add", "-A"]);
      await gitOutput(outputDir, [
        "commit",
        "-m",
        `reflection: batch ${batch.index} (recovered uncommitted edits)`,
      ]);
      commitCount += 1;
    } catch {
      // Recovery is best-effort; an unrecoverable tree still ships its diff
      // of whatever WAS committed.
    }
  }
  // The batch's changes relative to the shared base — the aggregator's
  // primary input.
  try {
    const patch = await gitOutput(outputDir, ["diff", baseRevision, "HEAD"]);
    await writeFile(join(batchDir, "diff.patch"), `${patch}\n`, "utf-8");
  } catch {
    // A missing diff just reads as an empty batch to the aggregator.
  }

  const policyCheck = await validateMemfsChanges(
    outputDir,
    baseRevision,
    params.memfsPolicy,
    { baselineDirectories: guard.baselineDirectories },
  );
  const policyError = policyCheck.valid
    ? undefined
    : `MemFS write policy rejected ${policyCheck.violations.length} change(s): ${policyCheck.violations
        .map((violation) => `${violation.path} (${violation.reason})`)
        .join("; ")}`;

  const result: BatchReflectionResult = {
    batchIndex: batch.index,
    agentId: run.agentId,
    conversationId: run.conversationId ?? undefined,
    sessionIds: batch.sessions.map((s) => `${s.harness}:${s.sessionId}`),
    timeRange: { start: batch.startTime, end: batch.endTime },
    outputDir,
    reportPath,
    baseRevision,
    success: run.success && policyCheck.valid,
    error: run.error ?? policyError,
    commitCount,
    dirty,
    durationMs: run.durationMs,
  };
  await writeFile(
    reportPath,
    JSON.stringify({ ...result, report: run.report }, null, 2),
    "utf-8",
  );
  log(
    `[${label}] ${result.success ? "done" : `FAILED: ${result.error ?? "unknown error"}`} ` +
      `(${commitCount} commit(s)${dirty ? ", uncommitted edits left" : ""})`,
  );
  return result;
}

/** Run all batches with bounded concurrency; results ordered by batch index. */
export async function runBatchReflections(
  params: RunBatchReflectionsParams,
): Promise<BatchReflectionResult[]> {
  const results: BatchReflectionResult[] = [];
  let next = 0;
  const workerCount = Math.max(
    1,
    Math.min(params.concurrency, params.batches.length),
  );
  const workers = Array.from({ length: workerCount }, async (_, workerIndex) => {
    // Stagger session startups: a same-instant herd of runtime starts can
    // push the slowest past the protocol request timeout.
    await new Promise((resolve) => setTimeout(resolve, workerIndex * 1500));
    while (next < params.batches.length) {
      const batch = params.batches[next++];
      if (!batch) break;
      results.push(await runOneBatch(params, batch));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.batchIndex - b.batchIndex);
  return results;
}
