import {
  isHeadlessAutoAllowTool,
  requiresRuntimeUserInput,
} from "./interactiveToolPolicy.js";
import {
  RemoteEnvironmentClient,
  type RemoteEnvironmentConnection,
  type RemoteEnvironmentTarget,
} from "./remote.js";
import type {
  BootstrapStateOptions,
  BootstrapStateResult,
  CanUseToolResponse,
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeCloudClientOptions,
  LettaCodeEnvironment,
  LettaCodeSession,
  LettaCodeSocketConstructor,
  LettaCodeSocketLike,
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
  SendMessage,
} from "./types.js";

const DEFAULT_CLOUD_API_BASE_URL = "https://api.letta.com";
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_SANDBOX_TTL_MINUTES = 5;
const DEFAULT_SANDBOX_READY_TIMEOUT_MS = 120_000;
const DEFAULT_SANDBOX_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const SDK_AGENT_ORIGIN = "@letta-ai/letta-code-sdk";
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

type FetchLike = typeof fetch;

type RuntimeScope = {
  agent_id: string;
  conversation_id: string;
};

type CloudStatusMessage = Record<string, unknown> & {
  type?: unknown;
  seq?: unknown;
  event_seq?: unknown;
  idempotency_key?: unknown;
  request_id?: unknown;
  runId?: unknown;
  run_id?: unknown;
  stopReason?: unknown;
  stop_reason?: unknown;
  conversation_id?: unknown;
  conversationId?: unknown;
  agent_id?: unknown;
  agentId?: unknown;
  runtime?: RuntimeScope;
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
};

type PendingResponse = {
  predicate: (message: CloudStatusMessage) => boolean;
  resolve: (message: CloudStatusMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type CloudSessionMode =
  | { kind: "create-agent"; options: CreateAgentOptions }
  | {
      kind: "session";
      agentId?: string;
      conversationId?: string;
      newConversation?: boolean;
      defaultConversation?: boolean;
      options: LettaCodeClientSessionOptions;
    };

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

  if (!hasOriginTag) normalizedTags.push(SDK_AGENT_ORIGIN_TAG);
  return normalizedTags;
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

function normalizeMemoryBlock(block: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...block };
  if (normalized.value === undefined && typeof normalized.content === "string") {
    normalized.value = normalized.content;
  }
  return normalized;
}

function createCloudAgentBody(options: CreateAgentOptions): Record<string, unknown> {
  if (options.cwd !== undefined || options.permissionMode !== undefined || options.canUseTool !== undefined) {
    throw new Error("Cloud createAgent() creates the agent record only. Pass cwd, permissionMode, and canUseTool to createSession()/resumeSession() so they can be sent to the Remote Client device.");
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    throw new Error("Cloud createAgent() creates the agent record only. Pass SDK-hosted tools to createSession()/resumeSession() once they are wired through Remote Client control responses.");
  }
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error("Cloud createAgent() cannot persist allowedTools/disallowedTools in the Cloud agent REST payload yet. Configure tool filters on the execution session once the Remote Client toolset command is wired.");
  }
  if (options.skillSources !== undefined) {
    throw new Error("Cloud createAgent() cannot persist skillSources in the Cloud agent REST payload yet. Configure skill sources on the execution session once the Remote Client skills command is wired.");
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error("Cloud createAgent() cannot persist systemInfoReminder in the Cloud agent REST payload yet.");
  }
  if (options.sleeptime !== undefined) {
    throw new Error("Cloud createAgent() cannot persist sleeptime settings in the Cloud agent REST payload yet.");
  }
  if (options.memfs !== undefined) {
    throw new Error("Cloud createAgent() does not change device MemFS state. Pass memfs options to createSession()/resumeSession() so they can be sent to the Remote Client device.");
  }

  const body: Record<string, unknown> = {
    tags: includeSdkAgentOriginTag(options.tags),
  };

  if (options.model !== undefined) body.model = options.model;
  if (options.embedding !== undefined) body.embedding = options.embedding;

  if (options.systemPrompt !== undefined) {
    if (typeof options.systemPrompt === "string") {
      if (isPresetSystemPrompt(options.systemPrompt)) {
        throw new Error("Cloud createAgent() cannot expand SDK system prompt presets in the Cloud REST agent payload yet. Pass a custom system prompt string or omit systemPrompt.");
      }
      body.system = options.systemPrompt;
    } else {
      throw new Error("Cloud createAgent() cannot expand SDK system prompt preset objects in the Cloud REST agent payload yet. Pass a custom system prompt string or omit systemPrompt.");
    }
  }

  const memoryBlocks: Array<Record<string, unknown>> = [];
  const blockIds: string[] = [];
  for (const item of options.memory ?? []) {
    if (typeof item === "string") {
      throw new Error("Cloud createAgent() cannot expand memory preset names in the Cloud REST agent payload yet. Pass explicit memory blocks or block ids.");
    }
    if ("blockId" in item) {
      blockIds.push(item.blockId);
    } else {
      memoryBlocks.push(normalizeMemoryBlock(item as unknown as Record<string, unknown>));
    }
  }
  if (options.persona !== undefined) memoryBlocks.push({ label: "persona", value: options.persona });
  if (options.human !== undefined) memoryBlocks.push({ label: "human", value: options.human });
  if (memoryBlocks.length > 0) body.memory_blocks = memoryBlocks;
  if (blockIds.length > 0) body.block_ids = blockIds;

  return body;
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
  if (mode === "plan") return "memory";
  return undefined;
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

  return {
    role: "user",
    content: input,
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

export async function createCloudAgent(
  clientOptions: LettaCodeCloudClientOptions,
  agentOptions: CreateAgentOptions,
): Promise<string> {
  const fetchImpl = getFetch(clientOptions.fetch);
  const baseUrl = normalizeCloudApiBaseUrl(clientOptions.apiBaseUrl);
  const response = await fetchImpl(`${baseUrl}/v1/agents/`, {
    method: "POST",
    headers: cloudHeaders(clientOptions),
    body: JSON.stringify(createCloudAgentBody(agentOptions)),
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

export class CloudEnvironmentSession implements LettaCodeSession {
  private ws: LettaCodeSocketLike | null = null;
  private removeSocketHandlers: Array<() => void> = [];
  private runtime: RuntimeScope | null = null;
  private connectionId: string | null = null;
  private sandbox: CloudAgentSandbox | null = null;
  private sandboxPolicy: ResolvedSandboxPolicy | null = null;
  private initialized = false;
  private closed = false;
  private streamQueue: SDKMessage[] = [];
  private streamResolvers: Array<(msg: SDKMessage | null) => void> = [];
  private pendingTurn: PendingTurn | null = null;
  private pendingResponses = new Map<string, PendingResponse>();
  private activeTurn: Promise<void> | null = null;
  private activeTurnStartedAt = 0;
  private activeTurnAssistantText = "";
  private messageCounter = 0;
  private requestCounter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventSeq: number | null = null;
  private seenIdempotencyKeys = new Set<string>();
  private _agentId: string | null = null;
  private _sessionId: string | null = null;
  private _conversationId: string | null = null;
  private _model = "";

  constructor(
    private readonly cloudOptions: LettaCodeCloudClientOptions,
    private readonly mode: CloudSessionMode,
  ) {}

  async initialize(): Promise<SDKInitMessage> {
    if (this.initialized) {
      throw new Error("Session already initialized");
    }
    if (this.closed) {
      throw new Error("Session is closed");
    }

    const resolved = await this.resolveRuntime();
    this.runtime = resolved.runtime;
    this._agentId = resolved.runtime.agent_id;
    this._conversationId = resolved.runtime.conversation_id;
    this._sessionId = `${resolved.runtime.agent_id}:${resolved.runtime.conversation_id}`;

    const connection = await this.resolveConnection(resolved.runtime);
    this.connectionId = connection.connectionId;

    const apiKey = getCloudApiKey(this.cloudOptions);
    const authMode = this.cloudOptions.webSocketAuth ?? "header";
    const url = buildCloudStatusWebSocketUrl({
      apiBaseUrl: this.cloudOptions.apiBaseUrl,
      connectionId: connection.connectionId,
      agentId: resolved.runtime.agent_id,
      conversationId: resolved.runtime.conversation_id,
      apiKey,
      authMode,
    });

    const WebSocketCtor = getWebSocketConstructor(this.cloudOptions.WebSocket);
    const socketHeaders = authMode === "header" ? cloudWebSocketHeaders(this.cloudOptions) : undefined;
    const socketOptions = socketHeaders ? { headers: socketHeaders } : undefined;
    this.ws = new WebSocketCtor(url, socketOptions);
    this.removeSocketHandlers.push(
      addSocketListener(this.ws, "message", this.handleStatusEvent),
      addSocketListener(this.ws, "close", this.handleSocketClose),
      addSocketListener(this.ws, "error", this.handleSocketError),
    );
    await promiseWithTimeout(
      waitForOpen(this.ws),
      this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "Timed out waiting for Cloud status websocket to open.",
    );
    this.initialized = true;
    this.startPing();

    this.sendSync(true);
    await this.applyPostInitializeOptions();

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
    if (!this.runtime) {
      throw new Error("Session is not initialized");
    }
    if (this.activeTurn) {
      throw new Error("A turn is already in flight for this cloud session");
    }

    await this.refreshSandboxForTurn();

    this.streamQueue.length = 0;
    this.activeTurnAssistantText = "";
    this.activeTurnStartedAt = Date.now();
    this.pendingTurn = this.createPendingTurn();

    const pendingTurn = this.pendingTurn;
    this.activeTurn = this.dispatchAndWaitForTurn(message, pendingTurn)
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
          runIds: Array.from(pendingTurn.runIds),
        });
      })
      .finally(() => {
        this.pendingTurn = null;
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
    if (!this.runtime) {
      throw new Error("Session is not initialized");
    }

    this.sendSync(true);
    const requestId = this.nextRequestId("recover-approvals");
    const responsePromise = this.waitForResponse(
      requestId,
      (message) =>
        message.type === "recover_pending_approvals_ack" ||
        message.type === "recover_pending_approvals_response",
      options.timeoutMs ?? this.cloudOptions.requestTimeoutMs ?? 30_000,
    );
    this.sendToDevice({
      type: "recover_pending_approvals",
      request_id: requestId,
      runtime: this.runtime,
    });

    try {
      await responsePromise;
      return { recovered: true, pendingApproval: false, unsupported: false };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { recovered: false, pendingApproval: undefined, unsupported: false, detail };
    }
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    const conversationId = options.conversationId ?? this._conversationId;
    if (!conversationId) {
      throw new Error("No conversation id available for listMessages()");
    }

    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const url = new URL(`${baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/messages`);
    if (options.before !== undefined) url.searchParams.set("before", options.before);
    if (options.after !== undefined) url.searchParams.set("after", options.after);
    if (options.order !== undefined) url.searchParams.set("order", options.order);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));

    const response = await fetchImpl(url, { headers: cloudHeaders(this.cloudOptions) });
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

  async bootstrapState(options: BootstrapStateOptions = {}): Promise<BootstrapStateResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    const page = await this.listMessages({
      limit: options.limit,
      order: options.order,
    });

    return {
      agentId: this._agentId ?? "",
      conversationId: this._conversationId ?? "",
      model: this._model,
      tools: [],
      memfsEnabled: this.currentOptions().memfs === true,
      messages: page.messages,
      nextBefore: page.nextBefore ?? null,
      hasMore: page.hasMore ?? false,
      hasPendingApproval: false,
    };
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
    this.ws = null;
    for (const [requestId, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Cloud websocket closed before ${requestId} response arrived`));
    }
    this.pendingResponses.clear();
    this.resolveAll(null);

    if (this.sandbox !== null && this.sandboxPolicy?.terminateOnClose === true && this._agentId) {
      const agentId = this._agentId;
      void this.terminateAgentSandbox(agentId).catch(() => {
        // close() is intentionally synchronous; cleanup failures are ignored.
      });
    }
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
      terminalResolved: false,
    };
  }

  private async dispatchAndWaitForTurn(
    message: SendMessage,
    pendingTurn: PendingTurn,
  ): Promise<void> {
    if (!this.runtime) {
      throw new Error("Session is not initialized");
    }

    const clientMessageId = generateClientMessageId();
    this.sendToDevice({
      type: "input",
      request_id: this.nextRequestId("input"),
      runtime: this.runtime,
      payload: {
        kind: "create_message",
        messages: [toCloudUserMessage(message, clientMessageId)],
        supports_control_response: true,
        source: SDK_AGENT_ORIGIN,
      },
    });

    const terminal = await promiseWithTimeout(
      pendingTurn.terminalPromise,
      this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "Timed out waiting for Cloud Remote Client turn result.",
    );

    this.enqueue(this.resultFromTerminal(terminal, pendingTurn));
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

    if (!this.runtime || !isRuntimeMatch(message, this.runtime)) return;
    const type = typeof message.type === "string" ? message.type : undefined;

    if (type === "stream_delta") {
      const delta = message.delta;
      if (delta && typeof delta === "object") {
        const runId = typeof (delta as Record<string, unknown>).run_id === "string"
          ? ((delta as Record<string, unknown>).run_id as string)
          : undefined;
        if (runId && this.pendingTurn) this.pendingTurn.runIds.add(runId);
        const sdkMessage = this.transformStreamDelta(delta as Record<string, unknown>);
        if (sdkMessage) this.enqueue(sdkMessage);
      }
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
        errorCode: toSdkErrorCode(getStopReason(message)) ?? "error",
        runId: getRunId(message),
      });
    }
  }

  private ackIfSequenced(message: CloudStatusMessage): void {
    if (typeof message.seq !== "number") return;
    try {
      this.sendToDevice({ type: "ack", seq: message.seq });
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
    if (status === "WAITING_ON_INPUT") {
      this.resolvePendingTerminal({ success: true, stopReason: "end_turn" });
    }
  }

  private async handleControlRequest(message: CloudStatusMessage): Promise<void> {
    if (!this.runtime) return;
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
    this.sendToDevice({
      type: "input",
      runtime: this.runtime,
      payload: {
        kind: "approval_response",
        request_id: requestId,
        decision: response,
      },
    });
  }

  private async resolveToolApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<CanUseToolResponse> {
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
  }

  private resolvePendingTerminal(terminal: TerminalTurn): void {
    const pending = this.pendingTurn;
    if (!pending || pending.terminalResolved) return;
    if (terminal.runId) pending.runIds.add(terminal.runId);
    pending.terminalResolved = true;
    pending.resolveTerminal(terminal);
  }

  private rejectActiveTurn(error: Error): void {
    const pending = this.pendingTurn;
    if (!pending || pending.terminalResolved) return;
    pending.terminalResolved = true;
    pending.rejectTerminal(error);
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

  private async applyPostInitializeOptions(): Promise<void> {
    if (!this.runtime) return;
    const options = this.currentOptions();

    if (options.memfs === true) {
      const requestId = this.nextRequestId("enable-memfs");
      const response = await this.requestDevice(
        {
          type: "enable_memfs",
          request_id: requestId,
          runtime: this.runtime,
          agent_id: this.runtime.agent_id,
        },
        (message) => message.type === "enable_memfs_response",
        this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      );
      if (response.success === false) {
        throw new Error(typeof response.error === "string" ? response.error : "Failed to enable memfs");
      }
    }

    if (options.model !== undefined) {
      const requestId = this.nextRequestId("update-model");
      const response = await this.requestDevice(
        {
          type: "update_model",
          request_id: requestId,
          runtime: this.runtime,
          payload: { model_handle: options.model },
        },
        (message) => message.type === "update_model_response",
        this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      );
      if (response.success === false) {
        throw new Error(typeof response.error === "string" ? response.error : "Failed to update model");
      }
      if (typeof response.model_handle === "string") this._model = response.model_handle;
    }

    const payload: Record<string, unknown> = {};
    const mode = mapPermissionMode(options.permissionMode);
    if (mode) payload.mode = mode;
    if (options.cwd !== undefined) payload.cwd = options.cwd;
    if (Object.keys(payload).length > 0) {
      this.sendToDevice({
        type: "change_device_state",
        runtime: this.runtime,
        payload,
      });
    }
  }

  private currentOptions(): LettaCodeClientSessionOptions | CreateAgentOptions {
    return this.mode.kind === "create-agent" ? this.mode.options : this.mode.options;
  }

  private sendSync(recoverApprovals: boolean): void {
    if (!this.runtime || !this.ws || this.ws.readyState !== 1) return;
    this.sendToDevice({
      type: "sync",
      runtime: this.runtime,
      recover_approvals: recoverApprovals,
    });
  }

  private sendToDevice(command: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error("Cloud status websocket is not open.");
    }
    this.ws.send(JSON.stringify(command));
  }

  private requestDevice(
    command: Record<string, unknown> & { request_id?: string },
    predicate: (message: CloudStatusMessage) => boolean,
    timeoutMs: number,
  ): Promise<CloudStatusMessage> {
    const requestId = command.request_id ?? this.nextRequestId(String(command.type ?? "request"));
    command.request_id = requestId;
    const promise = this.waitForResponse(requestId, predicate, timeoutMs);
    this.sendToDevice(command);
    return promise;
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
