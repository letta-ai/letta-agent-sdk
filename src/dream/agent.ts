// A dream agent: the persistent identity a dream run is tied to. Initializing
// one creates its root directory —
//
//   agent.json    identity: name, model, worker agent ids, target paths
//   memory/       the agent's memory filesystem (git repo, initial commit)
//   runs/         one artifact directory per dream (dream-<stamp>)
//
// and TARGETS are bound at initialization, not per run: an AGENTS.md file
// target is maintained at system/AGENTS.md, and a skills/ directory target is
// mirrored at skills/ in the memfs. Every dream against the agent syncs the
// targets in first (the on-disk copies are the source of truth), and exports
// what the aggregation committed back out. Reflection cursors live inside the
// memory repo (.dream/cursors.json), so the whole identity is one directory.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type DreamTarget,
  exportDirTargetFromMemory,
  isDirTarget,
  readExistingTarget,
  readTargetFromMemory,
  resolveDreamTarget,
  syncDirTargetIntoMemory,
  syncTargetIntoMemory,
  writeTarget,
} from "./targets.js";

const execFileAsync = promisify(execFile);

export interface DreamAgentConfig {
  schema_version: "v1";
  name?: string;
  createdAt: string;
  /** Model for the worker agents (created lazily on the first dream). */
  model?: string;
  reflectorAgentId?: string;
  aggregatorAgentId?: string;
  /** Absolute target paths bound at initialization. */
  targets: string[];
}

export interface LoadedDreamAgent {
  rootDir: string;
  memoryDir: string;
  runsDir: string;
  configPath: string;
  config: DreamAgentConfig;
}

function agentPaths(rootDir: string): Omit<LoadedDreamAgent, "config"> {
  const root = resolve(rootDir);
  return {
    rootDir: root,
    memoryDir: join(root, "memory"),
    runsDir: join(root, "runs"),
    configPath: join(root, "agent.json"),
  };
}

export async function saveDreamAgentConfig(
  agent: LoadedDreamAgent,
): Promise<void> {
  await writeFile(
    agent.configPath,
    `${JSON.stringify(agent.config, null, 2)}\n`,
    "utf-8",
  );
}

export async function loadDreamAgent(
  rootDir: string,
): Promise<LoadedDreamAgent> {
  const paths = agentPaths(rootDir);
  const raw = await readFile(paths.configPath, "utf-8").catch(() => null);
  if (raw === null) {
    throw new Error(
      `No dream agent at ${paths.rootDir} (missing agent.json — run initDreamAgent first)`,
    );
  }
  return { ...paths, config: JSON.parse(raw) as DreamAgentConfig };
}

/**
 * Initialize a new dream-agent identity: memory repo with an initial commit,
 * runs directory, agent.json — and seed the configured targets into memory.
 */
export async function initDreamAgent(options: {
  rootDir: string;
  /** Target paths (e.g. "./AGENTS.md", "./skills/") bound to this agent. */
  targets?: string[];
  name?: string;
  model?: string;
}): Promise<LoadedDreamAgent> {
  const paths = agentPaths(options.rootDir);
  const existing = await readFile(paths.configPath, "utf-8").catch(() => null);
  if (existing !== null) {
    throw new Error(`A dream agent already exists at ${paths.rootDir}`);
  }
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.runsDir, { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: paths.memoryDir });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Dream",
      "-c",
      "user.email=dream@letta.com",
      "commit",
      "--allow-empty",
      "-m",
      "memory: initial state",
    ],
    { cwd: paths.memoryDir },
  );

  const agent: LoadedDreamAgent = {
    ...paths,
    config: {
      schema_version: "v1",
      ...(options.name ? { name: options.name } : {}),
      createdAt: new Date().toISOString(),
      ...(options.model ? { model: options.model } : {}),
      targets: (options.targets ?? []).map((t) => resolve(t)),
    },
  };
  await saveDreamAgentConfig(agent);
  await syncAgentTargetsIntoMemory(agent);
  return agent;
}

export interface ClassifiedAgentTargets {
  /** At most one maintained doc (e.g. AGENTS.md → system/AGENTS.md). */
  fileTarget?: DreamTarget;
  /** Directory tiers mirrored into the memfs (e.g. skills/ → skills/). */
  dirTargets: { path: string; memfsSubdir: string }[];
}

export async function classifyAgentTargets(
  agent: LoadedDreamAgent,
): Promise<ClassifiedAgentTargets> {
  const out: ClassifiedAgentTargets = { dirTargets: [] };
  for (const spec of agent.config.targets) {
    if (await isDirTarget(spec)) {
      const path = spec.replace(/\/+$/, "");
      out.dirTargets.push({ path, memfsSubdir: basename(path) });
    } else if (out.fileTarget) {
      throw new Error(
        `Dream agent ${agent.rootDir} has multiple file targets; only one maintained doc is supported`,
      );
    } else {
      out.fileTarget = resolveDreamTarget(spec);
    }
  }
  return out;
}

/** Sync every configured target into the memory repo (repo-as-truth). */
export async function syncAgentTargetsIntoMemory(
  agent: LoadedDreamAgent,
): Promise<void> {
  const { fileTarget, dirTargets } = await classifyAgentTargets(agent);
  if (fileTarget) {
    const existing = await readExistingTarget(fileTarget);
    if (existing !== null) {
      await syncTargetIntoMemory(agent.memoryDir, fileTarget, existing);
    }
  }
  for (const dir of dirTargets) {
    await syncDirTargetIntoMemory(agent.memoryDir, dir.path, dir.memfsSubdir);
  }
}

export interface AgentTargetExport {
  path: string;
  written: boolean | number;
}

/** Export what aggregation committed back out to the configured targets. */
export async function exportAgentTargets(
  agent: LoadedDreamAgent,
): Promise<AgentTargetExport[]> {
  const { fileTarget, dirTargets } = await classifyAgentTargets(agent);
  const results: AgentTargetExport[] = [];
  if (fileTarget) {
    const rendered = await readTargetFromMemory(agent.memoryDir, fileTarget);
    if (rendered !== null) {
      await writeTarget(fileTarget, rendered);
    }
    results.push({ path: fileTarget.path, written: rendered !== null });
  }
  for (const dir of dirTargets) {
    const { written } = await exportDirTargetFromMemory(
      agent.memoryDir,
      dir.path,
      dir.memfsSubdir,
    );
    results.push({ path: dir.path, written });
  }
  return results;
}
