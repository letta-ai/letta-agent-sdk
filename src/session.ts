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
  AnyAgentTool,
  ExecuteExternalToolRequest,
} from "./types.js";
import {
  isHeadlessAutoAllowTool,
  requiresRuntimeUserInput,
} from "./interactiveToolPolicy.js";


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
  private externalTools: Map<string, AnyAgentTool> = new Map();


  constructor(
    private options: InternalSessionOptions = {}
  ) {
    // Note: Validation happens in public API functions (createSession, createAgent, etc.)
    this.transport = new SubprocessTransport(options);

    // Store external tools in a map for quick lookup
    if (options.tools) {
      for (const tool of options.tools) {
        this.externalTools.set(tool.name, tool);
      }
    }
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

        // Register external tools with CLI
        if (this.externalTools.size > 0) {
          await this.registerExternalTools();
        }

        // Include external tool names in the tools list
        const allTools = [
          ...initMsg.tools,
          ...Array.from(this.externalTools.keys()),
        ];

        sessionLog("init", `initialized: agent=${initMsg.agent_id} conversation=${initMsg.conversation_id} model=${initMsg.model} tools=${allTools.length} (${this.externalTools.size} external)`);

        return {
          type: "init",
          agentId: initMsg.agent_id,
          sessionId: initMsg.session_id,
          conversationId: initMsg.conversation_id,
          model: initMsg.model,
          tools: allTools,
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
      // Handle CLI → SDK control requests (e.g., can_use_tool, execute_external_tool)
      if (wireMsg.type === "control_request") {
        const controlReq = wireMsg as ControlRequest;
        // Widen to string to allow SDK-extension subtypes not in the protocol union
        const subtype: string = controlReq.request.subtype;
        sessionLog("stream", `control_request: subtype=${subtype} tool=${(controlReq.request as CanUseToolControlRequest).tool_name || "N/A"}`);

        if (subtype === "can_use_tool") {
          await this.handleCanUseTool(
            controlReq.request_id,
            controlReq.request as CanUseToolControlRequest
          );
          continue;
        }
        if (subtype === "execute_external_tool") {
          // SDK extension: not in protocol ControlRequestBody union, extract fields via Record
          const rawReq = controlReq.request as Record<string, unknown>;
          await this.handleExecuteExternalTool(
            controlReq.request_id,
            {
              subtype: "execute_external_tool",
              tool_call_id: rawReq.tool_call_id as string,
              tool_name: rawReq.tool_name as string,
              input: rawReq.input as Record<string, unknown>,
            }
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
   * Register external tools with the CLI
   */
  private async registerExternalTools(): Promise<void> {
    const toolDefs = Array.from(this.externalTools.values()).map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      // Convert TypeBox schema to plain JSON Schema
      parameters: this.schemaToJsonSchema(tool.parameters),
    }));

    sessionLog("registerTools", `registering ${toolDefs.length} external tools: ${toolDefs.map(t => t.name).join(", ")}`);

    await this.transport.write({
      type: "control_request",
      request_id: `register_tools_${Date.now()}`,
      request: {
        subtype: "register_external_tools",
        tools: toolDefs,
      },
    });
  }

  /**
   * Convert TypeBox schema to JSON Schema
   */
  private schemaToJsonSchema(schema: unknown): Record<string, unknown> {
    // TypeBox schemas are already JSON Schema compatible
    // Just need to extract the schema object
    if (schema && typeof schema === "object") {
      // TypeBox schemas have these JSON Schema properties
      const s = schema as Record<string, unknown>;
      return {
        type: s.type,
        properties: s.properties,
        required: s.required,
        additionalProperties: s.additionalProperties,
        description: s.description,
      };
    }
    return { type: "object" };
  }

  /**
   * Handle execute_external_tool control request from CLI
   */
  private async handleExecuteExternalTool(
    requestId: string,
    req: ExecuteExternalToolRequest
  ): Promise<void> {
    const tool = this.externalTools.get(req.tool_name);
    
    if (!tool) {
      // Tool not found - send error result
      sessionLog("executeExternalTool", `ERROR: unknown tool ${req.tool_name}`);
      await this.transport.write({
        type: "control_response",
        response: {
          subtype: "external_tool_result",
          request_id: requestId,
          tool_call_id: req.tool_call_id,
          content: [{ type: "text", text: `Unknown external tool: ${req.tool_name}` }],
          is_error: true,
        },
      });
      return;
    }

    try {
      sessionLog("executeExternalTool", `executing ${req.tool_name} (call_id=${req.tool_call_id})`);
      // Execute the tool
      const result = await tool.execute(req.tool_call_id, req.input);
      
      // Send success result
      await this.transport.write({
        type: "control_response",
        response: {
          subtype: "external_tool_result",
          request_id: requestId,
          tool_call_id: req.tool_call_id,
          content: result.content,
          is_error: false,
        },
      });
      sessionLog("executeExternalTool", `${req.tool_name} completed successfully`);
    } catch (err) {
      // Send error result
      const errorMessage = err instanceof Error ? err.message : String(err);
      sessionLog("executeExternalTool", `${req.tool_name} failed: ${errorMessage}`);
      await this.transport.write({
        type: "control_response",
        response: {
          subtype: "external_tool_result",
          request_id: requestId,
          tool_call_id: req.tool_call_id,
          content: [{ type: "text", text: `Tool execution error: ${errorMessage}` }],
          is_error: true,
        },
      });
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
    const toolName = req.tool_name;
    const hasCallback = typeof this.options.canUseTool === "function";
    const toolNeedsRuntimeUserInput = requiresRuntimeUserInput(toolName);
    const autoAllowWithoutCallback =
      isHeadlessAutoAllowTool(toolName);

    sessionLog("canUseTool", `tool=${toolName} mode=${this.options.permissionMode || "default"} requestId=${requestId}`);

    // Tools that require runtime user input cannot be auto-allowed without a callback.
    if (toolNeedsRuntimeUserInput && !hasCallback) {
      response = {
        behavior: "deny",
        message: "No canUseTool callback registered",
        interrupt: false,
      };
    } else if (
      this.options.permissionMode === "bypassPermissions" &&
      !toolNeedsRuntimeUserInput
    ) {
      // bypassPermissions auto-allows non-interactive tools.
      sessionLog("canUseTool", `AUTO-ALLOW ${toolName} (bypassPermissions)`);
      response = {
        behavior: "allow",
        updatedInput: null,
        updatedPermissions: [],
      } satisfies CanUseToolResponseAllow;
    } else if (hasCallback) {
      try {
        const result = await this.options.canUseTool!(toolName, req.input);
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
    } else if (autoAllowWithoutCallback) {
      // Default headless behavior matches Claude: EnterPlanMode can proceed
      // without requiring a callback in bidirectional mode.
      sessionLog("canUseTool", `AUTO-ALLOW ${toolName} (default behavior)`);
      response = {
        behavior: "allow",
        updatedInput: null,
        updatedPermissions: [],
      } satisfies CanUseToolResponseAllow;
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
    sessionLog("canUseTool", `response sent for ${toolName}`);
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
