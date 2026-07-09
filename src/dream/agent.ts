// A dream agent IS a memfs-enabled Letta agent — the identity is its agent
// id. Its memory lives where the harness keeps that agent's memory
// filesystem checkout (~/.letta/agents/<id>/memory), maintained and synced
// by the harness; the pipeline stores nothing but its own state next to it:
//
//   ~/.letta/agents/<agent-id>/
//     memory/              the agent's memfs checkout (harness-owned)
//     dream/               pipeline state: agent.json (bound targets,
//                          reflector id, model), reflection cursors, and
//                          runs/<dream-id>/ per-dream artifacts
//
// TARGETS are bound at initialization: an AGENTS.md file target maintained at
// system/AGENTS.md, and a skills/ directory target mirrored at skills/.
// Aggregation runs as a session ON the dream agent itself, so synthesized
// changes land in its own memfs through the harness's memory machinery.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { LettaAgentClient } from "../client.js";
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

export interface DreamAgentConfig {
  schema_version: "v1";
  name?: string;
  createdAt: string;
  /** Model for the reflector worker (created lazily on the first dream). */
  model?: string;
  reflectorAgentId?: string;
  /** Absolute target paths bound at initialization. */
  targets: string[];
  /**
   * When true, the agent's memory IS its targets: every dream confines its
   * edits to the bound target paths (system/<doc>, skills/) and creates no
   * other memory files. Default: targets are maintained in addition to
   * regular tiered memory, matching letta-code's `dream --to`.
   */
  targetsOnly?: boolean;
}

export interface LoadedDreamAgent {
  /** The Letta agent this identity IS. */
  agentId: string;
  /** The agent's memory filesystem checkout (harness-owned). */
  memoryDir: string;
  /** Pipeline state directory (dream/). */
  stateDir: string;
  runsDir: string;
  configPath: string;
  config: DreamAgentConfig;
}

/** The harness's per-agent directory (memory checkout lives inside). */
function harnessAgentDir(agentId: string, agentsDir?: string): string {
  return join(agentsDir ?? join(homedir(), ".letta", "agents"), agentId);
}

function agentPaths(
  agentId: string,
  agentsDir?: string,
): Omit<LoadedDreamAgent, "config"> {
  const base = harnessAgentDir(agentId, agentsDir);
  const stateDir = join(base, "dream");
  return {
    agentId,
    memoryDir: join(base, "memory"),
    stateDir,
    runsDir: join(stateDir, "runs"),
    configPath: join(stateDir, "agent.json"),
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
  agentId: string,
  options: { agentsDir?: string } = {},
): Promise<LoadedDreamAgent> {
  const paths = agentPaths(agentId, options.agentsDir);
  const raw = await readFile(paths.configPath, "utf-8").catch(() => null);
  if (raw === null) {
    throw new Error(
      `${agentId} is not an initialized dream agent (missing ${paths.configPath} — run initDreamAgent first)`,
    );
  }
  return { ...paths, config: JSON.parse(raw) as DreamAgentConfig };
}

/**
 * Initialize a new dream agent: create a memfs-enabled Letta agent (the
 * identity is its agent id), record the pipeline state next to the harness's
 * memory checkout, and seed the configured targets into memory.
 */
export async function initDreamAgent(
  client: LettaAgentClient,
  options: {
    /** Target paths (e.g. "./AGENTS.md", "./skills/") bound to this agent. */
    targets?: string[];
    /** Confine all memory edits to the targets (see DreamAgentConfig). */
    targetsOnly?: boolean;
    name?: string;
    /** Model for the dream agent AND its reflector worker. */
    model?: string;
    /** Override the harness agents directory (tests). */
    agentsDir?: string;
    /** Reuse an existing memfs-enabled agent instead of creating one. */
    agentId?: string;
  } = {},
): Promise<LoadedDreamAgent> {
  const agentId =
    options.agentId ??
    (await client.createAgent({
      ...(options.model ? { model: options.model } : {}),
      tags: ["role:dream-agent"],
      // memfs stays enabled (the default): this agent's memory filesystem IS
      // the dream target, and aggregation runs on the agent itself.
    }));

  const paths = agentPaths(agentId, options.agentsDir);
  const existing = await readFile(paths.configPath, "utf-8").catch(() => null);
  if (existing !== null) {
    throw new Error(`${agentId} is already an initialized dream agent`);
  }
  const memoryInfo = await stat(paths.memoryDir).catch(() => null);
  if (!memoryInfo?.isDirectory()) {
    throw new Error(
      `No memory filesystem checkout at ${paths.memoryDir} — the dream agent must be memfs-enabled`,
    );
  }
  await mkdir(paths.runsDir, { recursive: true });

  const agent: LoadedDreamAgent = {
    ...paths,
    config: {
      schema_version: "v1",
      ...(options.name ? { name: options.name } : {}),
      createdAt: new Date().toISOString(),
      ...(options.model ? { model: options.model } : {}),
      targets: (options.targets ?? []).map((t) => resolve(t)),
      ...(options.targetsOnly ? { targetsOnly: true } : {}),
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
        `Dream agent ${agent.agentId} has multiple file targets; only one maintained doc is supported`,
      );
    } else {
      out.fileTarget = resolveDreamTarget(spec);
    }
  }
  return out;
}

/** Sync every configured target into the memory checkout (repo-as-truth). */
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
