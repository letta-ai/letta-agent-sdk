// Give a batch reflection agent an isolated copy of the target memory
// filesystem to edit: a local `git clone` at its current revision. The agent
// reconciles its batch's learnings against existing memory in place; the
// aggregator later reads each batch's diff against the shared base revision
// and synthesizes one edit onto the target. Clones are fully independent
// repos, so any number of batches can run concurrently.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Clone the memory filesystem into outputDir and return the base revision the
 * clone starts from (the revision batch diffs are taken against).
 */
export async function cloneMemoryTree(
  memoryDir: string,
  outputDir: string,
): Promise<string> {
  await execFileAsync("git", ["clone", "--quiet", memoryDir, outputDir]);
  // Commits are authored per the reflection prompt; the committer identity
  // just needs to exist inside the clone.
  await gitOutput(outputDir, ["config", "user.name", "Dream Reflection"]);
  await gitOutput(outputDir, ["config", "user.email", "dream@letta.com"]);
  return gitOutput(outputDir, ["rev-parse", "HEAD"]);
}

/** Commits past the base revision, and whether the tree has uncommitted edits. */
export async function inspectMemoryTree(
  memoryDir: string,
  baseRevision: string,
): Promise<{ commitCount: number; dirty: boolean }> {
  try {
    const total = Number.parseInt(
      await gitOutput(memoryDir, ["rev-list", "--count", `${baseRevision}..HEAD`]),
      10,
    );
    const dirty =
      (await gitOutput(memoryDir, ["status", "--porcelain"])) !== "";
    return {
      commitCount: Number.isFinite(total) ? Math.max(0, total) : 0,
      dirty,
    };
  } catch {
    return { commitCount: 0, dirty: false };
  }
}
