import {
  buildCreateAgentRequest,
  type CreateAgentMemoryBlock,
  type CreateAgentRequest,
} from "@letta-ai/letta-code/agent-presets";
import type { CreateAgentOptions } from "./types.js";

function isPresetSystemPrompt(value: string): boolean {
  return [
    "default",
    "letta-claude",
    "letta-codex",
    "letta-gemini",
    "claude",
    "codex",
    "gemini",
  ].includes(value);
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

  let system: string | undefined;
  if (options.systemPrompt !== undefined) {
    if (
      typeof options.systemPrompt !== "string" ||
      isPresetSystemPrompt(options.systemPrompt)
    ) {
      throw new Error(
        "createAgent() does not yet support system prompt presets for this backend.",
      );
    }
    system = options.systemPrompt;
  }

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
