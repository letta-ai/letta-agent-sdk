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
  /** Provider model settings persisted on the ephemeral conversation. */
  modelSettings?: Record<string, unknown>;
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
  /** Interrupt the active turn without closing the query session. */
  interrupt(): Promise<void>;
  /** Close the query and release its underlying session. */
  close(): void;
}
