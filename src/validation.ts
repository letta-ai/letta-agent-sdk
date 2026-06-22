/**
 * SDK Validation
 *
 * Validates user-provided options before spawning the CLI.
 */

import type { 
  CreateSessionOptions,
  CreateAgentOptions,
  MemoryItem, 
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
  if ((options as { memfsStartup?: unknown }).memfsStartup !== undefined) {
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

/**
 * Validate CreateSessionOptions (used by createSession and resumeSession).
 */
export function validateCreateSessionOptions(options: CreateSessionOptions): void {
  // Validate systemPrompt preset if provided
  if (options.systemPrompt !== undefined) {
    validateSystemPromptPreset(options.systemPrompt);
  }

  validateSkillSources(options.skillSources);
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
