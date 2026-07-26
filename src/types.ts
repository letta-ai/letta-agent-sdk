/**
 * SDK Types
 *
 * These are the public-facing types for SDK consumers.
 * Protocol types are defined locally to avoid relying on broken package subpath exports.
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
} from "./protocol.js";

// Import types for use in this file
import type { CreateBlock, CanUseToolResponse } from "./protocol.js";
import type { PersonalityId } from "@letta-ai/letta-code/agent-presets";

/** Letta Code personality preset used to seed a new agent. */
export type LettaCodePersonalityId = PersonalityId;

export interface LettaCodeSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  on?(type: string, listener: (event: unknown) => void): void;
  off?(type: string, listener: (event: unknown) => void): void;
  once?(type: string, listener: (event: unknown) => void): void;
}

export interface LettaCodeSocketOptions {
  headers?: Record<string, string>;
}

export type LettaCodeSocketConstructor = new (
  url: string,
  options?: LettaCodeSocketOptions,
) => LettaCodeSocketLike;

/**
 * React Native's WebSocket constructor accepts request headers as its third
 * argument, unlike the Node-style constructor used by the SDK protocol layer.
 */
export type LettaCodeReactNativeSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: LettaCodeSocketOptions,
) => LettaCodeSocketLike;

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

export interface RunTurnOptions {
  /**
   * Max automatic approval-conflict recovery attempts for this turn.
   * Overrides session-level maxApprovalRecoveryAttempts when provided.
   */
  maxApprovalRecoveryAttempts?: number;

  /**
   * Timeout in milliseconds for each approval recovery request.
   * Overrides session-level approvalRecoveryTimeoutMs when provided.
   */
  recoveryTimeoutMs?: number;
}

export interface RecoverPendingApprovalsOptions {
  /**
   * Timeout in milliseconds for the recovery control request.
   */
  timeoutMs?: number;
}

export interface RecoverPendingApprovalsResult {
  recovered: boolean;
  /**
   * Whether a pending approval is known to remain after recovery.
   * Undefined means the SDK could not determine the state (for example, timeout).
   */
  pendingApproval?: boolean;
  unsupported: boolean;
  detail?: string;
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
// SKILLS / REMINDER / DREAMING TYPES
// ═══════════════════════════════════════════════════════════════

export type SkillSource = "bundled" | "global" | "agent" | "project";

export type DreamingTrigger = "off" | "step-count" | "compaction-event";

export type DreamingBehavior = "reminder" | "auto-launch";

/**
 * Dreaming settings exposed through SDK options.
 * Any omitted fields preserve server/CLI defaults.
 */
export interface DreamingOptions {
  trigger?: DreamingTrigger;
  behavior?: DreamingBehavior;
  stepCount?: number;
}

/**
 * Fully-resolved dreaming settings emitted by init messages.
 */
export interface EffectiveDreamingSettings {
  trigger: DreamingTrigger;
  behavior: DreamingBehavior;
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
// TOP-LEVEL CLIENT TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * How the SDK reaches or runs the Letta Code harness.
 *
 * - local: spawn/manage a local Letta Code app-server over loopback websockets.
 * - remote: connect to a user-managed app-server over websockets.
 * - cloud: use agents hosted on Letta Cloud, with an explicit remote
 *   environment or SDK-managed sandbox.
 */
export type LettaCodeBackend = "local" | "remote" | "cloud";

/**
 * Stable execution target for remote/cloud runtimes.
 *
 * Strings are treated as human-readable environment names. Object forms allow
 * callers to avoid relying on names as unique identifiers.
 */
export type LettaCodeEnvironment =
  | string
  | { name: string }
  | { id: string }
  | { connectionId: string }
  | { deviceId: string };

export interface LettaCodeLocalAppServerOptions {
  /**
   * Optional URL for tests or advanced users with a pre-started local app-server.
   * Omit to let the SDK spawn and own a loopback app-server.
   */
  url?: string;
  /**
   * Which Letta Code backend the spawned app-server runs against:
   * - "local": the in-process experimental backend (agents stored on this
   *   machine, `agent-local-*` ids). The default.
   * - "api": Letta Cloud (real `agent-*` ids, cloud-side models such as
   *   letta/auto-memory) with tools still executing on this machine. Requires
   *   the harness to be authenticated (login or LETTA_API_KEY).
   */
  harnessBackend?: "api" | "local";
  /** Optional WebSocket constructor for tests/non-standard runtimes. */
  WebSocket?: LettaCodeSocketConstructor;
  /** Timeout for websocket protocol request/turn correlation. */
  requestTimeoutMs?: number;
  /** Local app-server listen URL when the SDK spawns it. Defaults to ws://127.0.0.1:0. */
  listen?: string;
  /** Timeout waiting for the spawned app-server to print its listening URL. */
  startupTimeoutMs?: number;
}

export interface LettaCodeLocalClientOptions {
  backend?: "local";
  /** Advanced local transport override. Defaults to app-server. */
  transport?: "app-server" | "stdio";
  /** Advanced app-server overrides for local transport. */
  appServer?: LettaCodeLocalAppServerOptions;
}

export interface LettaCodeRemoteClientOptions {
  backend: "remote";
  /** URL of the user-managed app-server / websocket endpoint. */
  url: string;
  /** Optional capability token sent as Authorization: Bearer <token> during websocket upgrade. */
  authToken?: string;
  /** Optional WebSocket constructor for non-browser runtimes and tests. */
  WebSocket?: LettaCodeSocketConstructor;
  /** Timeout for websocket protocol request/turn correlation. */
  requestTimeoutMs?: number;
}

export interface LettaCodeCloudSandboxOptions {
  /**
   * TTL to request when refreshing an SDK-managed sandbox. Defaults to 5
   * minutes, matching the Cloud API default. Valid range: 1-60.
   */
  ttlMinutes?: number;
  /** Timeout waiting for a newly created sandbox environment to come online. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for a newly created sandbox environment. */
  readyPollIntervalMs?: number;
  /** Interval for proactive TTL refreshes while the session is open. */
  refreshIntervalMs?: number;
  /**
   * Best-effort terminate the SDK-managed sandbox on session close. Defaults to
   * false so other sessions for the same conversation and reconnecting clients
   * can continue using it. Set true to restore eager cleanup when this session
   * exclusively owns the sandbox.
   */
  terminateOnClose?: boolean;
}

export interface LettaCodeCloudClientOptions {
  backend: "cloud";
  /** Optional API key override. Defaults to LETTA_API_KEY / existing auth. */
  apiKey?: string;
  /** Optional API base URL override. Defaults to the Letta API. */
  apiBaseUrl?: string;
  /** Optional extra HTTP headers for Cloud API requests. */
  headers?: Record<string, string>;
  /** Optional fetch implementation for tests/non-standard runtimes. */
  fetch?: typeof fetch;
  /** Optional WebSocket constructor for non-browser runtimes and tests. */
  WebSocket?: LettaCodeSocketConstructor;
  /** Timeout for websocket protocol request/turn correlation. */
  requestTimeoutMs?: number;
  /**
   * WebSocket authentication style. Defaults to Authorization headers; set to
   * query for browser-style clients that cannot send WebSocket headers.
   */
  webSocketAuth?: "header" | "query";
  /** Heartbeat interval for the Cloud status websocket. Defaults to 30s. */
  pingIntervalMs?: number;
  /**
   * Execution target for Letta Cloud sessions. If omitted, the SDK creates
   * and owns a sandbox for the session.
   */
  environment?: LettaCodeEnvironment;
  /** Options for SDK-managed sandboxes when environment is omitted. */
  sandbox?: LettaCodeCloudSandboxOptions;
}

export type LettaCodeClientOptions =
  | LettaCodeLocalClientOptions
  | LettaCodeRemoteClientOptions
  | LettaCodeCloudClientOptions;

export interface Repository {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepositoryParams {
  name: string;
}

export interface ListRepositoriesParams {
  limit?: number;
  offset?: number;
}

export interface ListRepositoriesResult {
  repositories: Repository[];
  hasNextPage: boolean;
}

export interface RepositoryResource {
  type: "repository";
  repositoryId: string;
}

export interface RepositoryFileEntry {
  path: string;
  type: "file" | "directory";
}

export interface ListRepositoryFilesParams {
  pathPrefix?: string;
  depth?: number;
  ref?: string;
}

export interface ListRepositoryFilesResult {
  files: RepositoryFileEntry[];
  ref: string;
}

export interface CreateRepositoryFileParams {
  path: string;
  content: string;
}

export interface RepositoryFile {
  path: string;
  content: string;
  contentSha256: string;
  ref?: string;
}

export interface UpdateRepositoryFileParams {
  path: string;
  content?: string;
  newPath?: string;
  precondition?: {
    contentSha256: string;
  };
}

export interface RepositoryFileMutationResult {
  path: string;
  contentSha256: string;
  commitSha: string;
}

export interface DeleteRepositoryFileParams {
  path: string;
}

export interface DeleteRepositoryFileResult {
  success: boolean;
  commitSha: string;
}

export interface RepositoryVersion {
  sha: string;
  message: string;
  timestamp: string;
  author_name: string | null;
}

export interface ListRepositoryVersionsParams {
  path?: string;
  limit?: number;
}

export interface GetRepositoryVersionParams {
  path: string;
}

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
  reasoningEffort?: ReasoningEffort;
  embedding?: string;
  systemPrompt?: SystemPromptConfig;

  // Memory blocks (only for new agents)
  memory?: MemoryItem[];
  persona?: string;  // Convenience for persona block
  human?: string;    // Convenience for human block

  // Tags (only for new agents)
  tags?: string[];

  // Skills/reminders
  skillSources?: SkillSource[];
  systemInfoReminder?: boolean;
  dreaming?: DreamingOptions;

  // Permissions
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  canUseTool?: CanUseToolCallback;

  // Server-side tools (only for new agents); omitted -> harness defaults.
  baseTools?: string[];

  // Custom tools
  tools?: AnyAgentTool[];

  // Process settings
  cwd?: string;

  /** If true, pass --include-partial-messages to CLI for token-level stream_event chunks */
  includePartialMessages?: boolean;

  /**
   * Max automatic approval-conflict recovery attempts per runTurn() call.
   * Set to 0 to disable automatic recovery.
   */
  maxApprovalRecoveryAttempts?: number;

  /**
   * Timeout in milliseconds for a single approval recovery request.
   */
  approvalRecoveryTimeoutMs?: number;

}

export type PermissionMode =
  | "standard"
  | "acceptEdits"
  | "unrestricted";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type LettaCodeModelEntry = Record<string, unknown> & {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
  updateArgs?: Record<string, unknown>;
};

export interface ListModelsResult {
  entries: LettaCodeModelEntry[];
  /** Handles available to this user. null means availability lookup failed. */
  availableHandles?: string[] | null;
  /** BYOK provider name -> base provider name, e.g. lc-anthropic -> anthropic. */
  byokProviderAliases?: Record<string, string>;
}

export interface UpdateModelOptions {
  /** Model id from listModels() or direct model handle. Model ids usually omit '/'. */
  model?: string;
  /** Explicit model id from listModels(). */
  modelId?: string;
  /** Explicit direct model handle, including BYOK handles. */
  modelHandle?: string;
  /** Select a reasoning tier for the target model handle. */
  reasoningEffort?: ReasoningEffort;
}

export interface UpdateModelResult {
  appliedTo?: "agent" | "conversation";
  modelId?: string;
  modelHandle?: string;
  modelSettings?: Record<string, unknown> | null;
}

export type SDKProtocolMessage<TType extends string = string> = Record<string, unknown> & {
  type: TType;
  request_id?: string;
};

export type SDKProtocolCommand<TType extends string = string> = SDKProtocolMessage<TType>;

export interface SendCommandOptions<TResponseType extends string = string> {
  /** Wait for a response with this protocol message type. Omit for fire-and-forget commands. */
  responseType?: TResponseType;
  /** Override the websocket protocol request timeout for this command. */
  timeoutMs?: number;
  /** Optional custom matcher for advanced protocol responses. */
  predicate?: (message: SDKProtocolMessage) => boolean;
}

/**
 * Options for createSession() and resumeSession() - restricted to options that can be applied to existing agents (LRU/Memo).
 * For creating new agents with custom memory/persona, use createAgent().
 */
export interface CreateSessionOptions {
  /** Model to use (e.g., "claude-sonnet-4-20250514") - updates the agent's LLM config */
  model?: string;

  /** Reasoning effort tier to use with the selected/current model on websocket protocol sessions. */
  reasoningEffort?: ReasoningEffort;

  /** System prompt preset (only presets, no custom strings or append) - updates the agent */
  systemPrompt?: SystemPromptPreset;

  /**
   * Exact client-side tool allowlist for the session, including custom SDK
   * tools. When omitted, the harness default toolset and registered custom
   * tools apply. Interactive user-input tools (AskUserQuestion) are always
   * excluded for SDK sessions.
   */
  allowedTools?: string[];

  /** List of disallowed tool names */
  disallowedTools?: string[];

  /** Permission mode */
  permissionMode?: PermissionMode;

  /** Working directory for the CLI process */
  cwd?: string;

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
   * Configure dreaming settings.
   */
  dreaming?: DreamingOptions;

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
   * Max automatic approval-conflict recovery attempts per runTurn() call.
   * Set to 0 to disable automatic recovery.
   */
  maxApprovalRecoveryAttempts?: number;

  /**
   * Timeout in milliseconds for a single approval recovery request.
   */
  approvalRecoveryTimeoutMs?: number;

  /** Cloud repository resources to attach for the lifetime of the SDK session. */
  resources?: RepositoryResource[];

}

/**
 * Session options accepted by LettaAgentClient methods.
 *
 * `environment` is a cloud execution-target override. It is deliberately
 * session-scoped rather than part of createAgent() options.
 */
export interface LettaCodeClientSessionOptions extends CreateSessionOptions {
  environment?: LettaCodeEnvironment;
  /** Per-session SDK-managed sandbox options when environment is omitted. */
  sandbox?: LettaCodeCloudSandboxOptions;
  /**
   * Extra environment variables for the session's harness process. Each
   * SDK-owned local app-server session runs in its own process, so this
   * scopes cleanly per session — e.g. MEMORY_DIR / LETTA_MEMORY_DIR to point
   * the harness's memory scoping (and its guard) at a session-specific
   * memory copy. Ignored on remote and cloud transports.
   */
  env?: Record<string, string>;
}

export interface LettaCodeSession extends AsyncDisposable {
  send(message: SendMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage>;
  abort(): Promise<void>;
  sendCommand(command: SDKProtocolCommand): Promise<void>;
  sendCommand<TResponse extends SDKProtocolMessage = SDKProtocolMessage>(
    command: SDKProtocolCommand,
    options: SendCommandOptions,
  ): Promise<TResponse>;
  listMessages(options?: ListMessagesOptions): Promise<ListMessagesResult>;
  listModels(): Promise<ListModelsResult>;
  updateModel(update: string | UpdateModelOptions): Promise<UpdateModelResult>;
  /**
   * Fetch the initial conversation projection used to hydrate or reconcile a
   * resumed session.
   */
  bootstrapState(options?: BootstrapStateOptions): Promise<BootstrapStateResult>;
  /**
   * Ask the runtime to recover any approval that was pending across a
   * disconnect.
   */
  recoverPendingApprovals(
    options?: RecoverPendingApprovalsOptions,
  ): Promise<RecoverPendingApprovalsResult>;
  /**
   * Update runtime controls for subsequent work in this conversation.
   *
   * The current app-server protocol does not acknowledge this command. The
   * promise confirms that the command was accepted for transport, not that the
   * runtime has applied it.
   */
  changeDeviceState(updates: ChangeDeviceStateOptions): Promise<void>;
  /**
   * Remove one queued user message and wait for the runtime acknowledgement.
   */
  removeQueuedMessage(itemId: string): Promise<RemoveQueuedMessageResult>;
  close(): void;
  readonly agentId: string | null;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
}

export interface ChangeDeviceStateOptions {
  cwd?: string;
  permissionMode?: PermissionMode;
}

export interface RemoveQueuedMessageResult {
  /** Queue item identifier echoed by the runtime. */
  itemId: string;
  /** False when the item was no longer present in the authoritative queue. */
  removed: boolean;
}

/**
 * Options for createAgent() - full control over agent creation.
 */
export interface CreateAgentOptions {
  /**
   * Letta Code personality preset. Defaults to "memo". The creation payload
   * is built by `@letta-ai/letta-code/agent-presets`, matching Chat/Desktop.
   */
  personality?: LettaCodePersonalityId;

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

  /**
   * Whether to enable the git-backed memory filesystem on the new agent
   * (default true). Pass false for worker-style agents that should not carry
   * their own memory repo — enabling memfs is a slow backend round trip, and
   * concurrent sessions on a shared-memfs agent contend on its git state.
   */
  memfs?: boolean;

  /** Display name for the agent. */
  name?: string;

  /** Description of the agent's purpose. */
  description?: string;

  /** Hide the agent from default listings (worker/subagent semantics). */
  hidden?: boolean;

  /**
   * Server-side tools to attach at creation. When omitted, the harness
   * applies its created-agent defaults (web_search, fetch_webpage). Pass []
   * for none or an explicit list to override. Client-side tools (Bash,
   * Edit, …) are provided by the harness at runtime and are unaffected.
   */
  baseTools?: string[];

  /**
   * Exact client-side tool allowlist for the session, including custom SDK
   * tools. When omitted, the harness default toolset and registered custom
   * tools apply. Interactive user-input tools (AskUserQuestion) are always
   * excluded for SDK sessions.
   */
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

  /** Tags to organize and categorize the agent. */
  tags?: string[];

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
   * Configure dreaming settings.
   */
  dreaming?: DreamingOptions;
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
  /** Backend-reported tool names, when the transport exposes an authoritative list. */
  tools?: string[];
  memfsEnabled?: boolean;
  skillSources?: SkillSource[];
  systemInfoReminderEnabled?: boolean;
  dreaming?: EffectiveDreamingSettings;
}

export interface SDKAssistantMessage {
  type: "assistant";
  content: string;
  uuid: string;
  /** Run ID from the Letta API for this event (used for stale-run detection). */
  runId?: string;
}

export interface SDKToolCallMessage {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Raw unparsed arguments string from the wire for consumer-side accumulation. */
  rawArguments?: string;
  uuid: string;
  /** Run ID from the Letta API for this event (used for stale-run detection). */
  runId?: string;
}

export interface SDKToolResultMessage {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
  uuid: string;
  /** Run ID from the Letta API for this event (used for stale-run detection). */
  runId?: string;
}

export interface SDKReasoningMessage {
  type: "reasoning";
  content: string;
  uuid: string;
  /** Run ID from the Letta API for this event (used for stale-run detection). */
  runId?: string;
}

/** Canonical SDK error codes recognized by the SDK. */
export type SDKErrorCode =
  | "approval_conflict"
  | "approval_conflict_terminal"
  | "protocol_error"
  | "error"
  | "llm_api_error"
  | "max_steps"
  | "interrupted"
  | "stream_closed";

export interface SDKResultMessage {
  type: "result";
  success: boolean;
  result?: string;
  /** Legacy error string (kept for compatibility). Prefer errorCode. */
  error?: string;
  /** Canonical typed error code for machine handling. */
  errorCode?: SDKErrorCode;
  /** True when the failure corresponds to an approval conflict/deadlock. */
  approvalConflict?: boolean;
  /** Whether another recovery attempt could still succeed. */
  recoverable?: boolean;
  /** Number of SDK-managed recovery attempts executed for this turn. */
  recoveryAttempts?: number;
  /** Best-effort human-readable approval-conflict detail (if available). */
  errorDetail?: string;
  stopReason?: string;
  durationMs: number;
  totalCostUsd?: number;
  conversationId: string | null;
  /** Run IDs associated with this turn (if provided by the CLI). */
  runIds?: string[];
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
  /** Canonical typed error code for machine handling. */
  errorCode?: SDKErrorCode;
  /** True when the error detail indicates an approval conflict/deadlock. */
  approvalConflict?: boolean;
  /** Whether another recovery attempt could still succeed. */
  recoverable?: boolean;
  /** Parsed API error detail string when present. */
  errorDetail?: string;
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

export interface SDKQueueItem {
  id: string;
  clientMessageId: string;
  kind: string;
  source: string;
  content: unknown;
  enqueuedAt: string;
}

export interface SDKQueueUpdateMessage {
  type: "queue_update";
  queue: SDKQueueItem[];
}

export interface SDKLoopStatusMessage {
  type: "loop_status";
  status: string;
  activeRunIds: string[];
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
  | SDKRetryMessage
  | SDKQueueUpdateMessage
  | SDKLoopStatusMessage;

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
 * `messages` are raw Letta API message objects in the requested order. Cursor
 * metadata is backend-supplied and omitted when the backend does not expose an
 * authoritative pagination answer.
 */
export interface ListMessagesResult {
  messages: unknown[];
  /** ID of the oldest message in this page; use as `before` for the next page when present. */
  nextBefore?: string | null;
  /** Whether more pages exist in the requested direction, when known. */
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
 * Contains best-effort data needed to render the initial conversation view
 * without additional round-trips. Backend-derived booleans/cursors are omitted
 * when the remote/app-server backend does not expose an authoritative value.
 */
export interface BootstrapStateResult {
  /** Resolved agent ID for this session. */
  agentId: string;
  /** Resolved conversation ID for this session. */
  conversationId: string;
  /** LLM model handle. */
  model: string | undefined;
  /** Backend-reported tool names, when the transport exposes an authoritative list. */
  tools?: string[];
  /** Whether memfs (git-backed memory) is enabled, when known. */
  memfsEnabled?: boolean;
  /** Initial history page (same shape as listMessages.messages). */
  messages: unknown[];
  /** Cursor to fetch older messages. Null when the backend knows there are no more pages. */
  nextBefore?: string | null;
  /** Whether more history pages exist, when known. */
  hasMore?: boolean;
  /** Whether there is a pending approval waiting for a response, when known. */
  hasPendingApproval?: boolean;
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
