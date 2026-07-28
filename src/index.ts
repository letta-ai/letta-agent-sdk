/**
 * Letta Agent SDK
 *
 * Programmatic control of Letta Code CLI with persistent agent memory.
 *
 * @example
 * ```typescript
 * import { LettaAgentClient, createAgent, createSession, resumeSession, prompt } from '@letta-ai/letta-agent-sdk';
 *
 * const client = new LettaAgentClient({ backend: 'local' });
 * const agentId = await client.createAgent();
 * const clientSession = client.resumeSession(agentId);
 *
 * // Create a new agent explicitly
 * const agentId = await createAgent();
 *
 * // Resume default conversation on an agent
 * const session = resumeSession(agentId);
 *
 * // Resume specific conversation
 * const session = resumeSession('conv-xxx');
 *
 * // Create new conversation on specific agent
 * const session = createSession(agentId);
 *
 * // One-shot prompt in a new conversation
 * const result = await prompt('Hello', agentId);
 * ```
 */

import { LettaAgentClient } from "./client.js";
import type {
  CreateSessionOptions,
  CreateAgentOptions,
  LettaCodeSession,
  SDKInitMessage,
  SDKResultMessage,
  SendMessage,
} from "./types.js";
import { validateCreateSessionOptions, validateCreateAgentOptions } from "./validation.js";

// Re-export types
export type {
  CreateSessionOptions,
  CreateAgentOptions,
  LettaCodePersonalityId,
  LettaCodeBackend,
  LettaCodeEnvironment,
  LettaCodeLocalClientOptions,
  LettaCodeLocalAppServerOptions,
  LettaCodeRemoteClientOptions,
  LettaCodeCloudClientOptions,
  LettaCodeCloudSandboxOptions,
  GitHubRepositoryRef,
  LettaCodeClientOptions,
  LettaCodeClientSessionOptions,
  LettaCodeSession,
  LettaCodeSocketLike,
  LettaCodeSocketConstructor,
  LettaCodeReactNativeSocketConstructor,
  SDKMessage,
  SDKInitMessage,
  SDKAssistantMessage,
  SDKToolCallMessage,
  SDKToolResultMessage,
  SDKReasoningMessage,
  SDKResultMessage,
  SDKErrorCode,
  SDKStreamEventMessage,
  SDKStreamEventPayload,
  SDKStreamEventDeltaPayload,
  SDKStreamEventMessagePayload,
  SDKUnknownStreamEventPayload,
  SDKErrorMessage,
  SDKRetryMessage,
  SDKQueueItem,
  SDKQueueUpdateMessage,
  SDKLoopStatusMessage,
  SDKProtocolMessage,
  SDKProtocolCommand,
  SendCommandOptions,
  RunTurnOptions,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  ChangeDeviceStateOptions,
  RemoveQueuedMessageResult,
  GetDeviceStatusOptions,
  SessionDeviceStatus,
  SessionPendingControlRequest,
  SessionPermissionSuggestion,
  SessionDiffHunkLine,
  SessionDiffHunk,
  SessionDiffPreview,
  SkillSource,
  DreamingOptions,
  SessionDreamingOptions,
  DreamingTrigger,
  DreamingBehavior,
  EffectiveDreamingSettings,
  PermissionMode,
  ReasoningEffort,
  CanUseToolCallback,
  CanUseToolContext,
  CanUseToolPermissionSuggestion,
  CanUseToolResponse,
  CanUseToolResponseAllow,
  CanUseToolResponseDeny,
  // Multimodal content types
  TextContent,
  ImageContent,
  MessageContentItem,
  SendMessage,
  // List messages API
  ListMessagesOptions,
  ListMessagesResult,
  ListModelsResult,
  LettaCodeModelEntry,
  UpdateModelOptions,
  UpdateModelResult,
  Repository,
  CreateRepositoryParams,
  ListRepositoriesParams,
  ListRepositoriesResult,
  RepositoryResource,
  RepositoryFileEntry,
  ListRepositoryFilesParams,
  ListRepositoryFilesResult,
  CreateRepositoryFileParams,
  RepositoryFile,
  UpdateRepositoryFileParams,
  RepositoryFileMutationResult,
  DeleteRepositoryFileParams,
  DeleteRepositoryFileResult,
  RepositoryVersion,
  ListRepositoryVersionsParams,
  GetRepositoryVersionParams,
  // Bootstrap API
  BootstrapStateOptions,
  BootstrapStateResult,
  // Tool types
  AgentTool,
  AgentToolResult,
  AgentToolResultContent,
  AgentToolUpdateCallback,
  AnyAgentTool,
} from "./types.js";
export type {
  AgentsClient,
  ConversationsClient,
  LettaAgent,
  LettaConversation,
  LettaConversationMessage,
  ModelsClient,
  ListAgentsOptions,
  UpdateAgentOptions,
  ListConversationsOptions,
  CreateConversationOptions,
  UpdateConversationOptions,
  ConversationMessagesOptions,
  ConversationMessagesResult,
} from "./management-types.js";

export { RepositoriesClient } from "./repositories.js";
export { LettaAgentClient } from "./client.js";
export { CloudManagedSandboxExpiredError } from "./cloud-session.js";
export { createReactNativeWebSocketConstructor } from "./websocket.js";

export { extractStreamTextDelta } from "./stream-events.js";

// Tool helpers
export {
  jsonResult,
  readStringParam,
  readNumberParam,
  readBooleanParam,
  readStringArrayParam,
} from "./tool-helpers.js";

/**
 * Create a new agent with a default conversation.
 * Returns the agentId which can be used with resumeSession or createSession.
 *
 * @example
 * ```typescript
 * // Create agent with default settings.
 * const agentId = await createAgent();
 *
 * // Create agent with custom memory
 * const agentId = await createAgent({
 *   memory: ['persona', 'project'],
 *   persona: 'You are a helpful coding assistant',
 *   model: 'claude-sonnet-4',
 *   tags: ['project:docs']
 * });
 *
 * // Then resume the default conversation:
 * const session = resumeSession(agentId);
 * ```
 */
export async function createAgent(options: CreateAgentOptions = {}): Promise<string> {
  validateCreateAgentOptions(options);
  return new LettaAgentClient().createAgent(options);
}

/**
 * Create a new conversation (session).
 *
 * Creates a new conversation on the specified agent.
 *
 * @example
 * ```typescript
 * // New conversation on specific agent
 * await using session = createSession(agentId);
 * ```
 */
export function createSession(
  agentId: string,
  options: CreateSessionOptions = {},
): LettaCodeSession {
  validateCreateSessionOptions(options);
  return new LettaAgentClient().createSession(agentId, options);
}

/**
 * Resume an existing session.
 *
 * - Pass an agent ID (agent-xxx) to resume the default conversation
 * - Pass a conversation ID (conv-xxx) to resume a specific conversation
 *
 * The default conversation always exists after createAgent, so you can:
 * `createAgent()` → `resumeSession(agentId)` without needing createSession first.
 *
 * @example
 * ```typescript
 * // Resume default conversation
 * await using session = resumeSession(agentId);
 *
 * // Resume specific conversation
 * await using session = resumeSession('conv-xxx');
 * ```
 */
export function resumeSession(
  id: string,
  options: CreateSessionOptions = {},
): LettaCodeSession {
  validateCreateSessionOptions(options);
  return new LettaAgentClient().resumeSession(id, options);
}

/**
 * One-shot prompt convenience function.
 *
 * Uses the specified agent in a new conversation.
 * - Uses a short-lived session and returns the final turn result.
 *
 * @example
 * ```typescript
 * const result = await prompt('What is the capital of France?', agentId);  // specific agent
 * ```
 */
type TurnSession = LettaCodeSession & {
  runTurn(message: SendMessage): Promise<SDKResultMessage>;
};

type InitializableSession = LettaCodeSession & {
  initialize(): Promise<SDKInitMessage>;
};

export async function prompt(
  message: SendMessage,
  agentId: string,
  options: CreateSessionOptions = {},
): Promise<SDKResultMessage> {
  const session = createSession(agentId, options);

  try {
    return await (session as TurnSession).runTurn(message);
  } finally {
    session.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// SESSIONLESS APIs
// ═══════════════════════════════════════════════════════════════

import type { ListMessagesOptions, ListMessagesResult } from "./types.js";

/**
 * Fetch conversation messages without requiring a pre-existing session.
 *
 * Creates a transient CLI subprocess, fetches the requested message page, and
 * closes the subprocess.  Useful for prefetching conversation histories before
 * opening a full session (e.g. desktop sidebar warm-up).
 *
 * Routing follows the same agent/conversation semantics as session history:
 * - Pass a conv-xxx conversationId to read a specific conversation.
 * - Omit conversationId to read the agent's default conversation.
 *
 * @param agentId - Agent ID to fetch messages for.
 * @param options - Pagination / filtering options (same as ListMessagesOptions).
 *
 * @example
 * ```typescript
 * // Prefetch default conversation
 * const { messages } = await listMessagesDirect(agentId);
 *
 * // Prefetch a specific conversation
 * const { messages, hasMore, nextBefore } = await listMessagesDirect(agentId, {
 *   conversationId: 'conv-abc',
 *   limit: 20,
 *   order: 'desc',
 * });
 * ```
 */
export async function listMessagesDirect(
  agentId: string,
  options: ListMessagesOptions = {},
): Promise<ListMessagesResult> {
  // resumeSession uses --default which maps to the agent's default conversation.
  // The session is transient: we only need it long enough to list messages.
  const session = new LettaAgentClient().resumeSession(agentId, {
    permissionMode: "unrestricted",
  });
  await (session as InitializableSession).initialize();
  try {
    return await session.listMessages(options);
  } finally {
    session.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// IMAGE HELPERS
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import type { ImageContent } from "./types.js";

/**
 * Create image content from a file path.
 * 
 * @example
 * ```typescript
 * await session.send([
 *   { type: "text", text: "What's in this image?" },
 *   imageFromFile("./screenshot.png")
 * ]);
 * ```
 */
export function imageFromFile(filePath: string): ImageContent {
  const data = readFileSync(filePath).toString("base64");
  const ext = filePath.toLowerCase();
  const media_type: ImageContent["source"]["media_type"] = 
    ext.endsWith(".png") ? "image/png"
    : ext.endsWith(".gif") ? "image/gif"
    : ext.endsWith(".webp") ? "image/webp"
    : "image/jpeg";
  
  return {
    type: "image",
    source: { type: "base64", media_type, data }
  };
}

/**
 * Create image content from base64 data.
 * 
 * @example
 * ```typescript
 * const base64 = fs.readFileSync("image.png").toString("base64");
 * await session.send([
 *   { type: "text", text: "Describe this" },
 *   imageFromBase64(base64, "image/png")
 * ]);
 * ```
 */
export function imageFromBase64(
  data: string,
  media_type: ImageContent["source"]["media_type"] = "image/png"
): ImageContent {
  return {
    type: "image",
    source: { type: "base64", media_type, data }
  };
}

/**
 * Create image content from a URL.
 * Fetches the image and converts to base64.
 * 
 * @example
 * ```typescript
 * const img = await imageFromURL("https://example.com/image.png");
 * await session.send([
 *   { type: "text", text: "What's this?" },
 *   img
 * ]);
 * ```
 */
export async function imageFromURL(url: string): Promise<ImageContent> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const data = Buffer.from(buffer).toString("base64");
  
  // Detect media type from content-type header or URL
  const contentType = response.headers.get("content-type");
  let media_type: ImageContent["source"]["media_type"] = "image/png";
  
  if (contentType?.includes("jpeg") || contentType?.includes("jpg") || url.match(/\.jpe?g$/i)) {
    media_type = "image/jpeg";
  } else if (contentType?.includes("gif") || url.endsWith(".gif")) {
    media_type = "image/gif";
  } else if (contentType?.includes("webp") || url.endsWith(".webp")) {
    media_type = "image/webp";
  }
  
  return {
    type: "image",
    source: { type: "base64", media_type, data }
  };
}
