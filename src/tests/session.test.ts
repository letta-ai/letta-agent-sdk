import { describe, expect, test } from "bun:test";
import { Session } from "../session.js";
import type { MessageWire, SDKMessage, WireMessage } from "../types.js";

const BUFFER_LIMIT = 100;

class MockTransport {
  writes: unknown[] = [];
  private queue: WireMessage[] = [];
  private resolvers: Array<(msg: WireMessage | null) => void> = [];
  private closed = false;

  async connect(): Promise<void> {
    return;
  }

  async write(msg: unknown): Promise<void> {
    this.writes.push(msg);
  }

  async *messages(): AsyncGenerator<WireMessage> {
    while (true) {
      const msg = await this.read();
      if (msg === null) {
        return;
      }
      yield msg;
    }
  }

  push(msg: WireMessage): void {
    if (this.closed) {
      return;
    }
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  close(): void {
    this.end();
  }

  end(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const resolve of this.resolvers) {
      resolve(null);
    }
    this.resolvers = [];
  }

  private async read(): Promise<WireMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (this.closed) {
      return null;
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

function attachMockTransport(session: Session, transport: MockTransport): void {
  (session as unknown as { transport: MockTransport }).transport = transport;
}

function createInitMessage(
  overrides: Record<string, unknown> = {},
): WireMessage {
  return {
    type: "system",
    subtype: "init",
    agent_id: "agent-1",
    session_id: "session-1",
    conversation_id: "conversation-1",
    model: "claude-sonnet-4",
    tools: ["Bash"],
    ...overrides,
  } as WireMessage;
}

function createAssistantMessage(index: number): WireMessage {
  return {
    type: "message",
    message_type: "assistant_message",
    uuid: `assistant-${index}`,
    content: `msg-${index}`,
  } as WireMessage;
}

function createApprovalRequestMessage(
  index: number,
  toolCall: {
    name: string;
    arguments: string;
    tool_call_id: string;
  },
): MessageWire {
  return {
    type: "message",
    session_id: "session-1",
    message_type: "approval_request_message",
    id: `message-approval-${index}`,
    date: "2026-01-01T00:00:00.000000+00:00",
    uuid: `approval-${index}`,
    tool_call: toolCall,
    tool_calls: [toolCall],
  };
}

function createResultMessage(
  overrides: Partial<{
    subtype: string;
    result: string | null;
    duration_ms: number;
    conversation_id: string;
    stop_reason: string;
    run_ids: unknown[];
  }> = {},
): WireMessage {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    duration_ms: 1,
    conversation_id: "conversation-1",
    stop_reason: "end_turn",
    ...overrides,
  } as WireMessage;
}

function createErrorWireMessage(): WireMessage {
  return {
    type: "error",
    session_id: "session-1",
    uuid: "error-1",
    message: "Rate limit exceeded",
    stop_reason: "llm_api_error",
    run_id: "run-1",
    api_error: {
      error_type: "llm_api_error",
      message: "429 from upstream provider",
      message_type: "error_message",
      run_id: "run-1",
    },
  } as WireMessage;
}

function createRetryWireMessage(): WireMessage {
  return {
    type: "retry",
    session_id: "session-1",
    uuid: "retry-1",
    reason: "llm_api_error",
    attempt: 2,
    max_attempts: 4,
    delay_ms: 1500,
    run_id: "run-1",
  } as WireMessage;
}

function createCanUseToolRequest(
  requestId: string,
  toolName: string,
  input: Record<string, unknown>,
): WireMessage {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      tool_call_id: `${requestId}-tool-call`,
      input,
      permission_suggestions: [],
      blocked_path: null,
    },
  } as WireMessage;
}

function findControlResponseByRequestId(
  writes: unknown[],
  requestId: string,
): Record<string, unknown> | undefined {
  return writes.find((msg) => {
    const payload = msg as { type?: string; response?: { request_id?: string } };
    return payload.type === "control_response" && payload.response?.request_id === requestId;
  }) as Record<string, unknown> | undefined;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("Session", () => {
  test("initialize returns optional init settings when provided by CLI", async () => {
    const session = new Session();
    const transport = new MockTransport();
    attachMockTransport(session, transport);

    try {
      transport.push(
        createInitMessage({
          memfs_enabled: true,
          skill_sources: ["project", "agent"],
          system_info_reminder_enabled: false,
          reflection_trigger: "step-count",
          reflection_behavior: "reminder",
          reflection_step_count: 9,
        }),
      );

      const init = await session.initialize();
      expect(init.memfsEnabled).toBe(true);
      expect(init.skillSources).toEqual(["project", "agent"]);
      expect(init.systemInfoReminderEnabled).toBe(false);
      expect(init.sleeptime).toEqual({
        trigger: "step-count",
        behavior: "reminder",
        stepCount: 9,
      });
    } finally {
      session.close();
    }
  });

  describe("handleCanUseTool with bypassPermissions", () => {
    async function invokeCanUseTool(
      session: Session,
      tool_name: string,
      input: Record<string, unknown>,
    ): Promise<unknown> {
      // @ts-expect-error - accessing private method for testing
      const handleCanUseTool = session.handleCanUseTool.bind(session);

      let capturedResponse: unknown;
      // @ts-expect-error - accessing private property for testing
      session.transport.write = async (msg: unknown) => {
        capturedResponse = msg;
      };

      await handleCanUseTool("test-request-id", {
        subtype: "can_use_tool",
        tool_name,
        tool_call_id: "test-tool-call-id",
        input,
        permission_suggestions: [],
        blocked_path: null,
      });

      return capturedResponse;
    }

    test("auto-approves tools when permissionMode is bypassPermissions", async () => {
      // Create a session with bypassPermissions
      const session = new Session({
        permissionMode: "bypassPermissions",
      });

      const capturedResponse = await invokeCanUseTool(session, "Bash", {
        command: "ls",
      });

      // Verify the response auto-approves
      expect(capturedResponse).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-request-id",
          response: {
            behavior: "allow",
            updatedInput: null,
            updatedPermissions: [],
          },
        },
      });
    });

    test("denies tools by default when no callback and not bypassPermissions", async () => {
      // Create a session with default permission mode
      const session = new Session({
        permissionMode: "default",
      });

      const capturedResponse = await invokeCanUseTool(session, "Bash", {
        command: "ls",
      });

      // Verify the response denies (no callback registered)
      expect(capturedResponse).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-request-id",
          response: {
            behavior: "deny",
            message: "No canUseTool callback registered",
            interrupt: false,
          },
        },
      });
    });

    test("auto-allows EnterPlanMode without callback", async () => {
      const session = new Session({
        permissionMode: "default",
      });

      const capturedResponse = await invokeCanUseTool(
        session,
        "EnterPlanMode",
        {},
      );

      expect(capturedResponse).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-request-id",
          response: {
            behavior: "allow",
            updatedInput: null,
            updatedPermissions: [],
          },
        },
      });
    });

    test("denies AskUserQuestion without callback even in bypassPermissions", async () => {
      const session = new Session({
        permissionMode: "bypassPermissions",
      });

      const capturedResponse = await invokeCanUseTool(
        session,
        "AskUserQuestion",
        {
          questions: [],
        },
      );

      expect(capturedResponse).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-request-id",
          response: {
            behavior: "deny",
            message: "No canUseTool callback registered",
            interrupt: false,
          },
        },
      });
    });

    test("uses canUseTool callback when provided and not bypassPermissions", async () => {
      const session = new Session({
        permissionMode: "default",
        canUseTool: async (toolName) => {
          if (toolName === "Bash") {
            return { behavior: "allow" };
          }
          return { behavior: "deny", message: "Tool not allowed" };
        },
      });

      const capturedResponse = await invokeCanUseTool(session, "Bash", {
        command: "ls",
      });

      // Verify callback was used and allowed
      expect(capturedResponse).toMatchObject({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-request-id",
          response: {
            behavior: "allow",
          },
        },
      });
    });
  });

  describe("transformMessage tool-call mapping", () => {
    test("maps approval_request_message to SDK tool_call message", () => {
      const session = new Session();
      const wireMsg = createApprovalRequestMessage(1, {
        name: "Bash",
        arguments: JSON.stringify({ command: "pwd" }),
        tool_call_id: "call-approval-1",
      });

      // @ts-expect-error - accessing private method for regression coverage
      const transformed = session.transformMessage(wireMsg) as SDKMessage | null;

      expect(transformed).toEqual({
        type: "tool_call",
        toolCallId: "call-approval-1",
        toolName: "Bash",
        toolInput: { command: "pwd" },
        rawArguments: JSON.stringify({ command: "pwd" }),
        uuid: "approval-1",
      });
    });

    test("falls back to raw tool arguments when approval_request_message args are not JSON", () => {
      const session = new Session();
      const wireMsg = createApprovalRequestMessage(2, {
        name: "Read",
        arguments: "path=/tmp/foo.txt",
        tool_call_id: "call-approval-2",
      });

      // @ts-expect-error - accessing private method for regression coverage
      const transformed = session.transformMessage(wireMsg) as SDKMessage | null;

      expect(transformed).toEqual({
        type: "tool_call",
        toolCallId: "call-approval-2",
        toolName: "Read",
        toolInput: { raw: "path=/tmp/foo.txt" },
        rawArguments: "path=/tmp/foo.txt",
        uuid: "approval-2",
      });
    });
  });

  describe("transformMessage result mapping", () => {
    test("maps result wire message run_ids to SDK runIds", () => {
      const session = new Session();
      const wireMsg = createResultMessage({
        run_ids: ["run-1", "run-2"],
      });

      // @ts-expect-error - accessing private method for regression coverage
      const transformed = session.transformMessage(wireMsg) as SDKMessage | null;

      expect(transformed).toEqual({
        type: "result",
        success: true,
        result: "done",
        error: undefined,
        stopReason: "end_turn",
        durationMs: 1,
        totalCostUsd: undefined,
        conversationId: "conversation-1",
        runIds: ["run-1", "run-2"],
      });
    });

    test("filters non-string run_ids and preserves valid values", () => {
      const session = new Session();
      const wireMsg = createResultMessage({
        run_ids: ["run-1", 42, null, "run-2"],
      });

      // @ts-expect-error - accessing private method for regression coverage
      const transformed = session.transformMessage(wireMsg) as SDKMessage | null;

      expect(transformed).toMatchObject({
        type: "result",
        runIds: ["run-1", "run-2"],
      });
    });
  });

  describe("transformMessage error/retry mapping", () => {
    test("maps error wire message to SDK error message", () => {
      const session = new Session();
      const wireMsg = createErrorWireMessage();

      // @ts-expect-error - accessing private method for regression coverage
      const transformed = session.transformMessage(wireMsg) as SDKMessage | null;

      expect(transformed).toEqual({
        type: "error",
        message: "Rate limit exceeded",
        stopReason: "llm_api_error",
        runId: "run-1",
        apiError: {
          error_type: "llm_api_error",
          message: "429 from upstream provider",
          message_type: "error_message",
          run_id: "run-1",
        },
      });
    });

    test("maps retry wire message to SDK retry message", () => {
      const session = new Session();
      const wireMsg = createRetryWireMessage();

      // @ts-expect-error - accessing private method for regression coverage
      const transformed = session.transformMessage(wireMsg) as SDKMessage | null;

      expect(transformed).toEqual({
        type: "retry",
        reason: "llm_api_error",
        attempt: 2,
        maxAttempts: 4,
        delayMs: 1500,
        runId: "run-1",
      });
    });
  });

  describe("background pump parity", () => {
    test("handles can_use_tool control requests before stream iteration starts", async () => {
      let callbackInvocations = 0;
      const session = new Session({
        permissionMode: "default",
        canUseTool: () => {
          callbackInvocations += 1;
          return { behavior: "allow" };
        },
      });
      const transport = new MockTransport();
      attachMockTransport(session, transport);

      try {
        transport.push(createInitMessage());
        await session.initialize();

        transport.push(
          createCanUseToolRequest("pre-stream-approval", "Bash", {
            command: "pwd",
          }),
        );

        await waitFor(() =>
          findControlResponseByRequestId(
            transport.writes,
            "pre-stream-approval",
          ) !== undefined,
        );

        expect(callbackInvocations).toBe(1);
        expect(
          findControlResponseByRequestId(
            transport.writes,
            "pre-stream-approval",
          ),
        ).toMatchObject({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "pre-stream-approval",
            response: {
              behavior: "allow",
            },
          },
        });
      } finally {
        session.close();
      }
    });

    test("bounds buffered stream messages and drops oldest deterministically", async () => {
      const session = new Session({
        permissionMode: "default",
      });
      const transport = new MockTransport();
      attachMockTransport(session, transport);

      const assistantCount = BUFFER_LIMIT + 20;

      try {
        transport.push(createInitMessage());
        await session.initialize();

        for (let i = 1; i <= assistantCount; i++) {
          transport.push(createAssistantMessage(i));
        }
        transport.push(createResultMessage());
        transport.push(
          createCanUseToolRequest("post-result-marker", "EnterPlanMode", {}),
        );

        await waitFor(() =>
          findControlResponseByRequestId(
            transport.writes,
            "post-result-marker",
          ) !== undefined,
        );

        const streamed: SDKMessage[] = [];
        for await (const msg of session.stream()) {
          streamed.push(msg);
        }

        const assistants = streamed.filter(
          (msg): msg is Extract<SDKMessage, { type: "assistant" }> =>
            msg.type === "assistant",
        );

        const expectedAssistantCount = BUFFER_LIMIT - 1;
        const expectedFirstAssistantIndex =
          assistantCount - expectedAssistantCount + 1;

        expect(assistants.length).toBe(expectedAssistantCount);
        expect(assistants[0]?.content).toBe(
          `msg-${expectedFirstAssistantIndex}`,
        );
        expect(assistants[assistants.length - 1]?.content).toBe(
          `msg-${assistantCount}`,
        );
        expect(streamed[streamed.length - 1]?.type).toBe("result");
      } finally {
        session.close();
      }
    });

    test("emits error and retry messages instead of dropping them", async () => {
      const session = new Session({
        permissionMode: "default",
      });
      const transport = new MockTransport();
      attachMockTransport(session, transport);

      try {
        transport.push(createInitMessage());
        await session.initialize();

        transport.push(createErrorWireMessage());
        transport.push(createRetryWireMessage());
        transport.push(createResultMessage());

        const streamed: SDKMessage[] = [];
        for await (const msg of session.stream()) {
          streamed.push(msg);
        }

        expect(streamed.some((msg) => msg.type === "error")).toBe(true);
        expect(streamed.some((msg) => msg.type === "retry")).toBe(true);
        expect(streamed[streamed.length - 1]?.type).toBe("result");
      } finally {
        session.close();
      }
    });
  });

  describe("generation-based stale message filtering", () => {
    test("filters stale messages enqueued before the current send()", async () => {
      const session = new Session();
      const transport = new MockTransport();
      attachMockTransport(session, transport);

      try {
        transport.push(createInitMessage());
        await session.initialize();

        // First send + stream (establishes generation 1)
        transport.push(createAssistantMessage(1));
        transport.push(createResultMessage({ result: "first" }));
        await session.send("first message");

        const firstMessages: SDKMessage[] = [];
        for await (const msg of session.stream()) {
          firstMessages.push(msg);
        }
        expect(firstMessages).toHaveLength(2);

        // Simulate a stale message arriving (pump pushes it before next send clears queue).
        // We inject it directly into the streamQueue with the OLD generation.
        const staleMsg = { type: "assistant" as const, content: "stale", uuid: "stale-1", _generation: 1 };
        // @ts-expect-error - accessing private field to simulate pump race
        session.streamQueue.push(staleMsg);

        // Second send (advances generation to 2, clears queue first)
        transport.push(createAssistantMessage(2));
        transport.push(createResultMessage({ result: "second" }));
        await session.send("second message");

        // But inject ANOTHER stale message after send() clears -- simulating
        // the pump pushing during the await in send().
        const raceStalMsg = { type: "assistant" as const, content: "race-stale", uuid: "stale-2" };
        // @ts-expect-error - accessing private field
        (raceStalMsg as unknown as { _generation: number })._generation = 1;
        // @ts-expect-error - accessing private field
        session.streamQueue.unshift(raceStalMsg);

        const secondMessages: SDKMessage[] = [];
        for await (const msg of session.stream()) {
          secondMessages.push(msg);
        }

        // The stale message should be filtered -- only fresh messages from gen 2
        expect(secondMessages).toHaveLength(2);
        expect((secondMessages[0] as { content: string }).content).toBe("msg-2");
        expect(secondMessages[1].type).toBe("result");
      } finally {
        session.close();
      }
    });
  });

  describe("transformMessage run_id pass-through", () => {
    test("includes runId on assistant messages", () => {
      const session = new Session();
      const wireMsg = {
        type: "message",
        message_type: "assistant_message",
        uuid: "a-1",
        content: "hello",
        run_id: "run-abc",
      } as WireMessage;

      // @ts-expect-error - accessing private method
      const transformed = session.transformMessage(wireMsg);
      expect(transformed).toMatchObject({
        type: "assistant",
        content: "hello",
        runId: "run-abc",
      });
    });

    test("includes runId on tool_call messages", () => {
      const session = new Session();
      const wireMsg = {
        type: "message",
        message_type: "tool_call_message",
        uuid: "tc-1",
        run_id: "run-abc",
        tool_calls: [{
          tool_call_id: "call-1",
          name: "Edit",
          arguments: "{}",
        }],
      } as WireMessage;

      // @ts-expect-error - accessing private method
      const transformed = session.transformMessage(wireMsg);
      expect(transformed).toMatchObject({
        type: "tool_call",
        toolName: "Edit",
        runId: "run-abc",
      });
    });

    test("includes runId on reasoning messages", () => {
      const session = new Session();
      const wireMsg = {
        type: "message",
        message_type: "reasoning_message",
        uuid: "r-1",
        reasoning: "thinking...",
        run_id: "run-abc",
      } as WireMessage;

      // @ts-expect-error - accessing private method
      const transformed = session.transformMessage(wireMsg);
      expect(transformed).toMatchObject({
        type: "reasoning",
        content: "thinking...",
        runId: "run-abc",
      });
    });

    test("includes runId on tool_result messages", () => {
      const session = new Session();
      const wireMsg = {
        type: "message",
        message_type: "tool_return_message",
        uuid: "tr-1",
        tool_call_id: "call-1",
        tool_return: "success",
        status: "success",
        run_id: "run-abc",
      } as WireMessage;

      // @ts-expect-error - accessing private method
      const transformed = session.transformMessage(wireMsg);
      expect(transformed).toMatchObject({
        type: "tool_result",
        runId: "run-abc",
      });
    });

    test("runId is undefined when wire message lacks run_id", () => {
      const session = new Session();
      const wireMsg = {
        type: "message",
        message_type: "assistant_message",
        uuid: "a-2",
        content: "no run id",
      } as WireMessage;

      // @ts-expect-error - accessing private method
      const transformed = session.transformMessage(wireMsg);
      expect(transformed).toMatchObject({ type: "assistant" });
      expect((transformed as { runId?: string }).runId).toBeUndefined();
    });
  });
});
