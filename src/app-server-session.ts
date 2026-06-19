import {
  createAppServerClient,
  type AppServerChannel,
  type AppServerClient,
  type AppServerExternalToolCallHandler,
  type AppServerMessageHandler,
  type AppServerSocketConstructor,
} from "@letta-ai/letta-code/app-server-client";
import type {
  AnyAgentTool,
  BootstrapStateOptions,
  BootstrapStateResult,
  CreateAgentOptions,
  LettaCodeRemoteClientOptions,
  LettaCodeSession,
  LettaCodeClientSessionOptions,
  ListMessagesOptions,
  ListMessagesResult,
  MessageContentItem,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  RunTurnOptions,
  SDKErrorCode,
  SDKInitMessage,
  SDKMessage,
  SDKResultMessage,
  SDKStreamEventPayload,
  SendMessage,
} from "./types.js";

type RuntimeScope = {
  agent_id: string;
  conversation_id: string;
};

type ProtocolMessage = Record<string, unknown> & {
  type: string;
  request_id?: string;
  runtime?: RuntimeScope;
};

type RuntimeStartResponse = ProtocolMessage & {
  type: "runtime_start_response";
  success: boolean;
  runtime: RuntimeScope | null;
  agent: (Record<string, unknown> & { id?: string; model?: string | null }) | null;
  conversation: (Record<string, unknown> & { id?: string; agent_id?: string }) | null;
  error?: string;
};

type ConversationRetrieveResponse = ProtocolMessage & {
  type: "conversation_retrieve_response";
  success: boolean;
  conversation: (Record<string, unknown> & { id?: string; agent_id?: string }) | null;
  error?: string;
};

type AppServerTurnResult = Awaited<ReturnType<AppServerClient["runTurn"]>>;

type RuntimeStartCommand = Parameters<AppServerClient["runtimeStart"]>[0];
type InputCommand = Parameters<AppServerClient["runTurn"]>[0];

type AppServerSessionOptions = LettaCodeRemoteClientOptions & {
  /**
   * Cloud status websockets fan out device frames to every subscriber rather
   * than honoring local app-server's split control/stream channels. Enable this
   * for cloud-backed sessions so assistant deltas are not double-counted.
   */
  ignoreControlStreamDeltas?: boolean;
};

export type AppServerSessionMode =
  | { kind: "create-agent"; options: CreateAgentOptions }
  | {
      kind: "session";
      agentId?: string;
      conversationId?: string;
      newConversation?: boolean;
      defaultConversation?: boolean;
      options: LettaCodeClientSessionOptions;
    };

const SDK_AGENT_ORIGIN_TAG = "origin:letta-code";
const FAILURE_STOP_REASONS = new Set(["error", "llm_api_error", "max_steps", "interrupted"]);
const KNOWN_SDK_ERROR_CODES = new Set<SDKErrorCode>([
  "approval_conflict",
  "approval_conflict_terminal",
  "protocol_error",
  "error",
  "llm_api_error",
  "max_steps",
  "interrupted",
  "stream_closed",
]);

function toSdkErrorCode(value: string | null | undefined): SDKErrorCode | undefined {
  if (!value || value.length === 0) return undefined;
  return KNOWN_SDK_ERROR_CODES.has(value as SDKErrorCode)
    ? (value as SDKErrorCode)
    : undefined;
}

function isApprovalConflictSignal(params: {
  detail?: string;
  message?: string;
  stopReason?: string | null;
}): boolean {
  if (params.stopReason === "requires_approval") return true;
  const haystack = [params.detail, params.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
  return (
    haystack.includes("waiting for approval on a tool call") ||
    haystack.includes("cannot send a new message") ||
    haystack.includes("requires_approval")
  );
}

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

function includeSdkAgentOriginTag(tags: string[] | undefined): string[] {
  const normalizedTags: string[] = [];
  let hasOriginTag = false;

  for (const tag of tags ?? []) {
    if (tag === SDK_AGENT_ORIGIN_TAG) {
      if (hasOriginTag) continue;
      hasOriginTag = true;
    }
    normalizedTags.push(tag);
  }

  if (!hasOriginTag) {
    normalizedTags.push(SDK_AGENT_ORIGIN_TAG);
  }

  return normalizedTags;
}

function assertRemoteCreateAgentOptionsSupported(options: CreateAgentOptions): void {
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error("Remote app-server createAgent() does not yet support allowedTools/disallowedTools.");
  }
  if (options.canUseTool !== undefined) {
    throw new Error("Remote app-server createAgent() does not yet support canUseTool callbacks.");
  }
  if (options.memfs !== undefined) {
    throw new Error("Remote app-server createAgent() does not yet support per-agent memfs toggles.");
  }
  if (options.skillSources !== undefined) {
    throw new Error("Remote app-server createAgent() does not yet support skillSources overrides.");
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error("Remote app-server createAgent() does not yet support systemInfoReminder overrides.");
  }
  if (options.sleeptime !== undefined) {
    throw new Error("Remote app-server createAgent() does not yet support sleeptime overrides.");
  }
}

export function assertRemoteSessionOptionsSupported(
  action: string,
  options: LettaCodeClientSessionOptions,
): void {
  if (options.model !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support model overrides for existing agents.`);
  }
  if (options.systemPrompt !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support systemPrompt overrides for existing agents.`);
  }
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support allowedTools/disallowedTools.`);
  }
  if (options.canUseTool !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support canUseTool callbacks.`);
  }
  if (options.memfs !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support per-session memfs toggles.`);
  }
  if (options.skillSources !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support skillSources overrides.`);
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support systemInfoReminder overrides.`);
  }
  if (options.sleeptime !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support sleeptime overrides.`);
  }
  if (options.memfsStartup !== undefined) {
    throw new Error(`Remote app-server ${action}() does not yet support memfsStartup overrides.`);
  }
  if (options.includePartialMessages !== undefined) {
    throw new Error(`Remote app-server ${action}() streams app-server deltas directly and does not support includePartialMessages.`);
  }
}

function mapPermissionMode(mode: LettaCodeClientSessionOptions["permissionMode"]): string | undefined {
  if (mode === undefined || mode === "default") return undefined;
  if (mode === "acceptEdits") return "acceptEdits";
  if (mode === "bypassPermissions") return "unrestricted";
  throw new Error("Remote app-server sessions do not yet support permissionMode 'plan'.");
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        pieces.push(part);
        continue;
      }
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") {
          pieces.push(record.text);
        }
      }
    }
    const joined = pieces.join("");
    return joined.length > 0 ? joined : null;
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }
  return null;
}

function toolInputFromArguments(args: unknown): { input: Record<string, unknown>; raw?: string } {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return { input: args as Record<string, unknown> };
  }
  const raw = typeof args === "string" ? args : "";
  if (!raw) return { input: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown>, raw };
    }
  } catch {
    // Fall through to raw wrapper.
  }
  return { input: { raw }, raw };
}

function firstToolCall(delta: Record<string, unknown>): Record<string, unknown> | undefined {
  const toolCalls = delta.tool_calls;
  if (Array.isArray(toolCalls)) {
    const first = toolCalls[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }
  if (toolCalls && typeof toolCalls === "object") {
    return toolCalls as Record<string, unknown>;
  }
  const toolCall = delta.tool_call;
  return toolCall && typeof toolCall === "object" ? (toolCall as Record<string, unknown>) : undefined;
}

function firstToolReturn(delta: Record<string, unknown>): Record<string, unknown> | undefined {
  const toolReturns = delta.tool_returns;
  if (Array.isArray(toolReturns)) {
    const first = toolReturns[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }
  return undefined;
}

function normalizeSendMessage(message: SendMessage): string | MessageContentItem[] {
  return message;
}

export function createAgentBody(options: CreateAgentOptions): Record<string, unknown> {
  assertRemoteCreateAgentOptionsSupported(options);

  const body: Record<string, unknown> = {
    tags: includeSdkAgentOriginTag(options.tags),
  };

  if (options.model !== undefined) body.model = options.model;
  if (options.embedding !== undefined) body.embedding = options.embedding;

  if (options.systemPrompt !== undefined) {
    if (typeof options.systemPrompt === "string") {
      if (isPresetSystemPrompt(options.systemPrompt)) {
        throw new Error("Remote app-server createAgent() does not yet support system prompt presets.");
      }
      body.system = options.systemPrompt;
    } else {
      throw new Error("Remote app-server createAgent() does not yet support system prompt preset objects.");
    }
  }

  const memoryBlocks: Array<Record<string, unknown>> = [];
  const blockIds: string[] = [];
  for (const item of options.memory ?? []) {
    if (typeof item === "string") {
      throw new Error("Remote app-server createAgent() does not yet support memory preset names.");
    }
    if ("blockId" in item) {
      blockIds.push(item.blockId);
    } else {
      memoryBlocks.push(item as unknown as Record<string, unknown>);
    }
  }
  if (options.persona !== undefined) {
    memoryBlocks.push({ label: "persona", value: options.persona });
  }
  if (options.human !== undefined) {
    memoryBlocks.push({ label: "human", value: options.human });
  }
  if (memoryBlocks.length > 0) body.memory_blocks = memoryBlocks;
  if (blockIds.length > 0) body.block_ids = blockIds;

  return body;
}

function externalToolGroups(tools: AnyAgentTool[] | undefined): Array<Record<string, unknown>> | undefined {
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

function requestControl(
  client: AppServerClient,
  type: string,
  body: Record<string, unknown>,
  predicate: (message: ProtocolMessage) => boolean,
): Promise<ProtocolMessage> {
  const request = client.request.bind(client) as unknown as (
    commandType: string,
    commandBody: Record<string, unknown>,
    options?: { predicate?: (message: ProtocolMessage) => boolean },
  ) => Promise<ProtocolMessage>;
  return request(type, body, { predicate });
}

export class AppServerSession implements LettaCodeSession {
  private client: AppServerClient | null = null;
  private runtime: RuntimeScope | null = null;
  private initialized = false;
  private closed = false;
  private streamQueue: SDKMessage[] = [];
  private streamResolvers: Array<(msg: SDKMessage | null) => void> = [];
  private removeMessageHandler: (() => void) | null = null;
  private removeExternalToolHandler: (() => void) | null = null;
  private externalTools = new Map<string, AnyAgentTool>();
  private activeTurn: Promise<void> | null = null;
  private activeTurnStartedAt = 0;
  private activeTurnAssistantText = "";
  private messageCounter = 0;
  private _agentId: string | null = null;
  private _sessionId: string | null = null;
  private _conversationId: string | null = null;
  private _model = "";

  constructor(
    private readonly remoteOptions: AppServerSessionOptions,
    private readonly mode: AppServerSessionMode,
  ) {
    const tools = mode.kind === "create-agent" ? mode.options.tools : mode.options.tools;
    for (const tool of tools ?? []) {
      this.externalTools.set(tool.name, tool);
    }
  }

  async initialize(): Promise<SDKInitMessage> {
    if (this.initialized) {
      throw new Error("Session already initialized");
    }
    if (this.closed) {
      throw new Error("Session is closed");
    }

    this.client = createAppServerClient({
      url: this.remoteOptions.url,
      ...(this.remoteOptions.WebSocket
        ? { WebSocket: this.remoteOptions.WebSocket as AppServerSocketConstructor }
        : {}),
      ...(this.remoteOptions.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.remoteOptions.requestTimeoutMs }
        : {}),
    });
    this.removeMessageHandler = this.client.onMessage(
      this.handleAppServerMessage as unknown as AppServerMessageHandler,
    );
    if (this.externalTools.size > 0) {
      this.removeExternalToolHandler = this.client.onExternalToolCall(this.handleExternalToolCall);
    }

    await this.client.connect();
    const response = await this.startRuntime();
    if (!response.success || !response.runtime) {
      throw new Error(response.error ?? "Failed to start app-server runtime");
    }

    this.runtime = response.runtime;
    this._agentId = response.runtime.agent_id;
    this._conversationId = response.runtime.conversation_id;
    this._sessionId = `${response.runtime.agent_id}:${response.runtime.conversation_id}`;
    this._model = typeof response.agent?.model === "string" ? response.agent.model : "";
    this.initialized = true;

    return {
      type: "init",
      agentId: response.runtime.agent_id,
      sessionId: this._sessionId,
      conversationId: response.runtime.conversation_id,
      model: this._model,
      tools: Array.from(this.externalTools.keys()),
    };
  }

  async send(message: SendMessage): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.client || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    if (this.activeTurn) {
      throw new Error("A turn is already in flight for this app-server session");
    }

    this.streamQueue.length = 0;
    this.activeTurnAssistantText = "";
    this.activeTurnStartedAt = Date.now();

    const command: InputCommand = {
      runtime: this.runtime,
      payload: {
        kind: "create_message",
        messages: [
          {
            role: "user",
            content: normalizeSendMessage(message),
          },
        ],
      },
    } as InputCommand;

    this.activeTurn = this.client
      .runTurn(command, {
        allowLoopStatusFallback: true,
        ...(this.remoteOptions.requestTimeoutMs !== undefined
          ? { timeoutMs: this.remoteOptions.requestTimeoutMs }
          : {}),
      })
      .then((turn) => {
        this.enqueue(this.resultFromTurn(turn));
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.enqueue({
          type: "error",
          message: detail,
          errorCode: "error",
          stopReason: "error",
          errorDetail: detail,
          recoverable: false,
        });
        this.enqueue({
          type: "result",
          success: false,
          error: "error",
          errorCode: "error",
          recoverable: false,
          errorDetail: detail,
          durationMs: Date.now() - this.activeTurnStartedAt,
          conversationId: this._conversationId,
        });
      })
      .finally(() => {
        this.activeTurn = null;
      });
  }

  async runTurn(
    message: SendMessage,
    _options: RunTurnOptions = {},
  ): Promise<SDKResultMessage> {
    await this.send(message);
    for await (const msg of this.stream()) {
      if (msg.type === "result") {
        return msg;
      }
    }
    return {
      type: "result",
      success: false,
      error: "stream_closed",
      errorCode: "stream_closed",
      recoverable: false,
      errorDetail: "Stream ended before terminal result",
      durationMs: Date.now() - this.activeTurnStartedAt,
      conversationId: this._conversationId,
    };
  }

  async *stream(): AsyncGenerator<SDKMessage> {
    while (true) {
      const msg = await this.nextMessage();
      if (!msg) break;
      yield msg;
      if (msg.type === "result") break;
    }
  }

  async recoverPendingApprovals(
    _options: RecoverPendingApprovalsOptions = {},
  ): Promise<RecoverPendingApprovalsResult> {
    return {
      recovered: false,
      unsupported: true,
      detail: "Remote app-server sessions do not yet support approval recovery through the SDK.",
    };
  }

  async listMessages(_options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    throw new Error("Remote app-server sessions do not yet support listMessages().");
  }

  async bootstrapState(
    _options: BootstrapStateOptions = {},
  ): Promise<BootstrapStateResult> {
    throw new Error("Remote app-server sessions do not yet support bootstrapState().");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.removeExternalToolHandler?.();
    this.removeMessageHandler?.();
    this.client?.close();
    this.client = null;
    this.resolveAll(null);
  }

  get agentId(): string | null {
    return this._agentId;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  private async startRuntime(): Promise<RuntimeStartResponse> {
    if (!this.client) throw new Error("App-server client is not connected");

    const command = await this.buildRuntimeStartCommand();
    const response = (await this.client.runtimeStart(command)) as unknown as RuntimeStartResponse;
    return response;
  }

  private async buildRuntimeStartCommand(): Promise<RuntimeStartCommand> {
    const options = this.mode.kind === "create-agent" ? this.mode.options : this.mode.options;
    const command: Record<string, unknown> = {
      client_info: {
        name: "@letta-ai/letta-code-sdk",
        title: "Letta Code SDK",
      },
      recover_approvals: false,
      force_device_status: true,
    };

    const mode = mapPermissionMode(options.permissionMode);
    if (mode) command.mode = mode;
    if (options.cwd !== undefined) command.cwd = options.cwd;
    const groups = externalToolGroups(options.tools);
    if (groups) command.external_tools = groups;

    if (this.mode.kind === "create-agent") {
      command.create_agent = {
        body: createAgentBody(this.mode.options),
        pin_global: true,
      };
      return command as RuntimeStartCommand;
    }

    if (this.mode.agentId) {
      command.agent_id = this.mode.agentId;
      if (this.mode.newConversation) {
        command.create_conversation = { body: {} };
      } else if (this.mode.defaultConversation) {
        command.conversation_id = "default";
      }
      return command as RuntimeStartCommand;
    }

    if (this.mode.conversationId) {
      const agentId = await this.resolveConversationAgentId(this.mode.conversationId);
      command.agent_id = agentId;
      command.conversation_id = this.mode.conversationId;
      return command as RuntimeStartCommand;
    }

    throw new Error(
      "Remote app-server createSession() requires an agent id. Call createAgent() first or pass an agent id.",
    );
  }

  private async resolveConversationAgentId(conversationId: string): Promise<string> {
    if (!this.client) throw new Error("App-server client is not connected");
    const response = (await requestControl(
      this.client,
      "conversation_retrieve",
      { conversation_id: conversationId },
      (message) => message.type === "conversation_retrieve_response",
    )) as ConversationRetrieveResponse;
    if (!response.success || !response.conversation?.agent_id) {
      throw new Error(response.error ?? `Failed to retrieve conversation ${conversationId}`);
    }
    return response.conversation.agent_id;
  }

  private handleAppServerMessage = (
    message: ProtocolMessage,
    channel?: AppServerChannel,
  ): void => {
    if (
      this.remoteOptions.ignoreControlStreamDeltas === true &&
      channel === "control" &&
      message.type === "stream_delta"
    ) {
      return;
    }
    if (!this.runtime || message.type !== "stream_delta") return;
    const runtime = message.runtime;
    if (
      !runtime ||
      runtime.agent_id !== this.runtime.agent_id ||
      runtime.conversation_id !== this.runtime.conversation_id
    ) {
      return;
    }

    const delta = message.delta;
    if (!delta || typeof delta !== "object") return;
    const sdkMessage = this.transformStreamDelta(delta as Record<string, unknown>);
    if (sdkMessage) {
      this.enqueue(sdkMessage);
    }
  };

  private handleExternalToolCall: AppServerExternalToolCallHandler = async (request) => {
    const tool = this.externalTools.get(request.tool_name);
    if (!tool) {
      throw new Error(`Unknown external tool: ${request.tool_name}`);
    }
    const result = await tool.execute(request.tool_call_id, request.input);
    return {
      content: result.content.map((part) => ({
        type: part.type,
        ...(part.text !== undefined ? { text: part.text } : {}),
        ...(part.data !== undefined ? { data: part.data } : {}),
        ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
      })),
    };
  };

  private transformStreamDelta(delta: Record<string, unknown>): SDKMessage | null {
    const messageType = typeof delta.message_type === "string" ? delta.message_type : undefined;
    const runId = typeof delta.run_id === "string" ? delta.run_id : undefined;
    const uuid = typeof delta.id === "string" ? delta.id : `app-server-${++this.messageCounter}`;

    if (messageType === "assistant_message") {
      const content = extractTextFromContent(delta.content);
      if (!content) return null;
      this.activeTurnAssistantText += content;
      return { type: "assistant", content, uuid, runId };
    }

    if (messageType === "reasoning_message") {
      const content = typeof delta.reasoning === "string"
        ? delta.reasoning
        : extractTextFromContent(delta.content);
      if (!content) return null;
      return { type: "reasoning", content, uuid, runId };
    }

    if (messageType === "tool_call_message" || messageType === "approval_request_message") {
      const toolCall = firstToolCall(delta);
      if (!toolCall) return null;
      const fn = toolCall.function && typeof toolCall.function === "object"
        ? (toolCall.function as Record<string, unknown>)
        : undefined;
      const toolCallId =
        (typeof toolCall.tool_call_id === "string" ? toolCall.tool_call_id : undefined) ??
        (typeof toolCall.id === "string" ? toolCall.id : undefined);
      if (!toolCallId) {
        const detail = `Missing tool_call_id in ${messageType} (uuid=${uuid})`;
        return {
          type: "error",
          message: detail,
          errorCode: "protocol_error",
          stopReason: "protocol_error",
          runId,
          recoverable: false,
          errorDetail: detail,
        };
      }
      const toolName =
        (typeof toolCall.name === "string" ? toolCall.name : undefined) ??
        (typeof fn?.name === "string" ? fn.name : undefined) ??
        "?";
      const { input, raw } = toolInputFromArguments(toolCall.arguments ?? fn?.arguments);
      return {
        type: "tool_call",
        toolCallId,
        toolName,
        toolInput: input,
        rawArguments: raw,
        uuid,
        runId,
      };
    }

    if (messageType === "tool_return_message") {
      const toolReturn = firstToolReturn(delta);
      const toolCallId =
        (typeof delta.tool_call_id === "string" ? delta.tool_call_id : undefined) ??
        (typeof toolReturn?.tool_call_id === "string" ? toolReturn.tool_call_id : undefined);
      if (!toolCallId) return null;
      const content = extractTextFromContent(delta.tool_return ?? toolReturn?.tool_return) ?? "";
      const status = typeof delta.status === "string" ? delta.status : toolReturn?.status;
      return {
        type: "tool_result",
        toolCallId,
        content,
        isError: status === "error",
        uuid,
        runId,
      };
    }

    if (messageType === "error_message" || messageType === "loop_error") {
      const detail =
        (typeof delta.detail === "string" ? delta.detail : undefined) ??
        (typeof delta.message === "string" ? delta.message : undefined) ??
        "App-server turn failed";
      const stopReason =
        (typeof delta.stop_reason === "string" ? delta.stop_reason : undefined) ??
        (typeof delta.error_type === "string" ? delta.error_type : undefined) ??
        "error";
      const approvalConflict = isApprovalConflictSignal({
        detail,
        message: typeof delta.message === "string" ? delta.message : undefined,
        stopReason,
      });
      return {
        type: "error",
        message: detail,
        errorCode: approvalConflict ? "approval_conflict" : toSdkErrorCode(stopReason),
        approvalConflict: approvalConflict || undefined,
        recoverable: approvalConflict ? true : false,
        errorDetail: detail,
        stopReason,
        runId,
      };
    }

    if (messageType === "retry") {
      return {
        type: "retry",
        reason: typeof delta.reason === "string" ? delta.reason : "error",
        attempt: typeof delta.attempt === "number" ? delta.attempt : 0,
        maxAttempts: typeof delta.max_attempts === "number" ? delta.max_attempts : 0,
        delayMs: typeof delta.delay_ms === "number" ? delta.delay_ms : 0,
        runId,
      };
    }

    if (messageType === "stop_reason" || messageType === "ping") {
      return null;
    }

    return {
      type: "stream_event",
      event: delta as SDKStreamEventPayload,
      uuid,
    };
  }

  private resultFromTurn(turn: AppServerTurnResult): SDKResultMessage {
    const stopReason = turn.stopReason ?? undefined;
    const approvalConflict = isApprovalConflictSignal({ stopReason });
    const success = !approvalConflict && !FAILURE_STOP_REASONS.has(stopReason ?? "");
    const errorCode = approvalConflict ? "approval_conflict" : toSdkErrorCode(stopReason);

    return {
      type: "result",
      success,
      result: this.activeTurnAssistantText || undefined,
      error: success ? undefined : (errorCode ?? stopReason ?? "error"),
      errorCode: success ? undefined : (errorCode ?? "error"),
      approvalConflict: approvalConflict || undefined,
      recoverable: approvalConflict ? true : undefined,
      stopReason,
      durationMs: Date.now() - this.activeTurnStartedAt,
      conversationId: turn.runtime.conversation_id,
      runIds: turn.runIds.length > 0 ? turn.runIds : undefined,
    };
  }

  private enqueue(message: SDKMessage): void {
    const resolver = this.streamResolvers.shift();
    if (resolver) {
      resolver(message);
      return;
    }
    this.streamQueue.push(message);
  }

  private nextMessage(): Promise<SDKMessage | null> {
    const next = this.streamQueue.shift();
    if (next) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.streamResolvers.push(resolve);
    });
  }

  private resolveAll(value: SDKMessage | null): void {
    for (const resolve of this.streamResolvers.splice(0)) {
      resolve(value);
    }
  }
}
