// Interactive tool policy for SDK permission callbacks.
// Centralizes behavior so transport/session logic doesn't hardcode names inline.

import type { CanUseToolContext, CanUseToolPermissionSuggestion } from "./types.js";

const INTERACTIVE_APPROVAL_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

const RUNTIME_USER_INPUT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const HEADLESS_AUTO_ALLOW_TOOLS = new Set(["EnterPlanMode"]);

export function isInteractiveApprovalTool(toolName: string): boolean {
  return INTERACTIVE_APPROVAL_TOOLS.has(toolName);
}

export function requiresRuntimeUserInput(toolName: string): boolean {
  return RUNTIME_USER_INPUT_TOOLS.has(toolName);
}

export function isHeadlessAutoAllowTool(toolName: string): boolean {
  return HEADLESS_AUTO_ALLOW_TOOLS.has(toolName);
}

function normalizePermissionSuggestions(
  value: unknown,
): CanUseToolPermissionSuggestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const suggestions: CanUseToolPermissionSuggestion[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.text === "string") {
      suggestions.push({ id: record.id, text: record.text });
    }
  }
  return suggestions;
}

/**
 * Build the {@link CanUseToolContext} passed to canUseTool callbacks from a raw
 * `can_use_tool` control request body. Fields absent from the wire request are
 * left undefined so callbacks can distinguish "not provided" from empty values.
 */
export function buildCanUseToolContext(
  request: Record<string, unknown>,
  requestId?: string,
): CanUseToolContext {
  const context: CanUseToolContext = {};
  if (typeof requestId === "string") context.requestId = requestId;
  if (typeof request.tool_call_id === "string") context.toolCallId = request.tool_call_id;
  const suggestions = normalizePermissionSuggestions(request.permission_suggestions);
  if (suggestions !== undefined) context.permissionSuggestions = suggestions;
  if (typeof request.blocked_path === "string" || request.blocked_path === null) {
    context.blockedPath = request.blocked_path as string | null;
  }
  if (Array.isArray(request.diffs)) context.diffs = request.diffs as unknown[];
  return context;
}
