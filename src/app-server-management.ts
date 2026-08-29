import {
  createAppServerClient,
  type AppServerClient,
  type AppServerRawResponse,
  type AppServerSocketConstructor,
} from "@letta-ai/letta-code/app-server-client";
import type {
  AgentDeleteResponseMessage,
  AgentListResponseMessage,
  AgentRetrieveResponseMessage,
  AgentUpdateResponseMessage,
  ConversationCreateResponseMessage,
  ConversationForkResponseMessage,
  ConversationListResponseMessage,
  ConversationMessagesListResponseMessage,
  ConversationRetrieveResponseMessage,
  ConversationUpdateResponseMessage,
  ListModelsResponseMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import type {
  AgentListParams,
  AgentUpdateParams,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ConversationCreateParams,
  ConversationForkParams,
  ConversationListParams,
  ConversationUpdateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";
import type { MessageListParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { normalizeAppServerModels } from "./app-server-models.js";
import { ConversationForkHydrationError } from "./management-errors.js";
import type { ManagementTransport } from "./management.js";
import { applyUniqueRequestIds } from "./request-ids.js";
import type {
  ConversationMessagesResult,
  LettaAgent,
  LettaConversation,
} from "./management-types.js";
import type { LettaCodeRemoteClientOptions, ListModelsResult } from "./types.js";

type OwnedConnection = { url: string; close(): void };

export type AppServerManagementOptions =
  Partial<LettaCodeRemoteClientOptions> & {
    url?: string;
    connect?: () => Promise<OwnedConnection>;
  };

type ActiveConnection = {
  client: AppServerClient;
  ownedConnection: OwnedConnection | null;
  detachDisconnect: () => void;
};

function ensureResponse<T>(
  response: { success: boolean; error?: string },
  value: T | null | undefined,
  fallback: string,
): T {
  if (!response.success || value == null) {
    throw new Error(response.error ?? fallback);
  }
  return value;
}

/**
 * Management transport that speaks the app-server control protocol.
 *
 * The app-server assigns every client an independent connection, so management
 * keeps one lazy pooled client while sessions connect alongside it. Unexpected
 * disconnects discard the pool and the next management request reconnects.
 */
export class AppServerManagementTransport
  implements ManagementTransport
{
  private connectionPromise: Promise<ActiveConnection> | null = null;
  private closingConnections = new Set<Promise<void>>();

  constructor(private readonly options: AppServerManagementOptions) {}

  async listAgents(query: AgentListParams): Promise<LettaAgent[]> {
    const response = await this.request<AgentListResponseMessage>(
      "agent_list",
      { query },
      "agent_list_response",
    );
    if (!response.success) {
      throw new Error(response.error ?? "Failed to list agents.");
    }
    return response.agents;
  }

  async retrieveAgent(agentId: string): Promise<LettaAgent> {
    const response = await this.request<AgentRetrieveResponseMessage>(
      "agent_retrieve",
      { agent_id: agentId },
      "agent_retrieve_response",
    );
    return ensureResponse(
      response,
      response.agent,
      `Failed to retrieve agent ${agentId}.`,
    );
  }

  async updateAgent(
    agentId: string,
    body: AgentUpdateParams,
  ): Promise<LettaAgent> {
    const response = await this.request<AgentUpdateResponseMessage>(
      "agent_update",
      { agent_id: agentId, body },
      "agent_update_response",
    );
    return ensureResponse(
      response,
      response.agent,
      `Failed to update agent ${agentId}.`,
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    const response = await this.request<AgentDeleteResponseMessage>(
      "agent_delete",
      { agent_id: agentId },
      "agent_delete_response",
    );
    if (!response.success) {
      throw new Error(response.error ?? `Failed to delete agent ${agentId}.`);
    }
  }

  async listModels(): Promise<ListModelsResult> {
    // A bare list_models command (no runtime scope) is answered on the
    // control channel, so no session or conversation is required.
    const response = await this.request<ListModelsResponseMessage>(
      "list_models",
      {},
      "list_models_response",
    );
    return normalizeAppServerModels(response);
  }

  async listConversations(
    query: ConversationListParams,
  ): Promise<LettaConversation[]> {
    const response = await this.request<ConversationListResponseMessage>(
      "conversation_list",
      { query },
      "conversation_list_response",
    );
    if (!response.success) {
      throw new Error(response.error ?? "Failed to list conversations.");
    }
    return response.conversations;
  }

  async retrieveConversation(
    conversationId: string,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationRetrieveResponseMessage>(
      "conversation_retrieve",
      { conversation_id: conversationId },
      "conversation_retrieve_response",
    );
    return ensureResponse(
      response,
      response.conversation,
      `Failed to retrieve conversation ${conversationId}.`,
    );
  }

  async createConversation(
    body: ConversationCreateParams,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationCreateResponseMessage>(
      "conversation_create",
      { body },
      "conversation_create_response",
    );
    return ensureResponse(
      response,
      response.conversation,
      "Failed to create conversation.",
    );
  }

  async updateConversation(
    conversationId: string,
    body: ConversationUpdateParams,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationUpdateResponseMessage>(
      "conversation_update",
      { conversation_id: conversationId, body },
      "conversation_update_response",
    );
    return ensureResponse(
      response,
      response.conversation,
      `Failed to update conversation ${conversationId}.`,
    );
  }

  async forkConversation(
    conversationId: string,
    body: ConversationForkParams,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationForkResponseMessage>(
      "conversation_fork",
      { conversation_id: conversationId, body },
      "conversation_fork_response",
    );
    const fork = ensureResponse(
      response,
      response.conversation,
      `Failed to fork conversation ${conversationId}.`,
    );
    try {
      return await this.retrieveConversation(fork.id);
    } catch (error) {
      throw new ConversationForkHydrationError(fork.id, error);
    }
  }

  async listConversationMessages(
    conversationId: string,
    query: MessageListParams,
  ): Promise<ConversationMessagesResult> {
    const response =
      await this.request<ConversationMessagesListResponseMessage>(
        "conversation_messages_list",
        { conversation_id: conversationId, query },
        "conversation_messages_list_response",
      );
    if (!response.success) {
      throw new Error(
        response.error ??
          `Failed to list messages for conversation ${conversationId}.`,
      );
    }
    return { messages: response.messages };
  }

  enqueueConversationMessage(): Promise<never> {
    return Promise.reject(
      new Error(
        'conversations.enqueue() is only available with backend: "cloud". App-server backends deliver messages through a session\'s send().',
      ),
    );
  }

  private async request<TResponse extends { type: string }>(
    type: string,
    body: Record<string, unknown>,
    responseType: string,
  ): Promise<TResponse> {
    if (this.closingConnections.size > 0) {
      await Promise.all([...this.closingConnections]);
    }
    // Concurrent requests share the same connect promise and request-id
    // counter, while connection identity keeps this pool independent from
    // session clients using the same app-server.
    const { client } = await this.acquireConnection();
    return client.requestRaw<TResponse & AppServerRawResponse>(
      {
        type,
        request_id: client.nextRequestId(type),
        ...body,
      },
      {
        predicate: (message): message is TResponse & AppServerRawResponse =>
          message !== null &&
          typeof message === "object" &&
          "type" in message &&
          message.type === responseType,
      },
    );
  }

  private acquireConnection(): Promise<ActiveConnection> {
    if (this.connectionPromise) return this.connectionPromise;
    const promise: Promise<ActiveConnection> = this.openConnection().then(
      (connection) => {
        // Unexpected disconnects (explicit closes do not notify) drop the
        // pooled connection so the next request reconnects lazily.
        connection.detachDisconnect = connection.client.onDisconnect(() => {
          this.discardConnection(promise, connection);
        });
        return connection;
      },
      (error) => {
        if (this.connectionPromise === promise) {
          this.connectionPromise = null;
        }
        throw error;
      },
    );
    this.connectionPromise = promise;
    return promise;
  }

  private async openConnection(): Promise<ActiveConnection> {
    const ownedConnection = this.options.url
      ? null
      : ((await this.options.connect?.()) ?? null);
    const url = this.options.url ?? ownedConnection?.url;
    if (!url) {
      throw new Error("App-server management requires a url or connect hook.");
    }

    let client: AppServerClient | null = null;
    try {
      client = applyUniqueRequestIds(createAppServerClient({
        url,
        ...(this.options.authToken !== undefined
          ? { authToken: this.options.authToken }
          : {}),
        ...(this.options.WebSocket
          ? {
              WebSocket:
                this.options.WebSocket as AppServerSocketConstructor,
            }
          : {}),
        ...(this.options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: this.options.requestTimeoutMs }
          : {}),
      }));
      await client.connect();
    } catch (error) {
      try {
        if (client) {
          client.close();
          ownedConnection?.close();
        } else {
          ownedConnection?.close();
        }
      } catch {
        // Preserve the original connect error after best-effort cleanup.
      }
      throw error;
    }
    return {
      client,
      ownedConnection,
      detachDisconnect: () => {},
    };
  }

  private discardConnection(
    promise: Promise<ActiveConnection>,
    connection: ActiveConnection,
  ): void {
    if (this.connectionPromise === promise) {
      this.connectionPromise = null;
    }
    void this.trackClosingConnection(connection);
  }

  private trackClosingConnection(
    connection: ActiveConnection,
  ): Promise<void> {
    const closing = closeConnection(connection);
    this.closingConnections.add(closing);
    void closing.then(
      () => this.closingConnections.delete(closing),
      () => this.closingConnections.delete(closing),
    );
    return closing;
  }
}

async function closeConnection(connection: ActiveConnection): Promise<void> {
  connection.detachDisconnect();
  connection.client.close();
  connection.ownedConnection?.close();
}
