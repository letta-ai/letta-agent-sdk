import type {
  LettaCodeClientSessionOptions,
  SDKMessage,
  SendMessage,
} from "./types.js";

/** Options for an agent-free query backed by an ephemeral conversation. */
export interface AgentFreeQueryOptions
  extends Omit<
    LettaCodeClientSessionOptions,
    | "model"
    | "reasoningEffort"
    | "stateless"
    | "dreaming"
    | "resources"
    | "filesystemConfinement"
  > {
  /** Model handle persisted on the ephemeral conversation. */
  model: string;
  /** Complete system prompt for the ephemeral conversation. */
  system: string;
  /** Resume an existing agent-free conversation instead of creating one. Creation settings are ignored on resume. */
  conversationId?: string;
  /** Provider model settings persisted on the ephemeral conversation. */
  modelSettings?: Record<string, unknown>;
  /** Invoking parent agent, persisted when the conversation is created. */
  parentAgentId?: string;
  /** Display name persisted on the ephemeral conversation. */
  name?: string;
  /** Whether the ephemeral conversation represents a subagent. */
  isSubagent?: boolean;
  /** Optional context-window limit persisted on the ephemeral conversation. */
  contextWindowLimit?: number | null;
}

/** Input accepted by query(). */
export interface QueryParams {
  prompt: SendMessage;
  options: AgentFreeQueryOptions;
}

/** Stream returned by query(), with controls for long-running execution. */
export interface Query extends AsyncGenerator<SDKMessage, void, unknown> {
  /** Created or resumed conversation ID; null until initialized, retained after close. */
  readonly conversationId: string | null;
  /** Underlying session agent ID; null for agent-free conversations. */
  readonly agentId: string | null;
  /** Interrupt the active turn without closing the query session. */
  interrupt(): Promise<void>;
  /** Close the query and release its underlying session. */
  close(): void;
}
