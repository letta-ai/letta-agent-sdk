// Dreaming: batch memory formation over recorded coding-agent sessions.
//
//   normalize → batch → reflect (parallel sessions, isolated memfs clones)
//             → aggregate (one diff-synthesis pass onto the target memfs)
//
// The caller owns the target memory filesystem (a git repo — e.g. an agent's
// memfs checkout, or a worktree of one when the caller wants isolation) and
// the run directory, which records every batch's inputs, edited clone, diff,
// trajectory, and report for inspection.

import { mkdir } from "node:fs/promises";
import type { LettaAgentClient } from "../client.js";
import {
  DEFAULT_BATCH_TOKEN_BUDGET,
  DEFAULT_MAX_SESSIONS_PER_BATCH,
  type DreamBatch,
  packDreamBatches,
} from "./batching.js";
import { type DreamAggregationOutcome, runDreamAggregation } from "./aggregate.js";
import { getTrajectorySource } from "./registry.js";
import {
  type BatchReflectionResult,
  runBatchReflections,
} from "./reflect.js";
import {
  type DreamSourceSpec,
  selectDreamSessions,
  sessionKey,
} from "./select.js";
import type { DiscoveredSession } from "./types.js";
import { estimateTokens } from "./types.js";
import { ensureDreamWorkers } from "./workers.js";

export type { DreamBatch } from "./batching.js";
export type { DreamAggregationOutcome } from "./aggregate.js";
export type { BatchReflectionResult } from "./reflect.js";
export { type DreamSourceSpec, selectDreamSessions } from "./select.js";
export { packDreamBatches } from "./batching.js";
export {
  AGGREGATOR_PERSONA,
  REFLECTION_SYSTEM_PROMPT,
} from "./prompts.js";
export { getTrajectorySource, listTrajectorySourceTypes } from "./registry.js";
export type {
  DiscoveredSession,
  NormalizedRecord,
  NormalizedSession,
  TrajectorySource,
} from "./types.js";

export interface DreamOptions {
  client: LettaAgentClient;
  /** What to reflect on. */
  sources: DreamSourceSpec[];
  /**
   * The target memory filesystem: a git repository the aggregation lands on.
   * Pass a worktree of the real memfs when isolation from concurrent edits
   * is needed.
   */
  memoryDir: string;
  /** Directory to record the run under (created if missing). */
  runRoot: string;
  /** Reuse an existing reflector agent (one is created when omitted). */
  reflectorAgentId?: string;
  /** Reuse an existing aggregator agent (one is created when omitted). */
  aggregatorAgentId?: string;
  /** Model for created worker agents (backend default when omitted). */
  model?: string;
  /** Extra instruction threaded into every pass. */
  instruction?: string;
  /** Per-batch token budget (default 60k, measured on normalized content). */
  batchTokenBudget?: number;
  /** Max sessions per batch (default 10). */
  maxSessionsPerBatch?: number;
  /** Cap on concurrent batch reflections; default: every batch at once. */
  concurrency?: number;
  /** When true, stop after planning (no agents run). */
  planOnly?: boolean;
  log?: (line: string) => void;
}

export type DreamResult =
  | { kind: "nothing_to_dream" }
  | { kind: "plan"; sessions: DiscoveredSession[]; batches: DreamBatch[] }
  | {
      kind: "completed";
      runRoot: string;
      success: boolean;
      sessions: DiscoveredSession[];
      batches: BatchReflectionResult[];
      aggregation: DreamAggregationOutcome;
      reflectorAgentId: string;
      aggregatorAgentId: string;
    };

export async function dream(options: DreamOptions): Promise<DreamResult> {
  const log = options.log ?? (() => {});

  const sessions = await selectDreamSessions(options.sources);
  if (sessions.length === 0) {
    return { kind: "nothing_to_dream" };
  }

  // Normalize up front and pack on the size of the normalized content: raw
  // store files shrink non-uniformly under normalization, so packing on raw
  // sizes skews batches — and this makes planOnly match reality.
  const normalizedJsonByKey = new Map<string, string>();
  const measuredSessions: DiscoveredSession[] = [];
  for (const session of sessions) {
    const source = getTrajectorySource(session.harness);
    const { records } = await source.normalize(session);
    const json = JSON.stringify(records, null, 1);
    normalizedJsonByKey.set(sessionKey(session), json);
    measuredSessions.push({ ...session, estTokens: estimateTokens(json) });
  }

  const batches = packDreamBatches(
    measuredSessions,
    options.batchTokenBudget ?? DEFAULT_BATCH_TOKEN_BUDGET,
    options.maxSessionsPerBatch ?? DEFAULT_MAX_SESSIONS_PER_BATCH,
  );
  if (options.planOnly) {
    return { kind: "plan", sessions: measuredSessions, batches };
  }

  await mkdir(options.runRoot, { recursive: true });
  const workers = await ensureDreamWorkers(options.client, {
    reflectorAgentId: options.reflectorAgentId,
    aggregatorAgentId: options.aggregatorAgentId,
    model: options.model,
    log,
  });
  log(
    `Selected ${measuredSessions.length} session(s) in ${batches.length} batch(es)`,
  );

  const batchResults = await runBatchReflections({
    client: options.client,
    reflectorAgentId: workers.reflectorAgentId,
    memoryDir: options.memoryDir,
    runRoot: options.runRoot,
    batches,
    normalizedJsonByKey,
    concurrency: options.concurrency ?? batches.length,
    instruction: options.instruction,
    log,
  });

  const aggregation = await runDreamAggregation({
    client: options.client,
    aggregatorAgentId: workers.aggregatorAgentId,
    memoryDir: options.memoryDir,
    runRoot: options.runRoot,
    reflections: batchResults,
    instruction: options.instruction,
    log,
  });

  return {
    kind: "completed",
    runRoot: options.runRoot,
    success: aggregation.success,
    sessions: measuredSessions,
    batches: batchResults,
    aggregation,
    reflectorAgentId: workers.reflectorAgentId,
    aggregatorAgentId: workers.aggregatorAgentId,
  };
}
