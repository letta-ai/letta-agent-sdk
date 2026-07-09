// Reflection cursors for long-lived sources — the port of letta-code's
// openhands incremental ingestion. An OpenHands conversation is an
// append-only event stream a dream may run against many times as it grows;
// after a successful aggregation the conversation's last-reflected record
// timestamp is recorded, and later runs drop everything at or before it — no
// new experience → nothing to reflect (which also keeps target docs like
// AGENTS.md churn-free). Claude/Codex sessions are finite files selected per
// run and stay cursor-free: re-processing what a spec selects is deliberate.
//
// The cursor file is SDK run state, not agent memory, so it lives in the
// dream-agent state directory and never competes with MemFS write guards.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CURSORS_REL_PATH = "cursors.json";

/** sessionKey ("openhands:<conversation-id>") → last reflected timestamp. */
export type DreamCursors = Record<string, { reflectedThrough: string }>;

export async function loadDreamCursors(
  stateDir: string,
): Promise<DreamCursors> {
  try {
    const raw = await readFile(join(stateDir, CURSORS_REL_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as DreamCursors)
      : {};
  } catch {
    return {};
  }
}

export async function saveDreamCursors(
  stateDir: string,
  cursors: DreamCursors,
): Promise<void> {
  const absPath = join(stateDir, CURSORS_REL_PATH);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, `${JSON.stringify(cursors, null, 2)}\n`, "utf-8");
}
