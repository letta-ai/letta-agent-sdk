/**
 * Letta Code SDK
 *
 * Programmatic control of Letta Code CLI with persistent agent memory.
 *
 * @example
 * ```typescript
 * import { createAgent, createSession, resumeSession, prompt } from '@letta-ai/letta-code-sdk';
 *
 * // Start session with default agent + new conversation (like `letta`)
 * const session = createSession();
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
 * // One-shot prompt (uses default agent)
 * const result = await prompt('Hello');
 * const result = await prompt('Hello', agentId);  // specific agent
 * ```
 */

import { Session } from "./session.js";
import type { CreateSessionOptions, CreateAgentOptions, SDKResultMessage } from "./types.js";
import { validateCreateSessionOptions, validateCreateAgentOptions } from "./validation.js";

// Re-export types
export type {
  CreateSessionOptions,
  CreateAgentOptions,
  SDKMessage,
  SDKInitMessage,
  SDKAssistantMessage,
  SDKToolCallMessage,
  SDKToolResultMessage,
  SDKReasoningMessage,
  SDKResultMessage,
  SDKStreamEventMessage,
  PermissionMode,
  CanUseToolCallback,
  CanUseToolResponse,
  CanUseToolResponseAllow,
  CanUseToolResponseDeny,
  // Multimodal content types
  TextContent,
  ImageContent,
  MessageContentItem,
  SendMessage,
} from "./types.js";

export { Session } from "./session.js";

/**
 * Create a new agent with a default conversation.
 * Returns the agentId which can be used with resumeSession or createSession.
 *
 * @example
 * ```typescript
 * // Create agent with default settings
 * const agentId = await createAgent();
 *
 * // Create agent with custom memory
 * const agentId = await createAgent({
 *   memory: ['persona', 'project'],
 *   persona: 'You are a helpful coding assistant',
 *   model: 'claude-sonnet-4'
 * });
 *
 * // Then resume the default conversation:
 * const session = resumeSession(agentId);
 * ```
 */
export async function createAgent(options: CreateAgentOptions = {}): Promise<string> {
  validateCreateAgentOptions(options);
  const session = new Session({ ...options, createOnly: true });
  const initMsg = await session.initialize();
  session.close();
  return initMsg.agentId;
}

/**
 * Create a new conversation (session).
 *
 * - Without agentId: uses default/LRU agent with new conversation (like `letta`)
 * - With agentId: creates new conversation on specified agent
 *
 * @example
 * ```typescript
 * // New conversation on default agent (like `letta`)
 * await using session = createSession();
 *
 * // New conversation on specific agent
 * await using session = createSession(agentId);
 * ```
 */
export function createSession(agentId?: string, options: CreateSessionOptions = {}): Session {
  validateCreateSessionOptions(options);
  if (agentId) {
    return new Session({ ...options, agentId, newConversation: true });
  } else {
    return new Session({ ...options, newConversation: true });
  }
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
  options: CreateSessionOptions = {}
): Session {
  validateCreateSessionOptions(options);
  if (id.startsWith("conv-")) {
    return new Session({ ...options, conversationId: id });
  } else {
    return new Session({ ...options, agentId: id, defaultConversation: true });
  }
}

/**
 * One-shot prompt convenience function.
 *
 * - Without agentId: uses default agent (like `letta -p`), new conversation
 * - With agentId: uses specific agent, new conversation
 *
 * @example
 * ```typescript
 * const result = await prompt('What is 2+2?');  // default agent
 * const result = await prompt('What is the capital of France?', agentId);  // specific agent
 * ```
 */
export async function prompt(
  message: string,
  agentId?: string
): Promise<SDKResultMessage> {
  // Use default agent behavior (like letta -p) when no agentId specified
  const session = agentId
    ? createSession(agentId)
    : createSession();

  try {
    await session.send(message);

    let result: SDKResultMessage | null = null;
    for await (const msg of session.stream()) {
      if (msg.type === "result") {
        result = msg;
        break;
      }
    }

    if (!result) {
      return {
        type: "result",
        success: false,
        error: "No result received",
        durationMs: 0,
        conversationId: session.conversationId,
      };
    }

    return result;
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
