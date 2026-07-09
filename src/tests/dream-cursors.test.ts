// OpenHands cursor persistence and transcript trimming through dream(planOnly).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import { initDreamAgent } from "../dream/agent.js";
import { loadDreamCursors, saveDreamCursors } from "../dream/cursors.js";
import { dream } from "../dream/index.js";
import { createOpenHandsSource } from "../dream/sources/openhands.js";
import type { NormalizedSession } from "../dream/types.js";

const FIXTURE_CONV = join(
  import.meta.dir,
  "fixtures",
  "dream",
  "openhands",
  "conv-demo",
);
const AGENT_ID = "agent-cursor-test";
const root = mkdtempSync(join(tmpdir(), "dream-cursors-"));
const agentsDir = join(root, "agents");
const memoryDir = join(agentsDir, AGENT_ID, "memory");
const stateDir = join(agentsDir, AGENT_ID, "dream");
const client = {
  createAgent: async () => AGENT_ID,
} as unknown as LettaAgentClient;

let sessionKey: string;
let timestamps: string[] = [];
let transcript: NormalizedSession;

beforeAll(async () => {
  await mkdir(join(memoryDir, ".letta"), { recursive: true });
  await writeFile(join(memoryDir, ".letta/config.json"), '{"version":1}\n');
  execFileSync("git", ["-C", memoryDir, "init", "--quiet"]);
  execFileSync("git", ["-C", memoryDir, "add", "-A"]);
  execFileSync("git", [
    "-C", memoryDir, "-c", "user.name=t", "-c", "user.email=t@t",
    "commit", "-m", "init",
  ]);
  await initDreamAgent(client, { agentsDir, memfs: {} });

  const source = createOpenHandsSource();
  const [session] = await source.discover(FIXTURE_CONV);
  if (!session) throw new Error("expected fixture conversation");
  sessionKey = `openhands:${session.sessionId}`;
  transcript = await source.normalize(session);
  timestamps = transcript.records
    .filter((record) => record.role !== "meta" && record.timestamp)
    .map((record) => record.timestamp as string);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function plan() {
  return dream({
    client,
    agentId: AGENT_ID,
    agentsDir,
    transcripts: [transcript],
    planOnly: true,
  });
}

describe("cursor persistence", () => {
  test("save and load round-trip in SDK state", async () => {
    await saveDreamCursors(stateDir, {
      "openhands:x": { reflectedThrough: "2026-01-01T00:00:00Z" },
    });
    expect(await loadDreamCursors(stateDir)).toEqual({
      "openhands:x": { reflectedThrough: "2026-01-01T00:00:00Z" },
    });
    await saveDreamCursors(stateDir, {});
  });
});

describe("cursor-gated planning", () => {
  test("no cursor selects the whole conversation", async () => {
    const result = await plan();
    expect(result.kind).toBe("plan");
    if (result.kind === "plan") expect(result.transcripts).toHaveLength(1);
  });

  test("mid-stream cursor stages only newer records", async () => {
    const full = await plan();
    if (full.kind !== "plan") throw new Error("expected plan");
    const fullTokens = full.transcripts[0]?.estTokens ?? 0;
    const middle = timestamps[Math.floor(timestamps.length / 2)];
    if (!middle) throw new Error("expected timestamps");
    await saveDreamCursors(stateDir, {
      [sessionKey]: { reflectedThrough: middle },
    });
    const trimmed = await plan();
    expect(trimmed.kind).toBe("plan");
    if (trimmed.kind !== "plan") return;
    expect(trimmed.transcripts).toHaveLength(1);
    expect(trimmed.transcripts[0]?.estTokens ?? 0).toBeLessThan(fullTokens);
  });

  test("cursor at the end leaves nothing to dream", async () => {
    const last = timestamps[timestamps.length - 1];
    if (!last) throw new Error("expected timestamps");
    await saveDreamCursors(stateDir, {
      [sessionKey]: { reflectedThrough: last },
    });
    expect((await plan()).kind).toBe("nothing_to_dream");
  });
});
