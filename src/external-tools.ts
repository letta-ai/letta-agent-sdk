import type { AppServerClient, AppServerExternalToolCallHandler } from "@letta-ai/letta-code/app-server-client";
import type { RuntimeScope } from "./remote-session-protocol.js";
import type { AgentToolCallContext, AnyAgentTool } from "./types.js";

/** The `external_tools` groups that advertise client tools to the runtime. */
export function externalToolGroups(tools: AnyAgentTool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      capabilities: { external_tool_call_cancel: true },
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
): CancellableToolCallHandler {
  // A request can be delivered more than once (e.g. relayed on more than one
  // socket). Share one execution per request_id so a tool never runs twice.
  const calls = new Map<string, ReturnType<AppServerExternalToolCallHandler>>();
  const execute: CancellableToolCallHandler = async (request, signal) => {
    const tool = externalTools.get(request.tool_name);
    if (!tool) {
      throw new Error(`Unknown external tool: ${request.tool_name}`);
    }
    const runtime = request.runtime ?? fallbackRuntime?.() ?? null;
    const context: AgentToolCallContext | undefined = runtime
      ? { toolCallId: request.tool_call_id, agentId: runtime.agent_id, conversationId: runtime.conversation_id }
      : undefined;
    const result = await tool.execute(request.tool_call_id, request.input, signal, undefined, context);
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
  return (request, signal) => {
    const requestId = request.request_id;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return execute(request, signal);
    }
    const existing = calls.get(requestId);
    if (existing) return existing;
    const call = execute(request, signal);
    calls.set(requestId, call);
    while (calls.size > MAX_REMEMBERED_EXTERNAL_TOOL_CALLS) {
      const oldest = calls.keys().next().value;
      if (oldest === undefined) break;
      calls.delete(oldest);
    }
    return call;
  };
}


type CancellableToolCallHandler = (
  request: Parameters<AppServerExternalToolCallHandler>[0],
  signal?: AbortSignal,
) => ReturnType<AppServerExternalToolCallHandler>;

/** Own response arbitration so cancellation and completion cannot both reply. */
export function registerExternalToolCallHandler(
  client: AppServerClient,
  handler: CancellableToolCallHandler,
): () => void {
  const pending = new Map<string, { controller: AbortController; finish: (response: Record<string, unknown>) => void }>();
  const completed = new Set<string>();
  const remove = client.onMessage((raw, channel) => {
    if (channel !== "control") return;
    const message = raw as unknown as Record<string, unknown>;
    const requestId = message.request_id;
    if (typeof requestId !== "string") return;
    if (message.type === "external_tool_call_cancel") {
      const call = pending.get(requestId);
      if (!call) return;
      // Claim the response before abort listeners can resolve or throw.
      call.finish({ error: "cancelled" });
      call.controller.abort(message.reason);
      return;
    }
    if (message.type !== "external_tool_call_request" || pending.has(requestId) || completed.has(requestId)) return;
    const controller = new AbortController();
    const finish = (response: Record<string, unknown>) => {
      if (!pending.delete(requestId)) return;
      completed.add(requestId);
      if (completed.size > MAX_REMEMBERED_EXTERNAL_TOOL_CALLS) completed.delete(completed.values().next().value!);
      client.send({ type: "external_tool_call_response", request_id: requestId, ...response });
    };
    pending.set(requestId, { controller, finish });
    try {
      Promise.resolve(handler(raw as Parameters<AppServerExternalToolCallHandler>[0], controller.signal)).then(
        (result) => finish({ result }),
        (error: unknown) => finish({ error: error instanceof Error ? error.message : String(error) }),
      );
    } catch (error) {
      finish({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return () => {
    remove();
    for (const call of pending.values()) call.controller.abort();
    pending.clear();
  };
}
