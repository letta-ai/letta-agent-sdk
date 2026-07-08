// Aggregation stage: synthesize every batch's memory changes (diffs against
// the shared base revision) into the target memory filesystem, in ONE pass.
// The aggregator always runs (even for one batch) and is the only stage that
// edits the target. Batches that failed or produced nothing are skipped. When
// the input count is large, the aggregator itself decides whether to delegate
// aspects to its own subagents — the pipeline imposes no fan-out structure.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import { gitOutput } from "./clone.js";
import { buildAggregatorUserPrompt } from "./prompts.js";
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
  instruction?: string;
  log?: (line: string) => void;
}): Promise<DreamAggregationOutcome> {
  const log = params.log ?? (() => {});

  // Batches that failed or produced nothing contribute nothing to merge.
  const withContent = params.reflections.filter(
    (r) => r.success && (r.commitCount > 0 || r.dirty),
  );
  if (withContent.length === 0) {
    return {
      success: true,
      report:
        "Reflections found no durable learnings to persist; memory left unchanged.",
      commitCount: 0,
    };
  }

  const aggregateDir = join(params.runRoot, "aggregate");
  await mkdir(aggregateDir, { recursive: true });
  const baseRevision = await gitOutput(params.memoryDir, [
    "rev-parse",
    "HEAD",
  ]);

  const userPrompt = buildAggregatorUserPrompt({
    batchesDir: join(params.runRoot, "batches"),
    batchCount: params.reflections.length,
    memoryDir: params.memoryDir,
    instruction: params.instruction,
  });

  log(
    `[aggregate] integrating ${withContent.length} reflection output(s) into memory`,
  );
  const run = await runAgentToCompletion(params.client, {
    agentId: params.aggregatorAgentId,
    userPrompt,
    // cwd one level above the target so the harness's own state doesn't land
    // inside (and get committed to) the memory filesystem.
    cwd: dirname(params.memoryDir),
    label: "aggregate",
    onProgress: log,
  });

  const records = normalizeSdkMessages(userPrompt, run.messages);
  if (records) {
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
  const outcome: DreamAggregationOutcome = {
    success: run.success,
    report: run.report,
    error: run.error,
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
        durationMs: run.durationMs,
        inputs: withContent.map((r) => `batch-${r.batchIndex}`),
        report: run.report,
      },
      null,
      2,
    ),
    "utf-8",
  );
  log(
    `[aggregate] ${outcome.success ? "done" : `FAILED: ${outcome.error ?? "unknown error"}`} ` +
      `(${commitCount} commit(s) on target)`,
  );
  return outcome;
}
