// SDK stream messages (a completed session's trajectory) → normalized-v1,
// via the same row pipeline the harness sources use — so a recorded
// reflection-agent run is byte-compatible with normalized session
// transcripts.

import type { PseudoRow } from "./normalize-core.js";
import { normalizeSessionRows } from "./normalize-core.js";
import type { SDKMessage } from "../types.js";
import type { NormalizedRecord } from "./types.js";

/**
 * Convert a session's captured SDKMessages into normalized-v1 records, with
 * the run's user prompt as the leading user record. Returns null when the
 * messages contain no conversational content.
 */
export function normalizeSdkMessages(
  userPrompt: string,
  messages: SDKMessage[],
): NormalizedRecord[] | null {
  const rows: PseudoRow[] = [
    {
      role: "user",
      turnType: "user_prompt",
      content: userPrompt,
      timestamp: null,
    },
  ];
  for (const msg of messages) {
    switch (msg.type) {
      case "reasoning":
        if (msg.content) {
          rows.push({
            role: "assistant",
            turnType: "assistant_thinking",
            content: msg.content,
            timestamp: null,
          });
        }
        break;
      case "assistant":
        if (msg.content) {
          rows.push({
            role: "assistant",
            turnType: "assistant_response",
            content: msg.content,
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
          toolInputJson: JSON.stringify(msg.toolInput ?? {}),
        });
        break;
      case "tool_result": {
        const content =
          msg.isError && !/^error/i.test(msg.content)
            ? `Error: ${msg.content}`
            : msg.content;
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
