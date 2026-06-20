export type RemoteEnvironmentTarget =
  | { connectionId: string }
  | { environmentId: string }
  | { deviceId: string }
  | { connectionName: string };

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
 * Small Cloud API helper for resolving explicit Letta Code environments.
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

}
