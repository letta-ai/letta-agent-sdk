import {
  buildCreatedAgentTags,
  buildCreateAgentRequestForPersonality,
  buildSystemPrompt,
  LETTA_CODE_AGENT_TYPE,
  MODEL_PRESETS,
} from "@letta-ai/letta-code/agent-presets";
import type { CreateAgentOptions } from "./types.js";

const DEFAULT_MODEL_ID = "auto";
const DEFAULT_SUMMARIZATION_MODEL = "letta/auto";

function resolveModel(modelIdentifier: string): string {
  const preset = MODEL_PRESETS.find(
    (model) =>
      model.id === modelIdentifier || model.handle === modelIdentifier,
  );
  if (preset) return preset.handle;

  // Preserve support for model handles supplied by self-hosted servers even
  // when they are not present in the bundled catalog.
  if (modelIdentifier.includes("/")) return modelIdentifier;

  throw new Error(`Unknown model: ${modelIdentifier}`);
}

/**
 * Build the standard harness portion of a create-agent request.
 *
 * Personality presets are explicit opt-ins. Without one, the SDK builds a
 * generic agent and lets the caller's memory blocks define its identity.
 */
export async function buildInitialAgentBody(
  options: CreateAgentOptions,
): Promise<Record<string, unknown>> {
  if (options.personality !== undefined) {
    return {
      ...(await buildCreateAgentRequestForPersonality({
        personalityId: options.personality,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.tags !== undefined ? { extraTags: options.tags } : {}),
      })),
    };
  }

  return {
    agent_type: LETTA_CODE_AGENT_TYPE,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    model: resolveModel(options.model ?? DEFAULT_MODEL_ID),
    system: buildSystemPrompt("default", "memfs"),
    tags: buildCreatedAgentTags({
      enableMemfs: true,
      tags: options.tags ?? [],
    }),
    initial_message_sequence: [],
    parallel_tool_calls: true,
    compaction_settings: { model: DEFAULT_SUMMARIZATION_MODEL },
  };
}
