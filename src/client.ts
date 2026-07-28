import { LettaAgentClientBase } from "./client-base.js";
import { AppServerManagementTransport } from "./app-server-management.js";
import type { ManagementTransport } from "./management.js";
import { createLocalAppServerSession } from "./local-app-server-session.js";
import { startLocalAppServer } from "./local-app-server.js";
import type {
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeLocalClientOptions,
  LettaCodeSession,
} from "./types.js";

export class LettaAgentClient extends LettaAgentClientBase {
  protected override createLocalManagementTransport(): ManagementTransport {
    const localOptions = (
      this.options as LettaCodeLocalClientOptions
    ).appServer;
    return new AppServerManagementTransport({
      ...(localOptions?.url !== undefined
        ? { url: localOptions.url }
        : {
            connect: () =>
              startLocalAppServer({
                listen: localOptions?.listen,
                backend: localOptions?.harnessBackend ?? "local",
                startupTimeoutMs: localOptions?.startupTimeoutMs,
              }),
          }),
      ...(localOptions?.WebSocket !== undefined
        ? { WebSocket: localOptions.WebSocket }
        : {}),
      ...(localOptions?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: localOptions.requestTimeoutMs }
        : {}),
      ...(localOptions?.idleLingerMs !== undefined
        ? { idleLingerMs: localOptions.idleLingerMs }
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
      () => this.releaseIdleManagementConnection(),
    );
    const initMsg = await session.initialize();
    session.close();
    return initMsg.agentId;
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
      () => this.releaseIdleManagementConnection(),
    );
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
        () => this.releaseIdleManagementConnection(),
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
      () => this.releaseIdleManagementConnection(),
    );
  }
}

function looksLikeConversationId(id: string): boolean {
  return id.startsWith("conv-") || id.startsWith("local-conv-");
}
