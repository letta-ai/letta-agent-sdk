import { RemoteEnvironmentClient, type RemoteEnvironmentTarget } from "./remote.js";
import { createAgentBody, type AppServerSessionMode } from "./app-server-session.js";
import type {
  BootstrapStateOptions,
  BootstrapStateResult,
  CreateAgentOptions,
  LettaCodeCloudClientOptions,
  LettaCodeEnvironment,
  LettaCodeSession,
  LettaCodeSocketConstructor,
  LettaCodeSocketLike,
  LettaCodeClientSessionOptions,
  ListMessagesOptions,
  ListMessagesResult,
  MessageContentItem,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  SDKErrorCode,
  SDKInitMessage,
  SDKMessage,
  SDKResultMessage,
  SendMessage,
  TextContent,
} from "./types.js";

const DEFAULT_CLOUD_API_BASE_URL = "https://api.letta.com";
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const SDK_AGENT_ORIGIN = "@letta-ai/letta-code-sdk";
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

type FetchLike = typeof fetch;

type RuntimeScope = {
  agent_id: string;
  conversation_id: string;
};

type CloudStatusMessage = Record<string, unknown> & {
  type?: unknown;
  runId?: unknown;
  run_id?: unknown;
  stopReason?: unknown;
  stop_reason?: unknown;
  conversation_id?: unknown;
  runtime?: RuntimeScope;
};

type CloudConversation = Record<string, unknown> & {
  id?: string;
  agent_id?: string;
};

type TerminalTurn = {
  success: boolean;
  stopReason: string | null;
  detail?: string;
  errorCode?: SDKErrorCode;
  runId?: string;
};

type PendingTurn = {
  resolveTerminal: (terminal: TerminalTurn) => void;
  rejectTerminal: (error: Error) => void;
  terminalPromise: Promise<TerminalTurn>;
  runIds: Set<string>;
  streamPromise: Promise<void> | null;
  terminalResolved: boolean;
};

type CloudUserMessage = {
  role: "user";
  content: string | TextContent[];
  client_message_id: string;
  otid: string;
};

function getDefaultApiKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return env?.LETTA_API_KEY ?? env?.LETTA_CLOUD_API_KEY;
}

function bearerTokenFromHeaders(headers: Record<string, string> | undefined): string | undefined {
  const authorization = headers?.Authorization ?? headers?.authorization;
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}

function getCloudApiKey(options: LettaCodeCloudClientOptions): string | undefined {
  return options.apiKey ?? bearerTokenFromHeaders(options.headers) ?? getDefaultApiKey();
}

function getFetch(fetchOverride?: FetchLike): FetchLike {
  const resolved = fetchOverride ?? globalThis.fetch;
  if (!resolved) {
    throw new Error("No fetch implementation available for cloud backend.");
  }
  return resolved.bind(globalThis) as FetchLike;
}

function getWebSocketConstructor(
  websocketOverride?: LettaCodeSocketConstructor,
): LettaCodeSocketConstructor {
  const resolved =
    websocketOverride ??
    (globalThis as { WebSocket?: LettaCodeSocketConstructor }).WebSocket;
  if (!resolved) {
    throw new Error("No WebSocket implementation available for cloud backend.");
  }
  return resolved;
}

function normalizeCloudApiBaseUrl(url: string | undefined): string {
  const parsed = new URL(url ?? DEFAULT_CLOUD_API_BASE_URL);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function cloudHeaders(options: LettaCodeCloudClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  const apiKey = getCloudApiKey(options);
  if (apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.detail;
    const reasonText = record.reason_text;
    const pieces = [message, reasonText]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (pieces.length > 0) return pieces.join(": ");
  }
  return fallback;
}

function assertOkResponse(response: Response, body: unknown, action: string): void {
  if (!response.ok) {
    throw new Error(
      responseErrorMessage(body, `${action} failed with HTTP ${response.status}`),
    );
  }
}

function environmentToRemoteTarget(
  environment: LettaCodeEnvironment,
): RemoteEnvironmentTarget {
  if (typeof environment === "string") {
    return { connectionName: environment };
  }
  if ("name" in environment) {
    return { connectionName: environment.name };
  }
  if ("id" in environment) {
    return { environmentId: environment.id };
  }
  if ("connectionId" in environment) {
    return { connectionId: environment.connectionId };
  }
  if ("deviceId" in environment) {
    return { deviceId: environment.deviceId };
  }
  if ("lastUsed" in environment) {
    return { lastUsed: true };
  }
  throw new Error("Unsupported cloud environment selector.");
}

function buildCloudStatusWebSocketUrl(params: {
  apiBaseUrl?: string;
  connectionId: string;
  agentId: string;
  conversationId: string;
  apiKey?: string;
}): string {
  const base = new URL(normalizeCloudApiBaseUrl(params.apiBaseUrl));
  if (base.protocol === "http:") {
    base.protocol = "ws:";
  } else if (base.protocol === "https:") {
    base.protocol = "wss:";
  } else if (base.protocol !== "ws:" && base.protocol !== "wss:") {
    throw new Error(`Unsupported cloud apiBaseUrl protocol: ${base.protocol}`);
  }
  base.pathname = `/v1/environments/${encodeURIComponent(params.connectionId)}/status/ws`;
  base.searchParams.set("agentId", params.agentId);
  base.searchParams.set("conversationId", params.conversationId);
  base.searchParams.set("channel", "stream");
  if (params.apiKey) {
    base.searchParams.set("token", params.apiKey);
  }
  return base.toString();
}

function addSocketListener(
  socket: LettaCodeSocketLike,
  type: string,
  listener: (event: unknown) => void,
): () => void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  if (socket.on) {
    socket.on(type, listener);
    return () => socket.off?.(type, listener);
  }
  throw new Error("WebSocket implementation does not support event listeners.");
}

function waitForOpen(socket: LettaCodeSocketLike): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanupFns: Array<() => void> = [];
    const cleanup = () => {
      for (const fn of cleanupFns) fn();
    };
    cleanupFns.push(
      addSocketListener(socket, "open", () => {
        cleanup();
        resolve();
      }),
      addSocketListener(socket, "error", () => {
        cleanup();
        reject(new Error("Cloud status websocket failed to connect."));
      }),
      addSocketListener(socket, "close", () => {
        cleanup();
        reject(new Error("Cloud status websocket closed before connecting."));
      }),
    );
  });
}

function toSdkErrorCode(value: string | null | undefined): SDKErrorCode | undefined {
  if (!value || value.length === 0) return undefined;
  return KNOWN_SDK_ERROR_CODES.has(value as SDKErrorCode)
    ? (value as SDKErrorCode)
    : undefined;
}

function mapPermissionMode(mode: LettaCodeClientSessionOptions["permissionMode"]): string | undefined {
  if (mode === undefined || mode === "default") return undefined;
  if (mode === "acceptEdits") return "acceptEdits";
  if (mode === "bypassPermissions") return "unrestricted";
  throw new Error("Cloud backend sessions do not yet support permissionMode 'plan'.");
}

function isTextContent(item: MessageContentItem): item is TextContent {
  return item.type === "text";
}

function generateClientMessageId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toCloudUserMessage(input: SendMessage, clientMessageId: string): CloudUserMessage {
  if (typeof input === "string") {
    return {
      role: "user",
      content: input,
      client_message_id: clientMessageId,
      otid: clientMessageId,
    };
  }

  const textParts = input.filter(isTextContent);
  if (textParts.length !== input.length) {
    throw new Error("Cloud backend messages currently support text content only.");
  }

  return {
    role: "user",
    content: textParts,
    client_message_id: clientMessageId,
    otid: clientMessageId,
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

function messageEventData(event: unknown): string | null {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    const data = (event as { data?: unknown }).data;
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(data);
    }
  }
  return null;
}

function isRuntimeMatch(message: CloudStatusMessage, runtime: RuntimeScope): boolean {
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

function getRunId(message: CloudStatusMessage): string | undefined {
  return typeof message.runId === "string"
    ? message.runId
    : typeof message.run_id === "string"
      ? message.run_id
      : undefined;
}

function getStopReason(message: CloudStatusMessage): string | null {
  return typeof message.stopReason === "string"
    ? message.stopReason
    : typeof message.stop_reason === "string"
      ? message.stop_reason
      : null;
}

function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function createCloudAgent(
  clientOptions: LettaCodeCloudClientOptions,
  agentOptions: CreateAgentOptions,
): Promise<string> {
  const fetchImpl = getFetch(clientOptions.fetch);
  const baseUrl = normalizeCloudApiBaseUrl(clientOptions.apiBaseUrl);
  const response = await fetchImpl(`${baseUrl}/v1/agents/`, {
    method: "POST",
    headers: cloudHeaders(clientOptions),
    body: JSON.stringify(createAgentBody(agentOptions)),
  });
  const body = await parseJsonResponse(response);
  assertOkResponse(response, body, "Cloud createAgent()");
  const agentId =
    body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string"
      ? (body as { id: string }).id
      : undefined;
  if (!agentId) {
    throw new Error("Cloud createAgent() response did not include an agent id.");
  }
  return agentId;
}

export function assertCloudSessionOptionsSupported(
  action: string,
  options: LettaCodeClientSessionOptions,
): void {
  if (options.model !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support model overrides for existing agents.`);
  }
  if (options.systemPrompt !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support systemPrompt overrides for existing agents.`);
  }
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support allowedTools/disallowedTools.`);
  }
  if (options.canUseTool !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support canUseTool callbacks.`);
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    throw new Error(`Cloud backend ${action}() does not yet support SDK-hosted tools.`);
  }
  if (options.memfs !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support per-session memfs toggles.`);
  }
  if (options.skillSources !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support skillSources overrides.`);
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support systemInfoReminder overrides.`);
  }
  if (options.sleeptime !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support sleeptime overrides.`);
  }
  if (options.memfsStartup !== undefined) {
    throw new Error(`Cloud backend ${action}() does not yet support memfsStartup overrides.`);
  }
  if (options.includePartialMessages !== undefined) {
    throw new Error(`Cloud backend ${action}() streams Cloud run events directly and does not support includePartialMessages.`);
  }
  mapPermissionMode(options.permissionMode);
}

export class CloudEnvironmentSession implements LettaCodeSession {
  private ws: LettaCodeSocketLike | null = null;
  private removeMessageHandler: (() => void) | null = null;
  private runtime: RuntimeScope | null = null;
  private connectionId: string | null = null;
  private initialized = false;
  private closed = false;
  private streamQueue: SDKMessage[] = [];
  private streamResolvers: Array<(msg: SDKMessage | null) => void> = [];
  private pendingTurn: PendingTurn | null = null;
  private activeTurn: Promise<void> | null = null;
  private activeTurnStartedAt = 0;
  private activeTurnAssistantText = "";
  private messageCounter = 0;
  private streamAbortController: AbortController | null = null;
  private _agentId: string | null = null;
  private _sessionId: string | null = null;
  private _conversationId: string | null = null;
  private _model = "";

  constructor(
    private readonly cloudOptions: LettaCodeCloudClientOptions,
    private readonly mode: AppServerSessionMode,
  ) {}

  async initialize(): Promise<SDKInitMessage> {
    if (this.initialized) {
      throw new Error("Session already initialized");
    }
    if (this.closed) {
      throw new Error("Session is closed");
    }

    const resolved = await this.resolveRuntime();
    this.connectionId = resolved.connectionId;
    this.runtime = resolved.runtime;
    this._agentId = resolved.runtime.agent_id;
    this._conversationId = resolved.runtime.conversation_id;
    this._sessionId = `${resolved.runtime.agent_id}:${resolved.runtime.conversation_id}`;

    const apiKey = getCloudApiKey(this.cloudOptions);
    const url = buildCloudStatusWebSocketUrl({
      apiBaseUrl: this.cloudOptions.apiBaseUrl,
      connectionId: resolved.connectionId,
      agentId: resolved.runtime.agent_id,
      conversationId: resolved.runtime.conversation_id,
      apiKey,
    });

    const WebSocketCtor = getWebSocketConstructor(this.cloudOptions.WebSocket);
    this.ws = new WebSocketCtor(url);
    this.removeMessageHandler = addSocketListener(this.ws, "message", this.handleStatusEvent);
    await waitForOpen(this.ws);
    this.applyInitialDeviceState();
    this.initialized = true;

    return {
      type: "init",
      agentId: resolved.runtime.agent_id,
      sessionId: this._sessionId,
      conversationId: resolved.runtime.conversation_id,
      model: this._model,
      tools: [],
    };
  }

  async send(message: SendMessage): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.runtime || !this.connectionId) {
      throw new Error("Session is not initialized");
    }
    if (this.activeTurn) {
      throw new Error("A turn is already in flight for this cloud session");
    }

    this.streamQueue.length = 0;
    this.activeTurnAssistantText = "";
    this.activeTurnStartedAt = Date.now();
    this.pendingTurn = this.createPendingTurn();

    this.activeTurn = this.dispatchAndWaitForTurn(message, this.pendingTurn)
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
          runIds: this.pendingTurn ? Array.from(this.pendingTurn.runIds) : undefined,
        });
      })
      .finally(() => {
        this.pendingTurn = null;
        this.streamAbortController = null;
        this.activeTurn = null;
      });
  }

  async runTurn(message: SendMessage): Promise<SDKResultMessage> {
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
      detail: "Cloud backend sessions do not yet support approval recovery through the SDK.",
    };
  }

  async listMessages(_options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    throw new Error("Cloud backend sessions do not yet support listMessages().");
  }

  async bootstrapState(_options: BootstrapStateOptions = {}): Promise<BootstrapStateResult> {
    throw new Error("Cloud backend sessions do not yet support bootstrapState().");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.streamAbortController?.abort();
    this.removeMessageHandler?.();
    this.ws?.close();
    this.ws = null;
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

  private createPendingTurn(): PendingTurn {
    let resolveTerminal!: (terminal: TerminalTurn) => void;
    let rejectTerminal!: (error: Error) => void;
    const terminalPromise = new Promise<TerminalTurn>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    return {
      resolveTerminal,
      rejectTerminal,
      terminalPromise,
      runIds: new Set<string>(),
      streamPromise: null,
      terminalResolved: false,
    };
  }

  private async dispatchAndWaitForTurn(
    message: SendMessage,
    pendingTurn: PendingTurn,
  ): Promise<void> {
    await this.postEnvironmentMessage(message);

    let terminal = await promiseWithTimeout(
      pendingTurn.terminalPromise,
      this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "Timed out waiting for Cloud environment turn result.",
    );

    if (pendingTurn.streamPromise) {
      try {
        await pendingTurn.streamPromise;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (terminal.success) {
          terminal = {
            success: false,
            stopReason: "stream_closed",
            detail,
            errorCode: "stream_closed",
          };
        }
      }
    }

    this.enqueue(this.resultFromTerminal(terminal, pendingTurn));
  }

  private async postEnvironmentMessage(message: SendMessage): Promise<void> {
    if (!this.runtime || !this.connectionId) {
      throw new Error("Session is not initialized");
    }
    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const clientMessageId = generateClientMessageId();
    const response = await fetchImpl(
      `${baseUrl}/v1/environments/${encodeURIComponent(this.connectionId)}/messages`,
      {
        method: "POST",
        headers: cloudHeaders(this.cloudOptions),
        body: JSON.stringify({
          messages: [toCloudUserMessage(message, clientMessageId)],
          agentId: this.runtime.agent_id,
          conversationId: this.runtime.conversation_id,
          source: SDK_AGENT_ORIGIN,
        }),
      },
    );
    const body = await parseJsonResponse(response);
    assertOkResponse(response, body, "Cloud send()");
  }

  private resultFromTerminal(
    terminal: TerminalTurn,
    pendingTurn: PendingTurn,
  ): SDKResultMessage {
    const stopReason = terminal.stopReason ?? (terminal.success ? "end_turn" : "error");
    const success = terminal.success && !FAILURE_STOP_REASONS.has(stopReason);
    const errorCode = terminal.errorCode ?? (success ? undefined : toSdkErrorCode(stopReason) ?? "error");
    return {
      type: "result",
      success,
      ...(success ? { result: this.activeTurnAssistantText } : { error: stopReason }),
      ...(errorCode ? { errorCode } : {}),
      ...(terminal.detail ? { errorDetail: terminal.detail } : {}),
      recoverable: false,
      stopReason,
      durationMs: Date.now() - this.activeTurnStartedAt,
      conversationId: this._conversationId,
      runIds: Array.from(pendingTurn.runIds),
    };
  }

  private handleStatusEvent = (event: unknown): void => {
    const data = messageEventData(event);
    if (!data) return;
    let parsed: CloudStatusMessage;
    try {
      parsed = JSON.parse(data) as CloudStatusMessage;
    } catch {
      return;
    }
    this.handleStatusMessage(parsed);
  };

  private handleStatusMessage(message: CloudStatusMessage): void {
    if (!this.runtime || !isRuntimeMatch(message, this.runtime)) return;
    const type = typeof message.type === "string" ? message.type : undefined;

    if (type === "stream_delta") {
      const delta = message.delta;
      if (delta && typeof delta === "object") {
        const sdkMessage = this.transformStreamDelta(delta as Record<string, unknown>);
        if (sdkMessage) this.enqueue(sdkMessage);
      }
      return;
    }

    if (type === "run_started") {
      const runId = getRunId(message);
      if (!runId || !this.pendingTurn) return;
      this.pendingTurn.runIds.add(runId);
      if (!this.pendingTurn.streamPromise) {
        this.pendingTurn.streamPromise = this.streamRun(runId);
      }
      return;
    }

    if (type === "result" || type === "run_completed") {
      const runId = getRunId(message);
      if (
        type === "run_completed" &&
        runId &&
        this.pendingTurn &&
        !this.pendingTurn.streamPromise
      ) {
        this.pendingTurn.runIds.add(runId);
        this.pendingTurn.streamPromise = this.streamRun(runId);
      }
      this.resolvePendingTerminal({
        success: (message.success as boolean | undefined) ?? getStopReason(message) === "end_turn",
        stopReason: getStopReason(message),
        runId,
      });
      return;
    }

    if (type === "run_request_error" || type === "error") {
      const detail =
        typeof message.error === "string"
          ? message.error
          : typeof message.message === "string"
            ? message.message
            : "Cloud environment run failed.";
      this.resolvePendingTerminal({
        success: false,
        stopReason: getStopReason(message) ?? "error",
        detail,
        errorCode: toSdkErrorCode(getStopReason(message)) ?? "error",
        runId: getRunId(message),
      });
    }
  }

  private resolvePendingTerminal(terminal: TerminalTurn): void {
    const pending = this.pendingTurn;
    if (!pending || pending.terminalResolved) return;
    if (terminal.runId) pending.runIds.add(terminal.runId);
    pending.terminalResolved = true;
    pending.resolveTerminal(terminal);
  }

  private async streamRun(runId: string): Promise<void> {
    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    this.streamAbortController = new AbortController();
    const response = await fetchImpl(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/stream`, {
      method: "POST",
      headers: {
        ...cloudHeaders(this.cloudOptions),
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ starting_after: 0 }),
      signal: this.streamAbortController.signal,
    });
    if (!response.ok) {
      const body = await parseJsonResponse(response);
      throw new Error(responseErrorMessage(body, `Cloud run stream failed with HTTP ${response.status}`));
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Cloud run stream response did not include a readable body.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = this.processSseBuffer(buffer);
    }
    buffer += decoder.decode();
    this.processSseBuffer(`${buffer}\n`);
  }

  private processSseBuffer(buffer: string): string {
    const lines = buffer.split("\n");
    const remainder = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trimStart();
      if (!data || data === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data) as unknown;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const sdkMessage = this.transformStreamDelta(parsed as Record<string, unknown>);
      if (sdkMessage) this.enqueue(sdkMessage);
    }
    return remainder;
  }

  private transformStreamDelta(delta: Record<string, unknown>): SDKMessage | null {
    const messageType = typeof delta.message_type === "string" ? delta.message_type : undefined;
    const runId = typeof delta.run_id === "string" ? delta.run_id : undefined;
    const uuid = typeof delta.id === "string" ? delta.id : `cloud-${++this.messageCounter}`;

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
      const toolCallId =
        (typeof toolCall.tool_call_id === "string" ? toolCall.tool_call_id : undefined) ??
        (typeof toolCall.id === "string" ? toolCall.id : undefined);
      const toolName =
        (typeof toolCall.name === "string" ? toolCall.name : undefined) ??
        (toolCall.function &&
        typeof toolCall.function === "object" &&
        typeof (toolCall.function as Record<string, unknown>).name === "string"
          ? ((toolCall.function as Record<string, unknown>).name as string)
          : undefined);
      const args =
        toolCall.arguments ??
        (toolCall.function && typeof toolCall.function === "object"
          ? (toolCall.function as Record<string, unknown>).arguments
          : undefined);
      if (!toolCallId || !toolName) return null;
      const { input, raw } = toolInputFromArguments(args);
      return {
        type: "tool_call",
        toolCallId,
        toolName,
        toolInput: input,
        ...(raw !== undefined ? { rawArguments: raw } : {}),
        uuid,
        runId,
      };
    }

    if (messageType === "tool_return_message") {
      const toolReturn = firstToolReturn(delta) ?? delta;
      const toolCallId =
        typeof toolReturn.tool_call_id === "string"
          ? toolReturn.tool_call_id
          : typeof delta.tool_call_id === "string"
            ? delta.tool_call_id
            : undefined;
      if (!toolCallId) return null;
      const content =
        typeof toolReturn.tool_return === "string"
          ? toolReturn.tool_return
          : extractTextFromContent(toolReturn.content) ?? "";
      const status = typeof toolReturn.status === "string" ? toolReturn.status : undefined;
      return {
        type: "tool_result",
        toolCallId,
        content,
        isError: status === "error",
        uuid,
        runId,
      };
    }

    return null;
  }

  private applyInitialDeviceState(): void {
    if (!this.ws || !this.runtime) return;
    const options = this.mode.kind === "session" ? this.mode.options : this.mode.options;
    const payload: Record<string, unknown> = {};
    const mode = mapPermissionMode(options.permissionMode);
    if (mode) payload.mode = mode;
    if (options.cwd !== undefined) payload.cwd = options.cwd;
    if (Object.keys(payload).length === 0) return;
    this.sendToDevice({
      type: "change_device_state",
      runtime: this.runtime,
      payload,
    });
  }

  private sendToDevice(command: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(command));
  }

  private async resolveRuntime(): Promise<{ connectionId: string; runtime: RuntimeScope }> {
    if (this.mode.kind === "create-agent") {
      const agentId = await createCloudAgent(this.cloudOptions, this.mode.options);
      const conversation = await this.createConversation(agentId);
      const runtime = { agent_id: agentId, conversation_id: conversation.id };
      return { connectionId: await this.resolveConnectionId(runtime), runtime };
    }

    let agentId = this.mode.agentId;
    let conversationId = this.mode.conversationId;

    if (agentId && this.mode.newConversation) {
      const conversation = await this.createConversation(agentId);
      conversationId = conversation.id;
    } else if (agentId && this.mode.defaultConversation) {
      conversationId = "default";
    }

    if (!agentId && conversationId) {
      const conversation = await this.retrieveConversation(conversationId);
      if (!conversation.agent_id) {
        throw new Error(`Cloud conversation ${conversationId} did not include an agent id.`);
      }
      agentId = conversation.agent_id;
    }

    if (!agentId || !conversationId) {
      throw new Error(
        "Cloud backend createSession()/resumeSession() requires an agent id or conversation id.",
      );
    }

    const runtime = { agent_id: agentId, conversation_id: conversationId };
    return { connectionId: await this.resolveConnectionId(runtime), runtime };
  }

  private async createConversation(agentId: string): Promise<{ id: string; agent_id?: string }> {
    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const url = new URL(`${baseUrl}/v1/conversations/`);
    url.searchParams.set("agent_id", agentId);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: cloudHeaders(this.cloudOptions),
      body: JSON.stringify({}),
    });
    const body = await parseJsonResponse(response);
    assertOkResponse(response, body, "Cloud createSession()");
    const conversation = body as CloudConversation | null;
    if (!conversation || typeof conversation.id !== "string") {
      throw new Error("Cloud createSession() response did not include a conversation id.");
    }
    return { id: conversation.id, agent_id: conversation.agent_id };
  }

  private async retrieveConversation(conversationId: string): Promise<{ id: string; agent_id?: string }> {
    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const response = await fetchImpl(
      `${baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}`,
      { headers: cloudHeaders(this.cloudOptions) },
    );
    const body = await parseJsonResponse(response);
    assertOkResponse(response, body, "Cloud resumeSession()");
    const conversation = body as CloudConversation | null;
    if (!conversation || typeof conversation.id !== "string") {
      throw new Error(`Cloud resumeSession() could not retrieve conversation ${conversationId}.`);
    }
    return { id: conversation.id, agent_id: conversation.agent_id };
  }

  private async resolveConnectionId(runtime: RuntimeScope): Promise<string> {
    const environment = this.getEnvironment();
    const target = environmentToRemoteTarget(environment);
    if ("lastUsed" in target && runtime.conversation_id === "default") {
      // The Cloud last-used endpoint accepts the default conversation alias.
    }

    const client = new RemoteEnvironmentClient({
      baseUrl: this.cloudOptions.apiBaseUrl,
      apiKey: this.cloudOptions.apiKey,
      headers: this.cloudOptions.headers,
      fetch: this.cloudOptions.fetch,
    });
    const resolved = await client.resolveEnvironment(target, {
      agentId: runtime.agent_id,
      conversationId: runtime.conversation_id,
    });
    return resolved.connectionId;
  }

  private getEnvironment(): LettaCodeEnvironment {
    const modeEnvironment = this.mode.kind === "session"
      ? this.mode.options.environment
      : undefined;
    const environment = modeEnvironment ?? this.cloudOptions.environment;
    if (environment === undefined) {
      throw new Error(
        "Cloud backend sessions require an environment. Set a client default or pass environment to createSession()/resumeSession().",
      );
    }
    return environment;
  }

  private enqueue(message: SDKMessage): void {
    const resolver = this.streamResolvers.shift();
    if (resolver) {
      resolver(message);
    } else {
      this.streamQueue.push(message);
    }
  }

  private nextMessage(): Promise<SDKMessage | null> {
    if (this.streamQueue.length > 0) {
      return Promise.resolve(this.streamQueue.shift() ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.streamResolvers.push(resolve);
    });
  }

  private resolveAll(message: SDKMessage | null): void {
    const resolvers = this.streamResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve(message);
    }
  }
}
