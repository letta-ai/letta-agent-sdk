// Thin wrapper around the SDK client: run one prompt to completion in an
// unrestricted session on an existing agent, capturing the full trajectory
// (every SDKMessage the stream emits).
//
// Sessions are scoped to their workspace by cwd and prompt; there is no OS
// sandbox on this path.

import type { LettaAgentClient } from "../client.js";
import type { SDKMessage } from "../types.js";

export interface RunAgentOptions {
  agentId: string;
  userPrompt: string;
  cwd: string;
  /** Progress label for logging. */
  label: string;
  onProgress?: (line: string) => void;
}

export interface RunAgentResult {
  agentId: string;
  conversationId: string | null;
  success: boolean;
  error?: string;
  /** Final assistant report (result.result when present, else last assistant message). */
  report: string;
  durationMs: number;
  messages: SDKMessage[];
}

export async function runAgentToCompletion(
  client: LettaAgentClient,
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const started = Date.now();
  const log = options.onProgress ?? (() => {});

  const session = client.createSession(options.agentId, {
    permissionMode: "unrestricted",
    cwd: options.cwd,
    dreaming: { trigger: "off" },
  });

  const messages: SDKMessage[] = [];
  let success = false;
  let error: string | undefined;
  let report = "";
  let lastAssistant = "";

  try {
    await session.send(options.userPrompt);
    for await (const msg of session.stream()) {
      messages.push(msg as SDKMessage);
      if (msg.type === "assistant") {
        lastAssistant = msg.content;
      } else if (msg.type === "tool_call") {
        log(`[${options.label}] tool: ${msg.toolName}`);
      } else if (msg.type === "error") {
        error = msg.message;
      } else if (msg.type === "result") {
        success = msg.success;
        report = msg.result ?? lastAssistant;
        if (!msg.success) error = error ?? msg.errorDetail ?? msg.error;
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    session.close();
  }

  return {
    agentId: options.agentId,
    conversationId: session.conversationId,
    success,
    error,
    report: report || lastAssistant,
    durationMs: Date.now() - started,
    messages,
  };
}
