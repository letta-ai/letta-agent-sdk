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

function canUseToolRequest(requestId: string): WireMessage {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "echo hi" },
    },
  } as unknown as WireMessage;
}

function queuedMessages(session: Session) {
  return ((session as unknown as { streamQueue: unknown[] }).streamQueue ??
    []) as Array<Record<string, unknown>>;
}

describe("tool call argument accumulation", () => {
  test("accumulates delta chunks and parses final tool input", async () => {
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
    const toolMsg = msgs.find((m) => m.type === "tool_call");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolInput).toEqual({ command: "echo hi" });
  });

  test("flushes pending tool call before control_request callback runs", async () => {
    const queueSizesSeenByCallback: number[] = [];

    const canUseTool = mock(() => {
      queueSizesSeenByCallback.push(
        queuedMessages(session).filter((m) => m.type === "tool_call").length
      );
      return {
        behavior: "allow" as const,
        updatedInput: null,
        updatedPermissions: [],
      };
    });

    const { transport, writes } = makeFakeTransport([
      toolChunk("tc-2", '{"command":"echo', "msg-3"),
      toolChunk("tc-2", ' hi"}', "msg-3"),
      canUseToolRequest("can-use-1"),
      reasoningChunk("msg-4"),
    ]);

    const session = new Session({
      agentId: "agent-test",
      canUseTool,
    });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(queueSizesSeenByCallback[0]).toBe(1);
    expect(
      writes.some((w) => {
        const wire = w as {
          type?: string;
          response?: { request_id?: string; subtype?: string };
        };
        return (
          wire.type === "control_response" &&
          wire.response?.request_id === "can-use-1" &&
          wire.response?.subtype === "success"
        );
      })
    ).toBe(true);
  });

  test("handles cumulative chunks without duplicating prior arguments", async () => {
    const { transport } = makeFakeTransport([
      toolChunk("tc-3", '{"command":"ec', "msg-5"),
      toolChunk("tc-3", '{"command":"echo hi"}', "msg-5"),
      reasoningChunk("msg-6"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsg = msgs.find((m) => m.type === "tool_call");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolInput).toEqual({ command: "echo hi" });
  });

  test("accumulates index-only continuation chunks after first id-bearing chunk", async () => {
    const { transport } = makeFakeTransport([
      indexedToolChunk(0, '{"command":"echo', "msg-7", { toolCallId: "tc-4" }),
      indexedToolChunk(0, ' hi"}', "msg-7"),
      reasoningChunk("msg-8"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsg = msgs.find((m) => m.type === "tool_call");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolCallId).toBe("tc-4");
    expect(toolMsg?.toolInput).toEqual({ command: "echo hi" });
  });

  test("handles nested OpenAI function chunks with tool_call_id + index continuation", async () => {
    const { transport } = makeFakeTransport([
      nestedFunctionChunk(1, '{"command":"echo', "msg-9", {
        toolCallId: "tc-5",
        toolName: "Bash",
      }),
      nestedFunctionChunk(1, ' hi"}', "msg-9", {
        toolName: "Bash",
      }),
      reasoningChunk("msg-10"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsg = msgs.find((m) => m.type === "tool_call");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolCallId).toBe("tc-5");
    expect(toolMsg?.toolName).toBe("Bash");
    expect(toolMsg?.toolInput).toEqual({ command: "echo hi" });
  });

  test("handles nested OpenAI function chunks keyed by id + index continuation", async () => {
    const { transport } = makeFakeTransport([
      nestedFunctionChunk(2, '{"query":"hello', "msg-11", {
        toolId: "call_abc123",
        toolName: "web_search",
      }),
      nestedFunctionChunk(2, ' world"}', "msg-11", {
        toolName: "web_search",
      }),
      reasoningChunk("msg-12"),
    ]);

    const session = new Session({ agentId: "agent-test" });
    (session as unknown as { transport: FakeTransport }).transport = transport;

    await (session as unknown as { runBackgroundPump: () => Promise<void> })
      .runBackgroundPump();

    const msgs = queuedMessages(session);
    const toolMsg = msgs.find((m) => m.type === "tool_call");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolCallId).toBe("call_abc123");
    expect(toolMsg?.toolName).toBe("web_search");
    expect(toolMsg?.toolInput).toEqual({ query: "hello world" });
  });
});
