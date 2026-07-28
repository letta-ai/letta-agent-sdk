import type {
  AgentListParams,
  AgentUpdateParams,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ConversationCreateParams,
  ConversationListParams,
  ConversationUpdateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";
import type { MessageListParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type {
  AgentRepositoriesClient,
  AgentsClient,
  ConversationsClient,
  ConversationMessagesResult,
  CreateConversationOptions,
  LettaAgent,
  LettaConversation,
  ListAgentsOptions,
  ListConversationsOptions,
  ModelsClient,
  UpdateAgentOptions,
  UpdateConversationOptions,
  ConversationMessagesOptions,
} from "./management-types.js";
import type { ListModelsResult } from "./types.js";

export interface ManagementTransport {
  listAgents(query: AgentListParams): Promise<LettaAgent[]>;
  retrieveAgent(agentId: string): Promise<LettaAgent>;
  updateAgent(
    agentId: string,
    body: AgentUpdateParams,
  ): Promise<LettaAgent>;
  deleteAgent(agentId: string): Promise<void>;
  listModels(): Promise<ListModelsResult>;
  listConversations(
    query: ConversationListParams,
  ): Promise<LettaConversation[]>;
  retrieveConversation(
    conversationId: string,
  ): Promise<LettaConversation>;
  createConversation(
    body: ConversationCreateParams,
  ): Promise<LettaConversation>;
  updateConversation(
    conversationId: string,
    body: ConversationUpdateParams,
  ): Promise<LettaConversation>;
  listConversationMessages(
    conversationId: string,
    query: MessageListParams,
  ): Promise<ConversationMessagesResult>;
}

type TransportProvider = () => ManagementTransport;

function assertNonEmptyId(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${name}. Expected a non-empty string.`);
  }
}

function agentListQuery(options: ListAgentsOptions): AgentListParams {
  const orderBy = options.orderBy === "createdAt"
    ? "created_at"
    : options.orderBy === "lastRunCompletion"
      ? "last_run_completion"
      : undefined;
  return {
    before: options.before,
    after: options.after,
    limit: options.limit,
    order: options.order,
    order_by: orderBy,
    query_text: options.query,
    name: options.name,
    tags: options.tags,
    match_all_tags: options.matchAllTags,
    include: options.include,
  };
}

function agentUpdateBody(options: UpdateAgentOptions): AgentUpdateParams {
  return {
    name: options.name,
    description: options.description,
    model: options.model,
    model_settings: options.modelSettings,
    system: options.system,
    tags: options.tags,
    hidden: options.hidden,
    context_window_limit: options.contextWindowLimit,
  };
}

function conversationListQuery(
  options: ListConversationsOptions,
): ConversationListParams {
  const orderBy: ConversationListParams["order_by"] =
    options.orderBy === "createdAt"
      ? "created_at"
      : options.orderBy === "lastRunCompletion"
        ? "last_run_completion"
        : options.orderBy === "lastMessageAt"
          ? "last_message_at"
          : undefined;
  return {
    agent_id: options.agentId,
    after: options.after,
    limit: options.limit,
    order: options.order,
    order_by: orderBy,
    archive_status: options.archiveStatus,
    summary_search: options.summarySearch,
  };
}

function conversationCreateBody(
  options: CreateConversationOptions,
): ConversationCreateParams {
  return {
    agent_id: options.agentId,
    summary: options.summary,
    description: options.description,
    model: options.model,
    model_settings: options.modelSettings,
    context_window_limit: options.contextWindowLimit,
    hidden: options.hidden,
  };
}

function conversationUpdateBody(
  options: UpdateConversationOptions,
): ConversationUpdateParams {
  return {
    summary: options.summary,
    description: options.description,
    model: options.model,
    model_settings: options.modelSettings,
    context_window_limit: options.contextWindowLimit,
    archived: options.archived,
  };
}

function conversationMessagesQuery(
  options: ConversationMessagesOptions,
): MessageListParams {
  return {
    before: options.before,
    after: options.after,
    order: options.order,
    limit: options.limit,
  };
}

export function createAgentsClient(
  transport: TransportProvider,
  repositories: () => AgentRepositoriesClient,
): AgentsClient {
  return {
    get repositories() {
      return repositories();
    },
    list: (options = {}) =>
      transport().listAgents(agentListQuery(options)),
    retrieve: (agentId) => transport().retrieveAgent(agentId),
    update: (agentId, options) =>
      transport().updateAgent(agentId, agentUpdateBody(options)),
    delete: async (agentId) => {
      assertNonEmptyId(agentId, "agent id");
      await transport().deleteAgent(agentId);
    },
  };
}

export function createModelsClient(
  transport: TransportProvider,
): ModelsClient {
  return {
    list: () => transport().listModels(),
  };
}

export function createConversationsClient(
  transport: TransportProvider,
): ConversationsClient {
  return {
    list: (options = {}) =>
      transport().listConversations(conversationListQuery(options)),
    retrieve: (conversationId) =>
      transport().retrieveConversation(conversationId),
    create: (options) =>
      transport().createConversation(conversationCreateBody(options)),
    update: (conversationId, options) =>
      transport().updateConversation(
        conversationId,
        conversationUpdateBody(options),
      ),
    listMessages: (conversationId, options = {}) =>
      transport().listConversationMessages(
        conversationId,
        conversationMessagesQuery(options),
      ),
  };
}
