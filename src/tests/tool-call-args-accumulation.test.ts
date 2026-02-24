import { describe, expect, mock, test } from "bun:test";
import { Session } from "../session.js";
import type { WireMessage } from "../types.js";

type FakeTransport = {
  messages: () => AsyncGenerator<WireMessage>;
  write: (msg: unknown) => Promise<void>;
};

function makeFakeTransport(messages: WireMessage[]) {
  const writes: unknown[] = [];
  const transport: FakeTransport = {
    async *messages() {
      for (const msg of messages) {
        yield msg;
      }
    },
    async write(msg: unknown) {
      writes.push(msg);
    },
  };
  return { transport, writes };
}

function toolChunk(
  toolCallId: string,
  args: string,
  uuid: string,
  messageType: "tool_call_message" | "approval_request_message" = "tool_call_message"
): WireMessage {
  return {
    type: "message",
    message_type: messageType,
    uuid,
    tool_call: {
      name: "Bash",
      arguments: args,
      tool_call_id: toolCallId,
    },
  } as unknown as WireMessage;
}

function indexedToolChunk(
  index: number,
  args: string,
  uuid: string,
  opts: {
    toolCallId?: string;
    toolName?: string;
    messageType?: "tool_call_message" | "approval_request_message";
  } = {}
): WireMessage {
  const toolCall: Record<string, unknown> = {
    name: opts.toolName ?? "Bash",
    arguments: args,
    index,
  };

  if (opts.toolCallId) {
    toolCall.tool_call_id = opts.toolCallId;
  }

  return {
    type: "message",
    message_type: opts.messageType ?? "tool_call_message",
    uuid,
    tool_calls: [toolCall],
  } as unknown as WireMessage;
}

function nestedFunctionChunk(
  index: number,
  args: string,
  uuid: string,
  opts: {
    toolCallId?: string;
    toolId?: string;
    toolName?: string;
    messageType?: "tool_call_message" | "approval_request_message";
  } = {}
): WireMessage {
  const toolCall: Record<string, unknown> = {
    index,
    function: {
      name: opts.toolName ?? "Bash",
      arguments: args,
    },
  };

  if (opts.toolCallId) {
    toolCall.tool_call_id = opts.toolCallId;
  }
  if (opts.toolId) {
    toolCall.id = opts.toolId;
  }

  return {
    type: "message",
    message_type: opts.messageType ?? "tool_call_message",
    uuid,
    tool_calls: [toolCall],
  } as unknown as WireMessage;
}

function reasoningChunk(uuid: string, text = "done"): WireMessage {
  return {
    type: "message",
    message_type: "reasoning_message",
    uuid,
    reasoning: text,
  } as unknown as WireMessage;
}

function queuedMessages(session: Session) {
  return ((session as unknown as { streamQueue: unknown[] }).streamQueue ??
    []) as Array<Record<string, unknown>>;
}

describe("tool call streaming passthrough", () => {
  test("emits each chunk immediately with rawArguments", async () => {
    const { transport } = makeFakeTransport([
      toolChunk("tc-1", '{"command":"echo', "msg-1"),
      toolChunk("tc-1", ' hi"}', "msg-1"),
      reasoningChunk("msg-2"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsgs = msgs.filter((m) => m.type === "tool_call");

    // Both chunks should be emitted individually (no buffering)
    expect(toolMsgs.length).toBe(2);

    // First chunk has partial args
    expect(toolMsgs[0]?.toolCallId).toBe("tc-1");
    expect(toolMsgs[0]?.rawArguments).toBe('{"command":"echo');

    // Second chunk has the continuation
    expect(toolMsgs[1]?.toolCallId).toBe("tc-1");
    expect(toolMsgs[1]?.rawArguments).toBe(' hi"}');

    // Reasoning message also present
    expect(msgs.some((m) => m.type === "reasoning")).toBe(true);
  });

  test("emits single complete chunk with parsed toolInput", async () => {
    const { transport } = makeFakeTransport([
      toolChunk("tc-2", '{"command":"echo hi"}', "msg-3"),
      reasoningChunk("msg-4"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsg = msgs.find((m) => m.type === "tool_call");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolInput).toEqual({ command: "echo hi" });
    expect(toolMsg?.rawArguments).toBe('{"command":"echo hi"}');
  });

  test("resolves index-only continuation chunks to correct toolCallId", async () => {
    const { transport } = makeFakeTransport([
      indexedToolChunk(0, '{"command":"echo', "msg-5", { toolCallId: "tc-3" }),
      indexedToolChunk(0, ' hi"}', "msg-5"),
      reasoningChunk("msg-6"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsgs = msgs.filter((m) => m.type === "tool_call");

    // Both chunks emitted, both resolved to same toolCallId
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0]?.toolCallId).toBe("tc-3");
    expect(toolMsgs[1]?.toolCallId).toBe("tc-3");
  });

  test("resolves nested OpenAI function chunks with id + index continuation", async () => {
    const { transport } = makeFakeTransport([
      nestedFunctionChunk(1, '{"command":"echo', "msg-7", {
        toolCallId: "tc-4",
        toolName: "Bash",
      }),
      nestedFunctionChunk(1, ' hi"}', "msg-7", {
        toolName: "Bash",
      }),
      reasoningChunk("msg-8"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsgs = msgs.filter((m) => m.type === "tool_call");

    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0]?.toolCallId).toBe("tc-4");
    expect(toolMsgs[0]?.toolName).toBe("Bash");
    expect(toolMsgs[1]?.toolCallId).toBe("tc-4");
  });

  test("resolves nested OpenAI function chunks keyed by id field", async () => {
    const { transport } = makeFakeTransport([
      nestedFunctionChunk(2, '{"query":"hello', "msg-9", {
        toolId: "call_abc123",
        toolName: "web_search",
      }),
      nestedFunctionChunk(2, ' world"}', "msg-9", {
        toolName: "web_search",
      }),
      reasoningChunk("msg-10"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsgs = msgs.filter((m) => m.type === "tool_call");

    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0]?.toolCallId).toBe("call_abc123");
    expect(toolMsgs[0]?.toolName).toBe("web_search");
    expect(toolMsgs[1]?.toolCallId).toBe("call_abc123");
  });

  test("parallel tool calls emit independently with correct IDs", async () => {
    const { transport } = makeFakeTransport([
      // Tool A: first chunk
      indexedToolChunk(0, '{"command":"ls"}', "msg-11", { toolCallId: "tc-A" }),
      // Tool B: first chunk
      indexedToolChunk(1, '{"query":"test"}', "msg-11", { toolCallId: "tc-B", toolName: "web_search" }),
      // Tool A: second chunk
      indexedToolChunk(0, '', "msg-11"),
      reasoningChunk("msg-12"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsgs = msgs.filter((m) => m.type === "tool_call");

    // 3 tool_call chunks emitted (2 for A, 1 for B)
    expect(toolMsgs.length).toBe(3);
    expect(toolMsgs[0]?.toolCallId).toBe("tc-A");
    expect(toolMsgs[1]?.toolCallId).toBe("tc-B");
    expect(toolMsgs[2]?.toolCallId).toBe("tc-A"); // continuation via index
  });
});
