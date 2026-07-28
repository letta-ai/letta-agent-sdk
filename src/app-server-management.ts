import {
  createAppServerClient,
  type AppServerClient,
  type AppServerRequestCommandWithId,
  type AppServerSocketConstructor,
} from "@letta-ai/letta-code/app-server-client";
import type {
  ManagementQuery,
  ManagementTransport,
} from "./management.js";
import { applyUniqueRequestIds } from "./request-ids.js";
import type {
  ConversationMessagesResult,
  LettaAgent,
  LettaConversation,
} from "./management-types.js";
import type {
  LettaCodeModelEntry,
  LettaCodeRemoteClientOptions,
  ListModelsResult,
} from "./types.js";

type OwnedConnection = { url: string; close(): void };

type ManagementResponse = {
  type: string;
  success: boolean;
  error?: string;
};

type AgentListResponse = ManagementResponse & {
  agents: LettaAgent[];
};

type AgentResponse = ManagementResponse & {
  agent: LettaAgent | null;
};

type ConversationListResponse = ManagementResponse & {
  conversations: LettaConversation[];
};

type ConversationResponse = ManagementResponse & {
  conversation: LettaConversation | null;
};

type ConversationMessagesResponse = ManagementResponse & {
  messages: Record<string, unknown>[];
};

type ListModelsResponse = ManagementResponse & {
  entries?: unknown;
  available_handles?: unknown;
  byok_provider_aliases?: unknown;
};

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

function modelEntries(value: unknown): LettaCodeModelEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.handle !== "string" ||
      typeof record.label !== "string" ||
      typeof record.description !== "string"
    ) {
      return [];
    }
    return [{
      ...record,
      id: record.id,
      handle: record.handle,
      label: record.label,
      description: record.description,
    }];
  });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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

  async listAgents(query: ManagementQuery): Promise<LettaAgent[]> {
    const response = await this.request<AgentListResponse>(
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
    const response = await this.request<AgentResponse>(
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
    body: Record<string, unknown>,
  ): Promise<LettaAgent> {
    const response = await this.request<AgentResponse>(
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
    const response = await this.request<ManagementResponse>(
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
    const response = await this.request<ListModelsResponse>(
      "list_models",
      {},
      "list_models_response",
    );
    if (!response.success) {
      throw new Error(response.error ?? "Failed to list models.");
    }
    const result: ListModelsResult = {
      entries: modelEntries(response.entries),
    };
    if (response.available_handles === null) {
      result.availableHandles = null;
    } else if (Array.isArray(response.available_handles)) {
      result.availableHandles = response.available_handles.filter(
        (handle): handle is string => typeof handle === "string",
      );
    }
    const aliases = stringRecord(response.byok_provider_aliases);
    if (aliases) result.byokProviderAliases = aliases;
    return result;
  }

  async listConversations(
    query: ManagementQuery,
  ): Promise<LettaConversation[]> {
    const response = await this.request<ConversationListResponse>(
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
    const response = await this.request<ConversationResponse>(
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
    body: Record<string, unknown>,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationResponse>(
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
    body: Record<string, unknown>,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationResponse>(
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

  async listConversationMessages(
    conversationId: string,
    query: ManagementQuery,
  ): Promise<ConversationMessagesResult> {
    const response =
      await this.request<ConversationMessagesResponse>(
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
    const command = {
      type,
      request_id: client.nextRequestId(type),
      ...body,
    } as AppServerRequestCommandWithId;
    const response = await client.request(command, {
      predicate: (message): message is typeof message =>
        message.type === responseType,
    });
    return response as unknown as TResponse;
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
