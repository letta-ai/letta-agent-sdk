// Session selection for a dream run: parse source specs, discover sessions
// per trajectory source, apply cursor semantics, and dedupe across sources.
// Every run re-processes whatever its specs select; use cursors to narrow.
//
// Spec forms:
//   { type: "claude" }                      → all sessions in the default store
//   { type: "claude", locator: "<session>" } → CURSOR: that session and every
//                                             later-starting session, store-wide
//                                             (harnesses with a default store)
//   { type: "openhands", locator: "<path>" } → exactly what the locator names
//   { type: "letta", locator: "<agent>/<conv>" } → one recorded conversation
//   { type: "transcript", locator: "<path>" }    → normalized-v1 file or dir

import { getTrajectorySource } from "./registry.js";
import type { DiscoveredSession } from "./types.js";

/**
 * Harnesses whose sources can discover a whole local store with no locator.
 * For these, a locator resolving to a single session acts as a time cursor
 * ("this session onwards, store-wide") rather than selecting only itself.
 */
const CURSOR_CAPABLE_TYPES = new Set(["claude", "codex"]);

export interface DreamSourceSpec {
  type: string;
  locator?: string;
}

/** A stable identity for a discovered session across sources. */
export function sessionKey(session: DiscoveredSession): string {
  return `${session.harness}:${session.sessionId}`;
}

/** Filesystem-safe file name for one normalized session. */
export function sessionFileName(session: DiscoveredSession): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${safe(session.harness)}-${safe(session.sessionId)}.json`;
}

async function discoverForSpec(
  spec: DreamSourceSpec,
): Promise<DiscoveredSession[]> {
  const source = getTrajectorySource(spec.type);
  if (!spec.locator) {
    return source.discover();
  }
  const located = await source.discover(spec.locator);
  const cursor = located.length === 1 ? located[0] : undefined;
  if (cursor && CURSOR_CAPABLE_TYPES.has(spec.type)) {
    const all = await source.discover();
    const onward = all.filter(
      (session) => session.startTime.localeCompare(cursor.startTime) >= 0,
    );
    // The named session itself must be included even if the store scan
    // somehow misses it (e.g. it was moved); dedupe below handles overlap.
    return [cursor, ...onward];
  }
  return located;
}

/** Discover, dedupe, and time-order the sessions the specs select. */
export async function selectDreamSessions(
  specs: DreamSourceSpec[],
): Promise<DiscoveredSession[]> {
  const byKey = new Map<string, DiscoveredSession>();
  for (const spec of specs) {
    for (const session of await discoverForSpec(spec)) {
      const key = sessionKey(session);
      if (!byKey.has(key)) {
        byKey.set(key, session);
      }
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );
}
