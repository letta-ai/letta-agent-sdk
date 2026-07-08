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
import { buildReflectionUserPrompt } from "./prompts.js";
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
  /** The target memory filesystem batches clone. */
  memoryDir: string;
  runRoot: string;
  batches: DreamBatch[];
  /** sessionKey(session) → normalized-v1 JSON (already serialized). */
  normalizedJsonByKey: Map<string, string>;
  concurrency: number;
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
    instruction: params.instruction,
  });

  const label = `reflect:batch-${batch.index}`;
  log(
    `[${label}] ${batch.sessions.length} session(s), ~${batch.estTokens} tokens, ` +
      `${batch.startTime} → ${batch.endTime}`,
  );

  const run = await runAgentToCompletion(params.client, {
    agentId: params.reflectorAgentId,
    userPrompt,
    cwd: batchDir,
    label,
    onProgress: log,
  });

  const records = normalizeSdkMessages(userPrompt, run.messages);
  if (records) {
    await writeFile(
      join(batchDir, "trajectory.json"),
      JSON.stringify(records, null, 1),
      "utf-8",
    );
  }
  const { commitCount, dirty } = await inspectMemoryTree(
    outputDir,
    baseRevision,
  );
  // The batch's changes relative to the shared base — the aggregator's
  // primary input.
  try {
    const patch = await gitOutput(outputDir, ["diff", baseRevision, "HEAD"]);
    await writeFile(join(batchDir, "diff.patch"), `${patch}\n`, "utf-8");
  } catch {
    // A missing diff just reads as an empty batch to the aggregator.
  }

  const result: BatchReflectionResult = {
    batchIndex: batch.index,
    agentId: run.agentId,
    conversationId: run.conversationId ?? undefined,
    sessionIds: batch.sessions.map((s) => s.sessionId),
    timeRange: { start: batch.startTime, end: batch.endTime },
    outputDir,
    reportPath,
    baseRevision,
    success: run.success,
    error: run.error,
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
  const workers = Array.from({ length: workerCount }, async () => {
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
