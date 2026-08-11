import type { ChatMessage, MessagePart, ToolState } from "./transcript";

// The server projects SDK events into this browser-safe protocol. Add a field
// here only when a visible component needs it.
export type BrowserEvent =
  | { type: "assistant"; content: string }
  | { type: "reasoning"; content: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: Record<string, unknown>;
      inputFragment: string;
    }
  | { type: "tool_result"; id: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "done" };

export async function* readBrowserEvents(response: Response) {
  if (!response.body) throw new Error("The response has no body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line) yield JSON.parse(line) as BrowserEvent;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer) as BrowserEvent;
}

function finishCurrentReasoning(parts: MessagePart[]) {
  const lastPart = parts.at(-1);
  return lastPart?.type === "reasoning" && !lastPart.complete
    ? [...parts.slice(0, -1), { ...lastPart, complete: true }]
    : parts;
}

function finishMessageParts(
  parts: MessagePart[],
  status: "complete" | "failed",
) {
  return parts.map((part) => {
    if (part.type === "reasoning") return { ...part, complete: true };
    if (part.type !== "tools") return part;
    return {
      ...part,
      tools: part.tools.map((tool) =>
        tool.status === "running" ? { ...tool, status } : tool,
      ),
    };
  });
}

// This pure reducer is the live counterpart to projectTranscript(). Both paths
// produce the same ordered MessagePart[] shape for React.
export function applyBrowserEvent(
  message: ChatMessage,
  event: BrowserEvent,
): ChatMessage {
  if (event.type === "assistant") {
    const parts = finishCurrentReasoning(message.parts);
    const lastPart = parts.at(-1);
    return {
      ...message,
      parts:
        lastPart?.type === "text"
          ? [
              ...parts.slice(0, -1),
              { ...lastPart, content: lastPart.content + event.content },
            ]
          : [...parts, { type: "text", content: event.content }],
    };
  }

  if (event.type === "reasoning") {
    const lastPart = message.parts.at(-1);
    return {
      ...message,
      parts:
        lastPart?.type === "reasoning" && !lastPart.complete
          ? [
              ...message.parts.slice(0, -1),
              { ...lastPart, content: lastPart.content + event.content },
            ]
          : [
              ...message.parts,
              { type: "reasoning", content: event.content, complete: false },
            ],
    };
  }

  if (event.type === "tool_call") {
    const parts = finishCurrentReasoning(message.parts);
    const hasTool = parts.some(
      (part) =>
        part.type === "tools" &&
        part.tools.some((tool) => tool.id === event.id),
    );

    if (hasTool) {
      return {
        ...message,
        parts: parts.map((part) =>
          part.type === "tools"
            ? {
                ...part,
                tools: part.tools.map((tool) =>
                  tool.id === event.id
                    ? {
                        ...tool,
                        name: event.name,
                        input: event.input,
                        rawInput: tool.rawInput + event.inputFragment,
                      }
                    : tool,
                ),
              }
            : part,
        ),
      };
    }

    const nextTool: ToolState = {
      id: event.id,
      name: event.name,
      input: event.input,
      rawInput: event.inputFragment,
      status: "running",
    };
    const lastPart = parts.at(-1);
    return {
      ...message,
      parts:
        lastPart?.type === "tools"
          ? [
              ...parts.slice(0, -1),
              { ...lastPart, tools: [...lastPart.tools, nextTool] },
            ]
          : [...parts, { type: "tools", tools: [nextTool] }],
    };
  }

  if (event.type === "tool_result") {
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.type === "tools"
          ? {
              ...part,
              tools: part.tools.map((tool) =>
                tool.id === event.id
                  ? {
                      ...tool,
                      status: event.isError ? "failed" : "complete",
                    }
                  : tool,
              ),
            }
          : part,
      ),
    };
  }

  if (event.type === "error") {
    return {
      ...message,
      complete: true,
      error: event.message,
      parts: finishMessageParts(message.parts, "failed"),
    };
  }

  if (event.type === "done") {
    return {
      ...message,
      complete: true,
      parts: finishMessageParts(message.parts, "complete"),
    };
  }

  return message;
}
