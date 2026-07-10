import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureMemfsCloneGuard,
  createMemfsWritePolicy,
  installMemfsGuard,
  materializeMemfsStructure,
  recreateMemfsDirectories,
  validateMemfsChanges,
  validateMemfsStructure,
} from "../dream/memfs.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[], options: { fail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.fail) {
      return error instanceof Error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? error.message)
        : String(error);
    }
    throw error;
  }
}

async function initRepo(root = tempDir("dream-memfs")): Promise<string> {
  const memoryDir = join(root, "memory");
  await mkdir(join(memoryDir, ".letta"), { recursive: true });
  await writeFile(join(memoryDir, ".letta", "config.json"), '{"version":1}\n');
  git(memoryDir, ["init", "--quiet"]);
  git(memoryDir, ["add", "-A"]);
  git(memoryDir, ["commit", "-m", "initial"]);
  return memoryDir;
}

const structure = {
  files: {
    "system/letta-code/AGENTS.md":
      "---\ndescription: Letta Code project guidance\n---\n# Letta Code\n",
  },
  directories: ["skills/"],
} as const;

const strictPolicy = createMemfsWritePolicy(structure, {
  allowedNewFilePrefixes: ["skills/"],
  allowedOperations: [
    {
      path: "system/letta-code/AGENTS.md",
      operations: ["modify"],
    },
  ],
});

async function seedRepo(memoryDir: string): Promise<void> {
  await materializeMemfsStructure(memoryDir, structure);
  git(memoryDir, ["add", "-A"]);
  git(memoryDir, ["commit", "-m", "seed memory"]);
}

async function installNativeMarkerHooks(memoryDir: string): Promise<void> {
  const hooksDir = join(memoryDir, ".git", "hooks");
  const pre = join(hooksDir, "pre-commit");
  const post = join(hooksDir, "post-commit");
  await writeFile(
    pre,
    "#!/bin/sh\ntouch \"$(git rev-parse --git-dir)/native-pre-ran\"\n",
  );
  await writeFile(
    post,
    "#!/bin/sh\ntouch \"$(git rev-parse --git-dir)/native-post-ran\"\n",
  );
  await chmod(pre, 0o755);
  await chmod(post, 0o755);
}

describe("MemFS structure", () => {
  test("validates and materializes nested files plus a truly empty directory", async () => {
    const root = tempDir("dream-memfs-structure");
    const validated = validateMemfsStructure(structure);
    expect(validated.files.map((file) => file.path)).toEqual([
      "system/letta-code/AGENTS.md",
    ]);
    expect(validated.directories).toEqual(["skills"]);

    await materializeMemfsStructure(root, structure);
    expect(await readFile(join(root, "system/letta-code/AGENTS.md"), "utf-8"))
      .toContain("# Letta Code");
    expect((await lstat(join(root, "skills"))).isDirectory()).toBe(true);
    expect(await readFile(join(root, "skills/.gitkeep"), "utf-8").catch(() => null))
      .toBeNull();
  });

  test("rejects traversal, reserved internals, absolute paths, and file conflicts", () => {
    for (const path of [
      "../escape.md",
      "system/../escape.md",
      "/tmp/escape.md",
      ".git/config",
      "system/.git/config",
      ".letta/config.json",
      "system\\windows.md",
    ]) {
      expect(() => validateMemfsStructure({ files: { [path]: "x" } })).toThrow();
    }
    expect(() =>
      validateMemfsStructure({
        files: { system: "x", "system/letta-code/AGENTS.md": "y" },
      }),
    ).toThrow(/conflicts/);
  });

  test("refuses to materialize through a symlink", async () => {
    const root = tempDir("dream-memfs-symlink");
    const outside = tempDir("dream-memfs-outside");
    await symlink(outside, join(root, "system"));
    expect(materializeMemfsStructure(root, structure)).rejects.toThrow(/symlink/);
  });

  test("recreates declared empty directories after they disappear", async () => {
    const root = tempDir("dream-memfs-empty-dir");
    await recreateMemfsDirectories(root, ["skills", "skills/nested"]);
    expect((await lstat(join(root, "skills/nested"))).isDirectory()).toBe(true);
  });
});

describe("MemFS pre-commit guard", () => {
  test("allows the exact system file to be modified and preserves native hooks", async () => {
    const memoryDir = await initRepo();
    await seedRepo(memoryDir);
    await installNativeMarkerHooks(memoryDir);
    const installation = await installMemfsGuard(memoryDir, strictPolicy);

    expect(git(memoryDir, ["config", "--get", "core.hooksPath"]).trim()).toBe(
      installation.hooksDir,
    );
    expect(installation.hooksDir.startsWith(join(memoryDir, ".git"))).toBe(true);
    await writeFile(
      join(memoryDir, "system/letta-code/AGENTS.md"),
      "---\ndescription: Letta Code project guidance\n---\n# Updated\n",
    );
    git(memoryDir, ["add", "-A"]);
    git(memoryDir, ["commit", "-m", "update guidance"]);

    expect((await lstat(join(memoryDir, ".git/native-pre-ran"))).isFile()).toBe(true);
    expect((await lstat(join(memoryDir, ".git/native-post-ran"))).isFile()).toBe(true);
  });

  test("rejects deleting the protected system file", async () => {
    const memoryDir = await initRepo();
    await seedRepo(memoryDir);
    await installMemfsGuard(
      memoryDir,
      createMemfsWritePolicy(structure, {
        allowedNewFilePrefixes: ["skills/"],
      }),
    );
    rmSync(join(memoryDir, "system/letta-code/AGENTS.md"));
    git(memoryDir, ["add", "-A"]);
    const output = git(memoryDir, ["commit", "-m", "delete guidance"], {
      fail: true,
    });
    expect(output).toContain("delete of system/letta-code/AGENTS.md is not allowed");
  });

  test("allows create, modify, rename, and delete below skills", async () => {
    const memoryDir = await initRepo();
    await seedRepo(memoryDir);
    await installMemfsGuard(memoryDir, strictPolicy);
    await mkdir(join(memoryDir, "skills/testing"), { recursive: true });
    await writeFile(join(memoryDir, "skills/testing/SKILL.md"), "# Testing\n");
    git(memoryDir, ["add", "-A"]);
    git(memoryDir, ["commit", "-m", "create skill"]);

    await writeFile(join(memoryDir, "skills/testing/SKILL.md"), "# Better testing\n");
    git(memoryDir, ["add", "-A"]);
    git(memoryDir, ["commit", "-m", "modify skill"]);
    git(memoryDir, ["mv", "skills/testing", "skills/verified-testing"]);
    git(memoryDir, ["commit", "-m", "rename skill"]);
    rmSync(join(memoryDir, "skills/verified-testing"), {
      recursive: true,
      force: true,
    });
    git(memoryDir, ["add", "-A"]);
    git(memoryDir, ["commit", "-m", "delete skill"]);
  });

  test("rejects other top-level, system, and .letta changes, including unstaged files", async () => {
    const memoryDir = await initRepo();
    await seedRepo(memoryDir);
    await installMemfsGuard(memoryDir, strictPolicy);
    await writeFile(join(memoryDir, "README.md"), "not allowed\n");
    await writeFile(join(memoryDir, ".letta/config.json"), '{"version":2}\n');
    await mkdir(join(memoryDir, "skills/valid"), { recursive: true });
    await writeFile(join(memoryDir, "skills/valid/SKILL.md"), "# Valid\n");
    git(memoryDir, ["add", "skills/valid/SKILL.md"]);
    const output = git(memoryDir, ["commit", "-m", "mixed tree"], { fail: true });
    expect(output).toContain("README.md");
    expect(output).toContain(".letta/config.json");
  });

  test("rejects empty directories outside skills and symlinks inside skills", async () => {
    const memoryDir = await initRepo();
    await seedRepo(memoryDir);
    await installMemfsGuard(memoryDir, strictPolicy);
    await mkdir(join(memoryDir, "reference/empty"), { recursive: true });
    await mkdir(join(memoryDir, "skills/links"), { recursive: true });
    await symlink("../../system/letta-code/AGENTS.md", join(memoryDir, "skills/links/doc"));
    git(memoryDir, ["add", "-A"]);
    const output = git(memoryDir, ["commit", "-m", "invalid shape"], {
      fail: true,
    });
    expect(output).toContain("disallowed staged mode 120000");
    expect(output).toContain("directory reference");
  });
});

describe("clone configuration and post-run validation", () => {
  test("restores native + policy hooks and declared empty directories in a clone", async () => {
    const source = await initRepo();
    await seedRepo(source);
    await installNativeMarkerHooks(source);
    await installMemfsGuard(source, strictPolicy);
    const clone = join(tempDir("dream-memfs-clone"), "clone");
    git(dirnameFor(clone), ["clone", "--quiet", source, clone]);

    expect(await lstat(join(clone, "skills")).catch(() => null)).toBeNull();
    expect(await lstat(join(clone, ".git/hooks/pre-commit")).catch(() => null))
      .toBeNull();
    const installation = await configureMemfsCloneGuard(source, clone, strictPolicy);
    expect((await lstat(join(clone, "skills"))).isDirectory()).toBe(true);
    expect(git(clone, ["config", "--get", "core.hooksPath"]).trim()).toBe(
      installation.hooksDir,
    );

    await writeFile(join(clone, "outside.md"), "no\n");
    git(clone, ["add", "-A"]);
    expect(git(clone, ["commit", "-m", "bad"], { fail: true })).toContain(
      "outside.md",
    );
  });

  test("detects no-verify commits, including transient illegal changes", async () => {
    const memoryDir = await initRepo();
    await seedRepo(memoryDir);
    const installation = await installMemfsGuard(memoryDir, strictPolicy);
    const base = git(memoryDir, ["rev-parse", "HEAD"]).trim();

    await writeFile(join(memoryDir, "outside.md"), "temporary\n");
    git(memoryDir, ["add", "outside.md"]);
    git(memoryDir, ["commit", "--no-verify", "-m", "illegal add"]);
    rmSync(join(memoryDir, "outside.md"));
    git(memoryDir, ["add", "-A"]);
    git(memoryDir, ["commit", "--no-verify", "-m", "hide illegal add"]);

    const validation = await validateMemfsChanges(memoryDir, base, strictPolicy, {
      baselineDirectories: installation.baselineDirectories,
    });
    expect(validation.valid).toBe(false);
    expect(validation.violations.some((v) => v.path === "outside.md")).toBe(true);
  });

  test("detects dirty files and empty directories while accepting legal skill changes", async () => {
    const memoryDir = await initRepo();
    await seedRepo(memoryDir);
    const installation = await installMemfsGuard(memoryDir, strictPolicy);
    const base = git(memoryDir, ["rev-parse", "HEAD"]).trim();
    await mkdir(join(memoryDir, "skills/new"), { recursive: true });
    await writeFile(join(memoryDir, "skills/new/SKILL.md"), "# New\n");
    await writeFile(join(memoryDir, "not-allowed.md"), "bad\n");
    await mkdir(join(memoryDir, "reference/empty"), { recursive: true });

    const validation = await validateMemfsChanges(memoryDir, base, strictPolicy, {
      baselineDirectories: installation.baselineDirectories,
    });
    expect(validation.valid).toBe(false);
    expect(validation.violations.some((v) => v.path === "not-allowed.md")).toBe(
      true,
    );
    expect(validation.violations.some((v) => v.path === "reference")).toBe(true);
    expect(
      validation.violations.some((v) => v.path === "skills/new/SKILL.md"),
    ).toBe(false);
  });
});

function dirnameFor(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
