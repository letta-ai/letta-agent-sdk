// SDK stream messages (a completed session's trajectory) → normalized-v1,
// via the same row pipeline the harness sources use — so a recorded
// reflection-agent run is byte-compatible with normalized session
// transcripts.

import type { PseudoRow } from "./normalize-core.js";
import { normalizeSessionRows } from "./normalize-core.js";
import type { SDKMessage } from "../types.js";
import type { NormalizedRecord } from "./types.js";
import { redactSensitiveText } from "./redact.js";

/**
 * Convert a session's captured SDKMessages into normalized-v1 records, with
 * the run's user prompt as the leading user record. Returns null when the
 * messages contain no conversational content.
 */
/**
 * The cloud (api-backend) wire streams reasoning/assistant content as
 * per-token deltas that all share their logical message's id; stitch those
 * runs back into whole messages. Complete-message streams (local backend)
 * pass through unchanged, since consecutive distinct messages have distinct
 * ids.
 */
function coalesceStreamDeltas(messages: SDKMessage[]): SDKMessage[] {
  const coalesced: SDKMessage[] = [];
  const toolCallIndex = new Map<string, number>();
  for (const msg of messages) {
    const prev = coalesced[coalesced.length - 1];
    if (
      prev !== undefined &&
      (msg.type === "reasoning" || msg.type === "assistant") &&
      prev.type === msg.type &&
      prev.uuid === msg.uuid
    ) {
      prev.content += msg.content;
      continue;
    }
    if (msg.type === "tool_call") {
      const key = `${msg.runId ?? ""}:${msg.uuid}:${msg.toolCallId}`;
      const existingIndex = toolCallIndex.get(key);
      const chunk =
        msg.rawArguments ?? JSON.stringify(msg.toolInput ?? {});
      if (existingIndex !== undefined) {
        const existing = coalesced[existingIndex];
        if (existing?.type === "tool_call") {
          const raw = `${existing.rawArguments ?? ""}${chunk}`;
          let toolInput: Record<string, unknown> = { raw };
          try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              toolInput = parsed as Record<string, unknown>;
            }
          } catch {
            // Keep the accumulated raw arguments until the final chunk lands.
          }
          existing.rawArguments = raw;
          existing.toolInput = toolInput;
          if (existing.toolName === "?" && msg.toolName !== "?") {
            existing.toolName = msg.toolName;
          }
          continue;
        }
      }
      toolCallIndex.set(key, coalesced.length);
      coalesced.push({ ...msg, rawArguments: chunk });
      continue;
    }
    if (msg.type === "tool_result") {
      for (const key of toolCallIndex.keys()) {
        if (key.endsWith(`:${msg.toolCallId}`)) toolCallIndex.delete(key);
      }
    }
    coalesced.push(
      msg.type === "reasoning" || msg.type === "assistant"
        ? { ...msg }
        : msg,
    );
  }
  return coalesced;
}

export function normalizeSdkMessages(
  userPrompt: string,
  messages: SDKMessage[],
): NormalizedRecord[] | null {
  const rows: PseudoRow[] = [
    {
      role: "user",
      turnType: "user_prompt",
      content: redactSensitiveText(userPrompt),
      timestamp: null,
    },
  ];
  for (const msg of coalesceStreamDeltas(messages)) {
    switch (msg.type) {
      case "reasoning":
        if (msg.content) {
          rows.push({
            role: "assistant",
            turnType: "assistant_thinking",
            content: redactSensitiveText(msg.content),
            timestamp: null,
          });
        }
        break;
      case "assistant":
        if (msg.content) {
          rows.push({
            role: "assistant",
            turnType: "assistant_response",
            content: redactSensitiveText(msg.content),
            timestamp: null,
          });
        }
        break;
      case "tool_call":
        rows.push({
          role: "tool_use",
          turnType: "tool_use",
          timestamp: null,
          toolName: msg.toolName,
          toolCallId: msg.toolCallId,
          toolInputJson: redactSensitiveText(
            msg.rawArguments ?? JSON.stringify(msg.toolInput ?? {}),
          ),
        });
        break;
      case "tool_result": {
        const content =
          msg.isError && !/^error/i.test(msg.content)
            ? `Error: ${redactSensitiveText(msg.content)}`
            : redactSensitiveText(msg.content);
        rows.push({
          role: "tool_result",
          turnType: "tool_result",
          content,
          timestamp: null,
          toolCallId: msg.toolCallId,
        });
        break;
      }
      default:
        break; // init/result/error/retry carry no conversational content
    }
  }
  if (rows.length <= 1) return null;
  const result = normalizeSessionRows(rows, { source: "letta-agent-sdk" });
  return result.status === "ok" ? (result.records ?? null) : null;
}
