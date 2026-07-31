/**
 * SDK Validation
 *
 * Validates user-provided options before spawning the CLI.
 */

import type { 
  CreateSessionOptions,
  CreateAgentOptions,
  MemoryItem, 
  McpServers,
  CreateBlock,
  SystemPromptPreset,
  SkillSource,
  DreamingOptions,
} from "./types.js";

const VALID_SKILL_SOURCES: SkillSource[] = [
  "bundled",
  "global",
  "agent",
  "project",
];

const VALID_TOOLSET_BASES = [
  "auto",
  "codex",
  "codex_snake",
  "default",
  "gemini",
  "gemini_snake",
  "none",
] as const;

const VALID_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/**
 * Extract block labels from memory items.
 */
function getBlockLabels(memory: MemoryItem[]): string[] {
  return memory
    .map((item) => {
      if (typeof item === "string") return item; // preset name
      if ("label" in item) return (item as CreateBlock).label; // CreateBlock
      return null; // blockId - no label to check
    })
    .filter((label): label is string => label !== null);
}

function validateApprovalRecoveryOptions(options: CreateSessionOptions): void {
  if (
    options.maxApprovalRecoveryAttempts !== undefined &&
    (!Number.isInteger(options.maxApprovalRecoveryAttempts) ||
      options.maxApprovalRecoveryAttempts < 0)
  ) {
    throw new Error(
      "Invalid maxApprovalRecoveryAttempts. Expected a non-negative integer."
    );
  }

  if (
    options.approvalRecoveryTimeoutMs !== undefined &&
    (!Number.isInteger(options.approvalRecoveryTimeoutMs) ||
      options.approvalRecoveryTimeoutMs <= 0)
  ) {
    throw new Error(
      "Invalid approvalRecoveryTimeoutMs. Expected a positive integer."
    );
  }
}

function validateRemovedSessionOptions(options: CreateSessionOptions): void {
  const removedOptions = options as CreateSessionOptions & Record<string, unknown>;
  if (removedOptions.systemPrompt !== undefined) {
    throw new Error("systemPrompt is not supported when opening an existing agent session.");
  }
  if (removedOptions.disallowedTools !== undefined) {
    throw new Error("disallowedTools is not supported when opening an existing agent session.");
  }
  if (removedOptions.systemInfoReminder !== undefined) {
    throw new Error("systemInfoReminder is not supported when opening an existing agent session.");
  }
  if (removedOptions.includePartialMessages !== undefined) {
    throw new Error("includePartialMessages is not supported by app-server sessions.");
  }
  if (
    options.dreaming &&
    "behavior" in options.dreaming &&
    options.dreaming.behavior !== undefined
  ) {
    throw new Error("dreaming.behavior is not supported when opening an existing agent session.");
  }
  if (removedOptions.memfsStartup !== undefined) {
    throw new Error(
      "memfsStartup is not supported by the SDK.",
    );
  }
}

/**
 * Validate systemPrompt preset value.
 */
function validateSystemPromptPreset(preset: string): void {
  const validPresets = [
    "default",
    "letta-claude",
    "letta-codex",
    "letta-gemini",
    "claude",
    "codex",
    "gemini",
  ];
  if (!validPresets.includes(preset)) {
    throw new Error(
      `Invalid system prompt preset '${preset}'. ` +
        `Valid presets: ${validPresets.join(", ")}`
    );
  }
}

function validateClientToolset(
  toolset: CreateSessionOptions["toolset"],
): void {
  if (toolset === undefined) return;
  if (!toolset || typeof toolset !== "object" || Array.isArray(toolset)) {
    throw new Error("Invalid toolset. Expected an object with optional base and include fields.");
  }
  if (
    toolset.base !== undefined &&
    !VALID_TOOLSET_BASES.includes(toolset.base)
  ) {
    throw new Error(
      `Invalid toolset.base '${String(toolset.base)}'. Valid values: ${VALID_TOOLSET_BASES.join(", ")}`,
    );
  }
  if (
    toolset.include !== undefined &&
    (!Array.isArray(toolset.include) ||
      toolset.include.some(
        (toolName) => typeof toolName !== "string" || toolName.length === 0,
      ))
  ) {
    throw new Error(
      "Invalid toolset.include. Expected an array of non-empty bundled tool names.",
    );
  }
}

function validateSkillSources(sources: SkillSource[] | undefined): void {
  if (sources === undefined) {
    return;
  }

  for (const source of sources) {
    if (!VALID_SKILL_SOURCES.includes(source)) {
      throw new Error(
        `Invalid skill source '${source}'. Valid values: ${VALID_SKILL_SOURCES.join(", ")}`
      );
    }
  }
}

function validateDreamingOptions(dreaming: DreamingOptions | undefined): void {
  if (dreaming === undefined) {
    return;
  }

  if (
    dreaming.trigger !== undefined &&
    !["off", "step-count", "compaction-event"].includes(dreaming.trigger)
  ) {
    throw new Error(
      `Invalid dreaming.trigger '${String(dreaming.trigger)}'. Valid values: off, step-count, compaction-event`
    );
  }

  if (
    dreaming.behavior !== undefined &&
    !["reminder", "auto-launch"].includes(dreaming.behavior)
  ) {
    throw new Error(
      `Invalid dreaming.behavior '${String(dreaming.behavior)}'. Valid values: reminder, auto-launch`
    );
  }

  if (
    dreaming.stepCount !== undefined &&
    (!Number.isInteger(dreaming.stepCount) || dreaming.stepCount <= 0)
  ) {
    throw new Error(
      "Invalid dreaming.stepCount. Expected a positive integer."
    );
  }
}

function validateReasoningEffort(value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    !VALID_REASONING_EFFORTS.includes(value as (typeof VALID_REASONING_EFFORTS)[number])
  ) {
    throw new Error(
      `Invalid reasoningEffort '${String(value)}'. Valid values: ${VALID_REASONING_EFFORTS.join(", ")}`
    );
  }
}

function validateMcpServers(servers: McpServers | undefined): void {
  if (servers === undefined) return;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("Invalid mcpServers. Expected an object keyed by server name.");
  }
  for (const [name, config] of Object.entries(servers)) {
    if (name.length === 0) {
      throw new Error("Invalid mcpServers. Server names must be non-empty.");
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Invalid MCP server '${name}'. Expected a configuration object.`);
    }
    if (config.type === "http" || config.type === "sse") {
      if (typeof config.url !== "string" || config.url.length === 0) {
        throw new Error(`Invalid MCP server '${name}'. Expected a non-empty url.`);
      }
      continue;
    }
    if (config.type !== undefined && config.type !== "stdio") {
      throw new Error(
        `Invalid MCP server '${name}' type '${String(config.type)}'. Valid values: stdio, http, sse.`,
      );
    }
    if (typeof config.command !== "string" || config.command.length === 0) {
      throw new Error(`Invalid MCP server '${name}'. Expected a non-empty command.`);
    }
  }
}

/**
 * Validate CreateSessionOptions (used by createSession and resumeSession).
 */
export function validateCreateSessionOptions(options: CreateSessionOptions): void {
  validateClientToolset(options.toolset);
  validateSkillSources(options.skillSources);
  validateMcpServers(options.mcpServers);
  validateReasoningEffort(options.reasoningEffort);
  validateDreamingOptions(options.dreaming);
  validateApprovalRecoveryOptions(options);
  validateRemovedSessionOptions(options);
}

/**
 * Validate CreateAgentOptions (used by createAgent).
 */
export function validateCreateAgentOptions(options: CreateAgentOptions): void {
  // Validate memory/persona consistency
  if (options.memory !== undefined) {
    const blockLabels = getBlockLabels(options.memory);

    if (options.persona !== undefined && !blockLabels.includes("persona")) {
      throw new Error(
        "Cannot set 'persona' value - block not included in 'memory'. " +
          "Either add 'persona' to memory array or remove the persona option."
      );
    }

    if (options.human !== undefined && !blockLabels.includes("human")) {
      throw new Error(
        "Cannot set 'human' value - block not included in 'memory'. " +
          "Either add 'human' to memory array or remove the human option."
      );
    }
  }

  // Validate systemPrompt preset if provided as preset object
  if (
    options.systemPrompt !== undefined &&
    typeof options.systemPrompt === "object"
  ) {
    validateSystemPromptPreset(options.systemPrompt.preset);
  } else if (
    options.systemPrompt !== undefined &&
    typeof options.systemPrompt === "string"
  ) {
    // Check if it's a preset name (if so, validate it)
    const validPresets = [
      "default",
      "letta-claude",
      "letta-codex",
      "letta-gemini",
      "claude",
      "codex",
      "gemini",
    ] as const;
    if (validPresets.includes(options.systemPrompt as SystemPromptPreset)) {
      validateSystemPromptPreset(options.systemPrompt);
    }
    // If not a preset, it's a custom string - no validation needed
  }

  validateSkillSources(options.skillSources);
  validateDreamingOptions(options.dreaming);
}
