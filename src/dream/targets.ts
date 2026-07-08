// Render targets for a dream run — a doc (e.g. AGENTS.md) maintained INSIDE
// the memory filesystem at `system/<name>` and exported back to its on-disk
// path after aggregation. Port of letta-code's `dream --to`:
//
// - Each run syncs the on-disk doc into the memfs first (when the memfs has
//   no copy or the on-disk body changed), so reflection starts from the
//   current shared state — the repo copy is the source of truth for a doc
//   shared across agents.
// - Reflection batches maintain the doc in their memfs clones alongside their
//   other memory edits; the aggregator synthesizes those diffs onto the
//   target like any other memory file.
// - After aggregation, the committed doc is exported back to `path` as plain
//   markdown (managed frontmatter stripped).
//
// Files under system/ carry YAML frontmatter (letta-code's memfs pre-commit
// hook requires a description), so a managed block is added when seeding and
// stripped on export.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { gitOutput } from "./clone.js";
import { listFilesRecursive } from "./store-utils.js";

export interface DreamTarget {
  /** Filesystem path the rendered doc is read from and written back to. */
  path: string;
  /** The file name maintained inside the memfs at `system/<fileName>`. */
  fileName: string;
  kind: "agents-md" | "generic";
}

export function resolveDreamTarget(spec: string): DreamTarget {
  const fileName = basename(spec);
  if (!fileName) {
    throw new Error(`Invalid dream target "${spec}": expected a file path`);
  }
  const lower = fileName.toLowerCase();
  const kind =
    lower === "agents.md" || lower === "agent.md" ? "agents-md" : "generic";
  return { path: spec, fileName, kind };
}

/** The doc's path inside the memfs, relative to the memory root. */
export function targetMemfsRelPath(target: DreamTarget): string {
  return `system/${target.fileName}`;
}

const MANAGED_DESCRIPTION: Record<DreamTarget["kind"], string> = {
  "agents-md":
    "Repository guidance for coding agents, maintained by dreaming.",
  generic: "Document distilled by dreaming.",
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFrontmatter(content: string): {
  header: string | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { header: null, body: content };
  return { header: match[1] ?? "", body: content.slice(match[0].length) };
}

export function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

/** Add the managed frontmatter block unless a description already exists. */
export function addManagedFrontmatter(
  content: string,
  kind: DreamTarget["kind"],
): string {
  const { header, body } = splitFrontmatter(content);
  if (header !== null && /(^|\n)description:\s*\S/.test(header)) {
    return content;
  }
  return `---\ndescription: ${MANAGED_DESCRIPTION[kind]}\n---\n${body}`;
}

/** Read the current on-disk target doc, or null if it doesn't exist. */
export async function readExistingTarget(
  target: DreamTarget,
): Promise<string | null> {
  try {
    return await readFile(target.path, "utf-8");
  } catch {
    return null;
  }
}

/** The committed memfs content at relPath (`git show HEAD:…`), or null. */
async function readMemfsHead(
  memoryDir: string,
  relPath: string,
): Promise<string | null> {
  try {
    return await gitOutput(memoryDir, ["show", `HEAD:${relPath}`]);
  } catch {
    return null;
  }
}

/**
 * Sync the on-disk target doc into the memory filesystem at
 * `system/<fileName>` and commit it: written when the memfs has no copy OR
 * the on-disk body differs from the committed copy (another agent's merged
 * edits, or a human edit). Must run BEFORE batch clones are taken, since
 * clones start from the target's current HEAD.
 */
export async function syncTargetIntoMemory(
  memoryDir: string,
  target: DreamTarget,
  content: string,
): Promise<{ synced: boolean }> {
  const relPath = targetMemfsRelPath(target);
  const committed = await readMemfsHead(memoryDir, relPath);
  if (
    committed !== null &&
    stripFrontmatter(committed).trim() === stripFrontmatter(content).trim()
  ) {
    return { synced: false };
  }

  const absPath = join(memoryDir, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, addManagedFrontmatter(content, target.kind), "utf-8");
  await gitOutput(memoryDir, ["add", relPath]);
  await gitOutput(memoryDir, [
    "-c",
    "user.name=Dream",
    "-c",
    "user.email=dream@letta.com",
    "commit",
    "-m",
    `dream: sync ${target.fileName} from target`,
    "--",
    relPath,
  ]);
  return { synced: true };
}

/**
 * Read the doc as committed in the memory filesystem, frontmatter stripped,
 * or null if it was never written (a no-signal run leaves the target absent).
 */
export async function readTargetFromMemory(
  memoryDir: string,
  target: DreamTarget,
): Promise<string | null> {
  const committed = await readMemfsHead(memoryDir, targetMemfsRelPath(target));
  if (committed === null) return null;
  const body = stripFrontmatter(committed).trim();
  return body.length > 0 ? `${body}\n` : null;
}

/** Write the rendered doc to the target path, creating parent dirs. */
export async function writeTarget(
  target: DreamTarget,
  content: string,
): Promise<void> {
  await mkdir(dirname(target.path) || ".", { recursive: true });
  await writeFile(target.path, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Directory targets (skills/): a directory mirrored into the memfs as a
// whole tier rather than a single maintained doc. Files flow in before
// reflection (the on-disk directory is the source of truth) and committed
// changes flow back out after aggregation. No managed frontmatter — the
// files are already agent-facing documents.

/**
 * Mirror the on-disk directory into `<memoryDir>/<memfsSubdir>` and commit
 * when anything changed. Returns the number of files written.
 */
export async function syncDirTargetIntoMemory(
  memoryDir: string,
  dirPath: string,
  memfsSubdir: string,
): Promise<{ synced: number }> {
  const files = listFilesRecursive(dirPath, () => true);
  let synced = 0;
  for (const file of files) {
    const rel = relative(dirPath, file);
    const dest = join(memoryDir, memfsSubdir, rel);
    const content = await readFile(file, "utf-8");
    const current = await readFile(dest, "utf-8").catch(() => null);
    if (current === content) continue;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf-8");
    synced += 1;
  }
  if (synced > 0) {
    await gitOutput(memoryDir, ["add", memfsSubdir]);
    await gitOutput(memoryDir, [
      "-c",
      "user.name=Dream",
      "-c",
      "user.email=dream@letta.com",
      "commit",
      "-m",
      `dream: sync ${memfsSubdir}/ from target`,
      "--",
      memfsSubdir,
    ]).catch(() => {});
  }
  return { synced };
}

/**
 * Copy the memfs directory tier back out to the on-disk target: files are
 * added or overwritten, never deleted (conservative — dreaming grows the
 * skill set; pruning is the caller's call). Returns files written.
 */
export async function exportDirTargetFromMemory(
  memoryDir: string,
  dirPath: string,
  memfsSubdir: string,
): Promise<{ written: number }> {
  const root = join(memoryDir, memfsSubdir);
  const files = listFilesRecursive(root, () => true);
  let written = 0;
  for (const file of files) {
    const rel = relative(root, file);
    const dest = join(dirPath, rel);
    const content = await readFile(file, "utf-8");
    const current = await readFile(dest, "utf-8").catch(() => null);
    if (current === content) continue;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf-8");
    written += 1;
  }
  return { written };
}

/** Classify a configured target path: an existing directory (or a spec with
 * a trailing slash) is a directory target; anything else is a file target. */
export async function isDirTarget(spec: string): Promise<boolean> {
  if (spec.endsWith("/")) return true;
  const info = await stat(spec).catch(() => null);
  return info?.isDirectory() ?? false;
}
