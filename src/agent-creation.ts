import {
  buildCreateAgentRequest,
  type CreateAgentMemoryBlock,
  type CreateAgentRequest,
  buildSystemPrompt,
} from "@letta-ai/letta-code/agent-presets";
import type {
  CreateAgentOptions,
  SystemPromptConfig,
  SystemPromptPreset,
} from "./types.js";

const SYSTEM_PROMPT_PRESET_IDS = {
  default: "default",
  letta: "letta",
  "source-claude": "source-claude",
  "source-codex": "source-codex",
  "source-gemini": "source-gemini",
  "letta-claude": "letta",
  "letta-codex": "letta",
  "letta-gemini": "letta",
  claude: "source-claude",
  codex: "source-codex",
  gemini: "source-gemini",
} as const satisfies Record<SystemPromptPreset, string>;

function isPresetSystemPrompt(value: string): value is SystemPromptPreset {
  return Object.hasOwn(SYSTEM_PROMPT_PRESET_IDS, value);
}

function resolveSystemPrompt(
  config: SystemPromptConfig,
  memoryMode: "memfs" | "standard",
): string {
  if (typeof config === "string") {
    return isPresetSystemPrompt(config)
      ? buildSystemPrompt(SYSTEM_PROMPT_PRESET_IDS[config], memoryMode)
      : config;
  }

  const base = buildSystemPrompt(
    SYSTEM_PROMPT_PRESET_IDS[config.preset],
    memoryMode,
  );
  return config.append === undefined || config.append.length === 0
    ? base
    : `${base}\n\n${config.append}`;
}

function assertCreateAgentOptionsSupported(options: CreateAgentOptions): void {
  if (
    options.allowedTools !== undefined ||
    options.disallowedTools !== undefined
  ) {
    throw new Error(
      "App-server createAgent() does not yet support allowedTools/disallowedTools.",
    );
  }
  if (options.canUseTool !== undefined) {
    throw new Error(
      "App-server createAgent() does not yet support canUseTool callbacks.",
    );
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error(
      "App-server createAgent() does not yet support systemInfoReminder overrides.",
    );
  }
  if (options.dreaming?.behavior !== undefined) {
    throw new Error(
      "App-server createAgent() does not yet support dreaming.behavior overrides.",
    );
  }
}

/** Translate SDK convenience options into the canonical Letta Code request. */
export async function createAgentBody(
  options: CreateAgentOptions,
): Promise<CreateAgentRequest> {
  assertCreateAgentOptionsSupported(options);

  const system = options.systemPrompt === undefined
    ? undefined
    : resolveSystemPrompt(
        options.systemPrompt,
        options.memfs === false ? "standard" : "memfs",
      );

  const memoryBlocks: CreateAgentMemoryBlock[] = [];
  const blockIds: string[] = [];
  for (const item of options.memory ?? []) {
    if (typeof item === "string") {
      throw new Error(
        "App-server createAgent() does not yet support memory preset names.",
      );
    }
    if ("blockId" in item) {
      blockIds.push(item.blockId);
    } else {
      memoryBlocks.push({ ...item });
    }
  }
  if (options.persona !== undefined) {
    memoryBlocks.push({ label: "persona", value: options.persona });
  }
  if (options.human !== undefined) {
    memoryBlocks.push({ label: "human", value: options.human });
  }
  const hasMemoryConfiguration =
    options.memory !== undefined ||
    options.persona !== undefined ||
    options.human !== undefined;

  return buildCreateAgentRequest({
    personalityId: options.personality,
    name: options.name,
    description: options.description,
    model: options.model,
    system,
    memoryBlocks: hasMemoryConfiguration ? memoryBlocks : undefined,
    blockIds,
    extraTags: options.tags,
    enableMemfs: options.memfs ?? true,
    baseTools: options.baseTools,
    embedding: options.embedding,
    hidden: options.hidden,
  });
}
