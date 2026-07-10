// Public transcript collection: discover sessions from one or more harness
// stores, select a bounded recent set from each source spec, and return
// normalized in-memory snapshots ready for dream().

import { getTrajectorySource } from "./registry.js";
import { sessionKey } from "./select.js";
import type {
  DiscoveredSession,
  NormalizedRecord,
  NormalizedSession,
} from "./types.js";
import { estimateTokens } from "./types.js";
import { validateRecords } from "./normalize-core.js";

export interface TranscriptSourceSpec {
  type: string;
  /** A source-specific file, directory, session id, or conversation locator. */
  locator?: string;
  /** Keep the latest N eligible sessions from this source spec. */
  limit?: number;
}

export interface CollectTranscriptsOptions {
  sources: TranscriptSourceSpec[];
  /**
   * Include sessions containing activity strictly after this instant. The
   * cutoff is applied to endTime; the full transcript is retained for context.
   */
  after?: Date | string;
}

/** A fully normalized transcript plus its source-session metadata. */
export type Transcript = NormalizedSession;

function timestampMs(value: string, label: string): number {
  const result = Date.parse(value);
  if (Number.isNaN(result)) {
    throw new Error(`Invalid ${label} timestamp: ${JSON.stringify(value)}`);
  }
  return result;
}

function cutoffMs(after: Date | string | undefined): number {
  if (after === undefined) return Number.NEGATIVE_INFINITY;
  const result = after instanceof Date ? after.getTime() : Date.parse(after);
  if (Number.isNaN(result)) {
    throw new Error(`Invalid transcript cutoff: ${JSON.stringify(after)}`);
  }
  return result;
}

function validateLimit(spec: TranscriptSourceSpec): void {
  if (
    spec.limit !== undefined &&
    (!Number.isInteger(spec.limit) || spec.limit <= 0)
  ) {
    throw new Error(
      `Transcript source ${JSON.stringify(spec.type)} limit must be a positive integer`,
    );
  }
}

function compareSessionsByRecency(
  a: DiscoveredSession,
  b: DiscoveredSession,
): number {
  return (
    timestampMs(a.endTime, "session endTime") -
      timestampMs(b.endTime, "session endTime") ||
    timestampMs(a.startTime, "session startTime") -
      timestampMs(b.startTime, "session startTime") ||
    a.harness.localeCompare(b.harness) ||
    a.sessionId.localeCompare(b.sessionId) ||
    a.path.localeCompare(b.path)
  );
}

function compareTranscriptsChronologically(
  a: Transcript,
  b: Transcript,
): number {
  return (
    timestampMs(a.session.startTime, "session startTime") -
      timestampMs(b.session.startTime, "session startTime") ||
    timestampMs(a.session.endTime, "session endTime") -
      timestampMs(b.session.endTime, "session endTime") ||
    a.session.harness.localeCompare(b.session.harness) ||
    a.session.sessionId.localeCompare(b.session.sessionId) ||
    a.session.path.localeCompare(b.session.path)
  );
}

function cloneRecords(records: NormalizedRecord[]): NormalizedRecord[] {
  return records.map((record) => ({
    ...record,
    ...(record.tool_calls
      ? { tool_calls: record.tool_calls.map((call) => ({ ...call })) }
      : {}),
  }));
}

function normalizedSnapshot(normalized: NormalizedSession): Transcript {
  const records = cloneRecords(normalized.records);
  const problem = validateRecords(records);
  if (problem) {
    throw new Error(
      `Invalid normalized transcript ${sessionKey(normalized.session)}: ${problem}`,
    );
  }

  const body = records.filter((record) => record.role !== "meta");
  const startTime = body[0]?.timestamp;
  const endTime = body[body.length - 1]?.timestamp;
  if (!startTime || !endTime) {
    throw new Error(
      `Invalid normalized transcript ${sessionKey(normalized.session)}: missing time bounds`,
    );
  }
  const meta = records[0]?.role === "meta" ? records[0] : undefined;
  const json = JSON.stringify(records);

  return {
    session: {
      ...normalized.session,
      startTime,
      endTime,
      estTokens: estimateTokens(json),
      recordCount: body.length,
      ...(meta?.cwd ? { cwd: meta.cwd } : {}),
    },
    records,
  };
}

function dedupeDiscovered(
  sessions: DiscoveredSession[],
): DiscoveredSession[] {
  const byKey = new Map<string, DiscoveredSession>();
  for (const session of [...sessions].sort(compareSessionsByRecency)) {
    // Later entries win, which deterministically keeps the newest snapshot
    // when a source reports the same logical session more than once.
    byKey.set(sessionKey(session), session);
  }
  return [...byKey.values()];
}

/**
 * Collect normalized transcript snapshots from local trajectory sources.
 *
 * Source specs are independent: the cutoff and each spec's limit are applied
 * before results are combined. Overlapping specs are deduplicated by stable
 * harness/session identity, and the returned list is globally chronological.
 */
export async function collectTranscripts(
  options: CollectTranscriptsOptions,
): Promise<Transcript[]> {
  const afterMs = cutoffMs(options.after);
  const collected = new Map<string, Transcript>();

  for (const spec of options.sources) {
    validateLimit(spec);
    const source = getTrajectorySource(spec.type);
    // Deliberately call the source directly. In particular, a Claude/Codex
    // locator names exactly what discover() resolves; it never expands into
    // an implicit range of later sessions.
    const discovered = await source.discover(spec.locator);
    const eligible = dedupeDiscovered(discovered)
      .filter(
        (session) =>
          timestampMs(session.endTime, "session endTime") > afterMs,
      )
      .sort(compareSessionsByRecency);
    const selected =
      spec.limit === undefined ? eligible : eligible.slice(-spec.limit);

    for (const session of selected) {
      const normalized = normalizedSnapshot(await source.normalize(session));
      const key = sessionKey(normalized.session);
      if (!collected.has(key)) collected.set(key, normalized);
    }
  }

  return [...collected.values()].sort(compareTranscriptsChronologically);
}
