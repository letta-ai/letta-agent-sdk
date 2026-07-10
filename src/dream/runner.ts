// Thin wrapper around the SDK client: run one prompt to completion in an
// unrestricted session on an existing agent, capturing the full trajectory
// (every SDKMessage the stream emits).
//
// Sessions are scoped to their workspace by cwd and prompt; there is no OS
// sandbox on this path.

import type { LettaAgentClient } from "../client.js";
import type { SDKMessage, SkillSource } from "../types.js";

export interface RunAgentOptions {
  agentId: string;
  userPrompt: string;
  cwd: string;
  /** Progress label for logging. */
  label: string;
  /** Continue this existing conversation instead of starting a new one. */
  resumeConversationId?: string;
  /** Extra env for the session's harness process (see session options). */
  env?: Record<string, string>;
  /** Restrict Letta Code skills for this runtime. [] disables every source. */
  skillSources?: SkillSource[];
  /** Abort: closes the session and returns a failed result promptly. */
  signal?: AbortSignal;
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

  if (options.signal?.aborted) {
    return {
      agentId: options.agentId,
      conversationId: null,
      success: false,
      error: "aborted before start",
      report: "",
      durationMs: 0,
      messages: [],
    };
  }

  const sessionOptions = {
    permissionMode: "unrestricted" as const,
    cwd: options.cwd,
    dreaming: { trigger: "off" as const },
    ...(options.env ? { env: options.env } : {}),
    ...(options.skillSources !== undefined
      ? { skillSources: options.skillSources }
      : {}),
  };
  const session = options.resumeConversationId
    ? client.resumeSession(options.resumeConversationId, sessionOptions)
    : client.createSession(options.agentId, sessionOptions);

  const messages: SDKMessage[] = [];
  let success = false;
  let error: string | undefined;
  let report = "";
  let lastAssistant = "";

  // Abort mid-turn by closing the session: the stream ends and the normal
  // failure handling below reports the run as unsuccessful.
  const onAbort = () => {
    log(`[${options.label}] aborted; closing session`);
    session.close();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

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
    options.signal?.removeEventListener("abort", onAbort);
    session.close();
  }
  if (options.signal?.aborted) {
    success = false;
    error = error ?? "aborted";
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
