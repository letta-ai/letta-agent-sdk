import { LettaAgentClientBase } from "./client-base.js";
import { AppServerManagementTransport } from "./app-server-management.js";
import type { ManagementTransport } from "./management.js";
import { createLocalAppServerSession } from "./local-app-server-session.js";
import { SharedLocalAppServer } from "./shared-local-app-server.js";
import type { QueryOptions } from "./query-types.js";
import type { SkillNodeSupport } from "./skill-loading.js";
import { loadSkillDirectory, pushSkillSupportFiles } from "./skill-node.js";
import type {
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeLocalClientOptions,
  LettaCodeSession,
} from "./types.js";

export class LettaAgentClient extends LettaAgentClientBase {
  private localServer: SharedLocalAppServer | null = null;
  private localClosePromise: Promise<void> | null = null;

  private sharedLocalServer(): SharedLocalAppServer {
    if (this.localClosePromise) throw new Error("LettaAgentClient is closed");
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

  protected override skillNodeSupport(): SkillNodeSupport {
    return { loadSkillDirectory, pushSkillSupportFiles };
  }

  protected override createLocalManagementTransport(): ManagementTransport {
    const localOptions = (
      this.options as LettaCodeLocalClientOptions
    ).appServer;
    const sharedServer = this.sharedLocalServer();
    return new AppServerManagementTransport({
      ...(localOptions?.url !== undefined
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
    });
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

function looksLikeConversationId(id: string): boolean {
  return id.startsWith("conv-") || id.startsWith("local-conv-");
}
