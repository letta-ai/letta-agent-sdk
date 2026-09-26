import { describe, expect, test } from "bun:test";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";
import type { ProtocolMessage, RuntimeScope } from "../remote-session-protocol.js";

const runtime: RuntimeScope = {
  agent_id: "agent-test",
  conversation_id: "conv-test",
};

function coordinator(): RemoteTurnCoordinator {
  return new RemoteTurnCoordinator({
    label: "test",
    onDeviceStatus() {},
  });
}

describe("turn_finished with no open turn", () => {
  test("surfaces a result for a run that outlived its turn", async () => {
    const turns = coordinator();
    turns.trackSentTurn(runtime);

    // The server reports idle while a run is still active, which closes the
    // SDK's turn, then finishes that run afterwards.
    turns.handleProtocolMessage(
      {
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "assistant_message",
          content: "working",
          run_id: "run-continued",
        },
      } as ProtocolMessage,
      runtime,
    );
    turns.handleProtocolMessage(
      {
        type: "update_loop_status",
        runtime,
        loop_status: { status: "WAITING_ON_INPUT", active_run_ids: ["run-continued"] },
      } as ProtocolMessage,
      runtime,
    );
    // assistant text, the idle loop status, then the result that closes the turn
    await turns.nextMessage();
    await turns.nextMessage();
    const closed = await turns.nextMessage();
    if (closed?.type !== "result") {
      throw new Error(`turn did not close on idle: ${closed?.type}`);
    }

    turns.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        run_id: "run-late",
        stop_reason: "end_turn",
      } as ProtocolMessage,
      runtime,
    );

    const result = await turns.nextMessage();
    expect(result).toMatchObject({
      type: "result",
      success: true,
      stopReason: "end_turn",
      conversationId: "conv-test",
      runIds: ["run-late"],
    });
  });

  test("does not surface a second result for a run the SDK already settled", async () => {
    const turns = coordinator();
    turns.trackSentTurn(runtime);
    turns.handleProtocolMessage(
      {
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "assistant_message",
          content: "done",
          run_id: "run-settled",
        },
      } as ProtocolMessage,
      runtime,
    );
    turns.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        run_id: "run-settled",
        stop_reason: "end_turn",
      } as ProtocolMessage,
      runtime,
    );
    await turns.nextMessage();
    const first = await turns.nextMessage();
    expect(first?.type).toBe("result");

    // The same run finishing again, now with no turn open, is a duplicate and
    // must not emit another result. nextMessage() would hang if it did not.
    turns.handleProtocolMessage(
      {
        type: "turn_finished",
        runtime,
        run_id: "run-settled",
        stop_reason: "end_turn",
      } as ProtocolMessage,
      runtime,
    );
    const duplicate = await Promise.race([
      turns.nextMessage().then(() => "emitted"),
      Promise.resolve("none"),
    ]);
    expect(duplicate).toBe("none");
  });
});
