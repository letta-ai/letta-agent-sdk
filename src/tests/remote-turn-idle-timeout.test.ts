import { describe, expect, test } from "bun:test";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";
import type { SDKMessage } from "../types.js";

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
const TIMEOUT_MS = 60;

function createTurn() {
  const coordinator = new RemoteTurnCoordinator({
    label: "test",
    requestTimeoutMs: TIMEOUT_MS,
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

async function nextResultOrError(
  coordinator: RemoteTurnCoordinator,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for (;;) {
    const message = await coordinator.nextMessage();
    if (!message) return messages;
    messages.push(message);
    if (message.type === "result") return messages;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("turn timeout", () => {
  test("does not fail a turn that keeps streaming past requestTimeoutMs", async () => {
    const { coordinator, emit } = createTurn();
    // Stream for ~4x the timeout, never idling longer than half of it.
    for (let index = 0; index < 8; index++) {
      emit({
        message_type: "reasoning_message",
        run_id: "run-1",
        otid: `reasoning-${index}`,
        reasoning: `step ${index}`,
      });
      await wait(TIMEOUT_MS / 2);
    }
    emit({ message_type: "assistant_message", run_id: "run-1", content: "Done" });
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

    const messages = await nextResultOrError(coordinator);
    expect(messages.filter((message) => message.type === "error")).toEqual([]);
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      success: true,
      result: "Done",
    });
    coordinator.close();
  });

  test("still fails a turn with no events for requestTimeoutMs", async () => {
    const { coordinator, emit } = createTurn();
    emit({
      message_type: "reasoning_message",
      run_id: "run-1",
      otid: "reasoning-0",
      reasoning: "thinking",
    });

    const messages = await nextResultOrError(coordinator);
    expect(messages.find((message) => message.type === "error")).toMatchObject({
      type: "error",
      message: "Timed out waiting for test turn",
    });
    expect(messages.at(-1)).toMatchObject({ type: "result", success: false });
    coordinator.close();
  });
});
