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
  SystemPromptPreset 
} from "./types.js";

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

/**
 * Validate CreateSessionOptions (used by createSession and resumeSession).
 */
export function validateCreateSessionOptions(options: CreateSessionOptions): void {
  // Validate systemPrompt preset if provided
  if (options.systemPrompt !== undefined) {
    validateSystemPromptPreset(options.systemPrompt);
  }
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
}
