import type {
  BootstrapStateOptions,
  BootstrapStateResult,
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeSession,
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

export type RuntimeScope = {
  agent_id: string;
  conversation_id: string;
};

export type ProtocolMessage = Record<string, unknown> & {
  type: string;
  request_id?: string;
  runtime?: RuntimeScope;
};

export type RuntimeSessionMode =
  | { kind: "create-agent"; options: CreateAgentOptions }
  | {
      kind: "session";
      agentId?: string;
      conversationId?: string;
      newConversation?: boolean;
      defaultConversation?: boolean;
      options: LettaCodeClientSessionOptions;
    };

export type RuntimeTurnResult = {
  runtime: RuntimeScope;
  stopReason: string | null;
  runIds: string[];
  success?: boolean;
  detail?: string;
  errorCode?: SDKErrorCode;
};

export type RuntimeRequestOptions = {
  timeoutMs?: number;
  predicate?: (message: ProtocolMessage) => boolean;
};

export interface RemoteClientRuntimeController {
  onMessage(handler: (message: ProtocolMessage, channel?: string) => void): () => void;
  send(command: Record<string, unknown>): void;
  request(
    type: string,
    body: Record<string, unknown>,
    options?: RuntimeRequestOptions,
  ): Promise<ProtocolMessage>;
  runTurnMessage(
    runtime: RuntimeScope,
    message: SendMessage,
    options?: { timeoutMs?: number },
  ): Promise<RuntimeTurnResult>;
  recoverPendingApprovals(
    runtime: RuntimeScope,
    options?: RecoverPendingApprovalsOptions,
  ): Promise<RecoverPendingApprovalsResult>;
  listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Promise<ListMessagesResult>;
  close(): void;
}

export type RuntimeSessionInit = {
  controller: RemoteClientRuntimeController;
  runtime: RuntimeScope;
  model?: string | null;
  tools?: string[];
};

type RemoteClientSessionCoreConfig = {
  label: string;
  requestTimeoutMs?: number;
};

type ReflectionSettings = {
  trigger: "off" | "step-count" | "compaction-event";
  step_count: number;
};

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

export function mapPermissionMode(
  mode: LettaCodeClientSessionOptions["permissionMode"],
): string | undefined {
  if (mode === undefined || mode === "default") return undefined;
  if (mode === "acceptEdits") return "acceptEdits";
  if (mode === "bypassPermissions") return "unrestricted";
  if (mode === "plan") return "memory";
  return undefined;
}

export function ensureSuccess(message: Record<string, unknown>, fallback: string): void {
  if (message.success === false) {
    throw new Error(typeof message.error === "string" ? message.error : fallback);
  }
}

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

function resolveReflectionSettings(
  sleeptime: LettaCodeClientSessionOptions["sleeptime"],
): ReflectionSettings | null {
  if (!sleeptime) return null;
  return {
    trigger: sleeptime.trigger ?? "step-count",
    step_count: sleeptime.stepCount ?? 5,
  };
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

function sameRuntime(message: ProtocolMessage, runtime: RuntimeScope): boolean {
  const msgRuntime = message.runtime;
  if (msgRuntime) {
    return (
      msgRuntime.agent_id === runtime.agent_id &&
      msgRuntime.conversation_id === runtime.conversation_id
    );
  }
  const messageAgentId =
    typeof message.agent_id === "string"
      ? message.agent_id
      : typeof message.agentId === "string"
        ? message.agentId
        : undefined;
  const messageConversationId =
    typeof message.conversation_id === "string"
      ? message.conversation_id
      : typeof message.conversationId === "string"
        ? message.conversationId
        : undefined;

  if (messageAgentId && messageAgentId !== runtime.agent_id) return false;
  if (messageConversationId && messageConversationId !== runtime.conversation_id) return false;
  return true;
}

export function normalizeSendMessage(message: SendMessage): string | MessageContentItem[] {
  return message;
}

export abstract class RemoteClientSessionCore implements LettaCodeSession {
  protected controller: RemoteClientRuntimeController | null = null;
  protected runtime: RuntimeScope | null = null;
  protected initialized = false;
  protected closed = false;
  protected activeTurnStartedAt = 0;
  protected _agentId: string | null = null;
  protected _sessionId: string | null = null;
  protected _conversationId: string | null = null;
  protected _model = "";

  private readonly label: string;
  private readonly requestTimeoutMs: number | undefined;
  private streamQueue: SDKMessage[] = [];
  private streamResolvers: Array<(msg: SDKMessage | null) => void> = [];
  private removeMessageHandler: (() => void) | null = null;
  private activeTurn: Promise<void> | null = null;
  private activeTurnAssistantText = "";
  private messageCounter = 0;
  private toolNames: string[] | undefined;

  protected constructor(
    protected readonly mode: RuntimeSessionMode,
    config: RemoteClientSessionCoreConfig,
  ) {
    this.label = config.label;
    this.requestTimeoutMs = config.requestTimeoutMs;
  }

  async initialize(): Promise<SDKInitMessage> {
    if (this.initialized) {
      throw new Error("Session already initialized");
    }
    if (this.closed) {
      throw new Error("Session is closed");
    }

    try {
      const init = await this.initializeRuntimeController();
      this.controller = init.controller;
      this.runtime = init.runtime;
      this._agentId = init.runtime.agent_id;
      this._conversationId = init.runtime.conversation_id;
      this._sessionId = `${init.runtime.agent_id}:${init.runtime.conversation_id}`;
      this._model = typeof init.model === "string" ? init.model : "";
      this.toolNames = init.tools;
      this.removeMessageHandler = this.controller.onMessage(this.handleProtocolMessage);
      this.initialized = true;

      await this.afterRuntimeInitialized();
      await this.applyPostInitializeOptions();

      const initMessage: SDKInitMessage = {
        type: "init",
        agentId: init.runtime.agent_id,
        sessionId: this._sessionId,
        conversationId: init.runtime.conversation_id,
        model: this._model,
      };
      if (this.toolNames !== undefined) initMessage.tools = this.toolNames;
      return initMessage;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async send(message: SendMessage): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    if (this.activeTurn) {
      throw new Error(`A turn is already in flight for this ${this.label} session`);
    }

    await this.beforeTurn();

    this.streamQueue.length = 0;
    this.activeTurnAssistantText = "";
    this.activeTurnStartedAt = Date.now();

    const controller = this.controller;
    const runtime = this.runtime;
    this.activeTurn = controller
      .runTurnMessage(runtime, message, {
        ...(this.requestTimeoutMs !== undefined ? { timeoutMs: this.requestTimeoutMs } : {}),
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
    options: RecoverPendingApprovalsOptions = {},
  ): Promise<RecoverPendingApprovalsResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    return this.controller.recoverPendingApprovals(this.runtime, options);
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller) {
      throw new Error("Session is not initialized");
    }
    const conversationId = options.conversationId ?? this._conversationId;
    if (!conversationId) {
      throw new Error("No conversation id available for listMessages()");
    }
    return this.controller.listMessages(conversationId, options);
  }

  async bootstrapState(
    options: BootstrapStateOptions = {},
  ): Promise<BootstrapStateResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    const page = await this.listMessages({
      limit: options.limit,
      order: options.order,
    });

    const state: BootstrapStateResult = {
      agentId: this._agentId ?? "",
      conversationId: this._conversationId ?? "",
      model: this._model,
      messages: page.messages,
    };
    if (this.toolNames !== undefined) {
      state.tools = this.toolNames;
    }
    if (page.nextBefore !== undefined) {
      state.nextBefore = page.nextBefore;
    }
    if (page.hasMore !== undefined) {
      state.hasMore = page.hasMore;
    }
    return state;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.removeMessageHandler?.();
    this.removeMessageHandler = null;
    this.controller?.close();
    this.controller = null;
    this.onCoreClose();
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

  async changeDeviceState(
    updates: {
      cwd?: string;
      permissionMode?: LettaCodeClientSessionOptions["permissionMode"];
      agentId?: string;
      conversationId?: string;
    },
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    const payload: Record<string, unknown> = {};
    if (updates.cwd !== undefined) payload.cwd = updates.cwd;
    const mode = mapPermissionMode(updates.permissionMode);
    if (mode !== undefined) payload.mode = mode;
    if (updates.agentId !== undefined) payload.agent_id = updates.agentId;
    if (updates.conversationId !== undefined) payload.conversation_id = updates.conversationId;

    this.controller.send({
      type: "change_device_state",
      runtime: this.runtime,
      payload,
    });
  }

  async updateToolset(toolsetPreference: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    const response = await this.controller.request(
      "update_toolset",
      {
        runtime: this.runtime,
        toolset_preference: toolsetPreference,
      },
      { predicate: (message) => message.type === "update_toolset_response" },
    );
    ensureSuccess(response, "Failed to update toolset");
  }

  protected abstract initializeRuntimeController(): Promise<RuntimeSessionInit>;

  protected async afterRuntimeInitialized(): Promise<void> {
    // Optional hook for subclasses to send transport-specific startup frames.
  }

  protected async beforeTurn(): Promise<void> {
    // Optional hook for subclasses to refresh transport-specific lifecycle state.
  }

  protected onCoreClose(): void {
    // Optional hook for subclass-owned resources outside the controller.
  }

  protected currentOptions(): LettaCodeClientSessionOptions | CreateAgentOptions {
    return this.mode.options;
  }

  protected shouldEnableMemfs(options: LettaCodeClientSessionOptions | CreateAgentOptions): boolean {
    void options;
    return false;
  }

  protected enableMemfsBody(): Record<string, unknown> {
    if (!this.runtime) return {};
    return { agent_id: this.runtime.agent_id };
  }

  protected setModel(model: string): void {
    this._model = model;
  }

  protected async applyPostInitializeOptions(): Promise<void> {
    if (!this.controller || !this.runtime) return;

    const options = this.currentOptions();

    if (this.shouldEnableMemfs(options)) {
      const response = await this.controller.request(
        "enable_memfs",
        this.enableMemfsBody(),
        { predicate: (message) => message.type === "enable_memfs_response" },
      );
      ensureSuccess(response, "Failed to enable memfs");
    }

    const sleeptimeSettings = resolveReflectionSettings(options.sleeptime);
    if (sleeptimeSettings) {
      const response = await this.controller.request(
        "set_reflection_settings",
        {
          runtime: this.runtime,
          settings: sleeptimeSettings,
          scope: "both",
        },
        { predicate: (message) => message.type === "set_reflection_settings_response" },
      );
      ensureSuccess(response, "Failed to update sleeptime settings");
    }

    if (this.mode.kind !== "session") return;

    if (this.mode.options.model !== undefined) {
      const response = await this.controller.request(
        "update_model",
        {
          runtime: this.runtime,
          payload: { model_handle: this.mode.options.model },
        },
        { predicate: (message) => message.type === "update_model_response" },
      );
      ensureSuccess(response, "Failed to update model");
      const updatedModel = typeof response.model_handle === "string"
        ? response.model_handle
        : this.mode.options.model;
      this._model = updatedModel;
    }

    // Initial cwd and permission mode are part of runtime_start for
    // app-server/listener sessions. Reserve change_device_state for explicit
    // post-init mutations via changeDeviceState().
  }

  private handleProtocolMessage = (message: ProtocolMessage): void => {
    if (!this.runtime || !sameRuntime(message, this.runtime)) return;
    if (message.type !== "stream_delta") return;
    const delta = message.delta;
    if (!delta || typeof delta !== "object") return;
    const sdkMessage = this.transformStreamDelta(delta as Record<string, unknown>);
    if (sdkMessage) {
      this.enqueue(sdkMessage);
    }
  };

  private transformStreamDelta(delta: Record<string, unknown>): SDKMessage | null {
    const messageType = typeof delta.message_type === "string" ? delta.message_type : undefined;
    const runId = typeof delta.run_id === "string" ? delta.run_id : undefined;
    const uuid = typeof delta.id === "string" ? delta.id : `${this.label}-${++this.messageCounter}`;

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
      const toolReturn = firstToolReturn(delta) ?? delta;
      const toolCallId =
        (typeof delta.tool_call_id === "string" ? delta.tool_call_id : undefined) ??
        (typeof toolReturn.tool_call_id === "string" ? toolReturn.tool_call_id : undefined);
      if (!toolCallId) return null;
      const content =
        extractTextFromContent(delta.tool_return ?? toolReturn.tool_return ?? toolReturn.content) ?? "";
      const status = typeof delta.status === "string" ? delta.status : toolReturn.status;
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
        `${this.label} turn failed`;
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

  private resultFromTurn(turn: RuntimeTurnResult): SDKResultMessage {
    const stopReason = turn.stopReason ?? (turn.success === false ? "error" : undefined);
    const approvalConflict = isApprovalConflictSignal({
      detail: turn.detail,
      stopReason,
    });
    const success = turn.success !== undefined
      ? turn.success && !approvalConflict && !FAILURE_STOP_REASONS.has(stopReason ?? "")
      : !approvalConflict && !FAILURE_STOP_REASONS.has(stopReason ?? "");
    const errorCode = approvalConflict
      ? "approval_conflict"
      : (turn.errorCode ?? toSdkErrorCode(stopReason));

    return {
      type: "result",
      success,
      result: success ? (this.activeTurnAssistantText || undefined) : undefined,
      error: success ? undefined : (errorCode ?? stopReason ?? "error"),
      errorCode: success ? undefined : (errorCode ?? "error"),
      approvalConflict: approvalConflict || undefined,
      recoverable: approvalConflict ? true : success ? undefined : false,
      errorDetail: success ? undefined : turn.detail,
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
