import type { SDKStreamEventPayload } from "./types.js";

export type StreamTextKind = "assistant" | "reasoning";

export interface StreamTextDelta {
  kind: StreamTextKind;
  text: string;
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        pieces.push(part);
        continue;
      }
      if (!part || typeof part !== "object") {
        continue;
      }
      const rec = part as Record<string, unknown>;
      if (typeof rec.text === "string") {
        pieces.push(rec.text);
      }
    }
    const joined = pieces.join("");
    return joined.length > 0 ? joined : null;
  }

  if (content && typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") {
      return rec.text;
    }
  }

  return null;
}

/**
 * Extract appendable assistant/reasoning text from a stream_event payload.
 *
 * Supports both shapes currently emitted by headless mode:
 * 1) content_block style: { type, delta: { text|reasoning } }
 * 2) message chunk style: { message_type: "assistant_message"|"reasoning_message", ... }
 */
export function extractStreamTextDelta(event: SDKStreamEventPayload): StreamTextDelta | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const rec = event as Record<string, unknown>;

  const maybeDelta = rec.delta;
  if (maybeDelta && typeof maybeDelta === "object") {
    const delta = maybeDelta as Record<string, unknown>;

    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      return { kind: "reasoning", text: delta.reasoning };
    }

    if (typeof delta.text === "string" && delta.text.length > 0) {
      return { kind: "assistant", text: delta.text };
    }
  }

  const messageType = rec.message_type;
  if (messageType === "reasoning_message") {
    const reasoningText =
      typeof rec.reasoning === "string" ? rec.reasoning : extractTextFromContent(rec.content);
    if (reasoningText && reasoningText.length > 0) {
      return { kind: "reasoning", text: reasoningText };
    }
  }

  if (messageType === "assistant_message") {
    const assistantText = extractTextFromContent(rec.content);
    if (assistantText && assistantText.length > 0) {
      return { kind: "assistant", text: assistantText };
    }
  }

  return null;
}
