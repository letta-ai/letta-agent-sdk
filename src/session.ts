/**
 * Session
 *
 * Represents a conversation session with a Letta agent.
 * Implements the V2 API pattern: send() / receive()
 */

import { SubprocessTransport } from "./transport.js";
import type {
  InternalSessionOptions,
  SDKMessage,
  SDKInitMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  WireMessage,
  ControlRequest,
  CanUseToolControlRequest,
  CanUseToolResponse,
  CanUseToolResponseAllow,
  CanUseToolResponseDeny,
  SendMessage,
} from "./types.js";


// All logging gated behind DEBUG_SDK env var
function sessionLog(tag: string, ...args: unknown[]) {
  if (process.env.DEBUG_SDK) console.error(`[SDK-Session] [${tag}]`, ...args);
}

export class Session implements AsyncDisposable {
  private transport: SubprocessTransport;
  private _agentId: string | null = null;
  private _sessionId: string | null = null;
  private _conversationId: string | null = null;
  private initialized = false;


  constructor(
    private options: InternalSessionOptions = {}
  ) {
    // Note: Validation happens in public API functions (createSession, createAgent, etc.)
    this.transport = new SubprocessTransport(options);
  }

  /**
   * Initialize the session (called automatically on first send)
   */
  async initialize(): Promise<SDKInitMessage> {
    if (this.initialized) {
      throw new Error("Session already initialized");
    }

    sessionLog("init", "connecting transport...");
    await this.transport.connect();
    sessionLog("init", "transport connected, sending initialize request");

    // Send initialize control request
    await this.transport.write({
      type: "control_request",
      request_id: "init_1",
      request: { subtype: "initialize" },
    });

    // Wait for init message
    sessionLog("init", "waiting for init message from CLI...");
    for await (const msg of this.transport.messages()) {
      sessionLog("init", `received wire message: type=${msg.type}`);
      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        const initMsg = msg as WireMessage & {
          agent_id: string;
          session_id: string;
          conversation_id: string;
          model: string;
          tools: string[];
        };
        this._agentId = initMsg.agent_id;
        this._sessionId = initMsg.session_id;
        this._conversationId = initMsg.conversation_id;
        this.initialized = true;

        sessionLog("init", `initialized: agent=${initMsg.agent_id} conversation=${initMsg.conversation_id} model=${initMsg.model} tools=${initMsg.tools?.length || 0}`);

        return {
          type: "init",
          agentId: initMsg.agent_id,
          sessionId: initMsg.session_id,
          conversationId: initMsg.conversation_id,
          model: initMsg.model,
          tools: initMsg.tools,
        };
      }
    }

    sessionLog("init", "ERROR: transport closed before init message received");
    throw new Error("Failed to initialize session - no init message received");
  }

  /**
   * Send a message to the agent
   * 
   * @param message - Text string or multimodal content array
   * 
   * @example
   * // Simple text
   * await session.send("Hello!");
   * 
   * @example
   * // With image
   * await session.send([
   *   { type: "text", text: "What's in this image?" },
   *   { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }
   * ]);
   */
  async send(message: SendMessage): Promise<void> {
    if (!this.initialized) {
      sessionLog("send", "auto-initializing (not yet initialized)");
      await this.initialize();
    }

    const preview = typeof message === "string"
      ? message.slice(0, 100)
      : Array.isArray(message) ? `[multimodal: ${message.length} parts]` : String(message).slice(0, 100);
    sessionLog("send", `sending message: ${preview}${typeof message === "string" && message.length > 100 ? "..." : ""}`);

    await this.transport.write({
      type: "user",
      message: { role: "user", content: message },
    });
    sessionLog("send", "message written to transport");
  }

  /**
   * Stream messages from the agent
   */
  async *stream(): AsyncGenerator<SDKMessage> {
    const streamStart = Date.now();
    let yieldCount = 0;
    let dropCount = 0;
    let gotResult = false;
    sessionLog("stream", `starting stream (agent=${this._agentId}, conversation=${this._conversationId})`);

    for await (const wireMsg of this.transport.messages()) {
      // Handle CLI → SDK control requests (e.g., can_use_tool)
      if (wireMsg.type === "control_request") {
        const controlReq = wireMsg as ControlRequest;
        sessionLog("stream", `control_request: subtype=${controlReq.request.subtype} tool=${(controlReq.request as CanUseToolControlRequest).tool_name || "N/A"}`);
        if (controlReq.request.subtype === "can_use_tool") {
          await this.handleCanUseTool(
            controlReq.request_id,
            controlReq.request as CanUseToolControlRequest
          );
          continue;
        }
      }

      const sdkMsg = this.transformMessage(wireMsg);
      if (sdkMsg) {
        yieldCount++;
        sessionLog("stream", `yield #${yieldCount}: type=${sdkMsg.type}${sdkMsg.type === "result" ? ` success=${(sdkMsg as SDKResultMessage).success} error=${(sdkMsg as SDKResultMessage).error || "none"}` : ""}`);
        yield sdkMsg;

        // Stop on result message
        if (sdkMsg.type === "result") {
          gotResult = true;
          break;
        }
      } else {
        dropCount++;
        const wireMsgAny = wireMsg as unknown as Record<string, unknown>;
        sessionLog("stream", `DROPPED wire message #${dropCount}: type=${wireMsg.type} message_type=${wireMsgAny.message_type || "N/A"} subtype=${wireMsgAny.subtype || "N/A"}`);
      }
    }

    const elapsed = Date.now() - streamStart;
    sessionLog("stream", `stream ended: duration=${elapsed}ms yielded=${yieldCount} dropped=${dropCount} gotResult=${gotResult}`);
    if (!gotResult) {
      sessionLog("stream", `WARNING: stream ended WITHOUT a result message -- transport may have closed unexpectedly`);
    }
  }

  /**
   * Handle can_use_tool control request from CLI (Claude SDK compatible format)
   */
  private async handleCanUseTool(
    requestId: string,
    req: CanUseToolControlRequest
  ): Promise<void> {
    let response: CanUseToolResponse;

    sessionLog("canUseTool", `tool=${req.tool_name} mode=${this.options.permissionMode || "default"} requestId=${requestId}`);

    // If bypassPermissions mode, auto-allow all tools
    if (this.options.permissionMode === "bypassPermissions") {
      sessionLog("canUseTool", `AUTO-ALLOW ${req.tool_name} (bypassPermissions)`);
      response = {
        behavior: "allow",
        updatedInput: null,
        updatedPermissions: [],
      } satisfies CanUseToolResponseAllow;
    } else if (this.options.canUseTool) {
      try {
        const result = await this.options.canUseTool(req.tool_name, req.input);
        if (result.behavior === "allow") {
          response = {
            behavior: "allow",
            updatedInput: result.updatedInput ?? null,
            updatedPermissions: [], // TODO: not implemented
          } satisfies CanUseToolResponseAllow;
        } else {
          response = {
            behavior: "deny",
            message: result.message ?? "Denied by canUseTool callback",
            interrupt: false, // TODO: not wired up yet
          } satisfies CanUseToolResponseDeny;
        }
      } catch (err) {
        response = {
          behavior: "deny",
          message: err instanceof Error ? err.message : "Callback error",
          interrupt: false,
        };
      }
    } else {
      // No callback registered - deny by default
      response = {
        behavior: "deny",
        message: "No canUseTool callback registered",
        interrupt: false,
      };
    }

    // Send control_response (Claude SDK compatible format)
    const responseBehavior = "behavior" in response ? response.behavior : "unknown";
    sessionLog("canUseTool", `responding: requestId=${requestId} behavior=${responseBehavior}`);
    await this.transport.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    });
    sessionLog("canUseTool", `response sent for ${req.tool_name}`);
  }

  /**
   * Abort the current operation (interrupt without closing the session)
   */
  async abort(): Promise<void> {
    sessionLog("abort", `aborting session (agent=${this._agentId})`);
    await this.transport.write({
      type: "control_request",
      request_id: `interrupt-${Date.now()}`,
      request: { subtype: "interrupt" },
    });
  }

  /**
   * Close the session
   */
  close(): void {
    sessionLog("close", `closing session (agent=${this._agentId}, conversation=${this._conversationId})`);
    this.transport.close();
  }

  /**
   * Get the agent ID (available after initialization)
   */
  get agentId(): string | null {
    return this._agentId;
  }

  /**
   * Get the session ID (available after initialization)
   */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Get the conversation ID (available after initialization)
   */
  get conversationId(): string | null {
    return this._conversationId;
  }

  /**
   * AsyncDisposable implementation for `await using`
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  /**
   * Transform wire message to SDK message
   */
  private transformMessage(wireMsg: WireMessage): SDKMessage | null {
    // Init message
    if (wireMsg.type === "system" && "subtype" in wireMsg && wireMsg.subtype === "init") {
      const msg = wireMsg as WireMessage & {
        agent_id: string;
        session_id: string;
        conversation_id: string;
        model: string;
        tools: string[];
      };
      return {
        type: "init",
        agentId: msg.agent_id,
        sessionId: msg.session_id,
        conversationId: msg.conversation_id,
        model: msg.model,
        tools: msg.tools,
      };
    }

    // Handle message types (all have type: "message" with message_type field)
    if (wireMsg.type === "message" && "message_type" in wireMsg) {
      const msg = wireMsg as WireMessage & {
        message_type: string;
        uuid: string;
        // assistant_message fields
        content?: string;
        // tool_call_message fields
        tool_call?: { name: string; arguments: string; tool_call_id: string };
        tool_calls?: Array<{ name: string; arguments: string; tool_call_id: string }>;
        // tool_return_message fields
        tool_call_id?: string;
        tool_return?: string;
        status?: "success" | "error";
        // reasoning_message fields
        reasoning?: string;
      };

      // Assistant message
      if (msg.message_type === "assistant_message" && msg.content) {
        return {
          type: "assistant",
          content: msg.content,
          uuid: msg.uuid,
        };
      }

      // Tool call message
      if (msg.message_type === "tool_call_message") {
        const toolCall = msg.tool_calls?.[0] || msg.tool_call;
        if (toolCall) {
          let toolInput: Record<string, unknown> = {};
          try {
            toolInput = JSON.parse(toolCall.arguments);
          } catch {
            toolInput = { raw: toolCall.arguments };
          }
          return {
            type: "tool_call",
            toolCallId: toolCall.tool_call_id,
            toolName: toolCall.name,
            toolInput,
            uuid: msg.uuid,
          };
        }
      }

      // Tool return message
      if (msg.message_type === "tool_return_message" && msg.tool_call_id) {
        return {
          type: "tool_result",
          toolCallId: msg.tool_call_id,
          content: msg.tool_return || "",
          isError: msg.status === "error",
          uuid: msg.uuid,
        };
      }

      // Reasoning message
      if (msg.message_type === "reasoning_message" && msg.reasoning) {
        return {
          type: "reasoning",
          content: msg.reasoning,
          uuid: msg.uuid,
        };
      }
    }

    // Stream event (partial message updates)
    if (wireMsg.type === "stream_event") {
      const msg = wireMsg as WireMessage & {
        event: {
          type: string;
          index?: number;
          delta?: { type?: string; text?: string; reasoning?: string };
          content_block?: { type?: string; text?: string };
        };
        uuid: string;
      };
      return {
        type: "stream_event",
        event: msg.event,
        uuid: msg.uuid,
      };
    }

    // Result message
    if (wireMsg.type === "result") {
      const msg = wireMsg as WireMessage & {
        subtype: string;
        result?: string;
        duration_ms: number;
        total_cost_usd?: number;
        conversation_id: string;
        stop_reason?: string;
      };
      return {
        type: "result",
        success: msg.subtype === "success",
        result: msg.result,
        error: msg.subtype !== "success" ? msg.subtype : undefined,
        stopReason: msg.stop_reason,
        durationMs: msg.duration_ms,
        totalCostUsd: msg.total_cost_usd,
        conversationId: msg.conversation_id,
      };
    }

    // Skip other message types (system_message, user_message, etc.)
    return null;
  }
}
