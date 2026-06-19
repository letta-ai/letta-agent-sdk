import {
  isHeadlessAutoAllowTool,
  requiresRuntimeUserInput,
} from "./interactiveToolPolicy.js";
import { AppServerSession, type AppServerSessionOptions } from "./app-server-session.js";
import {
  RemoteEnvironmentClient,
  type RemoteEnvironmentConnection,
  type RemoteEnvironmentTarget,
} from "./remote.js";
import {
  RemoteClientSessionCore,
  normalizeSendMessage,
  type ProtocolMessage,
  type RemoteClientRuntimeController,
  type RuntimeScope,
  type RuntimeSessionInit,
  type RuntimeSessionMode,
  type RuntimeTurnResult,
} from "./remote-client-session-core.js";
import type {
  CanUseToolResponse,
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeCloudClientOptions,
  LettaCodeEnvironment,
  LettaCodeSocketConstructor,
  LettaCodeSocketLike,
  ListMessagesOptions,
  ListMessagesResult,
  MessageContentItem,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  SDKErrorCode,
  SendMessage,
} from "./types.js";

const DEFAULT_CLOUD_API_BASE_URL = "https://api.letta.com";
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_SANDBOX_TTL_MINUTES = 5;
const DEFAULT_SANDBOX_READY_TIMEOUT_MS = 120_000;
const DEFAULT_SANDBOX_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_TERMINAL_GRACE_MS = 100;
const SDK_AGENT_ORIGIN = "@letta-ai/letta-code-sdk";

type FetchLike = typeof fetch;

type CloudStatusMessage = ProtocolMessage & {
  type: string;
  seq?: unknown;
  event_seq?: unknown;
  idempotency_key?: unknown;
  runId?: unknown;
  run_id?: unknown;
  stopReason?: unknown;
  stop_reason?: unknown;
  conversation_id?: unknown;
  conversationId?: unknown;
  agent_id?: unknown;
  agentId?: unknown;
  request?: unknown;
  loop_status?: unknown;
  delta?: unknown;
};

type CloudConversation = Record<string, unknown> & {
  id?: string;
  agent_id?: string;
};

type CloudAgentSandbox = {
  sandboxId: string;
  deviceId: string;
  connectionName: string;
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
  terminalResolved: boolean;
  idleSuccessTimer: ReturnType<typeof setTimeout> | null;
  sawTurnActivity: boolean;
};

type PendingResponse = {
  predicate: (message: CloudStatusMessage) => boolean;
  resolve: (message: CloudStatusMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type CloudSessionMode = RuntimeSessionMode;

type ResolvedSandboxPolicy = {
  lifecycle: "ephemeral" | "keep-warm" | "external";
  ttlMinutes: number;
  readyTimeoutMs: number;
  pollIntervalMs: number;
  refreshOnTurn: boolean;
  terminateOnClose: boolean;
};

type CloudUserMessage = {
  role: "user";
  content: string | MessageContentItem[];
  client_message_id: string;
  otid?: string;
};

type ResolveToolApproval = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<CanUseToolResponse>;

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

function cloudWebSocketHeaders(options: LettaCodeCloudClientOptions): Record<string, string> | undefined {
  const headers = { ...(options.headers ?? {}) };
  delete headers.authorization;
  delete headers.Authorization;
  const apiKey = getCloudApiKey(options);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return Object.keys(headers).length > 0 ? headers : undefined;
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

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`Invalid ${name}. Expected a positive integer.`);
  }
}

function validateTtlMinutes(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 60) {
    throw new Error("Invalid sandbox.ttlMinutes. Expected an integer from 1 to 60.");
  }
}

export function validateCloudClientOptions(options: LettaCodeCloudClientOptions): void {
  validatePositiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
  validatePositiveInteger(options.appServer?.requestTimeoutMs, "appServer.requestTimeoutMs");
  validatePositiveInteger(options.appServer?.startupTimeoutMs, "appServer.startupTimeoutMs");
  validateTtlMinutes(options.sandbox?.ttlMinutes);
  validatePositiveInteger(options.sandbox?.readyTimeoutMs, "sandbox.readyTimeoutMs");
  validatePositiveInteger(options.sandbox?.pollIntervalMs, "sandbox.pollIntervalMs");
  if (
    options.sandbox?.lifecycle !== undefined &&
    options.sandbox.lifecycle !== "ephemeral" &&
    options.sandbox.lifecycle !== "keep-warm" &&
    options.sandbox.lifecycle !== "external"
  ) {
    throw new Error("Invalid sandbox.lifecycle. Valid values: ephemeral, keep-warm, external.");
  }
  if (
    options.webSocketAuth !== undefined &&
    options.webSocketAuth !== "header" &&
    options.webSocketAuth !== "query"
  ) {
    throw new Error("Invalid webSocketAuth. Valid values: header, query.");
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
  throw new Error("Unknown cloud environment selector.");
}

function buildCloudStatusWebSocketUrl(params: {
  apiBaseUrl?: string;
  connectionId: string;
  agentId: string;
  conversationId: string;
  apiKey?: string;
  authMode: "header" | "query";
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
  if (params.authMode === "query" && params.apiKey) {
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

function messageEventData(event: unknown): string | null {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    const data = (event as { data?: unknown }).data;
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(data);
    }
    if (data instanceof Uint8Array) {
      return new TextDecoder().decode(data);
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function generateClientMessageId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toCloudUserMessage(input: SendMessage, clientMessageId: string): CloudUserMessage {
  return {
    role: "user",
    content: normalizeSendMessage(input),
    client_message_id: clientMessageId,
    otid: clientMessageId,
  };
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

function getDeltaStopReason(delta: Record<string, unknown>): string | null {
  return typeof delta.stopReason === "string"
    ? delta.stopReason
    : typeof delta.stop_reason === "string"
      ? delta.stop_reason
      : null;
}

function getDeltaRunId(delta: Record<string, unknown>): string | undefined {
  return typeof delta.runId === "string"
    ? delta.runId
    : typeof delta.run_id === "string"
      ? delta.run_id
      : undefined;
}

function getDeltaDetail(delta: Record<string, unknown>): string | undefined {
  return typeof delta.detail === "string"
    ? delta.detail
    : typeof delta.message === "string"
      ? delta.message
      : typeof delta.error === "string"
        ? delta.error
        : undefined;
}

function terminalFromStreamDelta(delta: Record<string, unknown>): TerminalTurn | null {
  const messageType = typeof delta.message_type === "string" ? delta.message_type : undefined;
  const isErrorMessage = messageType === "loop_error" || messageType === "error_message";
  if (delta.is_terminal !== true && !isErrorMessage) return null;

  const stopReason = getDeltaStopReason(delta) ?? (isErrorMessage ? "error" : null);
  const success = typeof delta.success === "boolean"
    ? delta.success
    : !isErrorMessage && stopReason !== "error" && stopReason !== "llm_api_error";
  return {
    success,
    stopReason: stopReason ?? (success ? "end_turn" : "error"),
    detail: success ? undefined : getDeltaDetail(delta),
    errorCode: success ? undefined : "error",
    runId: getDeltaRunId(delta),
  };
}

function isCloudConversation(value: unknown): value is CloudConversation & { id: string } {
  return Boolean(value && typeof value === "object" && typeof (value as CloudConversation).id === "string");
}

function isCloudAgentSandbox(value: unknown): value is CloudAgentSandbox {
  if (!value || typeof value !== "object") return false;
  const sandbox = value as CloudAgentSandbox;
  return (
    typeof sandbox.sandboxId === "string" &&
    typeof sandbox.deviceId === "string" &&
    typeof sandbox.connectionName === "string"
  );
}

function cloudHarnessAppServerOptions(
  clientOptions: LettaCodeCloudClientOptions,
): AppServerSessionOptions {
  const appServer = clientOptions.appServer;
  const apiKey = getCloudApiKey(clientOptions);
  const localEnv: Record<string, string | undefined> = {
    ...(apiKey ? { LETTA_API_KEY: apiKey } : {}),
    ...(clientOptions.apiBaseUrl
      ? { LETTA_BASE_URL: normalizeCloudApiBaseUrl(clientOptions.apiBaseUrl) }
      : {}),
  };
  return {
    local: appServer?.url === undefined,
    ...(appServer?.url !== undefined ? { url: appServer.url } : {}),
    ...(appServer?.WebSocket !== undefined ? { WebSocket: appServer.WebSocket } : {}),
    ...(clientOptions.requestTimeoutMs !== undefined || appServer?.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: appServer?.requestTimeoutMs ?? clientOptions.requestTimeoutMs }
      : {}),
    ...(appServer?.listen !== undefined ? { localListen: appServer.listen } : {}),
    ...(appServer?.startupTimeoutMs !== undefined
      ? { localStartupTimeoutMs: appServer.startupTimeoutMs }
      : {}),
    ...(Object.keys(localEnv).length > 0 ? { localEnv } : {}),
  };
}

export async function createCloudAgent(
  clientOptions: LettaCodeCloudClientOptions,
  agentOptions: CreateAgentOptions,
): Promise<string> {
  const session = new AppServerSession(cloudHarnessAppServerOptions(clientOptions), {
    kind: "create-agent",
    options: agentOptions,
  });
  const initMsg = await session.initialize();
  session.close();
  return initMsg.agentId;
}

export function assertCloudSessionOptionsSupported(
  action: string,
  options: LettaCodeClientSessionOptions,
): void {
  if (options.systemPrompt !== undefined) {
    throw new Error(`Cloud backend ${action}() cannot rewrite an existing agent's systemPrompt from the SDK adapter yet.`);
  }
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error(`Cloud backend ${action}() has not wired allowedTools/disallowedTools to the remote device protocol yet.`);
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    throw new Error(`Cloud backend ${action}() has not wired SDK-hosted tools to remote control_response yet.`);
  }
  if (options.skillSources !== undefined) {
    throw new Error(`Cloud backend ${action}() has not wired skillSources to the remote device protocol yet.`);
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error(`Cloud backend ${action}() has not wired systemInfoReminder to the remote device protocol yet.`);
  }
  if (options.sleeptime?.behavior !== undefined) {
    throw new Error(`Cloud backend ${action}() has not wired sleeptime.behavior to the remote device protocol yet.`);
  }
  if (options.memfs === false) {
    throw new Error(`Cloud backend ${action}() can enable MemFS, but disabling it is not wired through the remote device protocol yet.`);
  }
  if (options.memfsStartup !== undefined) {
    throw new Error(`Cloud backend ${action}() does not use memfsStartup; sandbox/device startup owns synchronization.`);
  }
  if (options.includePartialMessages !== undefined) {
    throw new Error(`Cloud backend ${action}() streams Remote Client deltas directly; includePartialMessages is not a separate toggle.`);
  }
}

async function listCloudMessages(
  cloudOptions: LettaCodeCloudClientOptions,
  conversationId: string,
  options: ListMessagesOptions = {},
): Promise<ListMessagesResult> {
  const fetchImpl = getFetch(cloudOptions.fetch);
  const baseUrl = normalizeCloudApiBaseUrl(cloudOptions.apiBaseUrl);
  const url = new URL(`${baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/messages`);
  if (options.before !== undefined) url.searchParams.set("before", options.before);
  if (options.after !== undefined) url.searchParams.set("after", options.after);
  if (options.order !== undefined) url.searchParams.set("order", options.order);
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));

  const response = await fetchImpl(url, { headers: cloudHeaders(cloudOptions) });
  const body = await parseJsonResponse(response);
  assertOkResponse(response, body, "Cloud listMessages()");

  const messages = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)
      ? ((body as { messages: unknown[] }).messages)
      : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
        ? ((body as { data: unknown[] }).data)
        : [];
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    messages,
    nextBefore:
      typeof record.nextBefore === "string"
        ? record.nextBefore
        : typeof record.next_before === "string"
          ? record.next_before
          : null,
    hasMore:
      typeof record.hasMore === "boolean"
        ? record.hasMore
        : typeof record.has_more === "boolean"
          ? record.has_more
          : false,
  };
}

class CloudStatusRuntimeController implements RemoteClientRuntimeController {
  private ws: LettaCodeSocketLike;
  private removeSocketHandlers: Array<() => void> = [];
  private messageHandlers = new Set<(message: ProtocolMessage, channel?: string) => void>();
  private pendingTurn: PendingTurn | null = null;
  private pendingResponses = new Map<string, PendingResponse>();
  private requestCounter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventSeq: number | null = null;
  private seenIdempotencyKeys = new Set<string>();
  private closed = false;

  private constructor(
    ws: LettaCodeSocketLike,
    private readonly cloudOptions: LettaCodeCloudClientOptions,
    private readonly runtime: RuntimeScope,
    private readonly resolveToolApproval: ResolveToolApproval,
  ) {
    this.ws = ws;
  }

  static async connect(params: {
    cloudOptions: LettaCodeCloudClientOptions;
    runtime: RuntimeScope;
    connectionId: string;
    resolveToolApproval: ResolveToolApproval;
  }): Promise<CloudStatusRuntimeController> {
    const apiKey = getCloudApiKey(params.cloudOptions);
    const authMode = params.cloudOptions.webSocketAuth ?? "header";
    const url = buildCloudStatusWebSocketUrl({
      apiBaseUrl: params.cloudOptions.apiBaseUrl,
      connectionId: params.connectionId,
      agentId: params.runtime.agent_id,
      conversationId: params.runtime.conversation_id,
      apiKey,
      authMode,
    });
    const WebSocketCtor = getWebSocketConstructor(params.cloudOptions.WebSocket);
    const socketHeaders = authMode === "header" ? cloudWebSocketHeaders(params.cloudOptions) : undefined;
    const socketOptions = socketHeaders ? { headers: socketHeaders } : undefined;
    const ws = new WebSocketCtor(url, socketOptions);
    const controller = new CloudStatusRuntimeController(
      ws,
      params.cloudOptions,
      params.runtime,
      params.resolveToolApproval,
    );
    controller.removeSocketHandlers.push(
      addSocketListener(ws, "message", controller.handleStatusEvent),
      addSocketListener(ws, "close", controller.handleSocketClose),
      addSocketListener(ws, "error", controller.handleSocketError),
    );
    await promiseWithTimeout(
      waitForOpen(ws),
      params.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "Timed out waiting for Cloud status websocket to open.",
    );
    controller.startPing();
    return controller;
  }

  onMessage(handler: (message: ProtocolMessage, channel?: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  send(command: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error("Cloud status websocket is not open.");
    }
    this.ws.send(JSON.stringify(command));
  }

  request(
    type: string,
    body: Record<string, unknown>,
    options: { timeoutMs?: number; predicate?: (message: ProtocolMessage) => boolean } = {},
  ): Promise<ProtocolMessage> {
    const requestId = typeof body.request_id === "string"
      ? body.request_id
      : this.nextRequestId(type.replace(/_/g, "-"));
    const predicate = options.predicate ?? ((message: ProtocolMessage) => message.request_id === requestId);
    const promise = this.waitForResponse(
      requestId,
      (message) => predicate(message),
      options.timeoutMs ?? this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    );
    this.send({
      type,
      request_id: requestId,
      ...body,
    });
    return promise;
  }

  async runTurnMessage(
    runtime: RuntimeScope,
    message: SendMessage,
    options: { timeoutMs?: number } = {},
  ): Promise<RuntimeTurnResult> {
    if (this.pendingTurn) {
      throw new Error(`A turn is already in flight for ${runtime.agent_id}/${runtime.conversation_id}`);
    }
    const pendingTurn = this.createPendingTurn();
    this.pendingTurn = pendingTurn;

    try {
      const clientMessageId = generateClientMessageId();
      this.send({
        type: "input",
        request_id: this.nextRequestId("input"),
        runtime,
        payload: {
          kind: "create_message",
          messages: [toCloudUserMessage(message, clientMessageId)],
          supports_control_response: true,
          source: SDK_AGENT_ORIGIN,
        },
      });

      const terminal = await promiseWithTimeout(
        pendingTurn.terminalPromise,
        options.timeoutMs ?? this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        "Timed out waiting for Cloud Remote Client turn result.",
      );

      return {
        runtime,
        success: terminal.success,
        stopReason: terminal.stopReason ?? (terminal.success ? "end_turn" : "error"),
        detail: terminal.detail,
        errorCode: terminal.errorCode,
        runIds: Array.from(pendingTurn.runIds),
      };
    } finally {
      this.clearIdleSuccessTimer(pendingTurn);
      this.pendingTurn = null;
    }
  }

  async recoverPendingApprovals(
    runtime: RuntimeScope,
    options: RecoverPendingApprovalsOptions = {},
  ): Promise<RecoverPendingApprovalsResult> {
    this.sendSync(true);
    try {
      await this.request(
        "recover_pending_approvals",
        { runtime },
        {
          timeoutMs: options.timeoutMs ?? this.cloudOptions.requestTimeoutMs ?? 30_000,
          predicate: (message) =>
            message.type === "recover_pending_approvals_ack" ||
            message.type === "recover_pending_approvals_response",
        },
      );
      return { recovered: true, pendingApproval: false, unsupported: false };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { recovered: false, pendingApproval: undefined, unsupported: false, detail };
    }
  }

  listMessages(
    conversationId: string,
    options: ListMessagesOptions = {},
  ): Promise<ListMessagesResult> {
    return listCloudMessages(this.cloudOptions, conversationId, options);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const remove of this.removeSocketHandlers.splice(0)) {
      remove();
    }
    this.ws?.close();
    for (const [requestId, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Cloud websocket closed before ${requestId} response arrived`));
    }
    this.pendingResponses.clear();
    this.rejectActiveTurn(new Error("Cloud status websocket closed."));
  }

  sendSync(recoverApprovals: boolean): void {
    this.send({
      type: "sync",
      runtime: this.runtime,
      recover_approvals: recoverApprovals,
    });
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
      terminalResolved: false,
      idleSuccessTimer: null,
      sawTurnActivity: false,
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

  private handleSocketClose = (): void => {
    if (this.closed) return;
    this.rejectActiveTurn(new Error("Cloud status websocket closed."));
  };

  private handleSocketError = (): void => {
    if (this.closed) return;
    this.rejectActiveTurn(new Error("Cloud status websocket error."));
  };

  private handleStatusMessage(message: CloudStatusMessage): void {
    this.ackIfSequenced(message);

    const requestId = typeof message.request_id === "string" ? message.request_id : undefined;
    if (requestId) {
      const pending = this.pendingResponses.get(requestId);
      if (pending?.predicate(message)) {
        clearTimeout(pending.timer);
        this.pendingResponses.delete(requestId);
        pending.resolve(message);
      }
    }

    const idempotencyKey =
      typeof message.idempotency_key === "string" ? message.idempotency_key : undefined;
    if (idempotencyKey) {
      if (this.seenIdempotencyKeys.has(idempotencyKey)) return;
      this.seenIdempotencyKeys.add(idempotencyKey);
    }

    this.trackEventSeq(message);

    if (!isRuntimeMatch(message, this.runtime)) return;
    const type = typeof message.type === "string" ? message.type : undefined;

    if (type === "stream_delta") {
      const delta = message.delta;
      if (delta && typeof delta === "object") {
        const deltaRecord = delta as Record<string, unknown>;
        const runId = getDeltaRunId(deltaRecord);
        if (runId && this.pendingTurn) this.pendingTurn.runIds.add(runId);
        const messageType = typeof deltaRecord.message_type === "string" ? deltaRecord.message_type : undefined;
        if (this.pendingTurn && messageType !== "user_message") {
          this.pendingTurn.sawTurnActivity = true;
        }
        const terminal = terminalFromStreamDelta(deltaRecord);
        this.emit(message);
        if (terminal) this.resolvePendingTerminal(terminal);
        return;
      }
      this.emit(message);
      return;
    }

    if (type === "update_loop_status") {
      this.handleLoopStatus(message);
      return;
    }

    if (type === "control_request") {
      void this.handleControlRequest(message);
      return;
    }

    if (type === "run_started") {
      const runId = getRunId(message);
      if (runId && this.pendingTurn) this.pendingTurn.runIds.add(runId);
      if (this.pendingTurn) this.pendingTurn.sawTurnActivity = true;
      return;
    }

    if (type === "result" || type === "run_completed") {
      this.resolvePendingTerminal({
        success: (message.success as boolean | undefined) ?? getStopReason(message) === "end_turn",
        stopReason: getStopReason(message),
        runId: getRunId(message),
      });
      return;
    }

    if (type === "run_request_error" || type === "error") {
      const detail =
        typeof message.error === "string"
          ? message.error
          : typeof message.message === "string"
            ? message.message
            : "Cloud Remote Client run failed.";
      this.resolvePendingTerminal({
        success: false,
        stopReason: getStopReason(message) ?? "error",
        detail,
        errorCode: "error",
        runId: getRunId(message),
      });
    }
  }

  private emit(message: CloudStatusMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  private ackIfSequenced(message: CloudStatusMessage): void {
    if (typeof message.seq !== "number") return;
    try {
      this.send({ type: "ack", seq: message.seq });
    } catch {
      // Best-effort reliability ack.
    }
  }

  private trackEventSeq(message: CloudStatusMessage): void {
    if (typeof message.event_seq !== "number") return;
    if (this.lastEventSeq !== null && message.event_seq > this.lastEventSeq + 1) {
      this.sendSync(true);
    }
    if (this.lastEventSeq === null || message.event_seq > this.lastEventSeq) {
      this.lastEventSeq = message.event_seq;
    }
  }

  private handleLoopStatus(message: CloudStatusMessage): void {
    const loopStatus = message.loop_status;
    if (!loopStatus || typeof loopStatus !== "object") return;
    const record = loopStatus as Record<string, unknown>;
    const activeRunIds = record.active_run_ids;
    if (Array.isArray(activeRunIds) && this.pendingTurn) {
      for (const runId of activeRunIds) {
        if (typeof runId === "string") this.pendingTurn.runIds.add(runId);
      }
    }
    const status = typeof record.status === "string" ? record.status : undefined;
    const pending = this.pendingTurn;
    if (pending && (status === "SENDING_API_REQUEST" || status === "WAITING_FOR_API_RESPONSE")) {
      pending.sawTurnActivity = true;
    }
    if (status === "WAITING_ON_INPUT") {
      this.scheduleIdleSuccessTerminal();
    }
  }

  private async handleControlRequest(message: CloudStatusMessage): Promise<void> {
    const requestId = typeof message.request_id === "string" ? message.request_id : undefined;
    const request = message.request;
    if (!requestId || !request || typeof request !== "object") return;
    const requestRecord = request as Record<string, unknown>;
    if (requestRecord.subtype !== "can_use_tool") return;

    const toolName = typeof requestRecord.tool_name === "string" ? requestRecord.tool_name : "unknown";
    const toolInput =
      requestRecord.input && typeof requestRecord.input === "object" && !Array.isArray(requestRecord.input)
        ? (requestRecord.input as Record<string, unknown>)
        : {};
    const response = await this.resolveToolApproval(toolName, toolInput);
    this.send({
      type: "input",
      runtime: this.runtime,
      payload: {
        kind: "approval_response",
        request_id: requestId,
        decision: response,
      },
    });
  }

  private scheduleIdleSuccessTerminal(): void {
    const pending = this.pendingTurn;
    if (!pending || pending.terminalResolved) return;
    if (!pending.sawTurnActivity) return;
    this.clearIdleSuccessTimer(pending);
    pending.idleSuccessTimer = setTimeout(() => {
      if (this.pendingTurn !== pending || pending.terminalResolved) return;
      pending.idleSuccessTimer = null;
      this.resolvePendingTerminal({ success: true, stopReason: "end_turn" });
    }, DEFAULT_IDLE_TERMINAL_GRACE_MS);
    (pending.idleSuccessTimer as { unref?: () => void }).unref?.();
  }

  private clearIdleSuccessTimer(pending: PendingTurn | null = this.pendingTurn): void {
    if (!pending?.idleSuccessTimer) return;
    clearTimeout(pending.idleSuccessTimer);
    pending.idleSuccessTimer = null;
  }

  private resolvePendingTerminal(terminal: TerminalTurn): void {
    const pending = this.pendingTurn;
    if (!pending || pending.terminalResolved) return;
    this.clearIdleSuccessTimer(pending);
    if (terminal.runId) pending.runIds.add(terminal.runId);
    pending.terminalResolved = true;
    pending.resolveTerminal(terminal);
  }

  private rejectActiveTurn(error: Error): void {
    const pending = this.pendingTurn;
    if (!pending || pending.terminalResolved) return;
    this.clearIdleSuccessTimer(pending);
    pending.terminalResolved = true;
    pending.rejectTerminal(error);
  }

  private waitForResponse(
    requestId: string,
    predicate: (message: CloudStatusMessage) => boolean,
    timeoutMs: number,
  ): Promise<CloudStatusMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error(`Timed out waiting for Cloud response ${requestId}.`));
      }, timeoutMs);
      this.pendingResponses.set(requestId, { predicate, resolve, reject, timer });
    });
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}-${Date.now()}-${this.requestCounter}`;
  }

  private startPing(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        // Best effort heartbeat.
      }
    }, this.cloudOptions.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }
}

export class CloudEnvironmentSession extends RemoteClientSessionCore {
  private connectionId: string | null = null;
  private sandbox: CloudAgentSandbox | null = null;
  private sandboxPolicy: ResolvedSandboxPolicy | null = null;

  constructor(
    private readonly cloudOptions: LettaCodeCloudClientOptions,
    mode: CloudSessionMode,
  ) {
    super(mode, {
      label: "cloud",
      requestTimeoutMs: cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      capabilities: {
        enableMemfs: true,
        updateModel: true,
        changeDeviceState: true,
      },
    });
  }

  override async listMessages(options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    const conversationId = options.conversationId ?? this._conversationId ?? this.conversationIdFromMode();
    if (conversationId) {
      return listCloudMessages(this.cloudOptions, conversationId, options);
    }
    return super.listMessages(options);
  }

  protected override enableMemfsBody(): Record<string, unknown> {
    if (!this.runtime) return {};
    return {
      runtime: this.runtime,
      agent_id: this.runtime.agent_id,
    };
  }

  protected override async initializeRuntimeController(): Promise<RuntimeSessionInit> {
    const resolved = await this.resolveRuntime();
    const connection = await this.resolveConnection(resolved.runtime);
    this.connectionId = connection.connectionId;
    const controller = await CloudStatusRuntimeController.connect({
      cloudOptions: this.cloudOptions,
      runtime: resolved.runtime,
      connectionId: connection.connectionId,
      resolveToolApproval: this.resolveToolApproval,
    });

    return {
      controller,
      runtime: resolved.runtime,
      tools: [],
    };
  }

  protected override async afterRuntimeInitialized(): Promise<void> {
    if (!this.controller || !this.runtime) return;
    this.controller.send({
      type: "sync",
      runtime: this.runtime,
      recover_approvals: true,
    });
  }

  protected override async beforeTurn(): Promise<void> {
    await this.refreshSandboxForTurn();
  }

  protected override onCoreClose(): void {
    if (this.sandbox !== null && this.sandboxPolicy?.terminateOnClose === true && this._agentId) {
      const agentId = this._agentId;
      void this.terminateAgentSandbox(agentId).catch(() => {
        // close() is intentionally synchronous; cleanup failures are ignored.
      });
    }
  }

  private conversationIdFromMode(): string | null {
    if (this.mode.kind !== "session") return null;
    if (this.mode.conversationId) return this.mode.conversationId;
    if (this.mode.agentId && this.mode.defaultConversation) return "default";
    return null;
  }

  private resolveToolApproval = async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<CanUseToolResponse> => {
    const options = this.currentOptions();
    const hasCallback = typeof options.canUseTool === "function";
    const toolNeedsRuntimeUserInput = requiresRuntimeUserInput(toolName);

    if (toolNeedsRuntimeUserInput && !hasCallback) {
      return {
        behavior: "deny",
        message: "No canUseTool callback registered",
        interrupt: false,
      };
    }

    if (options.permissionMode === "bypassPermissions" && !toolNeedsRuntimeUserInput) {
      return { behavior: "allow", updatedInput: null, updatedPermissions: [] };
    }

    if (hasCallback) {
      try {
        const result = await options.canUseTool!(toolName, toolInput);
        if (result.behavior === "allow") {
          return {
            behavior: "allow",
            message: result.message,
            updatedInput: result.updatedInput ?? null,
            updatedPermissions: result.updatedPermissions ?? [],
          };
        }
        return {
          behavior: "deny",
          message: result.message ?? "Denied by canUseTool callback",
          interrupt: result.interrupt ?? false,
        };
      } catch (error) {
        return {
          behavior: "deny",
          message: error instanceof Error ? error.message : "Callback error",
          interrupt: false,
        };
      }
    }

    if (isHeadlessAutoAllowTool(toolName)) {
      return { behavior: "allow", updatedInput: null, updatedPermissions: [] };
    }

    return {
      behavior: "deny",
      message: "No canUseTool callback registered",
      interrupt: false,
    };
  };

  private async resolveRuntime(): Promise<{ runtime: RuntimeScope }> {
    if (this.mode.kind === "create-agent") {
      const agentId = await createCloudAgent(this.cloudOptions, this.mode.options);
      const conversation = await this.createConversation(agentId);
      return { runtime: { agent_id: agentId, conversation_id: conversation.id } };
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

    return { runtime: { agent_id: agentId, conversation_id: conversationId } };
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
    if (!isCloudConversation(body)) {
      throw new Error("Cloud createSession() response did not include a conversation id.");
    }
    return { id: body.id, agent_id: body.agent_id };
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
    if (!isCloudConversation(body)) {
      throw new Error(`Cloud resumeSession() could not retrieve conversation ${conversationId}.`);
    }
    return { id: body.id, agent_id: body.agent_id };
  }

  private resolveSandboxPolicy(): ResolvedSandboxPolicy {
    if (this.sandboxPolicy) return this.sandboxPolicy;
    const sandboxOptions = this.cloudOptions.sandbox ?? {};
    const lifecycle =
      sandboxOptions.lifecycle ?? (this.effectiveEnvironment() !== undefined ? "external" : "ephemeral");
    const terminateOnClose =
      sandboxOptions.terminateOnClose ?? (lifecycle === "ephemeral");
    this.sandboxPolicy = {
      lifecycle,
      ttlMinutes: sandboxOptions.ttlMinutes ?? DEFAULT_SANDBOX_TTL_MINUTES,
      readyTimeoutMs: sandboxOptions.readyTimeoutMs ?? DEFAULT_SANDBOX_READY_TIMEOUT_MS,
      pollIntervalMs: sandboxOptions.pollIntervalMs ?? DEFAULT_SANDBOX_POLL_INTERVAL_MS,
      refreshOnTurn: sandboxOptions.refreshOnTurn ?? lifecycle !== "external",
      terminateOnClose,
    };
    return this.sandboxPolicy;
  }

  private async resolveConnection(runtime: RuntimeScope): Promise<{ connectionId: string }> {
    const policy = this.resolveSandboxPolicy();
    if (policy.lifecycle !== "external") {
      this.sandbox = await this.createAgentSandbox(runtime.agent_id);
      await this.refreshAgentSandbox(runtime.agent_id, policy.ttlMinutes);
      return this.waitForSandboxConnection(this.sandbox, policy);
    }

    const environment = this.effectiveEnvironment();
    if (environment === undefined) {
      throw new Error(
        "Cloud backend sandbox.lifecycle='external' requires an environment target.",
      );
    }
    const target = environmentToRemoteTarget(environment);
    const client = new RemoteEnvironmentClient({
      baseUrl: this.cloudOptions.apiBaseUrl,
      apiKey: getCloudApiKey(this.cloudOptions),
      headers: this.cloudOptions.headers,
      fetch: this.cloudOptions.fetch,
    });
    const resolved = await client.resolveEnvironment(target, {
      agentId: runtime.agent_id,
      conversationId: runtime.conversation_id,
    });
    return { connectionId: resolved.connectionId };
  }

  private effectiveEnvironment(): LettaCodeEnvironment | undefined {
    const modeEnvironment = this.mode.kind === "session"
      ? this.mode.options.environment
      : undefined;
    return modeEnvironment ?? this.cloudOptions.environment;
  }

  private async createAgentSandbox(agentId: string): Promise<CloudAgentSandbox> {
    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const response = await fetchImpl(
      `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/sandboxes`,
      {
        method: "POST",
        headers: cloudHeaders(this.cloudOptions),
        body: JSON.stringify({}),
      },
    );
    const body = await parseJsonResponse(response);
    assertOkResponse(response, body, "Cloud createAgentSandbox()");
    if (!isCloudAgentSandbox(body)) {
      throw new Error("Cloud createAgentSandbox() response did not include sandboxId/deviceId/connectionName.");
    }
    return body;
  }

  private async refreshAgentSandbox(agentId: string, ttlMinutes: number): Promise<void> {
    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const response = await fetchImpl(
      `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/sandboxes/refresh`,
      {
        method: "POST",
        headers: cloudHeaders(this.cloudOptions),
        body: JSON.stringify({ ttlMinutes }),
      },
    );
    const body = await parseJsonResponse(response);
    assertOkResponse(response, body, "Cloud refreshAgentSandbox()");
  }

  private async terminateAgentSandbox(agentId: string): Promise<void> {
    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const response = await fetchImpl(
      `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/sandboxes`,
      {
        method: "DELETE",
        headers: cloudHeaders(this.cloudOptions),
      },
    );
    const body = await parseJsonResponse(response);
    assertOkResponse(response, body, "Cloud terminateAgentSandbox()");
  }

  private async refreshSandboxForTurn(): Promise<void> {
    const policy = this.resolveSandboxPolicy();
    if (!policy.refreshOnTurn || !this._agentId || !this.sandbox) return;
    await this.refreshAgentSandbox(this._agentId, policy.ttlMinutes);
  }

  private async waitForSandboxConnection(
    sandbox: CloudAgentSandbox,
    policy: ResolvedSandboxPolicy,
  ): Promise<{ connectionId: string; environment?: RemoteEnvironmentConnection }> {
    const client = new RemoteEnvironmentClient({
      baseUrl: this.cloudOptions.apiBaseUrl,
      apiKey: getCloudApiKey(this.cloudOptions),
      headers: this.cloudOptions.headers,
      fetch: this.cloudOptions.fetch,
    });
    const deadline = Date.now() + policy.readyTimeoutMs;
    let lastError: Error | null = null;

    while (Date.now() <= deadline) {
      try {
        const { connections } = await client.listEnvironments({ onlineOnly: true });
        const match = connections.find(
          (environment) =>
            environment.connectionId &&
            (environment.deviceId === sandbox.deviceId ||
              environment.connectionName === sandbox.connectionName),
        );
        if (match?.connectionId) {
          return { connectionId: match.connectionId, environment: match };
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      await delay(policy.pollIntervalMs);
    }

    const suffix = lastError ? ` Last error: ${lastError.message}` : "";
    throw new Error(
      `Timed out waiting for Cloud sandbox ${sandbox.sandboxId} (${sandbox.deviceId}) to come online.${suffix}`,
    );
  }
}
