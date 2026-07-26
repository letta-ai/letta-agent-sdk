import type {
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

export type ManagementQuery = Record<
  string,
  string | number | boolean | string[] | null | undefined
>;

export interface ManagementTransport {
  listAgents(query: ManagementQuery): Promise<LettaAgent[]>;
  retrieveAgent(agentId: string): Promise<LettaAgent>;
  updateAgent(
    agentId: string,
    body: Record<string, unknown>,
  ): Promise<LettaAgent>;
  deleteAgent(agentId: string): Promise<void>;
  listModels(): Promise<ListModelsResult>;
  listConversations(
    query: ManagementQuery,
  ): Promise<LettaConversation[]>;
  retrieveConversation(
    conversationId: string,
  ): Promise<LettaConversation>;
  createConversation(
    body: Record<string, unknown>,
  ): Promise<LettaConversation>;
  updateConversation(
    conversationId: string,
    body: Record<string, unknown>,
  ): Promise<LettaConversation>;
  listConversationMessages(
    conversationId: string,
    query: ManagementQuery,
  ): Promise<ConversationMessagesResult>;
}

type TransportProvider = () => ManagementTransport;

function definedEntries(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function assertNonEmptyId(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${name}. Expected a non-empty string.`);
  }
}

function agentListQuery(options: ListAgentsOptions): ManagementQuery {
  const orderBy = options.orderBy?.replace(
    /[A-Z]/g,
    (character) => `_${character.toLowerCase()}`,
  );
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

function agentUpdateBody(options: UpdateAgentOptions): Record<string, unknown> {
  return definedEntries({
    name: options.name,
    description: options.description,
    model: options.model,
    model_settings: options.modelSettings,
    system: options.system,
    tags: options.tags,
    hidden: options.hidden,
    context_window_limit: options.contextWindowLimit,
  });
}

function conversationListQuery(
  options: ListConversationsOptions,
): ManagementQuery {
  const orderBy = options.orderBy?.replace(
    /[A-Z]/g,
    (character) => `_${character.toLowerCase()}`,
  );
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
): Record<string, unknown> {
  return definedEntries({
    agent_id: options.agentId,
    summary: options.summary,
    description: options.description,
    model: options.model,
    model_settings: options.modelSettings,
    context_window_limit: options.contextWindowLimit,
    hidden: options.hidden,
  });
}

function conversationUpdateBody(
  options: UpdateConversationOptions,
): Record<string, unknown> {
  return definedEntries({
    summary: options.summary,
    description: options.description,
    model: options.model,
    model_settings: options.modelSettings,
    context_window_limit: options.contextWindowLimit,
    archived: options.archived,
  });
}

function conversationMessagesQuery(
  options: ConversationMessagesOptions,
): ManagementQuery {
  return {
    before: options.before,
    after: options.after,
    order: options.order,
    limit: options.limit,
  };
}

export function createAgentsClient(
  transport: TransportProvider,
): AgentsClient {
  return {
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
