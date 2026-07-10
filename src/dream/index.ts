// Dreaming: form durable agent memory from an explicit list of normalized
// transcripts.
//
//   collectTranscripts() -> initDreamAgent() -> dream()
//
// dream() deliberately does not discover or normalize source stores. The
// caller supplies immutable transcript snapshots, which makes selection easy
// to inspect and makes a run reproducible after its source files change.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import {
  DEFAULT_BATCH_TOKEN_BUDGET,
  DEFAULT_MAX_SESSIONS_PER_BATCH,
  type DreamBatch,
  packDreamBatches,
} from "./batching.js";
import {
  type DreamAggregationOutcome,
  runDreamAggregation,
} from "./aggregate.js";
import {
  type BatchReflectionResult,
  runBatchReflections,
} from "./reflect.js";
import {
  loadDreamAgent,
  prepareDreamAgentMemfs,
  saveDreamAgentConfig,
} from "./agent.js";
import { loadDreamCursors, saveDreamCursors } from "./cursors.js";
import { AGGREGATOR_PERSONA } from "./prompts.js";
import { redactSensitiveText } from "./redact.js";
import { sessionKey } from "./select.js";
import type {
  DiscoveredSession,
  NormalizedSession,
} from "./types.js";
import {
  estimateTokens,
} from "./types.js";
import { validateRecords } from "./normalize-core.js";
import { ensureDreamWorkers } from "./workers.js";

export type { DreamBatch } from "./batching.js";
export type { DreamAggregationOutcome } from "./aggregate.js";
export type { BatchReflectionResult } from "./reflect.js";
export { packDreamBatches } from "./batching.js";
export {
  AGGREGATOR_PERSONA,
  REFLECTION_SYSTEM_PROMPT,
} from "./prompts.js";
export { getTrajectorySource, listTrajectorySourceTypes } from "./registry.js";
export {
  type DreamAgentConfig,
  type DreamAgentGuardOptions,
  type InitDreamAgentOptions,
  type LoadedDreamAgent,
  initDreamAgent,
  loadDreamAgent,
} from "./agent.js";
export {
  type MemfsOperation,
  type MemfsOperationRule,
  type MemfsStructure,
  type MemfsWritePolicy,
} from "./memfs.js";
export {
  collectTranscripts,
  type CollectTranscriptsOptions,
  type Transcript,
  type TranscriptSourceSpec,
} from "./transcripts.js";
export type {
  DiscoveredSession,
  NormalizedRecord,
  NormalizedSession,
  TrajectorySource,
} from "./types.js";

export interface DreamOptions {
  client: LettaAgentClient;
  /** Initialized dream-agent id returned by initDreamAgent(). */
  agentId: string;
  /** Immutable normalized transcript snapshots to reflect on. */
  transcripts: readonly NormalizedSession[];
  /** Additional instruction provided to every reflection batch only. */
  reflectionPrompt?: string;
  /** Override the harness agents directory (tests). */
  agentsDir?: string;
  /** Per-batch token budget (default 60k, measured on normalized content). */
  batchTokenBudget?: number;
  /** Maximum transcripts in one batch (default 10). */
  maxTranscriptsPerBatch?: number;
  /** Concurrent reflection sessions; default: every batch at once. */
  concurrency?: number;
  /** Preview cursor filtering and batch packing without running agents. */
  planOnly?: boolean;
  /**
   * Abort the run: in-flight reflector/aggregator sessions are closed, no
   * new batches start, the run's artifacts (clones, runRoot) are removed,
   * cursors are NOT advanced, and dream() rejects with the abort reason.
   * Shutting down a spawned app-server remains the caller's job via
   * client.close().
   */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** Long-lived streams tracked incrementally between dreams. */
const CURSOR_TRACKED_HARNESSES = new Set(["openhands"]);

export type DreamResult =
  | { kind: "nothing_to_dream" }
  | {
      kind: "plan";
      transcripts: DiscoveredSession[];
      batches: DreamBatch[];
    }
  | {
      kind: "completed";
      runRoot: string;
      success: boolean;
      transcripts: DiscoveredSession[];
      batches: BatchReflectionResult[];
      aggregation: DreamAggregationOutcome;
      reflectorAgentId: string;
      aggregatorAgentId: string;
    };

function dreamRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  return `dream-${stamp}`;
}

function orderedTranscripts(
  transcripts: readonly NormalizedSession[],
): NormalizedSession[] {
  return [...transcripts].sort((a, b) =>
    a.session.startTime.localeCompare(b.session.startTime) ||
    a.session.endTime.localeCompare(b.session.endTime) ||
    a.session.harness.localeCompare(b.session.harness) ||
    a.session.sessionId.localeCompare(b.session.sessionId)
  );
}

function validateTranscripts(
  transcripts: readonly NormalizedSession[],
): void {
  const seen = new Set<string>();
  for (const transcript of transcripts) {
    const key = sessionKey(transcript.session);
    if (seen.has(key)) {
      throw new Error(`dream(): duplicate transcript ${key}`);
    }
    seen.add(key);
    const problem = validateRecords(transcript.records);
    if (problem) {
      throw new Error(`dream(): invalid transcript ${key}: ${problem}`);
    }
  }
}

export async function dream(options: DreamOptions): Promise<DreamResult> {
  const log = options.log ?? (() => {});
  options.signal?.throwIfAborted();
  validateTranscripts(options.transcripts);

  const agent = await loadDreamAgent(options.agentId, {
    ...(options.agentsDir ? { agentsDir: options.agentsDir } : {}),
  });
  const memoryDir = agent.memoryDir;
  const cursorDir = agent.stateDir;

  if (options.transcripts.length === 0) {
    return { kind: "nothing_to_dream" };
  }
  await prepareDreamAgentMemfs(agent);

  const cursors = await loadDreamCursors(cursorDir);
  const lastReflectedTsByKey = new Map<string, string>();
  const normalizedJsonByKey = new Map<string, string>();
  const measuredTranscripts: DiscoveredSession[] = [];

  for (const transcript of orderedTranscripts(options.transcripts)) {
    const session = transcript.session;
    const key = sessionKey(session);
    let records = [...transcript.records];

    if (CURSOR_TRACKED_HARNESSES.has(session.harness)) {
      const cursor = cursors[key];
      if (cursor) {
        const body = records.filter(
          (record) =>
            record.role !== "meta" &&
            (record.timestamp ?? "") > cursor.reflectedThrough,
        );
        if (body.length === 0) {
          log(
            `[cursor] ${key}: nothing new past ${cursor.reflectedThrough}; skipping`,
          );
          continue;
        }
        records = [
          ...records.filter((record) => record.role === "meta"),
          ...body,
        ];
      }
      const lastTs = [...records]
        .reverse()
        .find((record) => record.role !== "meta" && record.timestamp)
        ?.timestamp;
      if (lastTs) lastReflectedTsByKey.set(key, lastTs);
    }

    // Run artifacts and reflection prompts should never retain credentials
    // that a recorded shell/env command happened to print.
    const json = redactSensitiveText(JSON.stringify(records, null, 1));
    normalizedJsonByKey.set(key, json);
    measuredTranscripts.push({
      ...session,
      estTokens: estimateTokens(json),
    });
  }

  if (measuredTranscripts.length === 0) {
    return { kind: "nothing_to_dream" };
  }

  const batches = packDreamBatches(
    measuredTranscripts,
    options.batchTokenBudget ?? DEFAULT_BATCH_TOKEN_BUDGET,
    options.maxTranscriptsPerBatch ?? DEFAULT_MAX_SESSIONS_PER_BATCH,
  );
  if (options.planOnly) {
    return {
      kind: "plan",
      transcripts: measuredTranscripts,
      batches,
    };
  }

  options.signal?.throwIfAborted();
  await mkdir(agent.runsDir, { recursive: true });
  const runRoot = join(agent.runsDir, dreamRunId());
  await mkdir(runRoot, { recursive: true });

  // On abort: remove this run's artifacts (batch clones live under runRoot)
  // and reject. Cursors are never advanced (the success gate below already
  // requires a non-aborted, fully successful run).
  const throwIfAbortedWithCleanup = async () => {
    if (!options.signal?.aborted) return;
    log("[abort] dream aborted; removing run artifacts");
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
    options.signal.throwIfAborted();
  };

  const workers = await ensureDreamWorkers(options.client, {
    reflectorAgentId: agent.config.reflectorAgentId,
    aggregatorAgentId: agent.agentId,
    model: agent.config.model,
    log,
  });
  if (agent.config.reflectorAgentId !== workers.reflectorAgentId) {
    agent.config.reflectorAgentId = workers.reflectorAgentId;
    await saveDreamAgentConfig(agent);
  }

  log(
    `Selected ${measuredTranscripts.length} transcript(s) in ${batches.length} batch(es)`,
  );
  const batchResults = await runBatchReflections({
    client: options.client,
    reflectorAgentId: workers.reflectorAgentId,
    parentAgentId: agent.agentId,
    memoryDir,
    runRoot,
    batches,
    normalizedJsonByKey,
    memfsPolicy: agent.config.memfs.policy,
    concurrency: options.concurrency ?? batches.length,
    ...(options.reflectionPrompt
      ? { reflectionPrompt: options.reflectionPrompt }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log,
  });
  await throwIfAbortedWithCleanup();

  const aggregation = await runDreamAggregation({
    client: options.client,
    aggregatorAgentId: agent.agentId,
    memoryDir,
    runRoot,
    reflections: batchResults,
    memfsPolicy: agent.config.memfs.policy,
    personaPreamble: AGGREGATOR_PERSONA,
    ...(options.signal ? { signal: options.signal } : {}),
    log,
  });
  await throwIfAbortedWithCleanup();

  const everyBatchSucceeded = batchResults.every((batch) => batch.success);
  const success = everyBatchSucceeded && aggregation.success;

  if (success && lastReflectedTsByKey.size > 0) {
    const reflectedKeys = new Set(
      batchResults
        .filter((batch) => batch.success)
        .flatMap((batch) => batch.sessionIds),
    );
    let advanced = 0;
    for (const [key, reflectedThrough] of lastReflectedTsByKey) {
      if (!reflectedKeys.has(key)) continue;
      cursors[key] = { reflectedThrough };
      advanced += 1;
    }
    if (advanced > 0) {
      await saveDreamCursors(cursorDir, cursors);
      log(`[cursor] advanced ${advanced} cursor(s)`);
    }
  }

  return {
    kind: "completed",
    runRoot,
    success,
    transcripts: measuredTranscripts,
    batches: batchResults,
    aggregation,
    reflectorAgentId: workers.reflectorAgentId,
    aggregatorAgentId: agent.agentId,
  };
}
