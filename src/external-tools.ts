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

const MAX_REMEMBERED_EXTERNAL_TOOL_CALLS = 200;

/**
 * Run a runtime's external tool call against the client tools by name.
 * `fallbackRuntime` covers listeners that send calls without a `runtime`.
 */
export function createExternalToolCallHandler(
  externalTools: Map<string, AnyAgentTool>,
  fallbackRuntime?: () => RuntimeScope | null,
): AppServerExternalToolCallHandler {
  // A request can be delivered more than once (e.g. relayed on more than one
  // socket). Share one execution per request_id so a tool never runs twice.
  const calls = new Map<string, ReturnType<AppServerExternalToolCallHandler>>();
  const execute: AppServerExternalToolCallHandler = async (request) => {
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
  return (request) => {
    const requestId = request.request_id;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return execute(request);
    }
    const existing = calls.get(requestId);
    if (existing) return existing;
    const call = execute(request);
    calls.set(requestId, call);
    while (calls.size > MAX_REMEMBERED_EXTERNAL_TOOL_CALLS) {
      const oldest = calls.keys().next().value;
      if (oldest === undefined) break;
      calls.delete(oldest);
    }
    return call;
  };
}
