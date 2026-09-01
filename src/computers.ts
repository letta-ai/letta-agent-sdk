import type { Letta } from "@letta-ai/letta-client";
import {
  RemoteEnvironmentClient,
  type RemoteEnvironmentConnection,
  type RemoteEnvironmentTarget,
} from "./remote.js";

/**
 * Selects the computer where a Cloud session runs tools and accesses files.
 *
 * Strings are treated as human-readable computer names. Prefer `deviceId` when
 * persisting a selection because connection IDs can rotate after reconnects.
 */
export type ComputerSelector =
  | string
  | { name: string }
  | { id: string }
  | { connectionId: string }
  | { deviceId: string };

export interface ComputerMetadata {
  os?: string;
  lettaCodeVersion?: string;
  nodeVersion?: string;
  workingDirectory?: string;
  gitBranch?: string;
  [key: string]: unknown;
}

/** A registered computer that can host Letta agent tool execution. */
export interface Computer {
  /** Environment record ID. */
  id: string;
  /** Stable identifier for the physical device across reconnects. */
  deviceId: string;
  /** Current online connection lease. This may rotate after reconnects. */
  connectionId: string | null;
  /** Human-readable computer name. */
  name: string;
  status: "online" | "offline";
  connectedAt: number | null;
  lastSeenAt: number;
  metadata?: ComputerMetadata;
}

export interface ListComputersOptions {
  limit?: number;
  after?: string;
  onlineOnly?: boolean;
}

export interface ListComputersResult {
  computers: Computer[];
  hasNextPage: boolean;
}

export interface ResolvedComputer {
  connectionId: string;
  /** Omitted when resolving an explicit connection ID. */
  computer?: Computer;
}

export interface ComputersClient {
  list(options?: ListComputersOptions): Promise<ListComputersResult>;
  get(deviceId: string): Promise<Computer>;
  resolve(selector: ComputerSelector): Promise<ResolvedComputer>;
}

function selectorToRemoteTarget(
  selector: ComputerSelector,
): RemoteEnvironmentTarget {
  if (typeof selector === "string") return { connectionName: selector };
  if ("name" in selector) return { connectionName: selector.name };
  if ("id" in selector) return { environmentId: selector.id };
  if ("connectionId" in selector) {
    return { connectionId: selector.connectionId };
  }
  return { deviceId: selector.deviceId };
}

function toComputer(environment: RemoteEnvironmentConnection): Computer {
  return {
    id: environment.id,
    deviceId: environment.deviceId,
    connectionId: environment.connectionId,
    name: environment.connectionName,
    status: environment.connectionId ? "online" : "offline",
    connectedAt: environment.connectedAt,
    lastSeenAt: environment.lastSeenAt,
    metadata: environment.metadata,
  };
}

/** Public Cloud computer discovery and selection client. */
export class ComputersClientImpl implements ComputersClient {
  private readonly environments: RemoteEnvironmentClient;

  constructor(
    client: Letta,
    private readonly assertOpen: () => void = () => {},
  ) {
    this.environments = new RemoteEnvironmentClient({}, client);
  }

  async list(
    options: ListComputersOptions = {},
  ): Promise<ListComputersResult> {
    this.assertOpen();
    const result = await this.environments.listEnvironments(options);
    return {
      computers: result.connections.map(toComputer),
      hasNextPage: result.hasNextPage,
    };
  }

  async get(deviceId: string): Promise<Computer> {
    this.assertOpen();
    if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
      throw new Error("Invalid deviceId. Expected a non-empty string.");
    }
    return toComputer(
      await this.environments.getEnvironmentByDeviceId(deviceId),
    );
  }

  async resolve(selector: ComputerSelector): Promise<ResolvedComputer> {
    this.assertOpen();
    const result = await this.environments.resolveEnvironment(
      selectorToRemoteTarget(selector),
    );
    return {
      connectionId: result.connectionId,
      computer: result.environment
        ? toComputer(result.environment)
        : undefined,
    };
  }
}
