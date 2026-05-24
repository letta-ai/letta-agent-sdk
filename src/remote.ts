import type { MessageContentItem, SendMessage, TextContent } from "./types.js";

export type RemoteEnvironmentTarget =
  | { connectionId: string }
  | { environmentId: string }
  | { deviceId: string }
  | { connectionName: string }
  | { lastUsed: true };

export type RemoteEnvironmentFallback = "fail_if_unavailable" | "any_online";

export interface RemoteEnvironmentClientOptions {
  /** Letta API base URL. Defaults to https://api.letta.com. */
  baseUrl?: string;
  /** Bearer token / API key. Defaults to process.env.LETTA_API_KEY when present. */
  apiKey?: string;
  /** Additional headers, e.g. x-project-id. */
  headers?: Record<string, string>;
  /** Custom fetch implementation for tests or non-standard runtimes. */
  fetch?: typeof fetch;
}

export interface RemoteEnvironmentConnection {
  id: string;
  connectionId: string | null;
  deviceId: string;
  connectionName: string;
  organizationId: string;
  userId?: string;
  apiKeyOwner?: string;
  podId: string | null;
  connectedAt: number | null;
  lastHeartbeat: number | null;
  lastSeenAt: number;
  firstSeenAt: number;
  currentMode?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteEnvironmentListResult {
  connections: RemoteEnvironmentConnection[];
  hasNextPage: boolean;
}

export interface RemoteRuntimeLastEnvironment {
  environmentId: string | null;
  deviceId: string;
  connectionName: string;
  metadata: Record<string, unknown> | null;
  status: "online" | "offline" | "unreachable";
  isOnline: boolean;
  lastSeenAt: number | null;
  lastUsedAt: number;
  source: "environment" | "sandbox" | "unknown";
}

export interface ResolvedRemoteEnvironment {
  connectionId: string;
  environment?: RemoteEnvironmentConnection;
  target: RemoteEnvironmentTarget;
}

export interface ResolveRemoteEnvironmentOptions {
  agentId?: string;
  conversationId?: string | null;
  fallback?: RemoteEnvironmentFallback;
}

export interface RemoteMessageDispatchResult {
  success: boolean;
  message: string;
  connectionId: string;
  environment?: RemoteEnvironmentConnection;
  clientMessageId: string;
}

export interface SendRemoteMessageOptions extends ResolveRemoteEnvironmentOptions {
  clientMessageId?: string;
}

export interface RemoteAgentOptions extends RemoteEnvironmentClientOptions {
  agentId: string;
  conversationId?: string | null;
  target: RemoteEnvironmentTarget;
  fallback?: RemoteEnvironmentFallback;
}

type RemoteUserMessage = {
  role: "user";
  content: string | TextContent[];
  client_message_id: string;
  otid?: string;
};

type RemoteFetch = typeof fetch;

function getDefaultApiKey(): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env.LETTA_API_KEY;
}

function createHeaders(options: RemoteEnvironmentClientOptions): Record<string, string> {
  const apiKey = options.apiKey ?? getDefaultApiKey();
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(options.headers ?? {}),
  };
}

function getFetch(options: RemoteEnvironmentClientOptions): RemoteFetch {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("Remote environments require a fetch implementation");
  }
  return fetchImpl.bind(globalThis) as RemoteFetch;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? "https://api.letta.com").replace(/\/$/, "");
}

function isTextContent(item: MessageContentItem): item is TextContent {
  return item.type === "text";
}

function toRemoteUserMessage(
  input: SendMessage,
  clientMessageId: string,
): RemoteUserMessage {
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
    throw new Error(
      "Remote environment messages currently support text content only",
    );
  }

  return {
    role: "user",
    content: textParts,
    client_message_id: clientMessageId,
    otid: clientMessageId,
  };
}

function generateClientMessageId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureOnline(
  environment: RemoteEnvironmentConnection,
  target: RemoteEnvironmentTarget,
): ResolvedRemoteEnvironment {
  if (!environment.connectionId) {
    const label =
      "deviceId" in target
        ? target.deviceId
        : "environmentId" in target
          ? target.environmentId
          : "connectionName" in target
            ? target.connectionName
            : environment.deviceId;
    throw new Error(`Remote environment is offline: ${label}`);
  }

  return {
    connectionId: environment.connectionId,
    environment,
    target,
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : response.statusText;
    throw new Error(`Letta API request failed (${response.status}): ${message}`);
  }

  return body as T;
}

/**
 * Small Cloud API helper for remote Letta Code environments.
 *
 * This wraps the currently public environment dispatch primitives. Message
 * sends are ACK-only: use the returned clientMessageId/run events elsewhere
 * for live UI once the Cloud remote streaming API is exposed.
 */
export class RemoteEnvironmentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: RemoteFetch;

  constructor(private readonly options: RemoteEnvironmentClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = getFetch(options);
  }

  async listEnvironments(query: { onlineOnly?: boolean } = {}): Promise<RemoteEnvironmentListResult> {
    const url = new URL(`${this.baseUrl}/v1/environments`);
    if (query.onlineOnly !== undefined) {
      url.searchParams.set("onlineOnly", String(query.onlineOnly));
    }

    const response = await this.fetchImpl(url, {
      headers: createHeaders(this.options),
    });
    return parseJsonResponse<RemoteEnvironmentListResult>(response);
  }

  async getEnvironmentByDeviceId(deviceId: string): Promise<RemoteEnvironmentConnection> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/environments/${encodeURIComponent(deviceId)}`,
      { headers: createHeaders(this.options) },
    );
    return parseJsonResponse<RemoteEnvironmentConnection>(response);
  }

  async getLastEnvironment(params: {
    agentId: string;
    conversationId: string;
  }): Promise<RemoteRuntimeLastEnvironment> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/environments/runtimes/${encodeURIComponent(params.agentId)}/${encodeURIComponent(params.conversationId)}/last`,
      { headers: createHeaders(this.options) },
    );
    return parseJsonResponse<RemoteRuntimeLastEnvironment>(response);
  }

  async resolveEnvironment(
    target: RemoteEnvironmentTarget,
    options: ResolveRemoteEnvironmentOptions = {},
  ): Promise<ResolvedRemoteEnvironment> {
    if ("connectionId" in target) {
      return { connectionId: target.connectionId, target };
    }

    try {
      if ("deviceId" in target) {
        return ensureOnline(await this.getEnvironmentByDeviceId(target.deviceId), target);
      }

      if ("lastUsed" in target) {
        if (!options.agentId) {
          throw new Error("agentId is required to resolve last used environment");
        }
        const conversationId = options.conversationId ?? "default";
        const last = await this.getLastEnvironment({
          agentId: options.agentId,
          conversationId,
        });
        return ensureOnline(await this.getEnvironmentByDeviceId(last.deviceId), target);
      }

      const { connections } = await this.listEnvironments();
      if ("environmentId" in target) {
        const match = connections.find((env) => env.id === target.environmentId);
        if (!match) {
          throw new Error(`Remote environment not found: ${target.environmentId}`);
        }
        return ensureOnline(match, target);
      }

      const matches = connections.filter(
        (env) => env.connectionName === target.connectionName,
      );
      if (matches.length === 0) {
        throw new Error(`Remote environment not found: ${target.connectionName}`);
      }
      if (matches.length > 1) {
        throw new Error(
          `Remote environment name is ambiguous: ${target.connectionName}`,
        );
      }
      const match = matches[0];
      if (!match) {
        throw new Error(`Remote environment not found: ${target.connectionName}`);
      }
      return ensureOnline(match, target);
    } catch (error) {
      if (options.fallback !== "any_online") {
        throw error;
      }

      const { connections } = await this.listEnvironments({ onlineOnly: true });
      const fallback = connections.find((env) => env.connectionId !== null);
      if (!fallback?.connectionId) {
        throw error;
      }

      return {
        connectionId: fallback.connectionId,
        environment: fallback,
        target,
      };
    }
  }

  async sendMessage(params: {
    agentId: string;
    conversationId?: string | null;
    target: RemoteEnvironmentTarget;
    input: SendMessage;
    options?: SendRemoteMessageOptions;
  }): Promise<RemoteMessageDispatchResult> {
    const clientMessageId =
      params.options?.clientMessageId ?? generateClientMessageId();
    const resolved = await this.resolveEnvironment(params.target, {
      agentId: params.agentId,
      conversationId: params.conversationId,
      fallback: params.options?.fallback,
    });

    const body = {
      messages: [toRemoteUserMessage(params.input, clientMessageId)],
      agentId: params.agentId,
      conversationId: params.conversationId ?? "default",
    };

    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/environments/${encodeURIComponent(resolved.connectionId)}/messages`,
      {
        method: "POST",
        headers: {
          ...createHeaders(this.options),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const result = await parseJsonResponse<{ success: boolean; message: string }>(
      response,
    );

    return {
      ...result,
      connectionId: resolved.connectionId,
      environment: resolved.environment,
      clientMessageId,
    };
  }
}

/**
 * Actor-style convenience wrapper for dispatching turns to a remote environment.
 *
 * Today this is a fire-and-forget `tell()` abstraction over the Cloud
 * environment dispatch endpoint. It intentionally does not pretend to stream a
 * final answer until Cloud exposes a stable remote run/event API for SDKs.
 */
export class RemoteAgent {
  private readonly client: RemoteEnvironmentClient;

  constructor(private readonly options: RemoteAgentOptions) {
    this.client = new RemoteEnvironmentClient(options);
  }

  async tell(
    input: SendMessage,
    options: SendRemoteMessageOptions = {},
  ): Promise<RemoteMessageDispatchResult> {
    return this.client.sendMessage({
      agentId: this.options.agentId,
      conversationId: this.options.conversationId,
      target: this.options.target,
      input,
      options: {
        fallback: this.options.fallback,
        ...options,
      },
    });
  }

  async resolveTarget(): Promise<ResolvedRemoteEnvironment> {
    return this.client.resolveEnvironment(this.options.target, {
      agentId: this.options.agentId,
      conversationId: this.options.conversationId,
      fallback: this.options.fallback,
    });
  }
}

export function createRemoteAgent(options: RemoteAgentOptions): RemoteAgent {
  return new RemoteAgent(options);
}
