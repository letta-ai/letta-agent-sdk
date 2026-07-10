// Dream-agent initialization from an explicit MemFS structure, plus the
// transcript-list dream API tied to that agent id.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import {
  initDreamAgent,
  loadDreamAgent,
  prepareDreamAgentMemfs,
} from "../dream/agent.js";
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

const AGENT_ID = "agent-11111111-2222-4333-8444-555555555555";
const root = mkdtempSync(join(tmpdir(), "dream-agent-"));
const agentsDir = join(root, "agents");
const memoryDir = join(agentsDir, AGENT_ID, "memory");

const fakeClient = {
  createAgent: async () => AGENT_ID,
} as unknown as LettaAgentClient;

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

  await initDreamAgent(fakeClient, {
    name: "demo",
    model: "anthropic/claude-opus-4-8",
    agentsDir,
    memfs: {
      directories: ["skills"],
      files: {
        "system/letta-code/AGENTS.md": "# Guide\n- test: bun test\n",
      },
    },
    guard: { allowedNewFilePrefixes: ["skills"] },
  });

  const source = createOpenHandsSource();
  const [session] = await source.discover(FIXTURE_CONV);
  if (!session) throw new Error("expected fixture conversation");
  transcript = await source.normalize(session);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("initDreamAgent", () => {
  test("seeds files, preserves empty directories, and stores the guard", async () => {
    const agent = await loadDreamAgent(AGENT_ID, { agentsDir });
    expect(agent.agentId).toBe(AGENT_ID);
    expect(agent.memoryDir).toBe(memoryDir);
    expect(
      await readFile(join(memoryDir, "system/letta-code/AGENTS.md"), "utf-8"),
    ).toContain("- test: bun test");
    expect((await lstat(join(memoryDir, "skills"))).isDirectory()).toBe(true);
    expect(agent.config.memfs.policy.existingPaths).toEqual([
      "system/letta-code/AGENTS.md",
    ]);
    expect(agent.config.memfs.policy.allowedNewFilePrefixes).toEqual([
      "skills",
    ]);
    expect(
      execFileSync(
        "git",
        [
          "-C",
          memoryDir,
          "ls-files",
          "--error-unmatch",
          "--",
          "system/letta-code/AGENTS.md",
        ],
        { encoding: "utf-8" },
      ).trim(),
    ).toBe("system/letta-code/AGENTS.md");
    expect(
      execFileSync("git", ["-C", memoryDir, "status", "--porcelain"], {
        encoding: "utf-8",
      }).trim(),
    ).toBe("");
    expect(
      execFileSync("git", ["-C", memoryDir, "config", "--get", "core.hooksPath"], {
        encoding: "utf-8",
      }).trim(),
    ).toContain("dream-hooks");
  });

  test("installed guard rejects new top-level files", async () => {
    await writeFile(join(memoryDir, "outside.md"), "not allowed\n");
    execFileSync("git", ["-C", memoryDir, "add", "outside.md"]);
    expect(() =>
      execFileSync("git", [
        "-C",
        memoryDir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-m",
        "bad",
      ], { stdio: "pipe" }),
    ).toThrow();
    execFileSync("git", ["-C", memoryDir, "restore", "--staged", "outside.md"]);
    await rm(join(memoryDir, "outside.md"));
  });

  test("refuses to re-initialize an existing identity", async () => {
    expect(
      initDreamAgent(fakeClient, { agentId: AGENT_ID, agentsDir }),
    ).rejects.toThrow(/already an initialized dream agent/);
  });

  test("requires a memfs checkout to exist", async () => {
    const bare = {
      createAgent: async () => "agent-no-memfs",
    } as unknown as LettaAgentClient;
    expect(initDreamAgent(bare, { agentsDir })).rejects.toThrow(
      /memfs-enabled/,
    );
  });

  test("refuses to use a checkout whose seed was replaced after initialization", async () => {
    const racedAgentId = "agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const racedMemoryDir = join(agentsDir, racedAgentId, "memory");
    await mkdir(join(racedMemoryDir, ".letta"), { recursive: true });
    await writeFile(join(racedMemoryDir, ".letta/config.json"), '{"version":1}\n');
    execFileSync("git", ["-C", racedMemoryDir, "init", "--quiet"]);
    execFileSync("git", ["-C", racedMemoryDir, "add", "-A"]);
    execFileSync("git", [
      "-C",
      racedMemoryDir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-m",
      "Initial commit",
    ]);

    const racedClient = {
      createAgent: async () => racedAgentId,
    } as unknown as LettaAgentClient;
    const agent = await initDreamAgent(racedClient, {
      agentsDir,
      memfs: {
        files: {
          "system/letta-code/AGENTS.md": "# Guide\n",
        },
      },
      guard: { allowedNewFilePrefixes: ["skills"] },
    });
    execFileSync("git", [
      "-C",
      racedMemoryDir,
      "rm",
      "--cached",
      "--",
      "system/letta-code/AGENTS.md",
    ]);

    expect(prepareDreamAgentMemfs(agent)).rejects.toThrow(
      /seeded path\(s\) are not tracked/,
    );
  });
});

describe("explicit-transcript dream API", () => {
  test("plans from supplied transcript snapshots and agent id", async () => {
    const result = await dream({
      client: fakeClient,
      agentId: AGENT_ID,
      agentsDir,
      transcripts: [transcript],
      planOnly: true,
    });
    expect(result.kind).toBe("plan");
    if (result.kind === "plan") expect(result.transcripts).toHaveLength(1);
  });

  test("rejects duplicate transcript identities", async () => {
    expect(
      dream({
        client: fakeClient,
        agentId: AGENT_ID,
        agentsDir,
        transcripts: [transcript, transcript],
        planOnly: true,
      }),
    ).rejects.toThrow(/duplicate transcript/);
  });

  test("returns nothing_to_dream for an empty transcript list", async () => {
    expect(
      await dream({
        client: fakeClient,
        agentId: AGENT_ID,
        agentsDir,
        transcripts: [],
        planOnly: true,
      }),
    ).toEqual({ kind: "nothing_to_dream" });
  });
});
