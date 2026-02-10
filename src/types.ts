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

  // Permissions
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  canUseTool?: CanUseToolCallback;

  // Custom tools
  tools?: AnyAgentTool[];

  // Process settings
  cwd?: string;
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

  /** Custom permission callback - called when tool needs approval */
  canUseTool?: CanUseToolCallback;

  /**
   * Custom tools that execute locally in the SDK process.
   * These tools are registered with the CLI and executed when the LLM calls them.
   */
  tools?: AnyAgentTool[];
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

export interface SDKStreamEventMessage {
  type: "stream_event";
  event: {
    type: string;  // "content_block_start" | "content_block_delta" | "content_block_stop"
    index?: number;
    delta?: { type?: string; text?: string; reasoning?: string };
    content_block?: { type?: string; text?: string };
  };
  uuid: string;
}

/** Union of all SDK message types */
export type SDKMessage =
  | SDKInitMessage
  | SDKAssistantMessage
  | SDKToolCallMessage
  | SDKToolResultMessage
  | SDKReasoningMessage
  | SDKResultMessage
  | SDKStreamEventMessage;

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
