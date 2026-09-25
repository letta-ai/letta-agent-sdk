import type { LettaCodeModelEntry, ListModelsResult } from "./types.js";
import {
  getContextWindow, getReasoningEffort, modelPayloadWithoutReasoning,
  sameContextCandidates, toBaseModelHandle,
  type NormalizedUpdateModelInput, type UpdateModelPayload,
} from "./remote-session-protocol.js";

/** Resolve a reasoning tier from the runtime's authoritative catalog. */
export function resolveUpdateModelPayloadFromCatalog(
  input: NormalizedUpdateModelInput,
  catalog: ListModelsResult,
  currentModel: string,
  currentSettings: Record<string, unknown> | null,
): UpdateModelPayload {
  if (input.reasoningEffort === undefined) return modelPayloadWithoutReasoning(input);
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const aliases = catalog.byokProviderAliases;
  let baseEntry: LettaCodeModelEntry | undefined;
  let explicitHandle: string | undefined;
  let targetHandle: string | undefined;
  if (input.modelId !== undefined) {
    baseEntry = byId.get(input.modelId);
    explicitHandle = input.modelHandle;
    targetHandle = baseEntry?.handle ?? toBaseModelHandle(input.modelHandle, aliases);
  } else if (input.modelHandle !== undefined) {
    explicitHandle = input.modelHandle;
    targetHandle = toBaseModelHandle(input.modelHandle, aliases);
  } else if (input.model !== undefined) {
    baseEntry = byId.get(input.model);
    if (baseEntry) targetHandle = baseEntry.handle;
    else {
      explicitHandle = input.model;
      targetHandle = toBaseModelHandle(input.model, aliases);
    }
  } else {
    explicitHandle = currentModel || undefined;
    targetHandle = toBaseModelHandle(currentModel || undefined, aliases);
  }
  if (!targetHandle) {
    throw new Error("reasoningEffort requires a current model or explicit model/modelId/modelHandle.");
  }
  const candidates = catalog.entries.filter(
    (entry) => entry.handle === targetHandle || entry.handle === explicitHandle,
  );
  if (candidates.length === 0) {
    throw new Error(`reasoningEffort requires a model from listModels(); no catalog entry found for ${targetHandle}.`);
  }
  const contextWindow = getContextWindow(baseEntry?.updateArgs) ?? getContextWindow(currentSettings);
  const scopedCandidates = sameContextCandidates(candidates, contextWindow);
  const matchingEntry = scopedCandidates.find((entry) => getReasoningEffort(entry) === input.reasoningEffort) ??
    candidates.find((entry) => getReasoningEffort(entry) === input.reasoningEffort);
  if (!matchingEntry) {
    throw new Error(`No ${input.reasoningEffort} reasoning tier found for model ${targetHandle}.`);
  }
  const payload: UpdateModelPayload = { model_id: matchingEntry.id };
  if (explicitHandle !== undefined) payload.model_handle = explicitHandle;
  return payload;
}
