import {
  applyBrowserEvent,
  type BrowserEvent,
} from "../lib/letta/browser-events";
import type { ChatMessage } from "../lib/letta/transcript";

function reduceEvents(events: BrowserEvent[]) {
  return events.reduce<ChatMessage>(applyBrowserEvent, {
    id: "assistant",
    role: "assistant",
    parts: [],
    complete: false,
  });
}

describe("live browser events", () => {
  it("preserves reasoning, text, tools, and later text in event order", () => {
    const message = reduceEvents([
      { type: "reasoning", content: "I should search." },
      { type: "assistant", content: "I will check. " },
      {
        type: "tool_call",
        id: "call-1",
        name: "web_search",
        input: {},
        inputFragment: '{"query":"Letta',
      },
      {
        type: "tool_call",
        id: "call-1",
        name: "web_search",
        input: { query: "Letta docs" },
        inputFragment: ' docs"}',
      },
      { type: "tool_result", id: "call-1", isError: false },
      { type: "assistant", content: "The title is Letta." },
      { type: "done" },
    ]);

    expect(message.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "tools",
      "text",
    ]);
    expect(message.parts[2]).toMatchObject({
      type: "tools",
      tools: [
        {
          name: "web_search",
          rawInput: '{"query":"Letta docs"}',
          status: "complete",
        },
      ],
    });
    expect(message.complete).toBe(true);
  });

  it("groups consecutive calls and settles missing results at done", () => {
    const message = reduceEvents([
      {
        type: "tool_call",
        id: "call-1",
        name: "fetch_webpage",
        input: { url: "https://docs.letta.com" },
        inputFragment: '{"url":"https://docs.letta.com"}',
      },
      {
        type: "tool_call",
        id: "call-2",
        name: "fetch_webpage",
        input: { url: "https://letta.com" },
        inputFragment: '{"url":"https://letta.com"}',
      },
      { type: "done" },
    ]);

    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({
      type: "tools",
      tools: [{ status: "complete" }, { status: "complete" }],
    });
  });
});
