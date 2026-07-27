import { LettaAgentClientBase } from "./client-base.js";
import { AppServerManagementTransport } from "./app-server-management.js";
import type { ManagementTransport } from "./management.js";
import { createLocalAppServerSession } from "./local-app-server-session.js";
import { startLocalAppServer } from "./local-app-server.js";
import { Session } from "./session.js";
import type {
  CreateAgentOptions,
  CreateSessionOptions,
  LettaCodeClientSessionOptions,
  LettaCodeLocalClientOptions,
  LettaCodeSession,
} from "./types.js";

export class LettaAgentClient extends LettaAgentClientBase {
  protected override createLocalManagementTransport(): ManagementTransport {
    if (this.useLegacyLocalStdio()) {
      throw new Error(
        'client.agents and client.conversations require the local "app-server" transport.',
      );
    }
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
    });
  }

  protected override async createLocalAgent(
    options: CreateAgentOptions,
  ): Promise<string> {
    if (!this.useLegacyLocalStdio()) {
      const localOptions = this.options as LettaCodeLocalClientOptions;
      const session = createLocalAppServerSession(
        localOptions.appServer,
        {
          kind: "create-agent",
          options,
        },
      );
      const initMsg = await session.initialize();
      session.close();
      return initMsg.agentId;
    }

    const session = new Session({ ...options, createOnly: true });
    const initMsg = await session.initialize();
    session.close();
    return initMsg.agentId;
  }

  protected override createLocalSession(
    agentId: string | undefined,
    options: LettaCodeClientSessionOptions,
    sessionOptions: CreateSessionOptions,
  ): LettaCodeSession {
    if (!this.useLegacyLocalStdio() && agentId) {
      const localOptions = this.options as LettaCodeLocalClientOptions;
      return createLocalAppServerSession(
        localOptions.appServer,
        {
          kind: "session",
          agentId,
          newConversation: true,
          options,
        },
      );
    }
    if (agentId) {
      return new Session({ ...sessionOptions, agentId, newConversation: true });
    }
    return new Session({ ...sessionOptions, newConversation: true });
  }

  protected override resumeLocalSession(
    id: string,
    options: LettaCodeClientSessionOptions,
    sessionOptions: CreateSessionOptions,
  ): LettaCodeSession {
    if (!this.useLegacyLocalStdio()) {
      const localOptions = this.options as LettaCodeLocalClientOptions;
      if (looksLikeConversationId(id)) {
        return createLocalAppServerSession(
          localOptions.appServer,
          {
            kind: "session",
            conversationId: id,
            options,
          },
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
      );
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
}

function looksLikeConversationId(id: string): boolean {
  return id.startsWith("conv-") || id.startsWith("local-conv-");
}
