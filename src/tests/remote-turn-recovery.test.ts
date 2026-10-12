import { describe, expect, test } from "bun:test";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";
import type { SDKMessage } from "../types.js";

const runtime = { agent_id: null, conversation_id: "conv-worker" };

function createTurn() {
  const coordinator = new RemoteTurnCoordinator({
    label: "test",
    onDeviceStatus() {},
  });
  coordinator.trackSentTurn(runtime);
  const emit = (delta: Record<string, unknown>) =>
    coordinator.handleProtocolMessage(
      { type: "stream_delta", runtime, delta },
      runtime,
    );
  return { coordinator, emit };
}

async function drain(
  coordinator: RemoteTurnCoordinator,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for (;;) {
    const message = await coordinator.nextMessage();
    if (!message) return messages;
    messages.push(message);
    if (message.type === "result") coordinator.close();
  }
}

describe("worker run recovery", () => {
  test("keeps one worker alive across a failed run and a successful continuation", async () => {
    const { coordinator, emit } = createTurn();
    emit({
      message_type: "tool_return_message",
      run_id: "run-1",
      tool_call_id: "tool-1",
      tool_return: "already executed",
      status: "success",
    });
    emit({
      message_type: "loop_error",
      run_id: "run-1",
      is_terminal: false,
      message: "Producer lost",
      stop_reason: "error",
    });
    expect(coordinator.hasInFlightTurn()).toBe(true);
    emit({
      message_type: "error_message",
      run_id: "run-1",
      error_type: "internal_error",
      error_code: "RUN_STREAM_PRODUCER_LOST",
      retryable: false,
      message: "Producer lost",
    });
    expect(coordinator.hasInFlightTurn()).toBe(true);
    emit({
      message_type: "stop_reason",
      run_id: "run-1",
      stop_reason: "error",
    });
    emit({
      message_type: "retry",
      run_id: "run-1",
      attempt: 1,
      max_attempts: 3,
    });
    emit({
      message_type: "assistant_message",
      run_id: "run-2",
      content: "Recovered",
    });
    coordinator.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        turn_id: "turn-1",
        run_id: "run-2",
        stop_reason: "end_turn",
      },
      runtime,
    );
    const messages = await drain(coordinator);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(messages.filter((m) => m.type === "tool_result")).toHaveLength(1);
    expect(messages.filter((m) => m.type === "result")).toMatchObject([
      { success: true, result: "Recovered", runIds: ["run-1", "run-2"] },
    ]);
  });

  test.each(["error", "cancelled"])(
    "preserves the canonical %s outcome after a recoverable notice",
    async (stopReason) => {
      const { coordinator, emit } = createTurn();
      emit({
        message_type: "loop_error",
        run_id: "run-1",
        is_terminal: false,
        message: "Retrying",
      });
      expect(coordinator.hasInFlightTurn()).toBe(true);
      coordinator.handleProtocolMessage(
        {
          type: "turn_finished",
          runtime,
          turn_id: "turn-1",
          run_id: "run-1",
          stop_reason: stopReason,
          error: "Stopped",
        },
        runtime,
      );
      const results = (await drain(coordinator)).filter(
        (m) => m.type === "result",
      );
      expect(results).toMatchObject([{ success: false, stopReason }]);
    },
  );

  test.each([true, undefined])(
    "preserves terminal/legacy loop errors (%s)",
    async (isTerminal) => {
      const { coordinator, emit } = createTurn();
      emit({
        message_type: "loop_error",
        run_id: "run-1",
        is_terminal: isTerminal,
        message: "Unrecoverable",
        stop_reason: "error",
      });
      expect(coordinator.hasInFlightTurn()).toBe(false);
      expect(
        (await drain(coordinator)).filter((m) => m.type === "result"),
      ).toMatchObject([{ success: false }]);
    },
  );
});
