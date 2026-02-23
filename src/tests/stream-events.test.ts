import { describe, expect, test } from "bun:test";
import { extractStreamTextDelta } from "../stream-events.js";

describe("extractStreamTextDelta", () => {
  test("extracts assistant delta from content_block_delta shape", () => {
    const out = extractStreamTextDelta({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    });

    expect(out).toEqual({ kind: "assistant", text: "hello" });
  });

  test("extracts reasoning delta from content_block_delta shape", () => {
    const out = extractStreamTextDelta({
      type: "content_block_delta",
      delta: { type: "reasoning_delta", reasoning: "think" },
    });

    expect(out).toEqual({ kind: "reasoning", text: "think" });
  });

  test("extracts reasoning from message_type chunk shape", () => {
    const out = extractStreamTextDelta({
      message_type: "reasoning_message",
      reasoning: "step by step",
    });

    expect(out).toEqual({ kind: "reasoning", text: "step by step" });
  });

  test("extracts assistant text from assistant_message string content", () => {
    const out = extractStreamTextDelta({
      message_type: "assistant_message",
      content: "final answer",
    });

    expect(out).toEqual({ kind: "assistant", text: "final answer" });
  });

  test("extracts assistant text from assistant_message content parts", () => {
    const out = extractStreamTextDelta({
      message_type: "assistant_message",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    });

    expect(out).toEqual({ kind: "assistant", text: "hello world" });
  });

  test("returns null for non-text stream events", () => {
    const out = extractStreamTextDelta({
      message_type: "tool_call_message",
      tool_call: { name: "Bash", arguments: "{}" },
    });

    expect(out).toBeNull();
  });

  test("returns null for unknown/empty shapes", () => {
    expect(extractStreamTextDelta({ type: "content_block_stop" })).toBeNull();
    expect(extractStreamTextDelta({})).toBeNull();
  });
});
