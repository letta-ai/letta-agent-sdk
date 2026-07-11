// Cancellation: DreamOptions.signal aborts the run — in-flight sessions are
// closed, no new batches start, run artifacts are removed, cursors are not
// advanced, and dream() rejects with the abort reason.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import { initDreamAgent } from "../dream/agent.js";
import { dream } from "../dream/index.js";
import { runAgentToCompletion } from "../dream/runner.js";
import { createOpenHandsSource } from "../dream/sources/openhands.js";
import type { NormalizedSession } from "../dream/types.js";

const FIXTURE_CONV = join(
  import.meta.dir,
  "fixtures",
  "dream",
  "openhands",
  "conv-demo",
);

const AGENT_ID = "agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const root = mkdtempSync(join(tmpdir(), "dream-cancel-"));
const agentsDir = join(root, "agents");
const memoryDir = join(agentsDir, AGENT_ID, "memory");
const runsDir = join(agentsDir, AGENT_ID, "dream", "runs");

let transcript: NormalizedSession;

beforeAll(async () => {
  await mkdir(join(memoryDir, ".letta"), { recursive: true });
  await writeFile(join(memoryDir, ".letta/config.json"), '{"version":1}\n');
  execFileSync("git", ["-C", memoryDir, "init", "--quiet"]);
  execFileSync("git", ["-C", memoryDir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    memoryDir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "Initial commit",
  ]);
  await initDreamAgent({ createAgent: async () => AGENT_ID } as unknown as LettaAgentClient, {
    name: "cancel-demo",
    model: "anthropic/claude-opus-4-8",
    agentsDir,
    guard: { allowedNewFilePrefixes: ["skills"] },
  });
  const source = createOpenHandsSource();
  const [session] = await source.discover(FIXTURE_CONV);
  if (!session) throw new Error("fixture conversation missing");
  transcript = await source.normalize(session);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Fake client whose sessions stream forever until close() is called —
 * modeling an in-flight agent turn that only an abort can end.
 */
function hangingClient() {
  const closed: string[] = [];
  let counter = 0;
  let signalStreamStarted: (() => void) | null = null;
  const firstStreamStarted = new Promise<void>((resolve) => {
    signalStreamStarted = resolve;
  });
  const makeSession = () => {
    let release: (() => void) | null = null;
    const conversationId = `conv-${++counter}`;
    return {
      conversationId,
      send: async () => {},
      stream: async function* () {
        signalStreamStarted?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        // Stream ends after close() without emitting a result message.
      },
      close: () => {
        closed.push(conversationId);
        release?.();
      },
    };
  };
  const client = {
    createAgent: async () => AGENT_ID,
    createSession: () => makeSession(),
    resumeSession: () => makeSession(),
  } as unknown as LettaAgentClient;
  return { client, closed, firstStreamStarted };
}

describe("runAgentToCompletion + signal", () => {
  test("already-aborted signal returns a failed result without starting", async () => {
    const { client, closed } = hangingClient();
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentToCompletion(client, {
      agentId: AGENT_ID,
      userPrompt: "p",
      cwd: root,
      label: "t",
      signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
    expect(closed).toHaveLength(0);
  });

  test("abort mid-turn closes the session and reports failure", async () => {
    const { client, closed, firstStreamStarted } = hangingClient();
    const controller = new AbortController();
    const pending = runAgentToCompletion(client, {
      agentId: AGENT_ID,
      userPrompt: "p",
      cwd: root,
      label: "t",
      signal: controller.signal,
    });
    await firstStreamStarted;
    controller.abort();
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
    expect(closed.length).toBeGreaterThan(0);
  });
});

describe("dream() + signal", () => {
  test("pre-aborted signal rejects before any work", async () => {
    const { client } = hangingClient();
    const controller = new AbortController();
    controller.abort();
    expect(
      dream({
        client,
        agentId: AGENT_ID,
        agentsDir,
        transcripts: [transcript],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  test("abort during reflection rejects, closes sessions, and removes run artifacts", async () => {
    const { client, closed, firstStreamStarted } = hangingClient();
    const controller = new AbortController();
    const pending = dream({
      client,
      agentId: AGENT_ID,
      agentsDir,
      transcripts: [transcript],
      signal: controller.signal,
    });
    // Deterministic: abort only once a reflection session is provably in flight.
    await firstStreamStarted;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(closed.length).toBeGreaterThan(0);
    // Batch clones live under runRoot; abort must remove the whole run dir.
    const leftovers = await readdir(runsDir).catch(() => []);
    expect(leftovers).toHaveLength(0);
  });
});
