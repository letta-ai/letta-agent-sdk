import type {
  AgentRepositoriesClient,
  AgentRepository,
  AgentRepositoryRecompileTarget,
  AttachAgentRepositoryOptions,
  DetachAgentRepositoryOptions,
  AgentRepositoryPermissions,
} from "./management-types.js";

const DEFAULT_VISIBILITY_TIMEOUT_MS = 10_000;
const DEFAULT_VISIBILITY_POLL_INTERVAL_MS = 100;

export interface AgentRepositoriesTransport {
  listAgentRepositories(agentId: string): Promise<AgentRepository[]>;
  attachAgentRepository(
    agentId: string,
    repositoryId: string,
    permissions: AgentRepositoryPermissions | undefined,
  ): Promise<AgentRepository>;
  detachAgentRepository(
    agentId: string,
    repositoryId: string,
  ): Promise<void>;
  recompileAgentSystemPrompt(agentId: string): Promise<void>;
}

type TransportProvider = () => AgentRepositoriesTransport;

type VisibilityOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

function assertNonEmptyId(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${name}. Expected a non-empty string.`);
  }
}

function assertPermissions(
  permissions: AgentRepositoryPermissions | undefined,
): void {
  if (
    permissions !== undefined &&
    permissions !== "read" &&
    permissions !== "read_write"
  ) {
    throw new Error(
      `Invalid repository permissions '${String(permissions)}'. Expected "read" or "read_write".`,
    );
  }
}

function assertRecompileTarget(
  recompile: AgentRepositoryRecompileTarget | undefined,
): void {
  if (recompile !== undefined && recompile !== "default" && recompile !== false) {
    throw new Error(
      `Invalid repository recompile target '${String(recompile)}'. Expected "default" or false.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRepositoryState(
  transport: AgentRepositoriesTransport,
  agentId: string,
  repositoryId: string,
  attached: boolean,
  permissions: AgentRepositoryPermissions | undefined,
  options: VisibilityOptions,
): Promise<void> {
  const deadline = Date.now() +
    (options.timeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS);
  while (true) {
    const repositories = await transport.listAgentRepositories(agentId);
    const repository = repositories.find(
      (repository) => repository.id === repositoryId,
    );
    const isDesiredState = attached
      ? repository !== undefined && repository.permissions === permissions
      : repository === undefined;
    if (isDesiredState) return;
    if (Date.now() >= deadline) {
      const action = attached ? "attach" : "detach";
      throw new Error(
        `Cloud ${action} agent repository did not become visible for ${agentId}: ${repositoryId}`,
      );
    }
    await sleep(
      options.pollIntervalMs ?? DEFAULT_VISIBILITY_POLL_INTERVAL_MS,
    );
  }
}

export function createAgentRepositoriesClient(
  transportProvider: TransportProvider,
  visibilityOptions: VisibilityOptions = {},
): AgentRepositoriesClient {
  return {
    list: async (agentId) => {
      assertNonEmptyId(agentId, "agent id");
      return transportProvider().listAgentRepositories(agentId);
    },
    attach: async (
      agentId: string,
      repositoryId: string,
      options: AttachAgentRepositoryOptions = {},
    ) => {
      assertNonEmptyId(agentId, "agent id");
      assertNonEmptyId(repositoryId, "repository id");
      assertPermissions(options.permissions);
      assertRecompileTarget(options.recompile);
      const transport = transportProvider();
      const repository = await transport.attachAgentRepository(
        agentId,
        repositoryId,
        options.permissions,
      );
      await waitForRepositoryState(
        transport,
        agentId,
        repositoryId,
        true,
        repository.permissions,
        visibilityOptions,
      );
      if (options.recompile !== false) {
        await transport.recompileAgentSystemPrompt(agentId);
      }
      return repository;
    },
    detach: async (
      agentId: string,
      repositoryId: string,
      options: DetachAgentRepositoryOptions = {},
    ) => {
      assertNonEmptyId(agentId, "agent id");
      assertNonEmptyId(repositoryId, "repository id");
      assertRecompileTarget(options.recompile);
      const transport = transportProvider();
      await transport.detachAgentRepository(agentId, repositoryId);
      await waitForRepositoryState(
        transport,
        agentId,
        repositoryId,
        false,
        undefined,
        visibilityOptions,
      );
      if (options.recompile !== false) {
        await transport.recompileAgentSystemPrompt(agentId);
      }
    },
  };
}
