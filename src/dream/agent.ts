// A dream agent is a memfs-enabled Letta agent. Its identity is the Letta
// agent id; the harness owns its memory checkout while this SDK stores dream
// run state alongside it:
//
//   ~/.letta/agents/<agent-id>/
//     memory/              harness-owned MemFS Git checkout
//     dream/               SDK configuration, cursors, and run artifacts

// Initialization accepts the complete starting MemFS shape. A write policy is
// installed as a Git pre-commit hook and is also checked after every agent run
// so --no-verify cannot bypass it.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LettaAgentClient } from "../client.js";
import { gitOutput } from "./clone.js";
import {
  createMemfsWritePolicy,
  installMemfsGuard,
  materializeMemfsStructure,
  recreateMemfsDirectories,
  validateMemfsWritePolicy,
  type MemfsGuardInstallation,
  type MemfsOperationRule,
  type MemfsStructure,
  type MemfsWritePolicy,
} from "./memfs.js";

export interface DreamAgentConfig {
  schema_version: "v1";
  name?: string;
  createdAt: string;
  /** Model for the dream agent and its lazily-created reflection worker. */
  model?: string;
  reflectorAgentId?: string;
  memfs: {
    /** Empty directories that initialization must preserve across clones. */
    directories: readonly string[];
    /** Persistent write policy enforced for reflection and aggregation. */
    policy: MemfsWritePolicy;
  };
}

export interface DreamAgentGuardOptions {
  /** Directory prefixes under which agents may create new files/folders. */
  allowedNewFilePrefixes?: readonly string[];
  /** Optional exact/recursive overrides for create, modify, and delete. */
  allowedOperations?: readonly MemfsOperationRule[];
}

export interface InitDreamAgentOptions {
  name?: string;
  /** Model for the dream agent and its reflection worker. */
  model?: string;
  /** Complete initial contents and declared empty directories for MemFS. */
  memfs?: MemfsStructure;
  /** Restrict what later reflection/aggregation sessions may write. */
  guard?: DreamAgentGuardOptions;
  /** Override the harness agents directory (primarily for tests). */
  agentsDir?: string;
  /** Reuse an existing memfs-enabled Letta agent instead of creating one. */
  agentId?: string;
}

export interface LoadedDreamAgent {
  agentId: string;
  memoryDir: string;
  stateDir: string;
  runsDir: string;
  configPath: string;
  config: DreamAgentConfig;
}

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
  const parsed = JSON.parse(raw) as Partial<DreamAgentConfig>;
  if (parsed.schema_version !== "v1" || !parsed.memfs?.policy) {
    throw new Error(
      `${agentId} has an incompatible dream-agent configuration; initialize a new dream agent`,
    );
  }
  const config: DreamAgentConfig = {
    ...parsed,
    schema_version: "v1",
    createdAt: parsed.createdAt ?? new Date(0).toISOString(),
    memfs: {
      directories: parsed.memfs.directories ?? [],
      policy: validateMemfsWritePolicy(parsed.memfs.policy),
    },
  };
  return { ...paths, config };
}

/** Reinstall the guard and recreate declared empty directories before a run. */
export async function prepareDreamAgentMemfs(
  agent: LoadedDreamAgent,
): Promise<MemfsGuardInstallation> {
  await recreateMemfsDirectories(
    agent.memoryDir,
    agent.config.memfs.directories,
  );
  await assertDreamAgentMemfsReady(agent);
  return installMemfsGuard(agent.memoryDir, agent.config.memfs.policy);
}

async function assertDreamAgentMemfsReady(
  agent: LoadedDreamAgent,
): Promise<void> {
  const untrackedSeeds: string[] = [];
  for (const path of agent.config.memfs.policy.existingPaths) {
    const tracked = await gitOutput(agent.memoryDir, [
      "ls-files",
      "--error-unmatch",
      "--",
      path,
    ]).catch(() => null);
    if (tracked === null) untrackedSeeds.push(path);
  }
  if (untrackedSeeds.length > 0) {
    throw new Error(
      `Dream agent MemFS is not ready: seeded path(s) are not tracked: ${untrackedSeeds.join(", ")}. ` +
        "The harness may still be initializing or may have replaced the checkout after seeding.",
    );
  }

  const status = await gitOutput(agent.memoryDir, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error(
      `Dream agent MemFS must be clean before use; found:\n${status}`,
    );
  }
}

/**
 * Create or bind a memfs-enabled Letta agent, seed its initial MemFS, commit
 * that seed, and install the requested write guard.
 */
export async function initDreamAgent(
  client: LettaAgentClient,
  options: InitDreamAgentOptions = {},
): Promise<LoadedDreamAgent> {
  const agentId =
    options.agentId ??
    (await client.createAgent({
      ...(options.model ? { model: options.model } : {}),
      tags: ["role:dream-agent"],
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

  const structure = options.memfs ?? {};
  const validated = await materializeMemfsStructure(paths.memoryDir, structure);
  if (validated.files.length > 0) {
    await gitOutput(paths.memoryDir, [
      "add",
      "--",
      ...validated.files.map((file) => file.path),
    ]);
    const staged = await gitOutput(paths.memoryDir, [
      "diff",
      "--cached",
      "--name-only",
    ]);
    if (staged !== "") {
      await gitOutput(paths.memoryDir, [
        "-c",
        "user.name=Dream",
        "-c",
        "user.email=dream@letta.com",
        "commit",
        "-m",
        "dream: initialize memory",
      ]);
    }
  }

  const policy = createMemfsWritePolicy(validated, options.guard);
  await mkdir(paths.runsDir, { recursive: true });
  const agent: LoadedDreamAgent = {
    ...paths,
    config: {
      schema_version: "v1",
      ...(options.name ? { name: options.name } : {}),
      createdAt: new Date().toISOString(),
      ...(options.model ? { model: options.model } : {}),
      memfs: {
        directories: validated.directories,
        policy,
      },
    },
  };
  await saveDreamAgentConfig(agent);
  await prepareDreamAgentMemfs(agent);
  return agent;
}
