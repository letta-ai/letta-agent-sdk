import type {
  BootstrapStateOptions,
  BootstrapStateResult,
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeSession,
  LettaCodeModelEntry,
  ListModelsResult,
  ListMessagesOptions,
  ListMessagesResult,
  MessageContentItem,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  ReasoningEffort,
  RunTurnOptions,
  SDKErrorCode,
  SDKInitMessage,
  SDKLoopStatusMessage,
  SDKMessage,
  SDKProtocolCommand,
  SDKProtocolMessage,
  SDKQueueItem,
  SDKQueueUpdateMessage,
  SDKResultMessage,
  SDKStreamEventPayload,
  SendCommandOptions,
  SendMessage,
  UpdateModelOptions,
  UpdateModelResult,
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

export type RuntimeSendTurnOptions = {
  clientMessageId: string;
};

export type RuntimeRequestOptions = {
  timeoutMs?: number;
  predicate?: (message: ProtocolMessage) => boolean;
};

export interface RemoteClientRuntimeController {
  onMessage(handler: (message: ProtocolMessage, channel?: string) => void): () => void;
  send(command: Record<string, unknown>): void;
  sendTurnMessage(
    runtime: RuntimeScope,
    message: SendMessage,
    options: RuntimeSendTurnOptions,
  ): void;
  abort(runtime: RuntimeScope): Promise<void>;
  request(
    type: string,
    body: Record<string, unknown>,
    options?: RuntimeRequestOptions,
  ): Promise<ProtocolMessage>;
  recoverPendingApprovals(
    runtime: RuntimeScope,
    options?: RecoverPendingApprovalsOptions,
  ): Promise<RecoverPendingApprovalsResult>;
  listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Promise<ListMessagesResult>;
  listModels(): Promise<ListModelsResult>;
  updateModel(
    runtime: RuntimeScope,
    payload: { model_id?: string; model_handle?: string },
  ): Promise<UpdateModelResult>;
  close(): void;
}

export type RuntimeSessionInit = {
  controller: RemoteClientRuntimeController;
  runtime: RuntimeScope;
  model?: string | null;
  modelSettings?: Record<string, unknown> | null;
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

type UpdateModelPayload = {
  model_id?: string;
  model_handle?: string;
};

type NormalizedUpdateModelInput = {
  model?: string;
  modelId?: string;
  modelHandle?: string;
  reasoningEffort?: ReasoningEffort;
};

type TurnTracker = {
  id: number;
  runtime: RuntimeScope;
  clientMessageId: string;
  queuedAt: number;
  startedAt: number;
  assistantText: string;
  runIds: Set<string>;
  observedTurnEvidence: boolean;
  observedRequiresApprovalStop: boolean;
  abortRequested: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
};

const FAILURE_STOP_REASONS = new Set([
  "error",
  "llm_api_error",
  "max_steps",
  "interrupted",
  "cancelled",
  "canceled",
]);
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
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

type LegacyPermissionMode = "default" | "bypassPermissions" | "fullAccess";

export function normalizePermissionMode(
  mode:
    | LettaCodeClientSessionOptions["permissionMode"]
    | LegacyPermissionMode
    | undefined,
): LettaCodeClientSessionOptions["permissionMode"] | undefined {
  if (mode === undefined || mode === "default") {
    return "standard";
  }
  if (mode === "bypassPermissions" || mode === "fullAccess") {
    return "unrestricted";
  }
  if (
    mode === "standard" ||
    mode === "acceptEdits" ||
    mode === "unrestricted"
  ) {
    return mode;
  }
  return undefined;
}

export function mapPermissionMode(
  mode:
    | LettaCodeClientSessionOptions["permissionMode"]
    | LegacyPermissionMode
    | undefined,
): string | undefined {
  return normalizePermissionMode(mode);
}

export function isUnrestrictedPermissionMode(
  mode:
    | LettaCodeClientSessionOptions["permissionMode"]
    | LegacyPermissionMode
    | undefined,
): boolean {
  return normalizePermissionMode(mode) === "unrestricted";
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

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.has(value as ReasoningEffort);
}

function nonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}. Expected a non-empty string.`);
  }
  return value;
}

function normalizeUpdateModelInput(update: string | UpdateModelOptions): NormalizedUpdateModelInput {
  if (typeof update === "string") {
    if (update.length === 0) {
      throw new Error("Invalid model. Expected a non-empty string.");
    }
    return { model: update };
  }
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new Error("Invalid updateModel options. Expected a model string or options object.");
  }

  const model = nonEmptyString(update.model, "model");
  const modelId = nonEmptyString(update.modelId, "modelId");
  const modelHandle = nonEmptyString(update.modelHandle, "modelHandle");
  const reasoningEffort = update.reasoningEffort;
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
    throw new Error(
      `Invalid reasoningEffort '${String(reasoningEffort)}'. Valid values: ${[...REASONING_EFFORTS].join(", ")}`,
    );
  }
  if (model !== undefined && (modelId !== undefined || modelHandle !== undefined)) {
    throw new Error("Invalid updateModel options. Use either model or explicit modelId/modelHandle, not both.");
  }
  if (
    model === undefined &&
    modelId === undefined &&
    modelHandle === undefined &&
    reasoningEffort === undefined
  ) {
    throw new Error("Invalid updateModel options. Provide model, modelId, modelHandle, or reasoningEffort.");
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(modelHandle !== undefined ? { modelHandle } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

function modelPayloadWithoutReasoning(input: NormalizedUpdateModelInput): UpdateModelPayload {
  const payload: UpdateModelPayload = {};
  if (input.modelId !== undefined) payload.model_id = input.modelId;
  if (input.modelHandle !== undefined) payload.model_handle = input.modelHandle;
  if (input.model !== undefined) {
    if (input.model.includes("/")) payload.model_handle = input.model;
    else payload.model_id = input.model;
  }
  return payload;
}

function toBaseModelHandle(
  handle: string | undefined,
  byokProviderAliases: Record<string, string> | undefined,
): string | undefined {
  if (!handle) return undefined;
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return handle;
  const provider = handle.slice(0, slashIndex);
  const model = handle.slice(slashIndex + 1);
  const baseProvider = byokProviderAliases?.[provider];
  return baseProvider ? `${baseProvider}/${model}` : handle;
}

function getContextWindow(value: Record<string, unknown> | null | undefined): number | undefined {
  const contextWindow = value?.context_window;
  return typeof contextWindow === "number" ? contextWindow : undefined;
}

function getReasoningEffort(entry: LettaCodeModelEntry): string | undefined {
  const effort = entry.updateArgs?.reasoning_effort;
  return typeof effort === "string" ? effort : undefined;
}

function sameContextCandidates(
  candidates: LettaCodeModelEntry[],
  contextWindow: number | undefined,
): LettaCodeModelEntry[] {
  if (contextWindow === undefined) return candidates;
  const matches = candidates.filter(
    (entry) => getContextWindow(entry.updateArgs) === contextWindow,
  );
  return matches.length > 0 ? matches : candidates;
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

function resolveDreamingSettings(
  dreaming: LettaCodeClientSessionOptions["dreaming"],
): ReflectionSettings | null {
  if (!dreaming) return null;
  return {
    trigger: dreaming.trigger ?? "step-count",
    step_count: dreaming.stepCount ?? 5,
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

function streamDeltaRecord(message: ProtocolMessage): Record<string, unknown> | null {
  if (message.type !== "stream_delta") return null;
  const delta = message.delta;
  return delta && typeof delta === "object" && !Array.isArray(delta)
    ? (delta as Record<string, unknown>)
    : null;
}

function streamDeltaMessageType(delta: Record<string, unknown>): string | undefined {
  return typeof delta.message_type === "string" ? delta.message_type : undefined;
}

function streamDeltaRunId(delta: Record<string, unknown>): string | undefined {
  return typeof delta.run_id === "string" ? delta.run_id : undefined;
}

function streamDeltaStopReason(delta: Record<string, unknown>): string | null | undefined {
  return typeof delta.stop_reason === "string" ? delta.stop_reason : undefined;
}

function loopStatusRecord(message: ProtocolMessage): Record<string, unknown> | null {
  if (message.type !== "update_loop_status") return null;
  const loopStatus = message.loop_status;
  return loopStatus && typeof loopStatus === "object" && !Array.isArray(loopStatus)
    ? (loopStatus as Record<string, unknown>)
    : null;
}

function loopStatusValue(message: ProtocolMessage): string | undefined {
  const loopStatus = loopStatusRecord(message);
  return typeof loopStatus?.status === "string" ? loopStatus.status : undefined;
}

function loopStatusRunIds(message: ProtocolMessage): string[] {
  const activeRunIds = loopStatusRecord(message)?.active_run_ids;
  return Array.isArray(activeRunIds)
    ? activeRunIds.filter((runId): runId is string => typeof runId === "string")
    : [];
}

function queueItems(message: ProtocolMessage): SDKQueueItem[] {
  const queue = message.queue;
  if (!Array.isArray(queue)) return [];
  return queue.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") return [];
    return [
      {
        id: record.id,
        clientMessageId:
          typeof record.client_message_id === "string" ? record.client_message_id : "",
        kind: typeof record.kind === "string" ? record.kind : "message",
        source: typeof record.source === "string" ? record.source : "user",
        content: record.content,
        enqueuedAt: typeof record.enqueued_at === "string" ? record.enqueued_at : "",
      },
    ];
  });
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
  protected _modelSettings: Record<string, unknown> | null = null;

  private readonly label: string;
  private readonly requestTimeoutMs: number | undefined;
  private streamQueue: SDKMessage[] = [];
  private streamResolvers: Array<(msg: SDKMessage | null) => void> = [];
  private removeMessageHandler: (() => void) | null = null;
  private activeTurn: TurnTracker | null = null;
  private pendingTurns: TurnTracker[] = [];
  private nextTurnId = 0;
  private messageCounter = 0;
  private clientMessageCounter = 0;
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
      this._modelSettings = init.modelSettings ?? null;
      this._model =
        typeof init.model === "string"
          ? init.model
          : typeof this._modelSettings?.model === "string"
            ? this._modelSettings.model
            : "";
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

    await this.beforeTurn();

    const turn = this.trackSentTurn(this.runtime);
    try {
      this.controller.sendTurnMessage(this.runtime, message, {
        clientMessageId: turn.clientMessageId,
      });
    } catch (error) {
      this.removeTrackedTurn(turn);
      throw error;
    }
  }

  async runTurn(
    message: SendMessage,
    _options: RunTurnOptions = {},
  ): Promise<SDKResultMessage> {
    if (this.activeTurn || this.pendingTurns.length > 0) {
      throw new Error(
        `A turn is already in flight for this ${this.label} session. Use send() and stream() to let the listener queue messages.`,
      );
    }
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

  async abort(): Promise<void> {
    if (!this.initialized) return;
    if (!this.controller || !this.runtime) return;
    if (this.activeTurn) this.activeTurn.abortRequested = true;
    await this.controller.abort(this.runtime);
  }

  async sendCommand(command: SDKProtocolCommand): Promise<void>;
  async sendCommand<TResponse extends SDKProtocolMessage = SDKProtocolMessage>(
    command: SDKProtocolCommand,
    options: SendCommandOptions,
  ): Promise<TResponse>;
  async sendCommand<TResponse extends SDKProtocolMessage = SDKProtocolMessage>(
    command: SDKProtocolCommand,
    options?: SendCommandOptions,
  ): Promise<void | TResponse> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller) {
      throw new Error("Session is not initialized");
    }
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error("Invalid command. Expected a protocol command object.");
    }
    if (typeof command.type !== "string" || command.type.length === 0) {
      throw new Error("Invalid command. Expected a non-empty type.");
    }

    if (!options || (!options.responseType && !options.predicate && options.timeoutMs === undefined)) {
      this.controller.send(command);
      return;
    }

    const { type, ...body } = command;
    const response = await this.controller.request(type, body, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      predicate: options.predicate
        ? (message) => options.predicate?.(message as SDKProtocolMessage) === true
        : options.responseType
          ? (message) => message.type === options.responseType
          : undefined,
    });
    return response as TResponse;
  }

  async listModels(): Promise<ListModelsResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller) {
      throw new Error("Session is not initialized");
    }
    return this.controller.listModels();
  }

  async updateModel(update: string | UpdateModelOptions): Promise<UpdateModelResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }

    const normalized = normalizeUpdateModelInput(update);
    const payload = await this.resolveUpdateModelPayload(normalized);
    const result = await this.controller.updateModel(this.runtime, payload);

    if (result.modelHandle !== undefined) {
      this._model = result.modelHandle;
    } else if (payload.model_handle !== undefined) {
      this._model = payload.model_handle;
    } else if (typeof result.modelSettings?.model === "string") {
      this._model = result.modelSettings.model;
    }
    if ("modelSettings" in result) {
      this._modelSettings = result.modelSettings ?? null;
    }
    return result;
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
    if (this.activeTurn?.timeout) clearTimeout(this.activeTurn.timeout);
    for (const turn of this.pendingTurns) {
      if (turn.timeout) clearTimeout(turn.timeout);
    }
    this.activeTurn = null;
    this.pendingTurns.length = 0;
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
    if (updates.permissionMode !== undefined) {
      const mode = mapPermissionMode(updates.permissionMode);
      if (mode !== undefined) payload.mode = mode;
    }
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

  private trackSentTurn(runtime: RuntimeScope): TurnTracker {
    const turn: TurnTracker = {
      id: ++this.nextTurnId,
      runtime,
      clientMessageId: `sdk-message-${Date.now()}-${++this.clientMessageCounter}`,
      queuedAt: Date.now(),
      startedAt: 0,
      assistantText: "",
      runIds: new Set<string>(),
      observedTurnEvidence: false,
      observedRequiresApprovalStop: false,
      abortRequested: false,
      timeout: null,
    };

    if (this.activeTurn) {
      this.pendingTurns.push(turn);
    } else {
      this.activateTurn(turn);
    }
    return turn;
  }

  private activateTurn(turn: TurnTracker): void {
    this.activeTurn = turn;
    turn.startedAt = Date.now();
    this.activeTurnStartedAt = turn.startedAt;
    if (this.requestTimeoutMs !== undefined) {
      turn.timeout = setTimeout(() => {
        this.failTurn(turn, `Timed out waiting for ${this.label} turn`);
      }, this.requestTimeoutMs);
      (turn.timeout as { unref?: () => void }).unref?.();
    }
  }

  private activateNextTurnFromProtocol(): TurnTracker | null {
    if (this.activeTurn) return this.activeTurn;
    const next = this.pendingTurns.shift();
    if (!next) return null;
    this.activateTurn(next);
    return next;
  }

  private removeTrackedTurn(turn: TurnTracker): void {
    if (turn.timeout) clearTimeout(turn.timeout);
    if (this.activeTurn === turn) {
      this.activeTurn = null;
      return;
    }
    const index = this.pendingTurns.indexOf(turn);
    if (index !== -1) this.pendingTurns.splice(index, 1);
  }

  private failTurn(turn: TurnTracker, detail: string): void {
    if (this.activeTurn !== turn) return;
    this.enqueue({
      type: "error",
      message: detail,
      errorCode: "error",
      stopReason: "error",
      errorDetail: detail,
      recoverable: false,
    });
    this.completeActiveTurn({
      runtime: turn.runtime,
      stopReason: "error",
      runIds: [...turn.runIds],
      success: false,
      detail,
      errorCode: "error",
    });
  }

  private completeActiveTurn(turn: RuntimeTurnResult): void {
    const active = this.activeTurn;
    if (!active) return;
    if (active.timeout) {
      clearTimeout(active.timeout);
      active.timeout = null;
    }
    this.enqueue(this.resultFromTurn(turn, active));
    this.activeTurn = null;
  }

  private async resolveUpdateModelPayload(
    input: NormalizedUpdateModelInput,
  ): Promise<UpdateModelPayload> {
    if (input.reasoningEffort === undefined) {
      return modelPayloadWithoutReasoning(input);
    }
    if (!this.controller) {
      throw new Error("Session is not initialized");
    }

    const catalog = await this.controller.listModels();
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
      if (baseEntry) {
        targetHandle = baseEntry.handle;
      } else {
        explicitHandle = input.model;
        targetHandle = toBaseModelHandle(input.model, aliases);
      }
    } else {
      explicitHandle = this._model || undefined;
      targetHandle = toBaseModelHandle(this._model || undefined, aliases);
    }

    if (!targetHandle) {
      throw new Error("reasoningEffort requires a current model or explicit model/modelId/modelHandle.");
    }

    const candidates = catalog.entries.filter(
      (entry) => entry.handle === targetHandle || entry.handle === explicitHandle,
    );
    if (candidates.length === 0) {
      throw new Error(
        `reasoningEffort requires a model from listModels(); no catalog entry found for ${targetHandle}.`,
      );
    }

    const contextWindow =
      getContextWindow(baseEntry?.updateArgs) ?? getContextWindow(this._modelSettings);
    const scopedCandidates = sameContextCandidates(candidates, contextWindow);
    const matchingEntry =
      scopedCandidates.find((entry) => getReasoningEffort(entry) === input.reasoningEffort) ??
      candidates.find((entry) => getReasoningEffort(entry) === input.reasoningEffort);

    if (!matchingEntry) {
      throw new Error(
        `No ${input.reasoningEffort} reasoning tier found for model ${targetHandle}.`,
      );
    }

    const payload: UpdateModelPayload = { model_id: matchingEntry.id };
    if (explicitHandle !== undefined) {
      payload.model_handle = explicitHandle;
    }
    return payload;
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

    const dreamingSettings = resolveDreamingSettings(options.dreaming);
    if (dreamingSettings) {
      const response = await this.controller.request(
        "set_reflection_settings",
        {
          runtime: this.runtime,
          settings: dreamingSettings,
          scope: "both",
        },
        { predicate: (message) => message.type === "set_reflection_settings_response" },
      );
      ensureSuccess(response, "Failed to update dreaming settings");
    }

    if (this.mode.kind !== "session") return;

    if (
      this.mode.options.model !== undefined ||
      this.mode.options.reasoningEffort !== undefined
    ) {
      await this.updateModel({
        ...(this.mode.options.model !== undefined ? { model: this.mode.options.model } : {}),
        ...(this.mode.options.reasoningEffort !== undefined
          ? { reasoningEffort: this.mode.options.reasoningEffort }
          : {}),
      });
    }

    // Initial cwd and permission mode are part of runtime_start for
    // websocket protocol sessions. Reserve change_device_state for explicit
    // post-init mutations via changeDeviceState().
  }

  private handleProtocolMessage = (message: ProtocolMessage): void => {
    if (!this.runtime || !sameRuntime(message, this.runtime)) return;

    if (message.type === "update_queue") {
      const sdkMessage: SDKQueueUpdateMessage = {
        type: "queue_update",
        queue: queueItems(message),
      };
      this.enqueue(sdkMessage);
      return;
    }

    if (message.type === "update_loop_status") {
      this.handleLoopStatusMessage(message);
      return;
    }

    const delta = streamDeltaRecord(message);
    if (!delta) return;
    const active = this.activateNextTurnFromProtocol();
    if (active) {
      active.observedTurnEvidence = true;
      const runId = streamDeltaRunId(delta);
      if (runId) active.runIds.add(runId);
    }

    const sdkMessage = this.transformStreamDelta(delta);
    if (sdkMessage) {
      this.enqueue(sdkMessage);
    }

    this.handleTurnTerminalDelta(delta, sdkMessage);
  };

  private handleLoopStatusMessage(message: ProtocolMessage): void {
    const status = loopStatusValue(message);
    if (!status) return;
    const activeRunIds = loopStatusRunIds(message);
    const sdkMessage: SDKLoopStatusMessage = {
      type: "loop_status",
      status,
      activeRunIds,
    };
    this.enqueue(sdkMessage);

    const active = this.activeTurn;
    if (!active) return;
    for (const runId of activeRunIds) active.runIds.add(runId);

    const hadTurnEvidence = active.observedTurnEvidence || active.observedRequiresApprovalStop;
    if (!hadTurnEvidence) return;
    if (status === "WAITING_ON_APPROVAL") {
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason: "requires_approval",
        runIds: [...active.runIds],
      });
      return;
    }
    if (status === "WAITING_ON_INPUT" && active.abortRequested) {
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason: "interrupted",
        runIds: [...active.runIds],
        success: false,
        detail: "Interrupted",
        errorCode: "interrupted",
      });
      return;
    }
    if (status === "WAITING_ON_INPUT" && active.observedTurnEvidence) {
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason: null,
        runIds: [...active.runIds],
      });
    }
  }

  private handleTurnTerminalDelta(
    delta: Record<string, unknown>,
    sdkMessage: SDKMessage | null,
  ): void {
    const active = this.activeTurn;
    if (!active) return;
    const messageType = streamDeltaMessageType(delta);
    if (messageType === "stop_reason") {
      const stopReason = streamDeltaStopReason(delta) ?? null;
      if (stopReason === "requires_approval") {
        active.observedRequiresApprovalStop = true;
        return;
      }
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason,
        runIds: [...active.runIds],
      });
      return;
    }

    if (sdkMessage?.type === "error") {
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason: sdkMessage.stopReason,
        runIds: [...active.runIds],
        success: false,
        detail: sdkMessage.errorDetail ?? sdkMessage.message,
        errorCode: sdkMessage.errorCode,
      });
    }
  }

  private transformStreamDelta(delta: Record<string, unknown>): SDKMessage | null {
    const messageType = typeof delta.message_type === "string" ? delta.message_type : undefined;
    const runId = typeof delta.run_id === "string" ? delta.run_id : undefined;
    const uuid = typeof delta.id === "string" ? delta.id : `${this.label}-${++this.messageCounter}`;

    if (messageType === "assistant_message") {
      const content = extractTextFromContent(delta.content);
      if (!content) return null;
      if (this.activeTurn) this.activeTurn.assistantText += content;
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

  private resultFromTurn(turn: RuntimeTurnResult, tracker?: TurnTracker): SDKResultMessage {
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
      result: success ? (tracker?.assistantText || undefined) : undefined,
      error: success ? undefined : (errorCode ?? stopReason ?? "error"),
      errorCode: success ? undefined : (errorCode ?? "error"),
      approvalConflict: approvalConflict || undefined,
      recoverable: approvalConflict ? true : success ? undefined : false,
      errorDetail: success ? undefined : turn.detail,
      stopReason,
      durationMs: Date.now() - (tracker?.startedAt || this.activeTurnStartedAt),
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
