import { LettaAgentClientBase } from "./client-base.js";
import { AppServerManagementTransport } from "./app-server-management.js";
import { getCloudApiKey } from "./cloud-client.js";
import type { ManagementTransport } from "./management.js";
import { createLocalAppServerSession } from "./local-app-server-session.js";
import { SharedLocalAppServer } from "./shared-local-app-server.js";
import type { QueryOptions } from "./query-types.js";
import type { SkillNodeSupport } from "./skill-loading.js";
import { loadSkillDirectory, pushSkillSupportFiles } from "./skill-node.js";
import type {
  CreateAgentOptions,
  LettaCodeCloudClientOptions,
  LettaCodeClientSessionOptions,
  LettaCodeLocalClientOptions,
  LettaCodeSession,
} from "./types.js";

export class LettaAgentClient extends LettaAgentClientBase {
  private localServer: SharedLocalAppServer | null = null;
  private localClosePromise: Promise<void> | null = null;

  private sharedLocalServer(): SharedLocalAppServer {
    if (this.localClosePromise) throw new Error("LettaAgentClient is closed");
    if (this.backend === "cloud") {
      return this.localServer ??= registeredComputerServer(
        this.options as LettaCodeCloudClientOptions,
      );
    }
    const options = (this.options as LettaCodeLocalClientOptions).appServer;
    return this.localServer ??= new SharedLocalAppServer({
      listen: options?.listen,
      backend: options?.harnessBackend ?? "local",
      startupTimeoutMs: options?.startupTimeoutMs,
    });
  }

  override close(): Promise<void> {
    if (!this.localClosePromise) {
      this.localClosePromise = Promise.all([
        super.close(),
        this.localServer?.close(),
      ]).then(() => {});
    }
    return this.localClosePromise;
  }

  protected override async startRegisteredComputer(): Promise<void> {
    await this.sharedLocalServer().connect();
  }

  protected override skillNodeSupport(): SkillNodeSupport {
    return { loadSkillDirectory, pushSkillSupportFiles };
  }

  protected override createLocalManagementTransport(): ManagementTransport {
    return new AppServerManagementTransport(this.localAppServerConnection());
  }

  protected override localAppServerConnection() {
    // A Cloud client's registered computer is always an SDK-spawned server.
    const localOptions = this.backend === "cloud"
      ? {
          WebSocket: (this.options as LettaCodeCloudClientOptions).WebSocket,
          requestTimeoutMs: (this.options as LettaCodeCloudClientOptions).requestTimeoutMs,
        }
      : (this.options as LettaCodeLocalClientOptions).appServer;
    const sharedServer = this.sharedLocalServer();
    return {
      ...(localOptions !== undefined && "url" in localOptions &&
        localOptions.url !== undefined
        ? { url: localOptions.url }
        : {
            connect: () => sharedServer.connect(),
          }),
      ...(localOptions?.WebSocket !== undefined
        ? { WebSocket: localOptions.WebSocket }
        : {}),
      ...(localOptions?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: localOptions.requestTimeoutMs }
        : {}),
    };
  }

  protected override async createLocalAgent(
    options: CreateAgentOptions,
  ): Promise<string> {
    const localOptions = this.options as LettaCodeLocalClientOptions;
    const session = createLocalAppServerSession(
      localOptions.appServer,
      {
        kind: "create-agent",
        options,
      },
      this.sharedLocalServer(),
    );
    try {
      const initMsg = await session.initialize();
      if (!initMsg.agentId) {
        throw new Error("Local App Server agent creation did not return an agent id.");
      }
      return initMsg.agentId;
    } finally {
      session.close();
    }
  }

  protected override createLocalSession(
    agentId: string,
    options: LettaCodeClientSessionOptions,
  ): LettaCodeSession {
    const localOptions = this.options as LettaCodeLocalClientOptions;
    return createLocalAppServerSession(
      localOptions.appServer,
      {
        kind: "session",
        agentId,
        newConversation: true,
        options,
      },
      this.sharedLocalServer(),
    );
  }

  protected override createLocalQuerySession(
    queryOptions: QueryOptions,
    sessionOptions: LettaCodeClientSessionOptions,
  ): LettaCodeSession {
    const localOptions = this.options as LettaCodeLocalClientOptions;
    return createLocalAppServerSession(localOptions.appServer, {
      kind: "conversation",
      ...(queryOptions.conversationId
        ? { conversationId: queryOptions.conversationId }
        : {
            createConversation: {
              model: queryOptions.model,
              system: queryOptions.system,
              ...(queryOptions.parentAgentId !== undefined
                ? { parentAgentId: queryOptions.parentAgentId }
                : {}),
              ...(queryOptions.name !== undefined ? { name: queryOptions.name } : {}),
              ...(queryOptions.isSubagent !== undefined
                ? { isSubagent: queryOptions.isSubagent }
                : {}),
              ...(queryOptions.modelSettings !== undefined
                ? { modelSettings: queryOptions.modelSettings }
                : {}),
              ...(queryOptions.contextWindowLimit !== undefined
                ? { contextWindowLimit: queryOptions.contextWindowLimit }
                : {}),
            },
          }),
      options: sessionOptions,
      ...(queryOptions.disableMemoryGuard === true
        ? { disableMemoryGuard: true }
        : {}),
    }, this.sharedLocalServer());
  }

  protected override resumeLocalSession(
    id: string,
    options: LettaCodeClientSessionOptions,
  ): LettaCodeSession {
    const localOptions = this.options as LettaCodeLocalClientOptions;
    if (looksLikeConversationId(id)) {
      return createLocalAppServerSession(
        localOptions.appServer,
        {
          kind: "session",
          conversationId: id,
          options,
        },
        this.sharedLocalServer(),
      );
    }
    return createLocalAppServerSession(
      localOptions.appServer,
      {
        kind: "session",
        agentId: id,
        defaultConversation: true,
        options,
      },
      this.sharedLocalServer(),
    );
  }
}

/**
 * The app-server behind `backend: "cloud", registerComputer`: it runs against
 * Letta Cloud with this client's credentials and registers this machine under
 * the given name.
 */
function registeredComputerServer(
  options: LettaCodeCloudClientOptions,
): SharedLocalAppServer {
  const name = options.registerComputer?.name;
  if (name === undefined) {
    throw new Error("A local app-server is only available with backend: \"local\" or registerComputer.");
  }
  const apiKey = getCloudApiKey(options);
  return new SharedLocalAppServer({
    backend: "api",
    computerName: name,
    env: {
      ...(apiKey !== undefined ? { LETTA_API_KEY: apiKey } : {}),
      ...(options.apiBaseUrl !== undefined
        ? { LETTA_BASE_URL: options.apiBaseUrl }
        : {}),
    },
  });
}

function looksLikeConversationId(id: string): boolean {
  return id.startsWith("conv-") || id.startsWith("local-conv-");
}
