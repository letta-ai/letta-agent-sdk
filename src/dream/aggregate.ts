// Aggregation stage: synthesize every batch's memory changes (diffs against
// the shared base revision) into the target memory filesystem, in ONE pass.
// The aggregator always runs (even for one batch) and is the only stage that
// edits the target. Batches that failed or produced nothing are skipped. When
// the input count is large, the aggregator itself decides whether to delegate
// aspects to its own subagents — the pipeline imposes no fan-out structure.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import { gitOutput, snapshotMemoryTree } from "./clone.js";
import {
  installMemfsGuard,
  recreateMemfsDirectories,
  validateMemfsChanges,
  type MemfsWritePolicy,
} from "./memfs.js";
import {
  AGGREGATOR_CONTINUE_PROMPT,
  buildAggregatorUserPrompt,
} from "./prompts.js";
import type { BatchReflectionResult } from "./reflect.js";
import { runAgentToCompletion } from "./runner.js";
import { normalizeSdkMessages } from "./sdk-messages.js";

export interface DreamAggregationOutcome {
  success: boolean;
  /** The aggregator's final report (or the skip reason). */
  report: string;
  error?: string;
  conversationId?: string;
  /** Commits the aggregator landed on the target, relative to the base. */
  commitCount: number;
}

export async function runDreamAggregation(params: {
  client: LettaAgentClient;
  aggregatorAgentId: string;
  /** The target memory filesystem the synthesis lands on. */
  memoryDir: string;
  runRoot: string;
  reflections: BatchReflectionResult[];
  /** Write policy enforced on the canonical MemFS and checked afterward. */
  memfsPolicy: MemfsWritePolicy;
  /**
   * Persona text prepended to the prompt when the aggregating agent doesn't
   * carry a dedicated aggregator persona block (a dream agent synthesizing
   * its own memory).
   */
  personaPreamble?: string;
  log?: (line: string) => void;
}): Promise<DreamAggregationOutcome> {
  const log = params.log ?? (() => {});

  // Batches that failed or produced nothing contribute nothing to merge.
  const withContent = params.reflections.filter(
    (r) => r.success && (r.commitCount > 0 || r.dirty),
  );
  if (withContent.length === 0) {
    const outcome: DreamAggregationOutcome = {
      success: true,
      report:
        "Reflections found no durable learnings to persist; memory left unchanged.",
      commitCount: 0,
    };
    const aggregateDir = join(params.runRoot, "aggregate");
    await mkdir(aggregateDir, { recursive: true });
    await writeFile(
      join(aggregateDir, "report.json"),
      JSON.stringify(
        {
          agentId: params.aggregatorAgentId,
          success: true,
          durationMs: 0,
          inputs: [],
          report: outcome.report,
        },
        null,
        2,
      ),
      "utf-8",
    );
    const outputDir = join(aggregateDir, "output");
    await snapshotMemoryTree(params.memoryDir, outputDir);
    await recreateMemfsDirectories(
      outputDir,
      params.memfsPolicy.declaredDirectories ?? [],
    );
    return outcome;
  }

  const aggregateDir = join(params.runRoot, "aggregate");
  await mkdir(aggregateDir, { recursive: true });
  const guard = await installMemfsGuard(params.memoryDir, params.memfsPolicy);
  const baseRevision = await gitOutput(params.memoryDir, [
    "rev-parse",
    "HEAD",
  ]);

  const builtPrompt = buildAggregatorUserPrompt({
    batchesDir: join(params.runRoot, "batches"),
    batchCount: params.reflections.length,
    memoryDir: params.memoryDir,
  });
  const userPrompt = params.personaPreamble
    ? `${params.personaPreamble.trim()}\n\n${builtPrompt}`
    : builtPrompt;

  log(
    `[aggregate] integrating ${withContent.length} reflection output(s) into memory`,
  );
  const landedCommits = async () =>
    Number(
      (
        await gitOutput(params.memoryDir, [
          "rev-list",
          "--count",
          `${baseRevision}..HEAD`,
        ]).catch(() => "0")
      ).trim() || "0",
    );
  // Scope the session's memory to the target memfs so the harness's memory
  // guard applies to the tree the aggregator is synthesizing onto. The
  // EXPLICIT marker distinguishes this deliberate scope from stale leakage.
  const memoryEnv = {
    MEMORY_DIR: params.memoryDir,
    LETTA_MEMORY_DIR: params.memoryDir,
    LETTA_MEMORY_DIR_EXPLICIT: "1",
  };
  let run = await runAgentToCompletion(params.client, {
    agentId: params.aggregatorAgentId,
    userPrompt,
    // cwd one level above the target so the harness's own state doesn't land
    // inside (and get committed to) the memory filesystem.
    cwd: dirname(params.memoryDir),
    label: "aggregate",
    env: memoryEnv,
    onProgress: log,
  });
  // The model can end its turn narrating its plan instead of executing it.
  // While nothing has landed on the target, nudge the same conversation to
  // keep going — its plan and diff survey are already in context.
  const passes: { prompt: string; run: typeof run }[] = [{ prompt: userPrompt, run }];
  for (
    let nudge = 0;
    nudge < 2 &&
    run.success &&
    run.conversationId !== null &&
    (await landedCommits()) === 0;
    nudge++
  ) {
    log("[aggregate] turn ended with no commits on target — nudging to continue");
    run = await runAgentToCompletion(params.client, {
      agentId: params.aggregatorAgentId,
      userPrompt: AGGREGATOR_CONTINUE_PROMPT,
      cwd: dirname(params.memoryDir),
      label: "aggregate",
      resumeConversationId: run.conversationId,
      env: memoryEnv,
      onProgress: log,
    });
    passes.push({ prompt: AGGREGATOR_CONTINUE_PROMPT, run });
  }

  const records = passes.flatMap(
    (pass) => normalizeSdkMessages(pass.prompt, pass.run.messages) ?? [],
  );
  if (records.length > 0) {
    await writeFile(
      join(aggregateDir, "trajectory.json"),
      JSON.stringify(records, null, 1),
      "utf-8",
    );
  }
  const gitLog = await gitOutput(params.memoryDir, [
    "log",
    "--format=%h  %s",
    "--reverse",
    `${baseRevision}..HEAD`,
  ]).catch(() => "");
  const gitPatch = await gitOutput(params.memoryDir, [
    "log",
    "-p",
    "--reverse",
    "--format=commit %h%n%s%n",
    `${baseRevision}..HEAD`,
  ]).catch(() => "");
  await writeFile(join(aggregateDir, "git-log.txt"), `${gitLog}\n`, "utf-8");
  await writeFile(join(aggregateDir, "memfs.patch"), `${gitPatch}\n`, "utf-8");

  const commitCount = gitLog ? gitLog.split("\n").length : 0;
  const landed = commitCount > 0;
  const policyCheck = await validateMemfsChanges(
    params.memoryDir,
    baseRevision,
    params.memfsPolicy,
    { baselineDirectories: guard.baselineDirectories },
  );
  const policyError = policyCheck.valid
    ? undefined
    : `MemFS write policy rejected ${policyCheck.violations.length} change(s): ${policyCheck.violations
        .map((violation) => `${violation.path} (${violation.reason})`)
        .join("; ")}`;
  const outcome: DreamAggregationOutcome = {
    success: run.success && landed && policyCheck.valid,
    report: run.report,
    error:
      run.error ??
      policyError ??
      (landed
        ? undefined
        : "Aggregation ended without committing the reflection outputs"),
    conversationId: run.conversationId ?? undefined,
    commitCount,
  };
  await writeFile(
    join(aggregateDir, "report.json"),
    JSON.stringify(
      {
        agentId: params.aggregatorAgentId,
        conversationId: outcome.conversationId,
        success: outcome.success,
        error: outcome.error,
        durationMs: passes.reduce((total, pass) => total + pass.run.durationMs, 0),
        inputs: withContent.map((r) => `batch-${r.batchIndex}`),
        report: run.report,
      },
      null,
      2,
    ),
    "utf-8",
  );
  if (outcome.success) {
    const outputDir = join(aggregateDir, "output");
    await snapshotMemoryTree(params.memoryDir, outputDir);
    await recreateMemfsDirectories(
      outputDir,
      params.memfsPolicy.declaredDirectories ?? [],
    );
  }
  log(
    `[aggregate] ${outcome.success ? "done" : `FAILED: ${outcome.error ?? "unknown error"}`} ` +
      `(${commitCount} commit(s) on target)`,
  );
  return outcome;
}
