import { describe, expect, test } from "bun:test";
import type { ProtocolMessage, RuntimeScope } from "../remote-session-protocol.js";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";

describe("cooked stream message identity", () => {
  test("preserves distinct OTIDs and replay cursors on remote text slices sharing an id", async () => {
    const runtime: RuntimeScope = {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    };
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);

    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        id: "message-shared",
        otid: "message-shared-0",
        seq_id: 41,
        run_id: "run-1",
        message_type: "assistant_message",
        content: "answer",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        id: "message-shared",
        otid: "message-shared-1",
        seq_id: 42,
        run_id: "run-1",
        message_type: "reasoning_message",
        reasoning: "thought",
      }),
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      uuid: "message-shared",
      otid: "message-shared-0",
      seqId: 41,
      runId: "run-1",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "reasoning",
      uuid: "message-shared",
      otid: "message-shared-1",
      seqId: 42,
      runId: "run-1",
    });
    coordinator.close();
  });

  test("preserves raw arguments on app-server tool call deltas", async () => {
    const runtime: RuntimeScope = {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    };
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);

    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        id: "message-tool",
        run_id: "run-1",
        message_type: "tool_call_message",
        tool_call: {
          tool_call_id: "tool-1",
          name: "Bash",
          arguments: '{"command":"echo hi"}',
        },
      }),
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "tool_call",
      toolCallId: "tool-1",
      toolName: "Bash",
      toolInput: { command: "echo hi" },
      rawArguments: '{"command":"echo hi"}',
      runId: "run-1",
    });
    coordinator.close();
  });
});

describe("remote turn terminal receipts", () => {
  const runtime: RuntimeScope = {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  };

  test("uses a correlated turn_finished receipt as a successful terminal", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "done",
        run_id: "run-1",
        id: "message-1",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-1",
        run_id: "run-1",
        stop_reason: "end_turn",
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "done",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      result: "done",
      stopReason: "end_turn",
      runIds: ["run-1"],
    });
    coordinator.close();
  });

  test("accepts turn_finished as the first run evidence", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-receipt-only",
        run_id: "run-receipt-only",
        stop_reason: "end_turn",
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      runIds: ["run-receipt-only"],
    });
    coordinator.close();
  });

  test("classifies tool_rule as a successful terminal", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-tool-rule",
        run_id: "run-tool-rule",
        stop_reason: "tool_rule",
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      stopReason: "tool_rule",
      runIds: ["run-tool-rule"],
    });
    coordinator.close();
  });

  test("terminalizes a manual approval when turn_finished follows loop status", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      {
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "WAITING_ON_APPROVAL",
          active_run_ids: ["run-approval"],
        },
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-approval",
        run_id: "run-approval",
        stop_reason: "requires_approval",
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "loop_status",
      status: "WAITING_ON_APPROVAL",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: false,
      approvalConflict: true,
      stopReason: "requires_approval",
      runIds: ["run-approval"],
    });
    coordinator.close();
  });

  test("keeps an auto-handled approval open when turn_finished follows loop status", () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      autoHandlesToolApprovals: true,
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      {
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "WAITING_ON_APPROVAL",
          active_run_ids: ["run-approval"],
        },
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-approval",
        run_id: "run-approval",
        stop_reason: "requires_approval",
      },
      runtime,
    );

    expect(coordinator.hasInFlightTurn()).toBe(true);
    coordinator.close();
  });

  test("does not apply a settled run receipt to the next tracked turn", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "first",
        run_id: "run-1",
        id: "message-1",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-1",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-1",
        run_id: "run-1",
        stop_reason: "end_turn",
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 1,
      }),
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics" },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      runIds: ["run-1"],
    });

    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-1",
        run_id: "run-1",
        stop_reason: "end_turn",
      },
      runtime,
    );

    expect(coordinator.hasInFlightTurn()).toBe(true);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "second",
        run_id: "run-2",
        id: "message-2",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-2",
        run_id: "run-2",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "second",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      result: "second",
      runIds: ["run-2"],
    });
    coordinator.close();
  });

  test("keeps trailing usage ahead of the terminal result", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "done",
        run_id: "run-usage",
        id: "message-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-usage",
      }),
      runtime,
    );
    expect(coordinator.hasInFlightTurn()).toBe(true);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        step_count: 3,
      }),
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "done",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: {
        message_type: "usage_statistics",
        step_count: 3,
      },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      result: "done",
      runIds: ["run-usage"],
    });
    coordinator.close();
  });

  test("settles after turn_finished when trailing usage never arrives", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "done without usage",
        run_id: "run-no-usage",
        id: "message-no-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-no-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-no-usage",
        run_id: "run-no-usage",
        stop_reason: "end_turn",
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "done without usage",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      result: "done without usage",
      runIds: ["run-no-usage"],
    });
    expect(coordinator.hasInFlightTurn()).toBe(false);
    coordinator.close();
  });

  test("does not let the request timeout override a canonical terminal", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      requestTimeoutMs: 5,
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "finished",
        run_id: "run-short-timeout",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-short-timeout",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-short-timeout",
        run_id: "run-short-timeout",
        stop_reason: "end_turn",
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      result: "finished",
    });
    coordinator.close();
  });

  test("drops usage that arrives after the fallback result", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "finished",
        run_id: "run-late-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-late-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-late-usage",
        run_id: "run-late-usage",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({ type: "result" });

    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 12,
      }),
      runtime,
    );
    const next = coordinator.nextMessage();
    coordinator.close();
    expect(await next).toBeNull();
  });

  test("ignores a turn_finished receipt for a different active run", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "running",
        run_id: "run-1",
        id: "message-1",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        run_id: "run-other",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(coordinator.hasInFlightTurn()).toBe(true);
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        run_id: "run-1",
        stop_reason: "end_turn",
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      runIds: ["run-1"],
    });
    coordinator.close();
  });

  test("ignores an uncorrelated turn_finished without a run id", () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        stop_reason: "end_turn",
      },
      runtime,
    );

    expect(coordinator.hasInFlightTurn()).toBe(true);
    coordinator.close();
  });

  test("classifies terminal failure receipts as failed results", async () => {
    const stopReasons = [
      "invalid_llm_response",
      "invalid_tool_call",
      "max_tokens_exceeded",
      "no_tool_call",
      "insufficient_credits",
      "context_window_overflow_in_system_prompt",
    ];

    for (const stopReason of stopReasons) {
      const coordinator = new RemoteTurnCoordinator({
        label: "test",
        onDeviceStatus: () => {},
      });
      coordinator.trackSentTurn(runtime);
      coordinator.handleProtocolMessage(
        {
          type: "turn_finished",
          runtime,
          turn_id: `turn-${stopReason}`,
          run_id: `run-${stopReason}`,
          stop_reason: stopReason,
          error: "terminal failure",
        },
        runtime,
      );

      expect(await coordinator.nextMessage()).toMatchObject({
        type: "result",
        success: false,
        error: "terminal failure",
        errorCode: "error",
        errorDetail: "terminal failure",
        stopReason,
      });
      coordinator.close();
    }
  });

  test("reports active transport loss as a recoverable unknown outcome", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "partial",
        run_id: "run-1",
        id: "message-1",
      }),
      runtime,
    );
    coordinator.closeWithError("connection dropped");

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "error",
      errorCode: "stream_closed",
      recoverable: true,
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: false,
      errorCode: "stream_closed",
      recoverable: true,
      runIds: ["run-1"],
    });
  });
});

function streamDelta(
  runtime: RuntimeScope,
  delta: Record<string, unknown>,
): ProtocolMessage {
  return { type: "stream_delta", runtime, delta };
}
