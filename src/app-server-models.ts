import type { ListModelsResponseMessage } from "@letta-ai/letta-code/app-server-protocol";
import type { ListModelsResult } from "./types.js";

export function normalizeAppServerModels(
  response: ListModelsResponseMessage,
): ListModelsResult {
  if (!response.success) {
    throw new Error(response.error ?? "listModels failed");
  }

  return {
    entries: response.entries,
    ...(response.available_handles !== undefined
      ? { availableHandles: response.available_handles }
      : {}),
    ...(response.byok_provider_aliases !== undefined
      ? { byokProviderAliases: response.byok_provider_aliases }
      : {}),
  };
}
