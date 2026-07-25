import type { ListMessagesResult } from "./types.js";

/** Agent state returned by either the Cloud API or Letta Code app-server. */
export type LettaAgent = Record<string, unknown> & {
  id: string;
  name: string;
  description?: string | null;
  model?: string | null;
  model_settings?: Record<string, unknown> | null;
  tags?: string[];
  created_at?: string | null;
  updated_at?: string | null;
};

/** Conversation state returned by either the Cloud API or Letta Code app-server. */
export type LettaConversation = Record<string, unknown> & {
  id: string;
  agent_id: string;
  summary?: string | null;
  description?: string | null;
  model?: string | null;
  model_settings?: Record<string, unknown> | null;
  archived?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  last_message_at?: string | null;
};

/** Raw Letta API message returned from conversation history. */
export type LettaConversationMessage = Record<string, unknown>;

export interface ListAgentsOptions {
  before?: string;
  after?: string;
  limit?: number;
  order?: "asc" | "desc";
  orderBy?: "createdAt" | "lastRunCompletion";
  /** Search agent names. */
  query?: string;
  /** Match one exact agent name. */
  name?: string;
  tags?: string[];
  matchAllTags?: boolean;
  /** Relationships to hydrate in each returned agent. */
  include?: string[];
}

export interface UpdateAgentOptions {
  name?: string | null;
  description?: string | null;
  model?: string | null;
  modelSettings?: Record<string, unknown> | null;
  system?: string | null;
  tags?: string[] | null;
  hidden?: boolean | null;
  contextWindowLimit?: number | null;
}

export interface ListConversationsOptions {
  agentId?: string;
  after?: string;
  limit?: number;
  order?: "asc" | "desc";
  orderBy?: "createdAt" | "lastRunCompletion" | "lastMessageAt";
  archiveStatus?: "unarchived" | "archived" | "all";
  summarySearch?: string;
}

export interface CreateConversationOptions {
  agentId: string;
  summary?: string | null;
  description?: string | null;
  model?: string | null;
  modelSettings?: Record<string, unknown> | null;
  contextWindowLimit?: number | null;
  hidden?: boolean;
}

export interface UpdateConversationOptions {
  summary?: string | null;
  description?: string | null;
  model?: string | null;
  modelSettings?: Record<string, unknown> | null;
  contextWindowLimit?: number | null;
  archived?: boolean | null;
}

export interface ConversationMessagesOptions {
  before?: string;
  after?: string;
  order?: "asc" | "desc";
  limit?: number;
}

export type ConversationMessagesResult = ListMessagesResult & {
  messages: LettaConversationMessage[];
};

export interface AgentsClient {
  list(options?: ListAgentsOptions): Promise<LettaAgent[]>;
  retrieve(agentId: string): Promise<LettaAgent>;
  update(
    agentId: string,
    options: UpdateAgentOptions,
  ): Promise<LettaAgent>;
}

export interface ConversationsClient {
  list(
    options?: ListConversationsOptions,
  ): Promise<LettaConversation[]>;
  retrieve(conversationId: string): Promise<LettaConversation>;
  create(options: CreateConversationOptions): Promise<LettaConversation>;
  update(
    conversationId: string,
    options: UpdateConversationOptions,
  ): Promise<LettaConversation>;
  listMessages(
    conversationId: string,
    options?: ConversationMessagesOptions,
  ): Promise<ConversationMessagesResult>;
}
