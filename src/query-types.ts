import type {
  LettaCodeClientSessionOptions,
  SDKMessage,
  SendMessage,
} from "./types.js";

/** Options for a query backed by an ordinary conversation. */
export interface QueryOptions
  extends Omit<
    LettaCodeClientSessionOptions,
    | "model"
    | "reasoningEffort"
    | "stateless"
    | "dreaming"
    | "resources"
    | "filesystemConfinement"
  > {
  /** Model handle persisted on the conversation. */
  model: string;
  /** Complete system prompt for the conversation. */
  system: string;
  /** Resume an existing conversation instead of creating one. Creation settings are ignored on resume. */
  conversationId?: string;
  /** Provider model settings persisted on the conversation. */
  modelSettings?: Record<string, unknown>;
  /** Invoking parent agent, persisted when the conversation is created. */
  parentAgentId?: string;
  /** Display name persisted on the conversation. */
  name?: string;
  /** Whether the conversation represents a subagent. */
  isSubagent?: boolean;
  /** Disable the runtime's memory guard for this query (app-server backends only). */
  disableMemoryGuard?: boolean;
  /** Optional context-window limit persisted on the conversation. */
  contextWindowLimit?: number | null;
}

/** @deprecated Use {@link QueryOptions}. */
export type AgentFreeQueryOptions = QueryOptions;

/** Input accepted by query(). */
export interface QueryParams {
  prompt: SendMessage;
  options: QueryOptions;
}

/** Stream returned by query(), with controls for long-running execution. */
export interface Query extends AsyncGenerator<SDKMessage, void, unknown> {
  /** Created or resumed conversation ID; null until initialized, retained after close. */
  readonly conversationId: string | null;
  /** Underlying session agent ID; null for conversations created by `query()`. */
  readonly agentId: string | null;
  /** Interrupt the active turn without closing the query session. */
  interrupt(): Promise<void>;
  /** Close the query and release its underlying session. */
  close(): void;
}
