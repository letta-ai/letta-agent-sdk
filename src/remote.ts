import type Letta from "@letta-ai/letta-client";
import { createCloudClient } from "./cloud-client.js";

export type RemoteEnvironmentTarget =
  | { connectionId: string }
  | { environmentId: string }
  | { deviceId: string }
  | { connectionName: string };

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

export interface RemoteEnvironmentListOptions {
  limit?: number;
  after?: string;
  onlineOnly?: boolean;
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
    throw new Error(`Computer is offline: ${label}`);
  }

  return {
    connectionId: environment.connectionId,
    environment,
    target,
  };
}

/**
 * Resolve explicit Letta Code environments through the generated Letta client.
 */
export class RemoteEnvironmentClient {
  constructor(
    options: RemoteEnvironmentClientOptions = {},
    private readonly client: Letta = createCloudClient({
      backend: "cloud",
      apiBaseUrl: options.baseUrl,
      apiKey: options.apiKey,
      headers: options.headers,
      fetch: options.fetch,
    }),
  ) {}

  async listEnvironments(
    options: RemoteEnvironmentListOptions = {},
  ): Promise<RemoteEnvironmentListResult> {
    return await this.client.environments.list({
      after: options.after,
      limit: options.limit === undefined ? undefined : String(options.limit),
      onlineOnly: options.onlineOnly === undefined
        ? undefined
        : String(options.onlineOnly),
    }) as RemoteEnvironmentListResult;
  }

  async getEnvironmentByDeviceId(deviceId: string): Promise<RemoteEnvironmentConnection> {
    return await this.client.environments.retrieve(
      deviceId,
    ) as RemoteEnvironmentConnection;
  }

  async resolveEnvironment(target: RemoteEnvironmentTarget): Promise<ResolvedRemoteEnvironment> {
    if ("connectionId" in target) {
      return { connectionId: target.connectionId, target };
    }

    if ("deviceId" in target) {
      return ensureOnline(await this.getEnvironmentByDeviceId(target.deviceId), target);
    }

    const connections: RemoteEnvironmentConnection[] = [];
    let after: string | undefined;
    do {
      const page = await this.listEnvironments({ limit: 100, after });
      connections.push(...page.connections);
      if (!page.hasNextPage || page.connections.length === 0) break;
      after = page.connections.at(-1)?.id;
    } while (after !== undefined);

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
      throw new Error(`Computer not found: ${target.connectionName}`);
    }
    const onlineMatches = matches.filter(
      (environment) => environment.connectionId !== null,
    );
    if (onlineMatches.length === 0) {
      throw new Error(`Computer is offline: ${target.connectionName}`);
    }
    if (onlineMatches.length > 1) {
      const candidates = onlineMatches
        .map((environment) =>
          `${environment.connectionName} (${environment.deviceId}, online)`
        )
        .join(", ");
      throw new Error(
        `Computer name is ambiguous: ${target.connectionName}. Matches: ${candidates}. Select one by deviceId.`,
      );
    }
    return ensureOnline(onlineMatches[0]!, target);
  }
}
