// Reflection cursors for long-lived sources — the port of letta-code's
// openhands incremental ingestion. An OpenHands conversation is an
// append-only event stream a dream may run against many times as it grows;
// after a successful aggregation the conversation's last-reflected record
// timestamp is recorded, and later runs drop everything at or before it — no
// new experience → nothing to reflect (which also keeps target docs like
// AGENTS.md churn-free). Claude/Codex sessions are finite files selected per
// run and stay cursor-free: re-processing what a spec selects is deliberate.
//
// The cursor file is committed to the memory repo itself: state describing
// what the memory has already absorbed belongs with the memory and travels
// with it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitOutput } from "./clone.js";

const CURSORS_REL_PATH = ".dream/cursors.json";

/** sessionKey ("openhands:<conversation-id>") → last reflected timestamp. */
export type DreamCursors = Record<string, { reflectedThrough: string }>;

export async function loadDreamCursors(
  memoryDir: string,
): Promise<DreamCursors> {
  try {
    const raw = await readFile(join(memoryDir, CURSORS_REL_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as DreamCursors)
      : {};
  } catch {
    return {};
  }
}

export async function saveDreamCursors(
  memoryDir: string,
  cursors: DreamCursors,
): Promise<void> {
  const absPath = join(memoryDir, CURSORS_REL_PATH);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, `${JSON.stringify(cursors, null, 2)}\n`, "utf-8");
  try {
    await gitOutput(memoryDir, ["add", CURSORS_REL_PATH]);
    await gitOutput(memoryDir, [
      "-c",
      "user.name=Dream",
      "-c",
      "user.email=dream@letta.com",
      "commit",
      "-m",
      "dream: advance reflection cursors",
      "--",
      CURSORS_REL_PATH,
    ]);
  } catch {
    // Unchanged content or a non-repo target: the file on disk is still the
    // source of truth for the next load.
  }
}
