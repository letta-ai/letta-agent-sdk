// Dream agent identity: initialization (memory repo + agent.json + target
// seeding for AGENTS.md and skills/), loading, and an agent-tied dream()
// exercised via planOnly.

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

const root = mkdtempSync(join(tmpdir(), "dream-agent-"));
const repoDir = join(root, "repo");
const agentRoot = join(root, "agent");
const agentsMd = join(repoDir, "AGENTS.md");
const skillsDir = join(repoDir, "skills");

beforeAll(async () => {
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
  test("creates the identity and seeds both targets into memory", async () => {
    const agent = await initDreamAgent({
      rootDir: agentRoot,
      name: "demo",
      model: "anthropic/claude-opus-4-6",
      targets: [agentsMd, skillsDir],
    });
    expect(agent.config.targets.length).toBe(2);

    const show = (path: string) =>
      execFileSync("git", ["-C", agent.memoryDir, "show", `HEAD:${path}`], {
        encoding: "utf-8",
      });
    expect(show("system/AGENTS.md")).toContain("- test: bun test");
    expect(show("skills/deploy.md")).toContain("Run the deploy pipeline.");
    // The doc gets managed frontmatter; skills files keep their own.
    expect(show("system/AGENTS.md").startsWith("---\ndescription:")).toBe(true);
    expect(show("skills/deploy.md").startsWith("---\nname: deploy")).toBe(true);
  });

  test("refuses to re-initialize an existing identity", async () => {
    expect(initDreamAgent({ rootDir: agentRoot })).rejects.toThrow(
      /already exists/,
    );
  });

  test("classifies AGENTS.md as the file target and skills/ as a dir tier", async () => {
    const agent = await loadDreamAgent(agentRoot);
    const { fileTarget, dirTargets } = await classifyAgentTargets(agent);
    expect(fileTarget?.kind).toBe("agents-md");
    expect(dirTargets).toEqual([{ path: skillsDir, memfsSubdir: "skills" }]);
  });
});

describe("agent-tied dream", () => {
  test("planOnly resolves memory + sources through the agent", async () => {
    const result = await dream({
      client: {} as LettaAgentClient, // planOnly never touches the client
      agent: agentRoot,
      sources: [{ type: "openhands", locator: FIXTURE_CONV }],
      planOnly: true,
    });
    expect(result.kind).toBe("plan");
  });

  test("rejects agent combined with explicit memoryDir/target", async () => {
    expect(
      dream({
        client: {} as LettaAgentClient,
        agent: agentRoot,
        memoryDir: "/tmp/x",
        sources: [],
        planOnly: true,
      }),
    ).rejects.toThrow(/omit them/);
  });
});

describe("exportAgentTargets", () => {
  test("writes memory-side changes back out to the targets", async () => {
    const agent = await loadDreamAgent(agentRoot);
    // Simulate a dream landing a new skill and revising the doc.
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
    // The unchanged pre-existing skill is untouched, not deleted.
    expect(
      await readFile(join(skillsDir, "deploy.md"), "utf-8"),
    ).toContain("Run the deploy pipeline.");
  });
});
