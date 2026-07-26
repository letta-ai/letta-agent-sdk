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
import type {
  ConversationMessagesResult,
  LettaAgent,
  LettaConversation,
  LettaModelEntry,
} from "./management-types.js";
import type { LettaCodeRemoteClientOptions } from "./types.js";

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

type ListModelsEntry = Record<string, unknown> & {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
};

type ListModelsResponse = ManagementResponse & {
  entries: ListModelsEntry[];
};

export type AppServerManagementOptions =
  Partial<LettaCodeRemoteClientOptions> & {
    url?: string;
    connect?: () => Promise<OwnedConnection>;
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

export class AppServerManagementTransport
  implements ManagementTransport
{
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

  async listModels(): Promise<LettaModelEntry[]> {
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
    return response.entries.map((entry) => ({
      ...entry,
      displayName: entry.label,
    }));
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
    const ownedConnection = this.options.url
      ? null
      : await this.options.connect?.();
    const url = this.options.url ?? ownedConnection?.url;
    if (!url) {
      throw new Error("App-server management requires a url or connect hook.");
    }

    let client: AppServerClient | null = null;
    try {
      client = createAppServerClient({
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
      });
      await client.connect();
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
    } finally {
      client?.close();
      ownedConnection?.close();
    }
  }
}
