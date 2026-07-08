// Dream render targets: resolution, managed frontmatter, and the memfs
// sync-in / export-out round trip against a real temporary git repo.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addManagedFrontmatter,
  readExistingTarget,
  readTargetFromMemory,
  resolveDreamTarget,
  stripFrontmatter,
  syncTargetIntoMemory,
  targetMemfsRelPath,
  writeTarget,
} from "../dream/targets.js";

describe("resolveDreamTarget", () => {
  test("classifies AGENTS.md (any case, agent/agents) as agents-md", () => {
    expect(resolveDreamTarget("./AGENTS.md").kind).toBe("agents-md");
    expect(resolveDreamTarget("/repo/agents.md").kind).toBe("agents-md");
    expect(resolveDreamTarget("Agent.md").kind).toBe("agents-md");
  });

  test("any other path is a generic target maintained under system/", () => {
    const target = resolveDreamTarget("docs/onboarding.md");
    expect(target.kind).toBe("generic");
    expect(target.fileName).toBe("onboarding.md");
    expect(targetMemfsRelPath(target)).toBe("system/onboarding.md");
  });
});

describe("managed frontmatter", () => {
  test("adds a description block to plain markdown", () => {
    const managed = addManagedFrontmatter("# Repo\n- build: bun run build\n", "agents-md");
    expect(managed.startsWith("---\ndescription:")).toBe(true);
    expect(stripFrontmatter(managed)).toBe("# Repo\n- build: bun run build\n");
  });

  test("preserves an existing description and is idempotent", () => {
    const existing = "---\ndescription: hand written\n---\n# Body\n";
    expect(addManagedFrontmatter(existing, "generic")).toBe(existing);
    const managed = addManagedFrontmatter("# Body\n", "generic");
    expect(addManagedFrontmatter(managed, "generic")).toBe(managed);
  });

  test("stripFrontmatter leaves plain markdown alone", () => {
    expect(stripFrontmatter("# No header\n")).toBe("# No header\n");
  });
});

describe("memfs sync round trip", () => {
  const root = mkdtempSync(join(tmpdir(), "dream-target-"));
  const memoryDir = join(root, "memory");
  const docPath = join(root, "repo", "AGENTS.md");
  const target = resolveDreamTarget(docPath);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", memoryDir, ...args], { stdio: "pipe" });

  beforeAll(async () => {
    await mkdir(memoryDir, { recursive: true });
    git(["init", "--quiet"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
    await mkdir(join(root, "repo"), { recursive: true });
    await writeFile(docPath, "# Guide\n- test: bun test\n", "utf-8");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("seeds the doc into system/ with frontmatter and commits it", async () => {
    const existing = await readExistingTarget(target);
    expect(existing).not.toBeNull();
    const { synced } = await syncTargetIntoMemory(memoryDir, target, existing as string);
    expect(synced).toBe(true);
    const committed = execFileSync(
      "git",
      ["-C", memoryDir, "show", "HEAD:system/AGENTS.md"],
      { encoding: "utf-8" },
    );
    expect(committed.startsWith("---\ndescription:")).toBe(true);
    expect(committed).toContain("- test: bun test");
  });

  test("re-sync with an unchanged body is a no-op", async () => {
    const { synced } = await syncTargetIntoMemory(
      memoryDir,
      target,
      "# Guide\n- test: bun test\n",
    );
    expect(synced).toBe(false);
  });

  test("on-disk edits re-sync (repo is the source of truth)", async () => {
    const { synced } = await syncTargetIntoMemory(
      memoryDir,
      target,
      "# Guide\n- test: bun test\n- lint: bun run check\n",
    );
    expect(synced).toBe(true);
  });

  test("readTargetFromMemory strips frontmatter; writeTarget exports it", async () => {
    const rendered = await readTargetFromMemory(memoryDir, target);
    if (rendered === null) throw new Error("expected a rendered doc");
    expect(rendered).toContain("- lint: bun run check");
    expect(rendered.startsWith("---")).toBe(false);
    await writeTarget(target, rendered);
    expect(await readFile(docPath, "utf-8")).toBe(rendered);
  });

  test("an absent doc reads as null (no placeholder export)", async () => {
    const missing = resolveDreamTarget(join(root, "repo", "OTHER.md"));
    expect(await readTargetFromMemory(memoryDir, missing)).toBeNull();
  });
});
