import { Session } from "./session.js";
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

function stripEnvironment(
  options: LettaCodeClientSessionOptions,
): CreateSessionOptions {
  const sessionOptions = { ...options };
  delete sessionOptions.environment;
  return sessionOptions;
}

function hasCreateAgentEnvironment(options: CreateAgentOptions): boolean {
  return "environment" in (options as Record<string, unknown>);
}

function looksLikeConversationId(id: string): boolean {
  return id.startsWith("conv-") || id.startsWith("local-conv-");
}

/**
 * Top-level Letta Code SDK client.
 *
 * `backend` selects how the SDK reaches or runs the Letta Code harness.
 * `local` spawns an SDK-owned Letta Code app-server and speaks the websocket
 * protocol by default, with an explicit stdio fallback for legacy flows.
 * `remote` connects to a user-managed Letta Code app-server websocket endpoint.
 * `cloud` connects to an explicit Letta Cloud remote environment and controls
 * it over the Remote Client websocket protocol.
 */
export class LettaCodeClient {
  readonly backend: LettaCodeBackend;
  readonly environment: LettaCodeEnvironment | undefined;
  private readonly options: LettaCodeClientOptions;

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
        "LettaCodeClient environment is only valid for cloud backends.",
      );
    }
    if (this.backend === "remote" && this.environment !== undefined) {
      throw new Error(
        "LettaCodeClient environment is only valid for the cloud backend; remote url selects the app-server runtime.",
      );
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
        throw new Error("LettaCodeClient remote backend requires a non-empty url.");
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
    this.assertLocalBackend("createAgent");
    if (!this.useLegacyLocalStdio()) {
      const session = new AppServerSession(this.localAppServerOptions(), {
        kind: "create-agent",
        options,
      });
      const initMsg = await session.initialize();
      session.close();
      return initMsg.agentId;
    }
    const session = new Session({ ...options, createOnly: true });
    const initMsg = await session.initialize();
    session.close();
    return initMsg.agentId;
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
    const sessionOptions = stripEnvironment(resolvedOptions);
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
          "Cloud backend createSession() requires an agent id. Call createAgent() first or pass an agent id.",
        );
      }
      return new CloudEnvironmentSession(this.cloudOptions(), {
        kind: "session",
        agentId,
        newConversation: true,
        options: resolvedOptions,
      });
    }
    if (!this.useLegacyLocalStdio() && agentId) {
      return new AppServerSession(this.localAppServerOptions(), {
        kind: "session",
        agentId,
        newConversation: true,
        options: resolvedOptions,
      });
    }
    if (agentId) {
      return new Session({ ...sessionOptions, agentId, newConversation: true });
    }
    return new Session({ ...sessionOptions, newConversation: true });
  }

  /**
   * Resume an existing agent default conversation or a specific conversation.
   *
   * `options.environment` overrides the client's default execution target for
   * cloud backends. Remote app-server URLs already select the runtime.
   */
  resumeSession(
    id: string,
    options: LettaCodeClientSessionOptions = {},
  ): LettaCodeSession {
    this.assertSessionBackend("resumeSession", options);
    const sessionOptions = stripEnvironment(options);
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
    if (!this.useLegacyLocalStdio()) {
      if (looksLikeConversationId(id)) {
        return new AppServerSession(this.localAppServerOptions(), {
          kind: "session",
          conversationId: id,
          options,
        });
      }
      return new AppServerSession(this.localAppServerOptions(), {
        kind: "session",
        agentId: id,
        defaultConversation: true,
        options,
      });
    }
    if (looksLikeConversationId(id)) {
      return new Session({ ...sessionOptions, conversationId: id });
    }
    return new Session({
      ...sessionOptions,
      agentId: id,
      defaultConversation: true,
    });
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
      return await session.runTurn(message);
    } finally {
      session.close();
    }
  }

  private assertLocalBackend(action: string): void {
    if (this.backend === "local") {
      return;
    }

    throw new Error(
      `LettaCodeClient backend '${this.backend}' is not implemented yet. ${action} currently supports backend 'local' only.`,
    );
  }

  private assertSessionBackend(
    action: string,
    options: LettaCodeClientSessionOptions,
  ): void {
    const effectiveEnvironment = options.environment ?? this.environment;
    if (this.backend === "local") {
      if (effectiveEnvironment !== undefined) {
        throw new Error(
          `${action}() environment overrides are only valid for cloud backends.`,
        );
      }
      if (!this.useLegacyLocalStdio()) {
        assertRemoteSessionOptionsSupported(action, options);
      }
      return;
    }

    if (this.backend === "remote") {
      if (options.environment !== undefined) {
        throw new Error(
          `${action}() environment overrides are only valid for cloud backends; remote url selects the app-server runtime.`,
        );
      }
      assertRemoteSessionOptionsSupported(action, options);
      return;
    }
    if (this.backend === "cloud") {
      assertCloudSessionOptionsSupported(action, options);
      return;
    }
    throw new Error(
      `LettaCodeClient backend '${this.backend}' is not implemented yet. ${action} currently supports backend 'local' only.`,
    );
  }

  private useLegacyLocalStdio(): boolean {
    return (this.options as LettaCodeLocalClientOptions).transport === "stdio";
  }

  private localAppServerOptions() {
    const localOptions = this.options as LettaCodeLocalClientOptions;
    const appServer = localOptions.appServer;
    return {
      local: appServer?.url === undefined,
      ...(appServer?.url !== undefined ? { url: appServer.url } : {}),
      ...(appServer?.WebSocket !== undefined ? { WebSocket: appServer.WebSocket } : {}),
      ...(appServer?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: appServer.requestTimeoutMs }
        : {}),
      ...(appServer?.listen !== undefined ? { localListen: appServer.listen } : {}),
      ...(appServer?.startupTimeoutMs !== undefined
        ? { localStartupTimeoutMs: appServer.startupTimeoutMs }
        : {}),
    };
  }

  private remoteOptions(): LettaCodeRemoteClientOptions {
    if (this.backend !== "remote") {
      throw new Error("Remote options requested for non-remote backend.");
    }
    return this.options as LettaCodeRemoteClientOptions;
  }

  private cloudOptions(): LettaCodeCloudClientOptions {
    if (this.backend !== "cloud") {
      throw new Error("Cloud options requested for non-cloud backend.");
    }
    return this.options as LettaCodeCloudClientOptions;
  }
}
