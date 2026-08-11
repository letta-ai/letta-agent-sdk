import type { LettaConversationMessage } from "@letta-ai/letta-agent-sdk/client";
import { projectTranscript } from "../lib/letta/transcript";

function persistedMessages() {
  return [
    {
      id: "user-1",
      message_type: "user_message",
      content: [{ type: "text", text: "Research Letta." }],
    },
    {
      id: "reasoning-1",
      message_type: "reasoning_message",
      reasoning: "I should search.",
    },
    {
      id: "tool-1",
      message_type: "tool_call_message",
      tool_calls: {
        tool_call_id: "call-1",
        name: "web_search",
        arguments: '{"query":"Letta"}',
      },
    },
    {
      id: "reasoning-2",
      message_type: "reasoning_message",
      reasoning: "I found the source.",
    },
    {
      id: "assistant-1",
      message_type: "assistant_message",
      content: [{ type: "text", text: "Here is the answer." }],
    },
    // Persisted return order is not guaranteed to follow display order. The
    // first projector pass collects status before it constructs the transcript.
    {
      id: "return-1",
      message_type: "tool_return_message",
      tool_returns: [
        { tool_call_id: "call-1", status: "success", content: "private" },
      ],
    },
  ] as unknown as LettaConversationMessage[];
}

describe("persisted transcript projection", () => {
  it("restores the same ordered part model used by live events", () => {
    const transcript = projectTranscript(persistedMessages());
    expect(transcript).toHaveLength(2);
    expect(transcript[1].parts.map((part) => part.type)).toEqual([
      "reasoning",
      "tools",
      "reasoning",
      "text",
    ]);
    expect(transcript[1].parts[1]).toMatchObject({
      type: "tools",
      tools: [{ name: "web_search", status: "complete" }],
    });
    expect(JSON.stringify(transcript)).not.toContain("private");
  });
});
