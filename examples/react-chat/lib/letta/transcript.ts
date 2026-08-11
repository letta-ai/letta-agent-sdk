import type { LettaConversationMessage } from "@letta-ai/letta-agent-sdk/client";

export type ToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  rawInput: string;
  status: "running" | "complete" | "failed";
};

export type MessagePart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string; complete: boolean }
  | { type: "tools"; tools: ToolState[] };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  complete: boolean;
  error?: string;
};

function textParts(content: unknown) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const { type, text } = part as { type?: unknown; text?: unknown };
    return (type === undefined || type === "text") && typeof text === "string"
      ? [text]
      : [];
  });
}

function userText(content: unknown) {
  return textParts(content)
    .filter((text) => {
      const normalized = text.trimStart();
      return !(
        normalized.startsWith(
          "<system-reminder>\nThis is an automated message providing context about the user's environment.",
        ) ||
        normalized.startsWith(
          "<system-reminder> This is an automated message providing information about you.",
        )
      );
    })
    .join("\n\n");
}

function parseToolInput(rawInput: string) {
  try {
    const value = JSON.parse(rawInput) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function persistedToolCalls(
  message: LettaConversationMessage,
  statuses: Map<string, "complete" | "failed">,
) {
  if (
    message.message_type !== "tool_call_message" &&
    message.message_type !== "approval_request_message"
  ) {
    return [];
  }

  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : message.tool_calls
      ? [message.tool_calls]
      : [message.tool_call];

  return calls.flatMap((call): ToolState[] => {
    const id = call.tool_call_id;
    const name = call.name;
    if (typeof id !== "string" || typeof name !== "string") return [];

    const rawInput = typeof call.arguments === "string" ? call.arguments : "";
    return [
      {
        id,
        name,
        input: parseToolInput(rawInput),
        rawInput,
        status: statuses.get(id) ?? "running",
      },
    ];
  });
}

function ensureAssistant(
  transcript: ChatMessage[],
  current: ChatMessage | undefined,
  sourceId: string,
) {
  if (current) return current;

  const assistant: ChatMessage = {
    id: `${sourceId}-assistant`,
    role: "assistant",
    parts: [],
    complete: true,
  };
  transcript.push(assistant);
  return assistant;
}

function appendText(message: ChatMessage, content: string) {
  if (!content) return;
  const lastPart = message.parts.at(-1);
  if (lastPart?.type === "text") {
    lastPart.content += content;
  } else {
    message.parts.push({ type: "text", content });
  }
}

function appendReasoning(message: ChatMessage, content: string) {
  if (!content) return;
  const lastPart = message.parts.at(-1);
  if (lastPart?.type === "reasoning") {
    lastPart.content += content;
  } else {
    message.parts.push({ type: "reasoning", content, complete: true });
  }
}

function appendTool(message: ChatMessage, tool: ToolState) {
  const duplicate = message.parts.some(
    (part) =>
      part.type === "tools" &&
      part.tools.some((existing) => existing.id === tool.id),
  );
  if (duplicate) return;

  const lastPart = message.parts.at(-1);
  if (lastPart?.type === "tools") {
    lastPart.tools.push(tool);
  } else {
    message.parts.push({ type: "tools", tools: [tool] });
  }
}

function recordToolStatus(
  statuses: Map<string, "complete" | "failed">,
  toolCallId: string,
  status: "complete" | "failed",
) {
  if (status === "failed" || !statuses.has(toolCallId)) {
    statuses.set(toolCallId, status);
  }
}

function collectToolStatuses(messages: LettaConversationMessage[]) {
  const statuses = new Map<string, "complete" | "failed">();

  for (const message of messages) {
    if (message.message_type === "tool_return_message") {
      const returns = message.tool_returns?.length
        ? message.tool_returns
        : [
            {
              tool_call_id: message.tool_call_id,
              status: message.status,
            },
          ];
      for (const result of returns) {
        if (typeof result.tool_call_id !== "string") continue;
        recordToolStatus(
          statuses,
          result.tool_call_id,
          result.status === "error" || message.is_err ? "failed" : "complete",
        );
      }
    }

    if (message.message_type === "approval_response_message") {
      for (const result of message.approvals ?? []) {
        if ("approve" in result) {
          if (!result.approve) {
            recordToolStatus(statuses, result.tool_call_id, "failed");
          }
        } else {
          recordToolStatus(
            statuses,
            result.tool_call_id,
            result.status === "error" ? "failed" : "complete",
          );
        }
      }
    }
  }

  return statuses;
}

function settleLatestTool(transcript: ChatMessage[]) {
  for (const message of [...transcript].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tools") continue;
      const tool = [...part.tools]
        .reverse()
        .find((candidate) => candidate.status === "running");
      if (tool) {
        tool.status = "failed";
        return;
      }
    }
  }
}

export function projectTranscript(messages: LettaConversationMessage[]) {
  const transcript: ChatMessage[] = [];
  const toolStatuses = collectToolStatuses(messages);
  let assistant: ChatMessage | undefined;

  for (const message of messages) {
    if (message.message_type === "user_message") {
      const content = userText(message.content);
      if (content) {
        transcript.push({
          id: message.id,
          role: "user",
          parts: [{ type: "text", content }],
          complete: true,
        });
        assistant = undefined;
      }
      continue;
    }

    if (message.message_type === "reasoning_message") {
      assistant = ensureAssistant(transcript, assistant, message.id);
      appendReasoning(assistant, message.reasoning);
      continue;
    }

    if (
      message.message_type === "tool_call_message" ||
      message.message_type === "approval_request_message"
    ) {
      assistant = ensureAssistant(transcript, assistant, message.id);
      for (const tool of persistedToolCalls(message, toolStatuses)) {
        appendTool(assistant, tool);
      }
      continue;
    }

    if (message.message_type === "tool_return_message") {
      continue;
    }

    if (message.message_type === "approval_response_message") {
      if (message.approve === false) settleLatestTool(transcript);
      continue;
    }

    if (message.message_type === "assistant_message") {
      const content = textParts(message.content).join("");
      if (content) {
        assistant = ensureAssistant(transcript, assistant, message.id);
        appendText(assistant, content);
      }
    }
  }

  return transcript;
}
