import type { AppServerExternalToolCallHandler } from "@letta-ai/letta-code/app-server-client";
import type { RuntimeScope } from "./remote-session-protocol.js";
import type { AgentToolCallContext, AnyAgentTool } from "./types.js";

/** The `external_tools` groups that advertise client tools to the runtime. */
export function externalToolGroups(tools: AnyAgentTool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      tools: tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      })),
    },
  ];
}

/**
 * Run a runtime's external tool call against the client tools by name.
 * `fallbackRuntime` covers listeners that send calls without a `runtime`.
 */
export function createExternalToolCallHandler(
  externalTools: Map<string, AnyAgentTool>,
  fallbackRuntime?: () => RuntimeScope | null,
): AppServerExternalToolCallHandler {
  return async (request) => {
    const tool = externalTools.get(request.tool_name);
    if (!tool) {
      throw new Error(`Unknown external tool: ${request.tool_name}`);
    }
    const runtime = request.runtime ?? fallbackRuntime?.() ?? null;
    const context: AgentToolCallContext | undefined = runtime
      ? { toolCallId: request.tool_call_id, agentId: runtime.agent_id, conversationId: runtime.conversation_id }
      : undefined;
    const result = await tool.execute(request.tool_call_id, request.input, undefined, undefined, context);
    return {
      content: result.content.map((part) => ({
        type: part.type,
        ...(part.text !== undefined ? { text: part.text } : {}),
        ...(part.data !== undefined ? { data: part.data } : {}),
        ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
      })),
      ...(result.isError === true ? { is_error: true } : {}),
    };
  };
}
