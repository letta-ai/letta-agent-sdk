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
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 1,
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
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-usage",
        run_id: "run-usage",
        stop_reason: "end_turn",
      },
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

  test("leaves usage after a completed result unassigned", async () => {
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
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: 12 },
    });
    expect(coordinator.hasInFlightTurn()).toBe(false);
    coordinator.close();
  });

  test("does not apply late usage from a settled turn to its queued successor", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "first",
        run_id: "run-first-late-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-first-late-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-first-late-usage",
        run_id: "run-first-late-usage",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({ type: "result" });

    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "second",
        run_id: "run-second-late-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-second-late-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 111,
      }),
      runtime,
    );
    expect(coordinator.hasInFlightTurn()).toBe(true);
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-second-late-usage",
        run_id: "run-second-late-usage",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "second",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: 111 },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      result: "second",
      runIds: ["run-second-late-usage"],
    });
    coordinator.close();
  });

  test("preserves the queued successor's usage when the prior turn emits none", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "first",
        run_id: "run-first-no-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-first-no-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-first-no-usage",
        run_id: "run-first-no-usage",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({ type: "result" });

    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "second",
        run_id: "run-second-with-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-second-with-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 222,
      }),
      runtime,
    );
    expect(coordinator.hasInFlightTurn()).toBe(true);
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-second-with-usage",
        run_id: "run-second-with-usage",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "second",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: 222 },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      result: "second",
      runIds: ["run-second-with-usage"],
    });
    coordinator.close();
  });

  test("defers a queued successor arriving during the prior turn's usage grace", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "first",
        run_id: "run-first-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-first-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-first-grace",
        run_id: "run-first-grace",
        stop_reason: "end_turn",
      },
      runtime,
    );

    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "second",
        run_id: "run-second-during-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-second-during-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 222,
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-second-during-grace",
        run_id: "run-second-during-grace",
        stop_reason: "end_turn",
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "first",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      result: "first",
      runIds: ["run-first-grace"],
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "second",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: 222 },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      result: "second",
      runIds: ["run-second-during-grace"],
    });
    coordinator.close();
  });

  test("keeps global queue updates and trailing usage ahead of the result", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "finished",
        run_id: "run-queue-before-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-queue-before-usage",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-queue-before-usage",
        run_id: "run-queue-before-usage",
        stop_reason: "end_turn",
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "update_queue",
        runtime,
        queue: [],
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 12,
      }),
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "queue_update",
      queue: [],
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: 12 },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
    });
    coordinator.close();
  });

  test("keeps a canonical terminal successful when the transport closes during usage grace", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "finished",
        run_id: "run-close-during-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-close-during-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-close-during-grace",
        run_id: "run-close-during-grace",
        stop_reason: "end_turn",
      },
      runtime,
    );
    coordinator.closeWithError("socket closed");

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      result: "finished",
    });
    expect(await coordinator.nextMessage()).toBeNull();
  });

  test("defers successor errors and loop status during the prior turn's usage grace", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "first",
        run_id: "run-first-before-error",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-first-before-error",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-first-before-error",
        run_id: "run-first-before-error",
        stop_reason: "end_turn",
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "error_message",
        error: "second failed",
        run_id: "run-second-error",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "WAITING_ON_INPUT",
          active_run_ids: ["run-second-error"],
        },
      },
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      runIds: ["run-first-before-error"],
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "error",
      runId: "run-second-error",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: false,
      runIds: ["run-second-error"],
    });
    coordinator.close();
  });

  test("drains deferred canonical terminals before transport close", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.trackSentTurn(runtime);
    for (const [ordinal, runId] of [
      ["first", "run-first-before-close"],
      ["second", "run-second-before-close"],
    ] as const) {
      coordinator.handleProtocolMessage(
        streamDelta(runtime, {
          message_type: "assistant_message",
          content: ordinal,
          run_id: runId,
        }),
        runtime,
      );
      coordinator.handleProtocolMessage(
        streamDelta(runtime, {
          message_type: "stop_reason",
          stop_reason: "end_turn",
          run_id: runId,
        }),
        runtime,
      );
      coordinator.handleProtocolMessage(
        {
          type: "turn_finished",
          runtime,
          turn_id: `turn-${ordinal}-before-close`,
          run_id: runId,
          stop_reason: "end_turn",
        },
        runtime,
      );
    }
    coordinator.closeWithError("socket closed");

    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "first",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      runIds: ["run-first-before-close"],
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "assistant",
      content: "second",
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      runIds: ["run-second-before-close"],
    });
    expect(await coordinator.nextMessage()).toBeNull();
  });

  test("keeps same-turn loop status and usage ahead of the result", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "finished",
        run_id: "run-status-during-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-status-during-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-status-during-grace",
        run_id: "run-status-during-grace",
        stop_reason: "end_turn",
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "WAITING_ON_INPUT",
          active_run_ids: ["run-status-during-grace"],
        },
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 12,
      }),
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "loop_status",
      status: "WAITING_ON_INPUT",
      activeRunIds: ["run-status-during-grace"],
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: 12 },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
    });
    coordinator.close();
  });

  test("does not treat empty-run loop status as successor evidence", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "finished",
        run_id: "run-empty-status",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-empty-status",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-empty-status",
        run_id: "run-empty-status",
        stop_reason: "end_turn",
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "WAITING_ON_INPUT",
          active_run_ids: [],
        },
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 12,
      }),
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: 12 },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "loop_status",
      status: "WAITING_ON_INPUT",
      activeRunIds: [],
    });
    coordinator.close();
  });

  test("does not treat stream ping as successor evidence", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "assistant_message",
        content: "finished",
        run_id: "run-ping-during-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-ping-during-grace",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-ping-during-grace",
        run_id: "run-ping-during-grace",
        stop_reason: "end_turn",
      },
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, { message_type: "ping" }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "usage_statistics",
        total_tokens: 12,
      }),
      runtime,
    );

    expect(await coordinator.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: 12 },
    });
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      success: true,
    });
    coordinator.close();
  });

  test("activates a queued turn from its terminal receipt", async () => {
    const coordinator = new RemoteTurnCoordinator({
      label: "test",
      onDeviceStatus: () => {},
    });
    coordinator.trackSentTurn(runtime);
    coordinator.trackSentTurn(runtime);
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-first-terminal-only",
        run_id: "run-first-terminal-only",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      runIds: ["run-first-terminal-only"],
    });

    coordinator.handleProtocolMessage(
      streamDelta(runtime, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-second-terminal-only",
      }),
      runtime,
    );
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-second-terminal-only",
        run_id: "run-second-terminal-only",
        stop_reason: "end_turn",
      },
      runtime,
    );
    expect(await coordinator.nextMessage()).toMatchObject({
      type: "result",
      runIds: ["run-second-terminal-only"],
    });
    expect(coordinator.hasInFlightTurn()).toBe(false);
    coordinator.close();
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
