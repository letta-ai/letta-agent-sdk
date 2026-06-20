import {
  createAppServerClient,
  type AppServerClient,
  type AppServerSocketConstructor,
  type AppServerSocketLike,
  type AppServerSocketOptions,
} from "@letta-ai/letta-code/app-server-client";
import {
  AppServerRuntimeController,
  AppServerSession,
  agentToolNames,
  createExternalToolCallHandler,
  externalToolGroups,
  registerAppServerControlRequestHandler,
  type AppServerSessionOptions,
} from "./app-server-session.js";
import {
  RemoteEnvironmentClient,
  type RemoteEnvironmentTarget,
} from "./remote.js";
import {
  RemoteClientSessionCore,
  mapPermissionMode,
  type ProtocolMessage,
  type RuntimeScope,
  type RuntimeSessionInit,
  type RuntimeSessionMode,
} from "./remote-client-session-core.js";
import type {
  AnyAgentTool,
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeCloudClientOptions,
  LettaCodeCloudSandboxOptions,
  LettaCodeEnvironment,
  LettaCodeSocketConstructor,
  LettaCodeSocketLike,
} from "./types.js";

const DEFAULT_CLOUD_API_BASE_URL = "https://api.letta.com";
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_SANDBOX_TTL_MINUTES = 5;
const MIN_SANDBOX_TTL_MINUTES = 1;
const MAX_SANDBOX_TTL_MINUTES = 60;
const DEFAULT_SANDBOX_READY_TIMEOUT_MS = 120_000;
const DEFAULT_SANDBOX_READY_POLL_INTERVAL_MS = 1_000;
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

type CloudRuntimeStartResponse = ProtocolMessage & {
  type: "runtime_start_response";
  success: boolean;
  runtime: RuntimeScope | null;
  agent: (Record<string, unknown> & { id?: string; model?: string | null }) | null;
  conversation: (Record<string, unknown> & { id?: string; agent_id?: string }) | null;
  error?: string;
};

type CloudConversation = Record<string, unknown> & {
  id?: string;
  agent_id?: string;
};

type CloudAgentSandbox = Record<string, unknown> & {
  sandboxId?: string;
  deviceId?: string;
  connectionName?: string;
};

type CloudAgentSandboxRefresh = Record<string, unknown> & {
  success?: boolean;
  sandboxId?: string;
  ttlMinutes?: number;
};

type ManagedCloudSandbox = {
  agentId: string;
  sandboxId: string;
  deviceId: string;
  connectionName: string;
  ttlMinutes: number;
  readyTimeoutMs: number;
  readyPollIntervalMs: number;
  refreshIntervalMs: number;
  terminateOnClose: boolean;
};

type ResolvedCloudConnection = {
  connectionId: string;
};

class CloudManagedSandboxOwnershipError extends Error {}

type CloudSessionMode = Extract<RuntimeSessionMode, { kind: "session" }>;

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

function validateIntegerRange(
  value: number | undefined,
  name: string,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}. Expected an integer between ${min} and ${max}.`);
  }
}

function validateCloudSandboxOptions(
  options: LettaCodeCloudSandboxOptions | undefined,
  name: string,
): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`Invalid ${name}. Expected an object.`);
  }
  validateIntegerRange(
    options.ttlMinutes,
    `${name}.ttlMinutes`,
    MIN_SANDBOX_TTL_MINUTES,
    MAX_SANDBOX_TTL_MINUTES,
  );
  validatePositiveInteger(options.readyTimeoutMs, `${name}.readyTimeoutMs`);
  validatePositiveInteger(options.readyPollIntervalMs, `${name}.readyPollIntervalMs`);
  validatePositiveInteger(options.refreshIntervalMs, `${name}.refreshIntervalMs`);
  if (
    options.terminateOnClose !== undefined &&
    typeof options.terminateOnClose !== "boolean"
  ) {
    throw new Error(`Invalid ${name}.terminateOnClose. Expected a boolean.`);
  }
}

export function validateCloudClientOptions(options: LettaCodeCloudClientOptions): void {
  validatePositiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
  validatePositiveInteger(options.appServer?.requestTimeoutMs, "appServer.requestTimeoutMs");
  validatePositiveInteger(options.appServer?.startupTimeoutMs, "appServer.startupTimeoutMs");
  validateCloudSandboxOptions(options.sandbox, "sandbox");
  if (options.environment !== undefined && options.sandbox !== undefined) {
    throw new Error("Cloud backend cannot specify both environment and sandbox options.");
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

type CloudStatusSocketControl = AppServerSocketLike & {
  sendCloudCommand(command: Record<string, unknown>): void;
};

type CloudStatusSocketState = {
  runtime: RuntimeScope;
  seenIdempotencyKeys: Set<string>;
  seenIdempotencyOrder: string[];
  lastEventSeq: number | null;
  controlSocket: CloudStatusSocketControl | null;
};

function createCloudStatusWebSocketConstructor(params: {
  cloudOptions: LettaCodeCloudClientOptions;
  runtime: RuntimeScope;
}): AppServerSocketConstructor {
  const WebSocketCtor = getWebSocketConstructor(params.cloudOptions.WebSocket);
  const authMode = params.cloudOptions.webSocketAuth ?? "header";
  const cloudHeaders = authMode === "header" ? cloudWebSocketHeaders(params.cloudOptions) : undefined;
  const pingIntervalMs = params.cloudOptions.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const state: CloudStatusSocketState = {
    runtime: params.runtime,
    seenIdempotencyKeys: new Set<string>(),
    seenIdempotencyOrder: [],
    lastEventSeq: null,
    controlSocket: null,
  };

  class CloudStatusSocketAdapter implements AppServerSocketLike {
    private readonly socket: LettaCodeSocketLike;
    private readonly channel: string | null;
    private readonly listenerRemovers = new Map<string, Map<(event: unknown) => void, () => void>>();
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private removeCloseListener: (() => void) | null = null;

    constructor(url: string, options?: AppServerSocketOptions) {
      this.channel = new URL(url).searchParams.get("channel");
      const mergedHeaders = authMode === "header"
        ? {
            ...(options?.headers ?? {}),
            ...(cloudHeaders ?? {}),
          }
        : undefined;
      const socketOptions = mergedHeaders && Object.keys(mergedHeaders).length > 0
        ? { headers: mergedHeaders }
        : undefined;
      this.socket = new WebSocketCtor(url, socketOptions);
      if (this.channel === "control") {
        state.controlSocket = this;
      }
      this.removeCloseListener = addSocketListener(this.socket, "close", () => {
        this.stopPing();
        if (state.controlSocket === this) state.controlSocket = null;
      });
      this.startPing(pingIntervalMs);
    }

    get readyState(): number {
      return this.socket.readyState;
    }

    send(data: string): void {
      this.socket.send(data);
    }

    close(): void {
      this.stopPing();
      this.removeCloseListener?.();
      this.removeCloseListener = null;
      if (state.controlSocket === this) state.controlSocket = null;
      this.socket.close();
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const wrapped = type === "message"
        ? (event: unknown) => {
            if (this.handleIncomingMessage(event)) {
              listener(event);
            }
          }
        : listener;
      const remove = addSocketListener(this.socket, type, wrapped);
      let typeRemovers = this.listenerRemovers.get(type);
      if (!typeRemovers) {
        typeRemovers = new Map();
        this.listenerRemovers.set(type, typeRemovers);
      }
      typeRemovers.set(listener, remove);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      const typeRemovers = this.listenerRemovers.get(type);
      const remove = typeRemovers?.get(listener);
      if (!remove) return;
      remove();
      typeRemovers?.delete(listener);
      if (typeRemovers?.size === 0) {
        this.listenerRemovers.delete(type);
      }
    }

    private handleIncomingMessage(event: unknown): boolean {
      const data = messageEventData(event);
      if (!data) return true;

      let message: CloudStatusMessage;
      try {
        message = JSON.parse(data) as CloudStatusMessage;
      } catch {
        return true;
      }

      this.ackIfSequenced(message);

      // Cloud's status gateway can mirror device stream frames to the control
      // subscriber. Drop them at the Cloud transport boundary instead of making
      // shared app-server session code understand Cloud fanout quirks. Do this
      // before idempotency/event tracking so the canonical stream-channel frame
      // is still delivered and sequenced.
      if (this.channel === "control" && message.type === "stream_delta") {
        return false;
      }

      if (this.isDuplicate(message)) return false;
      this.trackEventSeq(message);
      return true;
    }

    private ackIfSequenced(message: CloudStatusMessage): void {
      if (typeof message.seq !== "number") return;
      this.sendCloudCommand({ type: "ack", seq: message.seq });
    }

    private isDuplicate(message: CloudStatusMessage): boolean {
      const idempotencyKey =
        typeof message.idempotency_key === "string" ? message.idempotency_key : undefined;
      if (!idempotencyKey) return false;
      if (state.seenIdempotencyKeys.has(idempotencyKey)) return true;
      state.seenIdempotencyKeys.add(idempotencyKey);
      state.seenIdempotencyOrder.push(idempotencyKey);
      while (state.seenIdempotencyOrder.length > 1_000) {
        const oldest = state.seenIdempotencyOrder.shift();
        if (oldest) state.seenIdempotencyKeys.delete(oldest);
      }
      return false;
    }

    private trackEventSeq(message: CloudStatusMessage): void {
      if (typeof message.event_seq !== "number") return;
      if (state.lastEventSeq !== null && message.event_seq > state.lastEventSeq + 1) {
        this.sendSync(true);
      }
      if (state.lastEventSeq === null || message.event_seq > state.lastEventSeq) {
        state.lastEventSeq = message.event_seq;
      }
    }

    private sendSync(recoverApprovals: boolean): void {
      const target = state.controlSocket?.readyState === 1 ? state.controlSocket : this;
      target.sendCloudCommand({
        type: "sync",
        runtime: state.runtime,
        recover_approvals: recoverApprovals,
        force_device_status: true,
      });
    }

    sendCloudCommand(command: Record<string, unknown>): void {
      if (this.readyState !== 1) return;
      try {
        this.socket.send(JSON.stringify(command));
      } catch {
        // Best-effort Cloud status reliability command.
      }
    }

    private startPing(intervalMs: number): void {
      if (this.pingTimer) return;
      this.pingTimer = setInterval(() => {
        this.sendCloudCommand({ type: "ping" });
      }, intervalMs);
      (this.pingTimer as { unref?: () => void }).unref?.();
    }

    private stopPing(): void {
      if (!this.pingTimer) return;
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  return CloudStatusSocketAdapter as AppServerSocketConstructor;
}

function isCloudConversation(value: unknown): value is CloudConversation & { id: string } {
  return Boolean(value && typeof value === "object" && typeof (value as CloudConversation).id === "string");
}

function isCloudAgentSandbox(
  value: unknown,
): value is CloudAgentSandbox & { sandboxId: string; deviceId: string; connectionName: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as CloudAgentSandbox).sandboxId === "string" &&
      typeof (value as CloudAgentSandbox).deviceId === "string" &&
      typeof (value as CloudAgentSandbox).connectionName === "string",
  );
}

function isCloudAgentSandboxRefresh(
  value: unknown,
): value is CloudAgentSandboxRefresh & { success: boolean; sandboxId: string; ttlMinutes: number } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as CloudAgentSandboxRefresh).success === "boolean" &&
      typeof (value as CloudAgentSandboxRefresh).sandboxId === "string" &&
      typeof (value as CloudAgentSandboxRefresh).ttlMinutes === "number",
  );
}

function isRetryableManagedSandboxResolveError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Remote environment is offline") ||
    message.toLowerCase().includes("not found") ||
    message.includes("(404)")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function externalToolsByName(tools: AnyAgentTool[] | undefined): Map<string, AnyAgentTool> {
  const result = new Map<string, AnyAgentTool>();
  for (const tool of tools ?? []) {
    result.set(tool.name, tool);
  }
  return result;
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
    localBackend: "api",
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
  validateCloudSandboxOptions(options.sandbox, "sandbox");
  if (options.environment !== undefined && options.sandbox !== undefined) {
    throw new Error(`Cloud backend ${action}() cannot specify both environment and sandbox options.`);
  }
  if (options.systemPrompt !== undefined) {
    throw new Error(`Cloud backend ${action}() cannot rewrite an existing agent's systemPrompt from the SDK adapter yet.`);
  }
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error(`Cloud backend ${action}() has not wired allowedTools/disallowedTools to the remote device protocol yet.`);
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
  if ((options as { memfsStartup?: unknown }).memfsStartup !== undefined) {
    throw new Error(`Cloud backend ${action}() does not use memfsStartup; remote device startup owns synchronization.`);
  }
  if (options.includePartialMessages !== undefined) {
    throw new Error(`Cloud backend ${action}() streams Remote Client deltas directly; includePartialMessages is not a separate toggle.`);
  }
}

export class CloudEnvironmentSession extends RemoteClientSessionCore {
  private connectionId: string | null = null;
  private removeExternalToolHandler: (() => void) | null = null;
  private removeControlRequestHandler: (() => void) | null = null;
  private externalTools = new Map<string, AnyAgentTool>();
  private managedSandbox: ManagedCloudSandbox | null = null;
  private sandboxRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private sandboxRefreshInFlight: Promise<void> | null = null;
  private readonly cloudMode: CloudSessionMode;

  constructor(
    private readonly cloudOptions: LettaCodeCloudClientOptions,
    mode: CloudSessionMode,
  ) {
    super(mode, {
      label: "cloud",
      requestTimeoutMs: cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    });
    this.cloudMode = mode;
    const tools = mode.options.tools;
    this.externalTools = externalToolsByName(tools);
  }

  protected override async initializeRuntimeController(): Promise<RuntimeSessionInit> {
    const resolved = await this.resolveRuntime();
    const connection = await this.resolveConnectionForRuntime(resolved.runtime);
    this.connectionId = connection.connectionId;

    const apiKey = getCloudApiKey(this.cloudOptions);
    const url = buildCloudStatusWebSocketUrl({
      apiBaseUrl: this.cloudOptions.apiBaseUrl,
      connectionId: connection.connectionId,
      agentId: resolved.runtime.agent_id,
      conversationId: resolved.runtime.conversation_id,
      apiKey,
      authMode: this.cloudOptions.webSocketAuth ?? "header",
    });
    const client = createAppServerClient({
      url,
      WebSocket: createCloudStatusWebSocketConstructor({
        cloudOptions: this.cloudOptions,
        runtime: resolved.runtime,
      }),
      requestTimeoutMs: this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    });
    this.removeControlRequestHandler = registerAppServerControlRequestHandler({
      client,
      getRuntime: () => this.runtime,
      getOptions: () => this.currentOptions(),
    });
    if (this.externalTools.size > 0) {
      this.removeExternalToolHandler = client.onExternalToolCall(
        createExternalToolCallHandler(this.externalTools),
      );
    }

    try {
      await client.connect();
      const response = await this.startCloudRuntime(client, resolved.runtime);
      if (!response.success || !response.runtime) {
        throw new Error(response.error ?? "Failed to start Cloud status runtime");
      }

      const tools = agentToolNames(response.agent);
      return {
        controller: new AppServerRuntimeController(client, {
          requestTimeoutMs: this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        }),
        runtime: response.runtime,
        model: typeof response.agent?.model === "string" ? response.agent.model : "",
        ...(tools !== undefined ? { tools } : {}),
      };
    } catch (error) {
      this.removeExternalToolHandler?.();
      this.removeExternalToolHandler = null;
      this.removeControlRequestHandler?.();
      this.removeControlRequestHandler = null;
      client.close();
      await this.cleanupManagedSandbox();
      throw error;
    }
  }

  private async startCloudRuntime(
    client: AppServerClient,
    runtime: RuntimeScope,
  ): Promise<CloudRuntimeStartResponse> {
    const options = this.currentOptions();
    const command: Record<string, unknown> = {
      client_info: {
        name: SDK_AGENT_ORIGIN,
        title: "Letta Code SDK",
      },
      agent_id: runtime.agent_id,
      conversation_id: runtime.conversation_id,
      recover_approvals: false,
      force_device_status: true,
    };

    const mode = mapPermissionMode(options.permissionMode);
    if (mode) command.mode = mode;
    if (options.cwd !== undefined) command.cwd = options.cwd;
    const groups = externalToolGroups(options.tools);
    if (groups) command.external_tools = groups;

    return (await client.runtimeStart(
      command as Parameters<AppServerClient["runtimeStart"]>[0],
    )) as unknown as CloudRuntimeStartResponse;
  }

  protected override async afterRuntimeInitialized(): Promise<void> {
    if (!this.controller || !this.runtime) return;
    this.controller.send({
      type: "sync",
      runtime: this.runtime,
      recover_approvals: true,
      force_device_status: true,
    });
  }

  protected override async beforeTurn(): Promise<void> {
    const sandbox = this.managedSandbox;
    if (!sandbox) return;
    await this.refreshManagedSandbox(sandbox);
  }

  protected override onCoreClose(): void {
    this.removeExternalToolHandler?.();
    this.removeExternalToolHandler = null;
    this.removeControlRequestHandler?.();
    this.removeControlRequestHandler = null;
    void this.cleanupManagedSandbox();
  }

  private async resolveRuntime(): Promise<{ runtime: RuntimeScope }> {
    let agentId = this.cloudMode.agentId;
    let conversationId = this.cloudMode.conversationId;

    if (agentId && this.cloudMode.newConversation) {
      const conversation = await this.createConversation(agentId);
      conversationId = conversation.id;
    } else if (agentId && this.cloudMode.defaultConversation) {
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

  private async resolveConnectionForRuntime(
    runtime: RuntimeScope,
  ): Promise<ResolvedCloudConnection> {
    const environment = this.effectiveEnvironment();
    const sandboxOptions = this.effectiveSandboxOptions();
    if (environment !== undefined) {
      if (sandboxOptions !== undefined) {
        throw new Error("Cloud backend cannot specify both environment and sandbox options.");
      }
      return this.resolveExplicitConnection(environment);
    }
    return this.createManagedSandboxConnection(runtime);
  }

  private async resolveExplicitConnection(
    environment: LettaCodeEnvironment,
  ): Promise<{ connectionId: string }> {
    const target = environmentToRemoteTarget(environment);
    const resolved = await this.remoteEnvironmentClient().resolveEnvironment(target);
    return { connectionId: resolved.connectionId };
  }

  private async createManagedSandboxConnection(
    runtime: RuntimeScope,
  ): Promise<ResolvedCloudConnection> {
    const sandbox = await this.createManagedSandbox(runtime.agent_id);
    this.managedSandbox = sandbox;

    try {
      await this.refreshManagedSandbox(sandbox);
      const connection = await this.waitForManagedSandboxConnection(sandbox);
      this.startManagedSandboxRefresh(sandbox);
      return { connectionId: connection.connectionId };
    } catch (error) {
      await this.cleanupManagedSandbox();
      throw error;
    }
  }

  private async createManagedSandbox(agentId: string): Promise<ManagedCloudSandbox> {
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
    assertOkResponse(response, body, "Cloud create managed sandbox");
    if (!isCloudAgentSandbox(body)) {
      throw new Error("Cloud create managed sandbox response did not include sandbox connection details.");
    }

    const sandboxOptions = this.resolvedSandboxOptions();
    const ttlMinutes = sandboxOptions.ttlMinutes ?? DEFAULT_SANDBOX_TTL_MINUTES;
    const readyTimeoutMs = sandboxOptions.readyTimeoutMs
      ?? DEFAULT_SANDBOX_READY_TIMEOUT_MS;
    const readyPollIntervalMs = sandboxOptions.readyPollIntervalMs
      ?? DEFAULT_SANDBOX_READY_POLL_INTERVAL_MS;
    const defaultRefreshIntervalMs = Math.max(
      1_000,
      Math.floor(ttlMinutes * 60_000 * 0.8),
    );

    return {
      agentId,
      sandboxId: body.sandboxId,
      deviceId: body.deviceId,
      connectionName: body.connectionName,
      ttlMinutes,
      readyTimeoutMs,
      readyPollIntervalMs,
      refreshIntervalMs: sandboxOptions.refreshIntervalMs ?? defaultRefreshIntervalMs,
      terminateOnClose: sandboxOptions.terminateOnClose ?? true,
    };
  }

  private async refreshManagedSandbox(sandbox: ManagedCloudSandbox): Promise<void> {
    if (this.sandboxRefreshInFlight) {
      await this.sandboxRefreshInFlight;
      return;
    }

    this.sandboxRefreshInFlight = this.refreshManagedSandboxOnce(sandbox);
    try {
      await this.sandboxRefreshInFlight;
    } finally {
      this.sandboxRefreshInFlight = null;
    }
  }

  private async refreshManagedSandboxOnce(sandbox: ManagedCloudSandbox): Promise<void> {
    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const response = await fetchImpl(
      `${baseUrl}/v1/agents/${encodeURIComponent(sandbox.agentId)}/sandboxes/refresh`,
      {
        method: "POST",
        headers: cloudHeaders(this.cloudOptions),
        body: JSON.stringify({ ttlMinutes: sandbox.ttlMinutes }),
      },
    );
    const body = await parseJsonResponse(response);
    assertOkResponse(response, body, "Cloud refresh managed sandbox");
    if (!isCloudAgentSandboxRefresh(body) || !body.success) {
      throw new Error("Cloud refresh managed sandbox response did not confirm refresh.");
    }
    if (body.sandboxId !== sandbox.sandboxId) {
      throw new CloudManagedSandboxOwnershipError(
        `Cloud managed sandbox ownership changed for agent ${sandbox.agentId}: expected ${sandbox.sandboxId}, got ${body.sandboxId}.`,
      );
    }
  }

  private async terminateManagedSandbox(sandbox: ManagedCloudSandbox): Promise<void> {
    await this.refreshManagedSandbox(sandbox);

    const fetchImpl = getFetch(this.cloudOptions.fetch);
    const baseUrl = normalizeCloudApiBaseUrl(this.cloudOptions.apiBaseUrl);
    const response = await fetchImpl(
      `${baseUrl}/v1/agents/${encodeURIComponent(sandbox.agentId)}/sandboxes`,
      {
        method: "DELETE",
        headers: cloudHeaders(this.cloudOptions),
      },
    );
    const body = await parseJsonResponse(response);
    if (response.status === 404) return;
    assertOkResponse(response, body, "Cloud terminate managed sandbox");
  }

  private async waitForManagedSandboxConnection(
    sandbox: ManagedCloudSandbox,
  ): Promise<{ connectionId: string }> {
    const deadline = Date.now() + sandbox.readyTimeoutMs;
    let lastError: unknown;

    while (true) {
      try {
        const resolved = await this.remoteEnvironmentClient().resolveEnvironment({
          deviceId: sandbox.deviceId,
        });
        return { connectionId: resolved.connectionId };
      } catch (error) {
        lastError = error;
        if (!isRetryableManagedSandboxResolveError(error) || Date.now() >= deadline) {
          break;
        }
        const remainingMs = Math.max(0, deadline - Date.now());
        await sleep(Math.min(sandbox.readyPollIntervalMs, remainingMs));
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Cloud managed sandbox ${sandbox.sandboxId} did not come online within ${sandbox.readyTimeoutMs}ms: ${detail}`,
    );
  }

  private startManagedSandboxRefresh(sandbox: ManagedCloudSandbox): void {
    this.stopManagedSandboxRefresh();
    this.sandboxRefreshTimer = setInterval(() => {
      void this.refreshManagedSandbox(sandbox).catch((error) => {
        if (error instanceof CloudManagedSandboxOwnershipError) {
          this.stopManagedSandboxRefresh();
        }
      });
    }, sandbox.refreshIntervalMs);
    (this.sandboxRefreshTimer as { unref?: () => void }).unref?.();
  }

  private stopManagedSandboxRefresh(): void {
    if (!this.sandboxRefreshTimer) return;
    clearInterval(this.sandboxRefreshTimer);
    this.sandboxRefreshTimer = null;
  }

  private async cleanupManagedSandbox(): Promise<void> {
    this.stopManagedSandboxRefresh();
    const sandbox = this.managedSandbox;
    this.managedSandbox = null;
    if (!sandbox || !sandbox.terminateOnClose) return;
    try {
      await this.terminateManagedSandbox(sandbox);
    } catch {
      // Best-effort cleanup: Cloud TTL still bounds leaked managed sandboxes.
    }
  }

  private remoteEnvironmentClient(): RemoteEnvironmentClient {
    return new RemoteEnvironmentClient({
      baseUrl: this.cloudOptions.apiBaseUrl,
      apiKey: getCloudApiKey(this.cloudOptions),
      headers: this.cloudOptions.headers,
      fetch: this.cloudOptions.fetch,
    });
  }

  private effectiveEnvironment(): LettaCodeEnvironment | undefined {
    const modeEnvironment = this.mode.kind === "session"
      ? this.mode.options.environment
      : undefined;
    return modeEnvironment ?? this.cloudOptions.environment;
  }

  private effectiveSandboxOptions(): LettaCodeCloudSandboxOptions | undefined {
    const modeSandbox = this.mode.kind === "session"
      ? this.mode.options.sandbox
      : undefined;
    return modeSandbox ?? this.cloudOptions.sandbox;
  }

  private resolvedSandboxOptions(): LettaCodeCloudSandboxOptions {
    return this.effectiveSandboxOptions() ?? {};
  }
}
