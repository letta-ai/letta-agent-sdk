// OpenHands reflection cursors: persistence in the memory repo, and
// dream()'s cursor-gated selection (trim to new records; drop up-to-date
// conversations) exercised via planOnly against the openhands fixture store.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import { loadDreamCursors, saveDreamCursors } from "../dream/cursors.js";
import { dream } from "../dream/index.js";
import { createOpenHandsSource } from "../dream/sources/openhands.js";

const FIXTURE_CONV = join(
  import.meta.dir,
  "fixtures",
  "dream",
  "openhands",
  "conv-demo",
);

const root = mkdtempSync(join(tmpdir(), "dream-cursors-"));
const memoryDir = join(root, "memory");
const runRoot = join(root, "run");
const client = {} as LettaAgentClient; // planOnly never touches the client

let sessionKey: string;
let timestamps: string[] = [];

beforeAll(async () => {
  await mkdir(memoryDir, { recursive: true });
  execFileSync("git", ["-C", memoryDir, "init", "--quiet"]);
  execFileSync("git", [
    "-C", memoryDir, "-c", "user.name=t", "-c", "user.email=t@t",
    "commit", "--allow-empty", "-m", "init",
  ]);

  const source = createOpenHandsSource();
  const [session] = await source.discover(FIXTURE_CONV);
  if (!session) throw new Error("expected fixture conversation");
  sessionKey = `openhands:${session.sessionId}`;
  const { records } = await source.normalize(session);
  timestamps = records
    .filter((r) => r.role !== "meta" && r.timestamp)
    .map((r) => r.timestamp as string);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function plan() {
  return dream({
    client,
    sources: [{ type: "openhands", locator: FIXTURE_CONV }],
    memoryDir,
    runRoot,
    planOnly: true,
  });
}

describe("cursor persistence", () => {
  test("save commits to the memory repo and load round-trips", async () => {
    await saveDreamCursors(memoryDir, {
      "openhands:x": { reflectedThrough: "2026-01-01T00:00:00Z" },
    });
    expect(await loadDreamCursors(memoryDir)).toEqual({
      "openhands:x": { reflectedThrough: "2026-01-01T00:00:00Z" },
    });
    const log = execFileSync("git", ["-C", memoryDir, "log", "--oneline"], {
      encoding: "utf-8",
    });
    expect(log).toContain("dream: advance reflection cursors");
    // Clean up for the selection tests below.
    await saveDreamCursors(memoryDir, {});
  });
});

describe("cursor-gated selection", () => {
  test("no cursor: the whole conversation is selected", async () => {
    const result = await plan();
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.sessions.length).toBe(1);
  });

  test("mid-stream cursor: only newer records are staged (smaller batch)", async () => {
    const full = await plan();
    if (full.kind !== "plan") throw new Error("expected plan");
    const fullTokens = full.sessions[0]?.estTokens ?? 0;

    const middle = timestamps[Math.floor(timestamps.length / 2)];
    if (!middle) throw new Error("expected timestamps");
    await saveDreamCursors(memoryDir, {
      [sessionKey]: { reflectedThrough: middle },
    });
    const trimmed = await plan();
    expect(trimmed.kind).toBe("plan");
    if (trimmed.kind !== "plan") return;
    expect(trimmed.sessions.length).toBe(1);
    expect(trimmed.sessions[0]?.estTokens ?? 0).toBeLessThan(fullTokens);
  });

  test("cursor at the end: nothing to dream", async () => {
    const last = timestamps[timestamps.length - 1];
    if (!last) throw new Error("expected timestamps");
    await saveDreamCursors(memoryDir, {
      [sessionKey]: { reflectedThrough: last },
    });
    expect((await plan()).kind).toBe("nothing_to_dream");
  });
});
