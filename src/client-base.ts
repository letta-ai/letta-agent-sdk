import type Letta from "@letta-ai/letta-client";
import { RepositoriesClient } from "./repositories.js";
import { createAgentRepositoriesClient } from "./agent-repositories.js";
import { AppServerManagementTransport } from "./app-server-management.js";
import {
  AppServerSession,
  type AppServerSessionOptions,
} from "./app-server-session.js";
import { CloudManagementTransport } from "./cloud-management.js";
import { createCloudClient } from "./cloud-client.js";
import {
  ComputersClientImpl,
  type ComputerSelector,
  type ComputersClient,
} from "./computers.js";
import {
  CloudEnvironmentSession,
  assertCloudSessionOptionsSupported,
  createCloudAgent,
  validateCloudClientOptions,
} from "./cloud-session.js";
import {
  createAgentsClient,
  createConversationsClient,
  createModelsClient,
  type ManagementTransport,
} from "./management.js";
import type {
  AgentRepositoriesClient,
  AgentsClient,
  ConversationsClient,
  ModelsClient,
} from "./management-types.js";
import { createQuery } from "./query.js";
import type {
  AgentFreeQueryOptions,
  Query,
  QueryParams,
} from "./query-types.js";
import type {
  CreateAgentOptions,
  CreateSessionOptions,
  LettaCodeBackend,
  LettaCodeClientOptions,
  LettaCodeClientSessionOptions,
  LettaCodeEnvironment,
  LettaCodeRemoteClientOptions,
  LettaCodeLocalClientOptions,
  LettaCodeCloudClientOptions,
  LettaCodeSession,
  SDKResultMessage,
  SendMessage,
} from "./types.js";
import {
  validateCreateAgentOptions,
  validateCreateSessionOptions,
} from "./validation.js";

const VALID_BACKENDS = new Set<LettaCodeBackend>([
  "local",
  "remote",
  "cloud",
]);

function isLettaCodeBackend(value: string): value is LettaCodeBackend {
  return VALID_BACKENDS.has(value as LettaCodeBackend);
}

function getOptionsComputer(
  options: LettaCodeClientOptions,
): ComputerSelector | undefined {
  if (!("computer" in options) && !("environment" in options)) return undefined;
  if (options.computer !== undefined && options.environment !== undefined) {
    throw new Error('Specify either "computer" or deprecated "environment", not both.');
  }
  return options.computer ?? options.environment;
}

function stripCloudExecutionOptions(
  options: LettaCodeClientSessionOptions,
): CreateSessionOptions {
  const sessionOptions = { ...options };
  delete sessionOptions.computer;
  delete sessionOptions.environment;
  delete sessionOptions.sandbox;
  delete sessionOptions.filesystemConfinement;
  return sessionOptions;
}

function hasRepositoryResources(options: LettaCodeClientSessionOptions): boolean {
  return options.resources !== undefined && options.resources.length > 0;
}

function hasCreateAgentEnvironment(options: CreateAgentOptions): boolean {
  return "environment" in (options as Record<string, unknown>);
}

function looksLikeConversationId(id: string): boolean {
  return id.startsWith("conv-") || id.startsWith("local-conv-");
}

function agentFreeSessionOptions(
  options: AgentFreeQueryOptions,
): LettaCodeClientSessionOptions {
  const {
    system: _system,
    modelSettings: _modelSettings,
    contextWindowLimit: _contextWindowLimit,
    ...sessionOptions
  } = options;
  return sessionOptions;
}

function validateAgentFreeQueryOptions(options: AgentFreeQueryOptions): void {
  if (typeof options.model !== "string" || options.model.length === 0) {
    throw new Error("query() requires a non-empty model.");
  }
  if (typeof options.system !== "string") {
    throw new Error("query() requires a system prompt.");
  }
  validateCreateSessionOptions(agentFreeSessionOptions(options));
}

type OneShotSession = LettaCodeSession & {
  sendAndWaitForResult(message: SendMessage): Promise<SDKResultMessage>;
};

/**
 * Top-level Letta Agent SDK client.
 *
 * `backend` selects how the SDK reaches or runs the Letta Code harness.
 * `local` spawns an SDK-owned Letta Code app-server and speaks the websocket
 * protocol.
 * `remote` connects to a user-managed Letta Code app-server websocket endpoint.
 * `cloud` uses agents hosted on Letta Cloud, with an explicit remote
 * environment or SDK-managed sandbox.
 */
export class LettaAgentClientBase {
  readonly backend: LettaCodeBackend;
  readonly computer: ComputerSelector | undefined;
  /** @deprecated Use `computer`. */
  readonly environment: LettaCodeEnvironment | undefined;
  readonly agents: AgentsClient;
  readonly conversations: ConversationsClient;
  readonly models: ModelsClient;
  protected readonly options: LettaCodeClientOptions;
  private repositoriesClient: RepositoriesClient | null = null;
  private computersClient: ComputersClientImpl | null = null;
  private agentRepositoriesClient: AgentRepositoriesClient | null = null;
  private cloudClient: Letta | null = null;
  private managementTransport: ManagementTransport | null = null;

  constructor(options: LettaCodeClientOptions = {}) {
    const backend = options.backend ?? "local";
    if (!isLettaCodeBackend(backend)) {
      throw new Error(
        `Invalid Letta Code backend '${String(backend)}'. Valid values: local, remote, cloud.`,
      );
    }

    this.backend = backend;
    this.computer = getOptionsComputer(options);
    this.environment = this.computer;
    this.options = options;
    this.agents = createAgentsClient(
      () => this.getManagementTransport(),
      () => this.getAgentRepositoriesClient(),
    );
    this.conversations = createConversationsClient(
      () => this.getManagementTransport(),
    );
    this.models = createModelsClient(() => this.getManagementTransport());

    if (this.backend === "local" && this.computer !== undefined) {
      const field = "computer" in options && options.computer !== undefined
        ? "computer"
        : "environment";
      throw new Error(
        `LettaAgentClient ${field} is only valid with backend: "cloud".`,
      );
    }
    if (this.backend === "remote" && this.computer !== undefined) {
      const field = "computer" in options && options.computer !== undefined
        ? "computer"
        : "environment";
      throw new Error(
        `LettaAgentClient ${field} is only valid with backend: "cloud"; remote url selects the app-server runtime.`,
      );
    }
    if (this.backend !== "cloud" && (options as { sandbox?: unknown }).sandbox !== undefined) {
      throw new Error('LettaAgentClient sandbox options are only valid with backend: "cloud".');
    }

    if (this.backend === "local") {
      const localOptions = options as LettaCodeLocalClientOptions;
      if ("transport" in localOptions) {
        throw new Error(
          'Local transport selection has been removed. The local backend always uses the app-server protocol.',
        );
      }
      const requestTimeoutMs = localOptions.appServer?.requestTimeoutMs;
      if (
        requestTimeoutMs !== undefined &&
        (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
      ) {
        throw new Error("Invalid appServer.requestTimeoutMs. Expected a positive integer.");
      }
      const startupTimeoutMs = localOptions.appServer?.startupTimeoutMs;
      if (
        startupTimeoutMs !== undefined &&
        (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs <= 0)
      ) {
        throw new Error("Invalid appServer.startupTimeoutMs. Expected a positive integer.");
      }
    }

    if (this.backend === "remote") {
      if (!("url" in options) || typeof options.url !== "string" || options.url.length === 0) {
        throw new Error("LettaAgentClient remote backend requires a non-empty url.");
      }
      if (
        options.requestTimeoutMs !== undefined &&
        (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
      ) {
        throw new Error("Invalid requestTimeoutMs. Expected a positive integer.");
      }
    }

    if (this.backend === "cloud") {
      validateCloudClientOptions(options as LettaCodeCloudClientOptions);
    }
  }

  /**
   * Create a new Letta Code agent with a default conversation.
   *
   * Environment/device selection is intentionally not part of the agent payload;
   * it belongs to the client/session execution context.
   */
  get repositories(): RepositoriesClient {
    return this.getRepositoriesClient();
  }

  /** Discover and resolve computers registered with this Letta Cloud account. */
  get computers(): ComputersClient {
    return this.getComputersClient();
  }

  async createAgent(options: CreateAgentOptions = {}): Promise<string> {
    if (hasCreateAgentEnvironment(options)) {
      throw new Error(
        "createAgent() does not accept environment. Set a client default or pass environment to resumeSession()/createSession().",
      );
    }

    validateCreateAgentOptions(options);

    if (this.backend === "remote") {
      const session = new AppServerSession(this.appServerSessionOptions(), {
        kind: "create-agent",
        options,
      });
      const initMsg = await session.initialize();
      session.close();
      if (!initMsg.agentId) {
        throw new Error("App Server agent creation did not return an agent id.");
      }
      return initMsg.agentId;
    }
    if (this.backend === "cloud") {
      return createCloudAgent(this.getCloudClient(), options);
    }
    return this.createLocalAgent(options);
  }

  /**
   * Create a new conversation/session.
   *
   * The app-server protocol requires an explicit agent id.
   */
  createSession(
    agentId: string,
    options: LettaCodeClientSessionOptions = {},
  ): LettaCodeSession {
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new Error("createSession() requires a non-empty agent id.");
    }
    const sessionOptions = stripCloudExecutionOptions(options);
    validateCreateSessionOptions(sessionOptions);
    this.assertSessionBackend("createSession", options);

    if (this.backend === "remote") {
      return new AppServerSession(this.appServerSessionOptions(), {
        kind: "session",
        agentId,
        newConversation: true,
        options,
      });
    }
    if (this.backend === "cloud") {
      return new CloudEnvironmentSession(
        this.cloudOptions(),
        {
          kind: "session",
          agentId,
          newConversation: true,
          options,
        },
        this.getCloudClient(),
      );
    }
    return this.createLocalSession(agentId, options);
  }

  /**
   * Resume an existing agent default conversation or a specific conversation.
   *
   * `options.environment` overrides the client's default execution target for
   * Letta Cloud sessions. Remote app-server URLs already select the runtime.
   */
  resumeSession(
    id: string,
    options: LettaCodeClientSessionOptions = {},
  ): LettaCodeSession {
    const sessionOptions = stripCloudExecutionOptions(options);
    validateCreateSessionOptions(sessionOptions);
    this.assertSessionBackend("resumeSession", options);

    if (this.backend === "remote") {
      if (looksLikeConversationId(id)) {
        return new AppServerSession(this.appServerSessionOptions(), {
          kind: "session",
          conversationId: id,
          options,
        });
      }
      return new AppServerSession(this.appServerSessionOptions(), {
        kind: "session",
        agentId: id,
        defaultConversation: true,
        options,
      });
    }
    if (this.backend === "cloud") {
      if (looksLikeConversationId(id)) {
        return new CloudEnvironmentSession(
          this.cloudOptions(),
          {
            kind: "session",
            conversationId: id,
            options,
          },
          this.getCloudClient(),
        );
      }
      return new CloudEnvironmentSession(
        this.cloudOptions(),
        {
          kind: "session",
          agentId: id,
          defaultConversation: true,
          options,
        },
        this.getCloudClient(),
      );
    }
    return this.resumeLocalSession(id, options);
  }

  /**
   * One-shot convenience for scripts, smoke tests, and evals.
   * Applications should use a session when they need interactive turn state.
   */
  async prompt(
    message: SendMessage,
    agentId: string,
    options: LettaCodeClientSessionOptions = {},
  ): Promise<SDKResultMessage> {
    const session = this.createSession(agentId, options);

    try {
      return await (session as OneShotSession).sendAndWaitForResult(message);
    } finally {
      session.close();
    }
  }

  /** Run one prompt in a new agent-free ephemeral conversation. */
  query(params: QueryParams): Query {
    validateAgentFreeQueryOptions(params.options);
    return createQuery((options) => this.createAgentFreeSession(options), params);
  }

  private async createAgentFreeSession(
    options: AgentFreeQueryOptions,
  ): Promise<LettaCodeSession> {
    validateAgentFreeQueryOptions(options);
    const sessionOptions = agentFreeSessionOptions(options);
    this.assertSessionBackend("query", sessionOptions);

    if (this.backend === "remote") {
      return new AppServerSession(this.appServerSessionOptions(), {
        kind: "agent-free",
        createConversation: {
          model: options.model,
          system: options.system,
          ...(options.modelSettings !== undefined
            ? { modelSettings: options.modelSettings }
            : {}),
          ...(options.contextWindowLimit !== undefined
            ? { contextWindowLimit: options.contextWindowLimit }
            : {}),
        },
        options: sessionOptions,
      });
    }
    if (this.backend === "cloud") {
      const computer = options.computer ?? options.environment ?? this.computer;
      if (computer === undefined) {
        throw new Error(
          "Cloud query() requires an explicit computer; managed sandboxes are agent-scoped.",
        );
      }
      const conversation = await this.getCloudClient().post<unknown>(
        "/v1/conversations/ephemeral",
        {
          body: {
            model: options.model,
            system: options.system,
            ...(options.modelSettings !== undefined
              ? { model_settings: options.modelSettings }
              : {}),
            ...(options.contextWindowLimit !== undefined
              ? { context_window_limit: options.contextWindowLimit }
              : {}),
          },
        },
      );
      if (
        !conversation ||
        typeof conversation !== "object" ||
        typeof (conversation as { id?: unknown }).id !== "string"
      ) {
        throw new Error(
          "Cloud ephemeral conversation response did not include a conversation id.",
        );
      }
      return new CloudEnvironmentSession(
        this.cloudOptions(),
        {
          kind: "agent-free",
          conversationId: (conversation as { id: string }).id,
          options: sessionOptions,
        },
        this.getCloudClient(),
      );
    }
    return this.createLocalAgentFreeSession(options, sessionOptions);
  }

  private assertSessionBackend(
    action: string,
    options: LettaCodeClientSessionOptions,
  ): void {
    if (options.computer !== undefined && options.environment !== undefined) {
      throw new Error(
        `${action}() cannot specify both computer and deprecated environment.`,
      );
    }
    if (
      options.filesystemConfinement !== undefined &&
      options.filesystemConfinement !== "memory"
    ) {
      throw new Error(
        `Invalid filesystemConfinement '${String(options.filesystemConfinement)}'. Valid value: memory.`,
      );
    }
    const effectiveComputer =
      options.computer ?? options.environment ?? this.computer;
    if (this.backend === "local") {
      if (effectiveComputer !== undefined) {
        const field = options.computer !== undefined ? "computer" : "environment";
        throw new Error(
          `${action}() ${field} overrides are only valid with backend: "cloud".`,
        );
      }
      if (options.sandbox !== undefined) {
        throw new Error(`${action}() sandbox options are only valid with backend: "cloud".`);
      }
      if (hasRepositoryResources(options)) {
        throw new Error(`${action}() repository resources are only valid with backend: "cloud".`);
      }
      if (options.filesystemConfinement !== undefined) {
        const localOptions = this.options as LettaCodeLocalClientOptions;
        if (localOptions.appServer?.url !== undefined) {
          throw new Error(
            `${action}() filesystemConfinement requires an SDK-owned local app-server process.`,
          );
        }
      }
      return;
    }

    if (this.backend === "remote") {
      if (options.filesystemConfinement !== undefined) {
        throw new Error(
          `${action}() filesystemConfinement requires an SDK-owned local app-server process.`,
        );
      }
      if (options.computer !== undefined || options.environment !== undefined) {
        const field = options.computer !== undefined ? "computer" : "environment";
        throw new Error(
          `${action}() ${field} overrides are only valid with backend: "cloud"; remote url selects the app-server runtime.`,
        );
      }
      if (options.sandbox !== undefined) {
        throw new Error(`${action}() sandbox options are only valid with backend: "cloud"; remote url selects the app-server runtime.`);
      }
      if (hasRepositoryResources(options)) {
        throw new Error(`${action}() repository resources are only valid with backend: "cloud".`);
      }
      return;
    }
    if (this.backend === "cloud") {
      if (options.filesystemConfinement !== undefined) {
        throw new Error(
          `${action}() filesystemConfinement is only supported with backend: "local".`,
        );
      }
      const cloudOptions = this.cloudOptions();
      if (this.computer !== undefined && options.sandbox !== undefined) {
        const field = cloudOptions.computer !== undefined
          ? "computer"
          : "environment";
        throw new Error(`Letta Cloud ${action}() cannot specify sandbox options when the client has a default ${field}.`);
      }
      if (
        cloudOptions.sandbox !== undefined &&
        (options.computer !== undefined || options.environment !== undefined)
      ) {
        const field = options.computer !== undefined
          ? "a computer"
          : "an environment";
        throw new Error(`Letta Cloud ${action}() cannot specify ${field} when the client has default sandbox options.`);
      }
      assertCloudSessionOptionsSupported(action, options);
      return;
    }
    throw new Error(
      `LettaAgentClient backend '${this.backend}' is not implemented yet. ${action} currently supports backend 'local' only.`,
    );
  }

  protected createLocalAgent(_options: CreateAgentOptions): Promise<string> {
    throw this.localBackendUnavailableError();
  }

  protected createLocalSession(
    _agentId: string,
    _options: LettaCodeClientSessionOptions,
  ): LettaCodeSession {
    throw this.localBackendUnavailableError();
  }

  protected createLocalAgentFreeSession(
    _queryOptions: AgentFreeQueryOptions,
    _sessionOptions: LettaCodeClientSessionOptions,
  ): LettaCodeSession {
    throw this.localBackendUnavailableError();
  }

  protected resumeLocalSession(
    _id: string,
    _options: LettaCodeClientSessionOptions,
  ): LettaCodeSession {
    throw this.localBackendUnavailableError();
  }

  protected localBackendUnavailableError(): Error {
    return new Error(
      'The portable "@letta-ai/letta-agent-sdk/client" entry point supports backend: "remote" and backend: "cloud" only. Import from "@letta-ai/letta-agent-sdk" for local execution.',
    );
  }

  protected createLocalManagementTransport(): ManagementTransport {
    throw this.localBackendUnavailableError();
  }

  private remoteOptions(): LettaCodeRemoteClientOptions {
    if (this.backend !== "remote") {
      throw new Error("Remote options requested for non-remote backend.");
    }
    return this.options as LettaCodeRemoteClientOptions;
  }

  private appServerSessionOptions(): AppServerSessionOptions {
    return this.remoteOptions();
  }

  private getComputersClient(): ComputersClientImpl {
    if (this.backend !== "cloud") {
      throw new Error('client.computers is only available with backend: "cloud".');
    }
    this.computersClient ??= new ComputersClientImpl(this.getCloudClient());
    return this.computersClient;
  }

  private getRepositoriesClient(): RepositoriesClient {
    if (this.backend !== "cloud") {
      throw new Error('client.repositories is only available with backend: "cloud".');
    }
    this.repositoriesClient ??= new RepositoriesClient(
      this.cloudOptions(),
      this.getCloudClient(),
    );
    return this.repositoriesClient;
  }

  private getAgentRepositoriesClient(): AgentRepositoriesClient {
    if (this.backend !== "cloud") {
      throw new Error(
        'client.agents.repositories is only available with backend: "cloud".',
      );
    }
    this.agentRepositoriesClient ??= createAgentRepositoriesClient(
      () => this.getCloudManagementTransport(),
    );
    return this.agentRepositoriesClient;
  }

  private getCloudManagementTransport(): CloudManagementTransport {
    const transport = this.getManagementTransport();
    if (!(transport instanceof CloudManagementTransport)) {
      throw new Error("Cloud management requested for non-cloud backend.");
    }
    return transport;
  }

  private getCloudClient(): Letta {
    if (this.backend !== "cloud") {
      throw new Error("Letta client requested for non-cloud backend.");
    }
    this.cloudClient ??= createCloudClient(this.cloudOptions());
    return this.cloudClient;
  }

  private getManagementTransport(): ManagementTransport {
    if (this.managementTransport) return this.managementTransport;
    if (this.backend === "remote") {
      this.managementTransport = new AppServerManagementTransport(
        this.remoteOptions(),
      );
    } else if (this.backend === "cloud") {
      this.managementTransport = new CloudManagementTransport(
        this.getCloudClient(),
      );
    } else {
      this.managementTransport = this.createLocalManagementTransport();
    }
    return this.managementTransport;
  }

  private cloudOptions(): LettaCodeCloudClientOptions {
    if (this.backend !== "cloud") {
      throw new Error('Letta Cloud options requested for non-"cloud" backend.');
    }
    return this.options as LettaCodeCloudClientOptions;
  }
}
