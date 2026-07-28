import type { ListMessagesResult, ListModelsResult } from "./types.js";

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

export type AgentRepositoryPermissions = "read" | "read_write";
export type AgentRepositoryRecompileTarget = "default" | false;

/** A repository relationship persisted on an agent. */
export interface AgentRepository {
  id: string;
  name: string;
  isPrimary: boolean;
  permissions: AgentRepositoryPermissions;
}

export interface AttachAgentRepositoryOptions {
  /** Access granted to the agent. Defaults to `read_write` on the server. */
  permissions?: AgentRepositoryPermissions;
  /** Recompile the agent's default conversation after attachment. Defaults to `default`. */
  recompile?: AgentRepositoryRecompileTarget;
}

export interface DetachAgentRepositoryOptions {
  /** Recompile the agent's default conversation after detachment. Defaults to `default`. */
  recompile?: AgentRepositoryRecompileTarget;
}

/** Persistent agent-repository relationships. Available on the Cloud backend. */
export interface AgentRepositoriesClient {
  list(agentId: string): Promise<AgentRepository[]>;
  /**
   * Persistently attach a repository, wait for the relationship to become
   * visible, then recompile the agent's default conversation unless disabled.
   * If recompilation fails, the relationship remains attached and retrying is safe.
   */
  attach(
    agentId: string,
    repositoryId: string,
    options?: AttachAgentRepositoryOptions,
  ): Promise<AgentRepository>;
  /**
   * Persistently detach a repository, wait for the relationship to disappear,
   * then recompile the agent's default conversation unless disabled. If
   * recompilation fails, the relationship remains detached and retrying is safe.
   */
  detach(
    agentId: string,
    repositoryId: string,
    options?: DetachAgentRepositoryOptions,
  ): Promise<void>;
}

export interface AgentsClient {
  /** Persistent repository relationships for this agent. Cloud only. */
  readonly repositories: AgentRepositoriesClient;
  list(options?: ListAgentsOptions): Promise<LettaAgent[]>;
  retrieve(agentId: string): Promise<LettaAgent>;
  update(
    agentId: string,
    options: UpdateAgentOptions,
  ): Promise<LettaAgent>;
  delete(agentId: string): Promise<void>;
}

export interface ModelsClient {
  /**
   * List the model catalog without opening a session.
   *
   * Uses the same normalized result shape as `session.listModels()`, including
   * availability and BYOK-alias metadata when the backend provides it.
   */
  list(): Promise<ListModelsResult>;
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
