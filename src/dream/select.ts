// Stable transcript identity and artifact naming shared by collection and
// dream execution.

import type { DiscoveredSession } from "./types.js";

/** A stable identity for a discovered session across sources. */
export function sessionKey(session: DiscoveredSession): string {
  return `${session.harness}:${session.sessionId}`;
}

/** Filesystem-safe file name for one normalized session. */
export function sessionFileName(session: DiscoveredSession): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${safe(session.harness)}-${safe(session.sessionId)}.json`;
}
