/**
 * SDK Types
 *
 * These are the public-facing types for SDK consumers.
 * Protocol types are imported from @letta-ai/letta-code/protocol.
 */

// Re-export protocol types for internal use
export type {
  WireMessage,
  SystemInitMessage,
  MessageWire,
  ResultMessage,
  ErrorMessage,
  StreamEvent,
  ControlRequest,
  ControlResponse,
  CanUseToolControlRequest,
  CanUseToolResponse,
  CanUseToolResponseAllow,
  CanUseToolResponseDeny,
  // Configuration types
  SystemPromptPresetConfig,
  CreateBlock,
} from "@letta-ai/letta-code/protocol";

// Import types for use in this file
import type { CreateBlock, CanUseToolResponse } from "@letta-ai/letta-code/protocol";

// ═══════════════════════════════════════════════════════════════
// MESSAGE CONTENT TYPES (for multimodal support)
// ═══════════════════════════════════════════════════════════════

/**
 * Text content in a message
 */
export interface TextContent {
  type: "text";
  text: string;
}

/**
 * Image content in a message (base64 encoded)
 */
export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
}

/**
 * A single content item (text or image)
 */
export type MessageContentItem = TextContent | ImageContent;

/**
 * What send() accepts - either a simple string or multimodal content array
 */
export type SendMessage = string | MessageContentItem[];

// ═══════════════════════════════════════════════════════════════
// SKILLS / REMINDER / SLEEPTIME TYPES
// ═══════════════════════════════════════════════════════════════

export type SkillSource = "bundled" | "global" | "agent" | "project";

export type SleeptimeTrigger = "off" | "step-count" | "compaction-event";

export type SleeptimeBehavior = "reminder" | "auto-launch";

/**
 * Sleeptime settings exposed through SDK options.
 * Any omitted fields preserve server/CLI defaults.
 */
export interface SleeptimeOptions {
  trigger?: SleeptimeTrigger;
  behavior?: SleeptimeBehavior;
  stepCount?: number;
}

/**
 * Fully-resolved sleeptime settings emitted by init messages.
 */
export interface EffectiveSleeptimeSettings {
  trigger: SleeptimeTrigger;
  behavior: SleeptimeBehavior;
  stepCount: number;
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM PROMPT TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Available system prompt presets.
 */
export type SystemPromptPreset =
  | "default" // Alias for letta-claude
  | "letta-claude" // Full Letta Code prompt (Claude-optimized)
  | "letta-codex" // Full Letta Code prompt (Codex-optimized)
  | "letta-gemini" // Full Letta Code prompt (Gemini-optimized)
  | "claude" // Basic Claude (no skills/memory instructions)
  | "codex" // Basic Codex
  | "gemini"; // Basic Gemini

/**
 * System prompt preset configuration.
 */
export interface SystemPromptPresetConfigSDK {
  type: "preset";
  preset: SystemPromptPreset;
  append?: string;
}

/**
 * System prompt configuration - either a raw string or preset config.
 */
export type SystemPromptConfig = string | SystemPromptPresetConfigSDK;

// ═══════════════════════════════════════════════════════════════
// MEMORY TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Reference to an existing shared block by ID.
 */
export interface BlockReference {
  blockId: string;
}

/**
 * Memory item - can be a preset name, custom block, or block reference.
 */
export type MemoryItem =
  | string // Preset name: "project", "persona", "human"
  | CreateBlock // Custom block: { label, value, description? }
  | BlockReference; // Shared block reference: { blockId }

/**
 * Default memory block preset names.
 */
export type MemoryPreset = "persona" | "human" | "skills" | "loaded_skills";

// ═══════════════════════════════════════════════════════════════
// TOOL TYPES (matches pi-agent-core)
// ═══════════════════════════════════════════════════════════════

/**
 * Tool result content block
 */
export interface AgentToolResultContent {
  type: "text" | "image";
  text?: string;
  data?: string;      // base64 for images
  mimeType?: string;
}

/**
 * Tool result (matches pi-agent-core)
 */
export interface AgentToolResult<T> {
  content: AgentToolResultContent[];
  details?: T;
}

/**
 * Tool update callback (for streaming tool progress)
 */
export type AgentToolUpdateCallback<T> = (update: Partial<AgentToolResult<T>>) => void;

/**
 * Agent tool definition (matches pi-agent-core)
 */
export interface AgentTool<TParams, TResult> {
  /** Display label */
  label: string;

  /** Tool name (used in API calls) */
  name: string;

  /** Description shown to the model */
  description: string;

  /** JSON Schema for parameters (TypeBox or plain object) */
  parameters: TParams;

  /** Execution function */
  execute: (
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TResult>,
  ) => Promise<AgentToolResult<TResult>>;
}

/**
 * Convenience type for tools with any params
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any, unknown>;

// ═══════════════════════════════════════════════════════════════
// SESSION OPTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Callback for custom permission handling.
 */
export type CanUseToolCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<CanUseToolResponse> | CanUseToolResponse;

/**
 * Internal session options used by Session/Transport classes.
 * Not user-facing - use CreateSessionOptions or CreateAgentOptions instead.
 * @internal
 */
export interface InternalSessionOptions {
  // Agent/conversation routing
  agentId?: string;
  conversationId?: string;
  newConversation?: boolean;
  defaultConversation?: boolean;
  createOnly?: boolean;

  // Agent configuration
  model?: string;
  embedding?: string;
  systemPrompt?: SystemPromptConfig;

  // Memory blocks (only for new agents)
  memory?: MemoryItem[];
  persona?: string;  // Convenience for persona block
  human?: string;    // Convenience for human block

  // Tags (only for new agents)
  tags?: string[];

  // Memory filesystem (only for new agents)
  memfs?: boolean;

  // Skills/reminders
  skillSources?: SkillSource[];
  systemInfoReminder?: boolean;
  sleeptime?: SleeptimeOptions;

  // Permissions
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  canUseTool?: CanUseToolCallback;

  // Custom tools
  tools?: AnyAgentTool[];

  // Process settings
  cwd?: string;

  /** If true, pass --include-partial-messages to CLI for token-level stream_event chunks */
  includePartialMessages?: boolean;

  /**
   * Controls how the git-backed memory pull runs at session startup.
   * Maps to --memfs-startup <blocking|background|skip> CLI flag.
   */
  memfsStartup?: "blocking" | "background" | "skip";
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

/**
 * Options for createSession() and resumeSession() - restricted to options that can be applied to existing agents (LRU/Memo).
 * For creating new agents with custom memory/persona, use createAgent().
 */
export interface CreateSessionOptions {
  /** Model to use (e.g., "claude-sonnet-4-20250514") - updates the agent's LLM config */
  model?: string;

  /** System prompt preset (only presets, no custom strings or append) - updates the agent */
  systemPrompt?: SystemPromptPreset;

  /** List of allowed tool names */
  allowedTools?: string[];

  /** List of disallowed tool names */
  disallowedTools?: string[];

  /** Permission mode */
  permissionMode?: PermissionMode;

  /** Working directory for the CLI process */
  cwd?: string;

  /**
   * Enable/disable memory filesystem for this agent before running.
   * true -> `--memfs`, false -> `--no-memfs`, undefined -> leave unchanged.
   */
  memfs?: boolean;

  /**
   * Restrict available skills by source.
   * Empty array disables all skills (`--no-skills`).
   */
  skillSources?: SkillSource[];

  /**
   * Toggle first-turn system info reminder (device/git/cwd context).
   * false -> `--no-system-info-reminder`.
   */
  systemInfoReminder?: boolean;

  /**
   * Configure sleeptime (reflection) settings, equivalent to `/sleeptime`.
   */
  sleeptime?: SleeptimeOptions;

  /** Custom permission callback - called when tool needs approval */
  canUseTool?: CanUseToolCallback;

  /**
   * Custom tools that execute locally in the SDK process.
   * These tools are registered with the CLI and executed when the LLM calls them.
   */
  tools?: AnyAgentTool[];

  /**
   * If true, pass --include-partial-messages to CLI to receive token-level
   * stream_event chunks for incremental assistant/reasoning rendering.
   */
  includePartialMessages?: boolean;

  /**
   * Controls how the git-backed memory pull runs at session startup.
   *
   * - "blocking"  (default): await pull before emitting init; exit on conflict.
   * - "background": fire pull async; session init proceeds immediately.
   * - "skip": skip the pull entirely this session (fastest cold-open).
   *
   * Maps to the CLI --memfs-startup flag.
   */
  memfsStartup?: "blocking" | "background" | "skip";
}

/**
 * Options for createAgent() - full control over agent creation.
 */
export interface CreateAgentOptions {
  /** Model to use (e.g., "claude-sonnet-4-20250514") */
  model?: string;

  /** Embedding model to use (e.g., "text-embedding-ada-002") */
  embedding?: string;

  /**
   * System prompt configuration.
   * - string: Use as the complete system prompt
   * - SystemPromptPreset: Use a preset
   * - { type: 'preset', preset, append? }: Use a preset with optional appended text
   */
  systemPrompt?: string | SystemPromptPreset | SystemPromptPresetConfigSDK;

  /**
   * Memory block configuration. Each item can be:
   * - string: Preset block name ("persona", "human", "skills", "loaded_skills")
   * - CreateBlock: Custom block definition (e.g., { label: "project", value: "..." })
   * - { blockId: string }: Reference to existing shared block
   */
  memory?: MemoryItem[];

  /** Convenience: Set persona block value directly */
  persona?: string;

  /** Convenience: Set human block value directly */
  human?: string;

  /** List of allowed tool names */
  allowedTools?: string[];

  /** List of disallowed tool names */
  disallowedTools?: string[];

  /** Permission mode */
  permissionMode?: PermissionMode;

  /** Working directory for the CLI process */
  cwd?: string;

  /** Custom permission callback - called when tool needs approval */
  canUseTool?: CanUseToolCallback;

  /**
   * Custom tools that execute locally in the SDK process.
   * These tools are registered with the CLI and executed when the LLM calls them.
   */
  tools?: AnyAgentTool[];

  /** Tags to organize and categorize the agent */
  tags?: string[];

  /**
   * Enable git-backed memory filesystem for this newly created agent.
   * Maps to Letta Code CLI `--memfs` during agent creation.
   */
  memfs?: boolean;

  /**
   * Restrict available skills by source.
   * Empty array disables all skills (`--no-skills`).
   */
  skillSources?: SkillSource[];

  /**
   * Toggle first-turn system info reminder (device/git/cwd context).
   * false -> `--no-system-info-reminder`.
   */
  systemInfoReminder?: boolean;

  /**
   * Configure sleeptime (reflection) settings, equivalent to `/sleeptime`.
   */
  sleeptime?: SleeptimeOptions;
}

// ═══════════════════════════════════════════════════════════════
// SDK MESSAGE TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * SDK message types - clean wrappers around wire types
 */
export interface SDKInitMessage {
  type: "init";
  agentId: string;
  sessionId: string;
  conversationId: string;
  model: string;
  tools: string[];
  memfsEnabled?: boolean;
  skillSources?: SkillSource[];
  systemInfoReminderEnabled?: boolean;
  sleeptime?: EffectiveSleeptimeSettings;
}

export interface SDKAssistantMessage {
  type: "assistant";
  content: string;
  uuid: string;
}

export interface SDKToolCallMessage {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  uuid: string;
}

export interface SDKToolResultMessage {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
  uuid: string;
}

export interface SDKReasoningMessage {
  type: "reasoning";
  content: string;
  uuid: string;
}

export interface SDKResultMessage {
  type: "result";
  success: boolean;
  result?: string;
  error?: string;
  stopReason?: string;
  durationMs: number;
  totalCostUsd?: number;
  conversationId: string | null;
}

export interface SDKStreamEventDeltaPayload {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; reasoning?: string };
  content_block?: { type?: string; text?: string };
  [key: string]: unknown;
}

export interface SDKStreamEventMessagePayload {
  message_type: string;
  id?: string;
  otid?: string | null;
  content?: unknown;
  reasoning?: string;
  name?: string;
  tool_call?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  tool_return?: string;
  status?: string;
  [key: string]: unknown;
}

export interface SDKUnknownStreamEventPayload {
  type?: string;
  message_type?: string;
  [key: string]: unknown;
}

export type SDKStreamEventPayload =
  | SDKStreamEventDeltaPayload
  | SDKStreamEventMessagePayload
  | SDKUnknownStreamEventPayload;

export interface SDKStreamEventMessage {
  type: "stream_event";
  event: SDKStreamEventPayload;
  uuid: string;
}

/**
 * Error message from the CLI — carries the actual error detail that
 * would otherwise be lost (the subsequent `type=result` only has
 * the opaque string "error" as its error field).
 */
export interface SDKErrorMessage {
  type: "error";
  /** Human-readable error description from the CLI */
  message: string;
  /** Why the run stopped (e.g. "error", "llm_api_error", "max_steps") */
  stopReason: string;
  /** Run that produced the error, if available */
  runId?: string;
  /** Nested Letta API error when the error originated server-side */
  apiError?: Record<string, unknown>;
}

/**
 * Retry message — the CLI is retrying after a transient failure.
 * Emitted before each retry attempt so consumers can log / display progress.
 */
export interface SDKRetryMessage {
  type: "retry";
  /** The stop reason that triggered the retry */
  reason: string;
  /** Current attempt number (1-based) */
  attempt: number;
  /** Maximum attempts before giving up */
  maxAttempts: number;
  /** Delay in ms before the next attempt */
  delayMs: number;
  /** Run that triggered the retry, if available */
  runId?: string;
}

/** Union of all SDK message types */
export type SDKMessage =
  | SDKInitMessage
  | SDKAssistantMessage
  | SDKToolCallMessage
  | SDKToolResultMessage
  | SDKReasoningMessage
  | SDKResultMessage
  | SDKStreamEventMessage
  | SDKErrorMessage
  | SDKRetryMessage;

// ═══════════════════════════════════════════════════════════════
// LIST MESSAGES API
// ═══════════════════════════════════════════════════════════════

/**
 * Options for session.listMessages().
 */
export interface ListMessagesOptions {
  /** Explicit conversation ID (e.g. "conv-123"). If omitted, uses agent default. */
  conversationId?: string;
  /** Return messages before this message ID (cursor for older pages). */
  before?: string;
  /** Return messages after this message ID (cursor for newer pages). */
  after?: string;
  /** Sort order. Defaults to "desc" (newest first). */
  order?: "asc" | "desc";
  /** Max messages per page. Defaults to 50. */
  limit?: number;
}

/**
 * Result from session.listMessages().
 * `messages` are raw Letta API message objects in the requested order.
 */
export interface ListMessagesResult {
  messages: unknown[];
  /** ID of the oldest message in this page; use as `before` for the next page. */
  nextBefore?: string | null;
  /** Whether more pages exist in the requested direction. */
  hasMore?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// BOOTSTRAP SESSION STATE API
// ═══════════════════════════════════════════════════════════════

/**
 * Options for session.bootstrapState().
 */
export interface BootstrapStateOptions {
  /** Max messages to include in the initial history page. Defaults to 50. */
  limit?: number;
  /** Sort order for initial history page. Defaults to "desc" (newest first). */
  order?: "asc" | "desc";
}

/**
 * Result from session.bootstrapState().
 *
 * Contains all data needed to render the initial conversation view
 * without additional round-trips.
 */
export interface BootstrapStateResult {
  /** Resolved agent ID for this session. */
  agentId: string;
  /** Resolved conversation ID for this session. */
  conversationId: string;
  /** LLM model handle. */
  model: string | undefined;
  /** Tool names registered on the agent. */
  tools: string[];
  /** Whether memfs (git-backed memory) is enabled. */
  memfsEnabled: boolean;
  /** Initial history page (same shape as listMessages.messages). */
  messages: unknown[];
  /** Cursor to fetch older messages. Null when no more pages. */
  nextBefore: string | null;
  /** Whether more history pages exist. */
  hasMore: boolean;
  /** Whether there is a pending approval waiting for a response. */
  hasPendingApproval: boolean;
  /** Wall-clock timing breakdown in milliseconds (if provided by CLI). */
  timings?: {
    resolve_ms: number;
    list_messages_ms: number;
    total_ms: number;
  };
}

// ═══════════════════════════════════════════════════════════════
// EXTERNAL TOOL PROTOCOL TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Request to execute an external tool (CLI → SDK)
 */
export interface ExecuteExternalToolRequest {
  subtype: "execute_external_tool";
  tool_call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}
