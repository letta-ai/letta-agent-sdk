// Dream agent identity: the identity IS a memfs-enabled Letta agent. Tests
// use a fake client (fixed agent id) and a temp harness agents dir with a
// pre-created memory checkout — initialization binds targets and seeds them
// into the agent's memory; dream({ agent }) resolves everything from the id.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import {
  classifyAgentTargets,
  exportAgentTargets,
  initDreamAgent,
  loadDreamAgent,
} from "../dream/agent.js";
import { dream } from "../dream/index.js";

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
const repoDir = join(root, "repo");
const agentsMd = join(repoDir, "AGENTS.md");
const skillsDir = join(repoDir, "skills");

const fakeClient = {
  createAgent: async () => AGENT_ID,
} as unknown as LettaAgentClient;

beforeAll(async () => {
  // The harness materializes the memfs checkout when a memfs-enabled agent
  // is created; simulate that.
  await mkdir(memoryDir, { recursive: true });
  execFileSync("git", ["-C", memoryDir, "init", "--quiet"]);
  execFileSync("git", [
    "-C", memoryDir, "-c", "user.name=t", "-c", "user.email=t@t",
    "commit", "--allow-empty", "-m", "Initial commit",
  ]);
  await mkdir(skillsDir, { recursive: true });
  await writeFile(agentsMd, "# Guide\n- test: bun test\n", "utf-8");
  await writeFile(
    join(skillsDir, "deploy.md"),
    "---\nname: deploy\n---\nRun the deploy pipeline.\n",
    "utf-8",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("initDreamAgent", () => {
  test("creates the identity from the agent id and seeds both targets", async () => {
    const agent = await initDreamAgent(fakeClient, {
      name: "demo",
      model: "anthropic/claude-opus-4-7",
      targets: [agentsMd, skillsDir],
      agentsDir,
    });
    expect(agent.agentId).toBe(AGENT_ID);
    expect(agent.memoryDir).toBe(memoryDir);
    expect(agent.config.targets.length).toBe(2);

    const show = (path: string) =>
      execFileSync("git", ["-C", memoryDir, "show", `HEAD:${path}`], {
        encoding: "utf-8",
      });
    expect(show("system/AGENTS.md")).toContain("- test: bun test");
    expect(show("skills/deploy.md")).toContain("Run the deploy pipeline.");
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

  test("classifies AGENTS.md as the file target and skills/ as a dir tier", async () => {
    const agent = await loadDreamAgent(AGENT_ID, { agentsDir });
    const { fileTarget, dirTargets } = await classifyAgentTargets(agent);
    expect(fileTarget?.kind).toBe("agents-md");
    expect(dirTargets).toEqual([{ path: skillsDir, memfsSubdir: "skills" }]);
  });
});

describe("agent-tied dream", () => {
  test("planOnly resolves memory + sources through the agent id", async () => {
    const result = await dream({
      client: fakeClient, // planOnly never runs sessions
      agent: AGENT_ID,
      agentsDir,
      sources: [{ type: "openhands", locator: FIXTURE_CONV }],
      planOnly: true,
    });
    expect(result.kind).toBe("plan");
  });

  test("rejects agent combined with explicit memoryDir/target", async () => {
    expect(
      dream({
        client: fakeClient,
        agent: AGENT_ID,
        agentsDir,
        memoryDir: "/tmp/x",
        sources: [],
        planOnly: true,
      }),
    ).rejects.toThrow(/omit them/);
  });
});

describe("exportAgentTargets", () => {
  test("writes memory-side changes back out to the targets", async () => {
    const agent = await loadDreamAgent(AGENT_ID, { agentsDir });
    // Simulate an aggregation landing a new skill in the agent's memory.
    await mkdir(join(agent.memoryDir, "skills"), { recursive: true });
    await writeFile(
      join(agent.memoryDir, "skills", "release.md"),
      "---\nname: release\n---\nTag and publish.\n",
      "utf-8",
    );
    execFileSync("git", ["-C", agent.memoryDir, "add", "-A"]);
    execFileSync("git", [
      "-C", agent.memoryDir, "-c", "user.name=t", "-c", "user.email=t@t",
      "commit", "-m", "test: land skill",
    ]);

    const results = await exportAgentTargets(agent);
    expect(results.length).toBe(2);
    const exported = await readFile(join(skillsDir, "release.md"), "utf-8");
    expect(exported).toContain("Tag and publish.");
    expect(
      await readFile(join(skillsDir, "deploy.md"), "utf-8"),
    ).toContain("Run the deploy pipeline.");
  });
});
