import type {
  AgentListParams,
  AgentState,
  AgentUpdateParams,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  Conversation,
  ConversationCreateParams,
  ConversationForkParams,
  ConversationListParams,
  ConversationUpdateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";
import type { MessageListParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { ListMessagesResult, ListModelsResult } from "./types.js";

/** Agent state returned by either the Cloud API or Letta Code app-server. */
export type LettaAgent = AgentState;

/** Conversation state returned by either the Cloud API or Letta Code app-server. */
export type LettaConversation = Conversation;

/** Raw Letta API message returned from conversation history. */
export type LettaConversationMessage = Message;

type Present<T> = Exclude<T, null | undefined>;

export interface ListAgentsOptions {
  before?: Present<AgentListParams["before"]>;
  after?: Present<AgentListParams["after"]>;
  limit?: Present<AgentListParams["limit"]>;
  order?: "asc" | "desc";
  orderBy?: "createdAt" | "lastRunCompletion";
  /** Search agent names. */
  query?: Present<AgentListParams["query_text"]>;
  /** Match one exact agent name. */
  name?: Present<AgentListParams["name"]>;
  tags?: Present<AgentListParams["tags"]>;
  matchAllTags?: Present<AgentListParams["match_all_tags"]>;
  /** Relationships to hydrate in each returned agent. */
  include?: Present<AgentListParams["include"]>;
}

export interface UpdateAgentOptions {
  name?: AgentUpdateParams["name"];
  description?: AgentUpdateParams["description"];
  model?: AgentUpdateParams["model"];
  modelSettings?: AgentUpdateParams["model_settings"];
  system?: AgentUpdateParams["system"];
  tags?: AgentUpdateParams["tags"];
  hidden?: AgentUpdateParams["hidden"];
  contextWindowLimit?: AgentUpdateParams["context_window_limit"];
}

export interface ListConversationsOptions {
  agentId?: Present<ConversationListParams["agent_id"]>;
  after?: Present<ConversationListParams["after"]>;
  limit?: Present<ConversationListParams["limit"]>;
  order?: Present<ConversationListParams["order"]>;
  orderBy?: "createdAt" | "lastRunCompletion" | "lastMessageAt";
  archiveStatus?: Present<ConversationListParams["archive_status"]>;
  summarySearch?: Present<ConversationListParams["summary_search"]>;
}

export interface CreateConversationOptions {
  agentId: ConversationCreateParams["agent_id"];
  summary?: ConversationCreateParams["summary"];
  description?: ConversationCreateParams["description"];
  model?: ConversationCreateParams["model"];
  modelSettings?: ConversationCreateParams["model_settings"];
  contextWindowLimit?: ConversationCreateParams["context_window_limit"];
  hidden?: ConversationCreateParams["hidden"];
}

export interface UpdateConversationOptions {
  summary?: ConversationUpdateParams["summary"];
  description?: ConversationUpdateParams["description"];
  model?: ConversationUpdateParams["model"];
  modelSettings?: ConversationUpdateParams["model_settings"];
  contextWindowLimit?: ConversationUpdateParams["context_window_limit"];
  archived?: ConversationUpdateParams["archived"];
}

export interface ForkConversationOptions {
  /** Include source messages through this message, inclusive. */
  messageId?: Present<ConversationForkParams["message_id"]>;
  /** Hide the fork from normal conversation listings. */
  hidden?: Present<ConversationForkParams["hidden"]>;
}

export interface ConversationMessagesOptions {
  /** Return messages before this message ID (cursor for older pages, regardless of `order`). */
  before?: Present<MessageListParams["before"]>;
  /** Return messages after this message ID (cursor for newer pages, regardless of `order`). */
  after?: Present<MessageListParams["after"]>;
  /** Sort order of the returned page. Defaults to "desc" (newest first). */
  order?: "asc" | "desc";
  limit?: Present<MessageListParams["limit"]>;
}

export type ConversationMessagesResult = ListMessagesResult;

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
  /**
   * Create a persistent conversation from the source's in-context history.
   * Use `update(fork.id, { archived: true })` when a temporary fork is done.
   */
  fork(
    sourceConversationId: string,
    options?: ForkConversationOptions,
  ): Promise<LettaConversation>;
  listMessages(
    conversationId: string,
    options?: ConversationMessagesOptions,
  ): Promise<ConversationMessagesResult>;
}
