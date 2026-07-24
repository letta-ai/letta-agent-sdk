import { RepositoriesClient } from "./repositories.js";
import {
  AppServerSession,
  assertRemoteSessionOptionsSupported,
} from "./app-server-session.js";
import {
  CloudEnvironmentSession,
  assertCloudSessionOptionsSupported,
  createCloudAgent,
  validateCloudClientOptions,
} from "./cloud-session.js";
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

function getOptionsEnvironment(
  options: LettaCodeClientOptions,
): LettaCodeEnvironment | undefined {
  if ("environment" in options) {
    return options.environment;
  }
  return undefined;
}

function stripCloudExecutionOptions(
  options: LettaCodeClientSessionOptions,
): CreateSessionOptions {
  const sessionOptions = { ...options };
  delete sessionOptions.environment;
  delete sessionOptions.sandbox;
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

type TurnSession = LettaCodeSession & {
  runTurn(message: SendMessage): Promise<SDKResultMessage>;
};

/**
 * Top-level Letta Agent SDK client.
 *
 * `backend` selects how the SDK reaches or runs the Letta Code harness.
 * `local` spawns an SDK-owned Letta Code app-server and speaks the websocket
 * protocol by default, with an explicit stdio fallback for legacy flows.
 * `remote` connects to a user-managed Letta Code app-server websocket endpoint.
 * `cloud` uses agents hosted on Constellation, with an explicit remote
 * environment or SDK-managed sandbox.
 */
export class LettaAgentClientBase {
  readonly backend: LettaCodeBackend;
  readonly environment: LettaCodeEnvironment | undefined;
  protected readonly options: LettaCodeClientOptions;
  private repositoriesClient: RepositoriesClient | null = null;

  constructor(options: LettaCodeClientOptions = {}) {
    const backend = options.backend ?? "local";
    if (!isLettaCodeBackend(backend)) {
      throw new Error(
        `Invalid Letta Code backend '${String(backend)}'. Valid values: local, remote, cloud.`,
      );
    }

    this.backend = backend;
    this.environment = getOptionsEnvironment(options);
    this.options = options;

    if (this.backend === "local" && this.environment !== undefined) {
      throw new Error(
        'LettaAgentClient environment is only valid with backend: "cloud".',
      );
    }
    if (this.backend === "remote" && this.environment !== undefined) {
      throw new Error(
        'LettaAgentClient environment is only valid with backend: "cloud"; remote url selects the app-server runtime.',
      );
    }
    if (this.backend !== "cloud" && (options as { sandbox?: unknown }).sandbox !== undefined) {
      throw new Error('LettaAgentClient sandbox options are only valid with backend: "cloud".');
    }

    if (this.backend === "local") {
      const localOptions = options as LettaCodeLocalClientOptions;
      if (
        localOptions.transport !== undefined &&
        localOptions.transport !== "app-server" &&
        localOptions.transport !== "stdio"
      ) {
        throw new Error("Invalid local transport. Valid values: app-server, stdio.");
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

  async createAgent(options: CreateAgentOptions = {}): Promise<string> {
    if (hasCreateAgentEnvironment(options)) {
      throw new Error(
        "createAgent() does not accept environment. Set a client default or pass environment to resumeSession()/createSession().",
      );
    }

    validateCreateAgentOptions(options);

    if (this.backend === "remote") {
      const session = new AppServerSession(this.remoteOptions(), {
        kind: "create-agent",
        options,
      });
      const initMsg = await session.initialize();
      session.close();
      return initMsg.agentId;
    }
    if (this.backend === "cloud") {
      return createCloudAgent(this.cloudOptions(), options);
    }
    return this.createLocalAgent(options);
  }

  /**
   * Create a new conversation/session.
   *
   * Without an agent id, this uses the default/LRU agent, matching the legacy
   * top-level createSession() helper.
   */
  createSession(
    agentIdOrOptions?: string | LettaCodeClientSessionOptions,
    options: LettaCodeClientSessionOptions = {},
  ): LettaCodeSession {
    const agentId =
      typeof agentIdOrOptions === "string" ? agentIdOrOptions : undefined;
    const resolvedOptions =
      typeof agentIdOrOptions === "string" ? options : (agentIdOrOptions ?? {});

    this.assertSessionBackend("createSession", resolvedOptions);
    const sessionOptions = stripCloudExecutionOptions(resolvedOptions);
    validateCreateSessionOptions(sessionOptions);

    if (this.backend === "remote") {
      if (!agentId) {
        throw new Error(
          "App-server createSession() requires an agent id. Call createAgent() first or pass an agent id.",
        );
      }
      return new AppServerSession(this.remoteOptions(), {
        kind: "session",
        agentId,
        newConversation: true,
        options: resolvedOptions,
      });
    }
    if (this.backend === "cloud") {
      if (!agentId) {
        throw new Error(
          "Constellation createSession() requires an agent id. Call createAgent() first or pass an agent id.",
        );
      }
      return new CloudEnvironmentSession(this.cloudOptions(), {
        kind: "session",
        agentId,
        newConversation: true,
        options: resolvedOptions,
      });
    }
    return this.createLocalSession(agentId, resolvedOptions, sessionOptions);
  }

  /**
   * Resume an existing agent default conversation or a specific conversation.
   *
   * `options.environment` overrides the client's default execution target for
   * Constellation sessions. Remote app-server URLs already select the runtime.
   */
  resumeSession(
    id: string,
    options: LettaCodeClientSessionOptions = {},
  ): LettaCodeSession {
    this.assertSessionBackend("resumeSession", options);
    const sessionOptions = stripCloudExecutionOptions(options);
    validateCreateSessionOptions(sessionOptions);

    if (this.backend === "remote") {
      if (looksLikeConversationId(id)) {
        return new AppServerSession(this.remoteOptions(), {
          kind: "session",
          conversationId: id,
          options,
        });
      }
      return new AppServerSession(this.remoteOptions(), {
        kind: "session",
        agentId: id,
        defaultConversation: true,
        options,
      });
    }
    if (this.backend === "cloud") {
      if (looksLikeConversationId(id)) {
        return new CloudEnvironmentSession(this.cloudOptions(), {
          kind: "session",
          conversationId: id,
          options,
        });
      }
      return new CloudEnvironmentSession(this.cloudOptions(), {
        kind: "session",
        agentId: id,
        defaultConversation: true,
        options,
      });
    }
    return this.resumeLocalSession(id, options, sessionOptions);
  }

  /** One-shot prompt convenience helper using a new conversation. */
  async prompt(
    message: SendMessage,
    agentId?: string,
    options: LettaCodeClientSessionOptions = {},
  ): Promise<SDKResultMessage> {
    const session = agentId
      ? this.createSession(agentId, options)
      : this.createSession(options);

    try {
      return await (session as TurnSession).runTurn(message);
    } finally {
      session.close();
    }
  }

  private assertSessionBackend(
    action: string,
    options: LettaCodeClientSessionOptions,
  ): void {
    const effectiveEnvironment = options.environment ?? this.environment;
    if (this.backend === "local") {
      if (effectiveEnvironment !== undefined) {
        throw new Error(
          `${action}() environment overrides are only valid with backend: "cloud".`,
        );
      }
      if (options.sandbox !== undefined) {
        throw new Error(`${action}() sandbox options are only valid with backend: "cloud".`);
      }
      if (hasRepositoryResources(options)) {
        throw new Error(`${action}() repository resources are only valid with backend: "cloud".`);
      }
      if (!this.useLegacyLocalStdio()) {
        assertRemoteSessionOptionsSupported(action, options);
      }
      return;
    }

    if (this.backend === "remote") {
      if (options.environment !== undefined) {
        throw new Error(
          `${action}() environment overrides are only valid with backend: "cloud"; remote url selects the app-server runtime.`,
        );
      }
      if (options.sandbox !== undefined) {
        throw new Error(`${action}() sandbox options are only valid with backend: "cloud"; remote url selects the app-server runtime.`);
      }
      if (hasRepositoryResources(options)) {
        throw new Error(`${action}() repository resources are only valid with backend: "cloud".`);
      }
      assertRemoteSessionOptionsSupported(action, options);
      return;
    }
    if (this.backend === "cloud") {
      const cloudOptions = this.cloudOptions();
      if (cloudOptions.environment !== undefined && options.sandbox !== undefined) {
        throw new Error(`Constellation ${action}() cannot specify sandbox options when the client has a default environment.`);
      }
      if (cloudOptions.sandbox !== undefined && options.environment !== undefined) {
        throw new Error(`Constellation ${action}() cannot specify an environment when the client has default sandbox options.`);
      }
      assertCloudSessionOptionsSupported(action, options);
      return;
    }
    throw new Error(
      `LettaAgentClient backend '${this.backend}' is not implemented yet. ${action} currently supports backend 'local' only.`,
    );
  }

  protected useLegacyLocalStdio(): boolean {
    return (this.options as LettaCodeLocalClientOptions).transport === "stdio";
  }

  protected createLocalAgent(_options: CreateAgentOptions): Promise<string> {
    throw this.localBackendUnavailableError();
  }

  protected createLocalSession(
    _agentId: string | undefined,
    _options: LettaCodeClientSessionOptions,
    _sessionOptions: CreateSessionOptions,
  ): LettaCodeSession {
    throw this.localBackendUnavailableError();
  }

  protected resumeLocalSession(
    _id: string,
    _options: LettaCodeClientSessionOptions,
    _sessionOptions: CreateSessionOptions,
  ): LettaCodeSession {
    throw this.localBackendUnavailableError();
  }

  protected localBackendUnavailableError(): Error {
    return new Error(
      'The portable "@letta-ai/letta-agent-sdk/client" entry point supports backend: "remote" and backend: "cloud" only. Import from "@letta-ai/letta-agent-sdk" for local execution.',
    );
  }

  private remoteOptions(): LettaCodeRemoteClientOptions {
    if (this.backend !== "remote") {
      throw new Error("Remote options requested for non-remote backend.");
    }
    return this.options as LettaCodeRemoteClientOptions;
  }

  private getRepositoriesClient(): RepositoriesClient {
    if (this.backend !== "cloud") {
      throw new Error('client.repositories is only available with backend: "cloud".');
    }
    this.repositoriesClient ??= new RepositoriesClient(this.cloudOptions());
    return this.repositoriesClient;
  }

  private cloudOptions(): LettaCodeCloudClientOptions {
    if (this.backend !== "cloud") {
      throw new Error('Constellation options requested for non-"cloud" backend.');
    }
    return this.options as LettaCodeCloudClientOptions;
  }
}
