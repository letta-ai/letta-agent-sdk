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
import { join } from "node:path";
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
import {
  classifyAgentTargets,
  exportAgentTargets,
  loadDreamAgent,
  saveDreamAgentConfig,
  syncAgentTargetsIntoMemory,
} from "./agent.js";
import { loadDreamCursors, saveDreamCursors } from "./cursors.js";
import {
  readExistingTarget,
  readTargetFromMemory,
  resolveDreamTarget,
  syncTargetIntoMemory,
  writeTarget,
} from "./targets.js";
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
export { type DreamTarget, resolveDreamTarget } from "./targets.js";
export {
  type DreamAgentConfig,
  type LoadedDreamAgent,
  initDreamAgent,
  loadDreamAgent,
} from "./agent.js";
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
   * Root directory of a dream agent (see initDreamAgent). When set, the
   * memory filesystem, run directory (runs/<dream-id>), worker agents, model,
   * and targets all come from — and persist to — the agent identity, and
   * memoryDir/runRoot/target must be omitted.
   */
  agent?: string;
  /**
   * The target memory filesystem: a git repository the aggregation lands on.
   * Pass a worktree of the real memfs when isolation from concurrent edits
   * is needed. Required unless `agent` is set.
   */
  memoryDir?: string;
  /** Directory to record the run under (created if missing). Required unless `agent` is set. */
  runRoot?: string;
  /** Reuse an existing reflector agent (one is created when omitted). */
  reflectorAgentId?: string;
  /** Reuse an existing aggregator agent (one is created when omitted). */
  aggregatorAgentId?: string;
  /** Model for created worker agents (backend default when omitted). */
  model?: string;
  /** Extra instruction threaded into every pass. */
  instruction?: string;
  /**
   * Path of a doc (e.g. "./AGENTS.md") maintained from memory: synced into
   * the memfs at system/<name> before reflection (the on-disk copy is the
   * source of truth), revised by the reflection batches, synthesized by the
   * aggregator, and exported back to this path afterwards. A run that yields
   * no durable guidance leaves the doc untouched.
   */
  target?: string;
  /** Keep only the N most recent selected sessions (no cap when omitted). */
  maxSessions?: number;
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

/**
 * Harnesses whose sessions are long-lived streams tracked by a reflection
 * cursor (see cursors.ts). Finite per-run session files (claude, codex) are
 * deliberately not tracked.
 */
const CURSOR_TRACKED_HARNESSES = new Set(["openhands"]);

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
      /** Present when a target doc was requested: whether it was (re)written. */
      target?: { path: string; written: boolean };
    };

function dreamRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  return `dream-${stamp}`;
}

export async function dream(options: DreamOptions): Promise<DreamResult> {
  const log = options.log ?? (() => {});

  // An agent identity supplies (and persists) everything a bare run takes
  // as explicit options.
  const agentState = options.agent
    ? await loadDreamAgent(options.agent)
    : undefined;
  if (agentState && (options.memoryDir || options.runRoot || options.target)) {
    throw new Error(
      "dream(): `agent` already provides memoryDir/runRoot/target — omit them",
    );
  }
  const memoryDir = agentState?.memoryDir ?? options.memoryDir;
  const runRoot =
    options.runRoot ?? (agentState && join(agentState.runsDir, dreamRunId()));
  if (!memoryDir || !runRoot) {
    throw new Error("dream() requires either `agent` or memoryDir + runRoot");
  }

  let sessions = await selectDreamSessions(options.sources);
  if (sessions.length === 0) {
    return { kind: "nothing_to_dream" };
  }
  // Selection is time-ordered ascending, so the tail is the most recent.
  // Apply the cap before normalization — a bare machine-wide source can
  // select far more sessions than the caller wants to pay to normalize.
  if (options.maxSessions !== undefined && options.maxSessions > 0) {
    sessions = sessions.slice(-options.maxSessions);
  }

  // Normalize up front and pack on the size of the normalized content: raw
  // store files shrink non-uniformly under normalization, so packing on raw
  // sizes skews batches — and this makes planOnly match reality.
  //
  // Cursor-tracked harnesses (openhands: long-lived, append-only
  // conversations) are trimmed to the records past their reflection cursor;
  // a conversation with nothing new is dropped entirely.
  const cursors = await loadDreamCursors(memoryDir);
  const lastReflectedTsByKey = new Map<string, string>();
  const normalizedJsonByKey = new Map<string, string>();
  const measuredSessions: DiscoveredSession[] = [];
  for (const session of sessions) {
    const source = getTrajectorySource(session.harness);
    let { records } = await source.normalize(session);
    const key = sessionKey(session);
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
    const json = JSON.stringify(records, null, 1);
    normalizedJsonByKey.set(key, json);
    measuredSessions.push({ ...session, estTokens: estimateTokens(json) });
  }
  if (measuredSessions.length === 0) {
    return { kind: "nothing_to_dream" };
  }

  const batches = packDreamBatches(
    measuredSessions,
    options.batchTokenBudget ?? DEFAULT_BATCH_TOKEN_BUDGET,
    options.maxSessionsPerBatch ?? DEFAULT_MAX_SESSIONS_PER_BATCH,
  );
  if (options.planOnly) {
    return { kind: "plan", sessions: measuredSessions, batches };
  }

  // Seed the targets into the memfs before any batch clones are taken, so
  // every clone starts from the current on-disk (shared) state.
  let target = options.target ? resolveDreamTarget(options.target) : undefined;
  if (agentState) {
    await syncAgentTargetsIntoMemory(agentState);
    target = (await classifyAgentTargets(agentState)).fileTarget;
  } else if (target) {
    const existing = await readExistingTarget(target);
    if (existing !== null) {
      const { synced } = await syncTargetIntoMemory(
        memoryDir,
        target,
        existing,
      );
      if (synced) log(`[target] synced ${target.fileName} into memory`);
    }
  }

  await mkdir(runRoot, { recursive: true });
  const workers = await ensureDreamWorkers(options.client, {
    reflectorAgentId:
      options.reflectorAgentId ?? agentState?.config.reflectorAgentId,
    aggregatorAgentId:
      options.aggregatorAgentId ?? agentState?.config.aggregatorAgentId,
    model: options.model ?? agentState?.config.model,
    log,
  });
  // Workers belong to the identity: persist ids so every dream against this
  // agent reuses them (their history doubles as the agent's dream history).
  if (
    agentState &&
    (agentState.config.reflectorAgentId !== workers.reflectorAgentId ||
      agentState.config.aggregatorAgentId !== workers.aggregatorAgentId)
  ) {
    agentState.config.reflectorAgentId = workers.reflectorAgentId;
    agentState.config.aggregatorAgentId = workers.aggregatorAgentId;
    await saveDreamAgentConfig(agentState);
  }
  log(
    `Selected ${measuredSessions.length} session(s) in ${batches.length} batch(es)`,
  );

  const batchResults = await runBatchReflections({
    client: options.client,
    reflectorAgentId: workers.reflectorAgentId,
    memoryDir,
    runRoot,
    batches,
    normalizedJsonByKey,
    concurrency: options.concurrency ?? batches.length,
    instruction: options.instruction,
    ...(target ? { target } : {}),
    log,
  });

  const aggregation = await runDreamAggregation({
    client: options.client,
    aggregatorAgentId: workers.aggregatorAgentId,
    memoryDir,
    runRoot,
    reflections: batchResults,
    instruction: options.instruction,
    ...(target ? { target } : {}),
    log,
  });

  // Advance reflection cursors only for sessions whose batch succeeded AND
  // whose learnings actually landed — a failed batch or aggregation leaves
  // its cursors untouched so the next run re-processes.
  if (aggregation.success && lastReflectedTsByKey.size > 0) {
    const reflectedSessionIds = new Set(
      batchResults.filter((b) => b.success).flatMap((b) => b.sessionIds),
    );
    let advanced = 0;
    for (const [key, reflectedThrough] of lastReflectedTsByKey) {
      const sessionId = key.slice(key.indexOf(":") + 1);
      if (!reflectedSessionIds.has(sessionId)) continue;
      cursors[key] = { reflectedThrough };
      advanced += 1;
    }
    if (advanced > 0) {
      await saveDreamCursors(memoryDir, cursors);
      log(`[cursor] advanced ${advanced} cursor(s)`);
    }
  }

  // Export what aggregation committed back out to the targets. A failed
  // aggregation (or an absent doc) leaves the on-disk targets untouched.
  let targetOutcome: { path: string; written: boolean } | undefined;
  if (agentState) {
    if (aggregation.success) {
      for (const entry of await exportAgentTargets(agentState)) {
        log(
          `[target] ${entry.path}: ${
            typeof entry.written === "number"
              ? `${entry.written} file(s) written`
              : entry.written
                ? "updated"
                : "unchanged"
          }`,
        );
        if (typeof entry.written === "boolean") {
          targetOutcome = { path: entry.path, written: entry.written };
        }
      }
    }
  } else if (target) {
    const rendered = aggregation.success
      ? await readTargetFromMemory(memoryDir, target)
      : null;
    if (rendered !== null) {
      await writeTarget(target, rendered);
      log(`[target] wrote ${target.path}`);
    }
    targetOutcome = { path: target.path, written: rendered !== null };
  }

  return {
    kind: "completed",
    runRoot,
    success: aggregation.success,
    sessions: measuredSessions,
    batches: batchResults,
    aggregation,
    reflectorAgentId: workers.reflectorAgentId,
    aggregatorAgentId: workers.aggregatorAgentId,
    ...(targetOutcome ? { target: targetOutcome } : {}),
  };
}
