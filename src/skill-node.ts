/**
 * Node-only skill seeding: directory loading and the memory-repo git push.
 *
 * `skill-loading.ts` owns the portable core (types, validation, SKILL.md
 * parsing, block mapping). This module owns everything that touches the
 * filesystem or spawns git, and stays behind the package root so the
 * portable `/client` entry never pulls in Node builtins.
 */

import { readFile, readdir, stat, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  assertValidSkillName,
  parseSkillMarkdown,
  skillSupportFileEntries,
  type AgentSkill,
} from "./skill-loading.js";

const run = promisify(execFile);

/** Load one skill directory from disk. */
export async function loadSkillDirectory(dirPath: string): Promise<AgentSkill> {
  const dirStat = await stat(dirPath).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`Skill path is not a directory: ${dirPath}`);
  }

  const skillMd = await readFile(join(dirPath, "SKILL.md"), "utf-8").catch(
    () => null,
  );
  if (skillMd === null) {
    throw new Error(`Skill directory has no SKILL.md: ${dirPath}`);
  }

  const parsed = parseSkillMarkdown(skillMd);
  const name = parsed.name ?? basename(dirPath);
  assertValidSkillName(name);
  if (!parsed.description) {
    throw new Error(
      `SKILL.md in ${dirPath} has no frontmatter description. ` +
        `The description is the skill's trigger text; it is required.`,
    );
  }

  // Collect support files (everything except SKILL.md), preserving layout.
  const files: Record<string, Uint8Array> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = relative(dirPath, full).split(sep).join("/");
        if (rel === "SKILL.md") continue;
        files[rel] = new Uint8Array(await readFile(full));
      }
    }
  };
  await walk(dirPath);

  return {
    name,
    description: parsed.description,
    instructions: parsed.body.replace(/^\s+/, ""),
    ...(Object.keys(files).length > 0 ? { files } : {}),
  };
}

export interface SkillFilesPushTarget {
  apiBaseUrl: string;
  apiKey: string;
  agentId: string;
}

/**
 * Push skill support files into a new agent's memory git repo.
 *
 * SKILL.md rides the create-agent request as a memory block; everything else
 * in a skill directory (scripts/, references/, ...) has no block
 * representation and exactly one write channel: the agent's memory git
 * remote at `{apiBaseUrl}/v1/git/{agentId}/state.git`. This function owns
 * that one commit: shallow clone, write files, commit, push (with one
 * pull --rebase retry in case the server committed between clone and push).
 */
export async function pushSkillSupportFiles(
  target: SkillFilesPushTarget,
  skills: AgentSkill[],
): Promise<void> {
  const entries = skillSupportFileEntries(skills);
  if (entries.length === 0) return;

  const base = target.apiBaseUrl.replace(/\/+$/, "");
  const remote = `${base}/v1/git/${target.agentId}/state.git`;
  // Credentials travel via a one-shot Authorization header, not the URL, so
  // they cannot leak into error messages or the cloned repo's config.
  const authHeader = `Authorization: Basic ${Buffer.from(`x:${target.apiKey}`).toString("base64")}`;
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "letta-agent-sdk",
    GIT_AUTHOR_EMAIL: "sdk@letta.com",
    GIT_COMMITTER_NAME: "letta-agent-sdk",
    GIT_COMMITTER_EMAIL: "sdk@letta.com",
  };
  const git = (args: string[], cwd?: string) =>
    run("git", ["-c", `http.extraHeader=${authHeader}`, ...args], {
      env: gitEnv,
      ...(cwd ? { cwd } : {}),
    });

  const work = await mkdtemp(join(tmpdir(), "letta-skill-seed-"));
  try {
    await git(["clone", "--quiet", "--depth", "1", remote, work]);
    for (const entry of entries) {
      const filePath = join(work, entry.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, entry.data);
    }
    await git(["add", "-A"], work);
    await git(["commit", "--quiet", "-m", "feat: seed skill support files"], work);
    try {
      await git(["push", "--quiet", "origin", "HEAD"], work);
    } catch {
      await git(["pull", "--quiet", "--rebase", "origin", "HEAD"], work);
      await git(["push", "--quiet", "origin", "HEAD"], work);
    }
  } catch (error) {
    throw new Error(
      `Agent ${target.agentId} was created, but pushing skill support files ` +
        `to its memory repo failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
