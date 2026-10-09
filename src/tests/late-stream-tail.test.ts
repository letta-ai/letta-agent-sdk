import { describe, expect, test } from "bun:test";
import type { ProtocolMessage, RuntimeScope } from "../remote-session-protocol.js";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";

const runtime: RuntimeScope = { agent_id: "agent-1", conversation_id: "conv-1" };

function streamDelta(delta: Record<string, unknown>): ProtocolMessage {
  return { type: "stream_delta", runtime, delta };
}

async function drain(coordinator: RemoteTurnCoordinator) {
  const out = [];
  for (;;) {
    const message = await coordinator.nextMessage();
    if (!message) return out;
    out.push(message);
    if (message.type === "result") return out;
  }
}

// Cloud sends turn_finished on the control socket and stream deltas on the
// stream socket, so the receipt can overtake the end of the reply.
describe("turn_finished that overtakes the stream", () => {
  test("keeps assistant text that streams after turn_finished", async () => {
    const coordinator = new RemoteTurnCoordinator({ label: "test", onDeviceStatus: () => {} });
    coordinator.trackSentTurn(runtime);
    const send = (m: ProtocolMessage) => coordinator.handleProtocolMessage(m, runtime);

    send(streamDelta({ message_type: "assistant_message", content: "Hello ", run_id: "run-1", id: "message-1" }));
    send({ type: "turn_finished", runtime, turn_id: "turn-1", run_id: "run-1", stop_reason: "end_turn" });
    send(streamDelta({ message_type: "assistant_message", content: "world.", run_id: "run-1", id: "message-1" }));
    send(streamDelta({ message_type: "stop_reason", stop_reason: "end_turn", run_id: "run-1" }));
    send(streamDelta({ message_type: "usage_statistics", total_tokens: 3 }));

    const messages = await drain(coordinator);
    const text = messages.filter((m) => m.type === "assistant").map((m) => (m as { content: string }).content).join("");
    expect(text).toBe("Hello world.");
    expect(messages.at(-1)).toMatchObject({ type: "result", success: true, result: "Hello world.", stopReason: "end_turn", runIds: ["run-1"] });
    coordinator.close();
  });

  test("keeps the reply when idle loop status also overtakes the stream", async () => {
    const coordinator = new RemoteTurnCoordinator({ label: "test", onDeviceStatus: () => {} });
    coordinator.trackSentTurn(runtime);
    const send = (m: ProtocolMessage) => coordinator.handleProtocolMessage(m, runtime);

    send(streamDelta({ message_type: "assistant_message", content: "Hello ", run_id: "run-1", id: "message-1" }));
    send({ type: "turn_finished", runtime, turn_id: "turn-1", run_id: "run-1", stop_reason: "end_turn" });
    send({ type: "update_loop_status", runtime, loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] } });
    send(streamDelta({ message_type: "assistant_message", content: "world.", run_id: "run-1", id: "message-1" }));
    send(streamDelta({ message_type: "stop_reason", stop_reason: "end_turn", run_id: "run-1" }));

    const messages = await drain(coordinator);
    expect(messages.at(-1)).toMatchObject({ type: "result", success: true, result: "Hello world." });
    coordinator.close();
  });

  test("still settles when the stream never sends its stop_reason", async () => {
    const coordinator = new RemoteTurnCoordinator({ label: "test", onDeviceStatus: () => {} });
    coordinator.trackSentTurn(runtime);
    const send = (m: ProtocolMessage) => coordinator.handleProtocolMessage(m, runtime);

    send(streamDelta({ message_type: "assistant_message", content: "partial", run_id: "run-1", id: "message-1" }));
    send({ type: "turn_finished", runtime, turn_id: "turn-1", run_id: "run-1", stop_reason: "end_turn" });

    const messages = await drain(coordinator);
    expect(messages.at(-1)).toMatchObject({ type: "result", success: true, result: "partial", runIds: ["run-1"] });
    coordinator.close();
  });

  test("does not attribute the next run's output to a turn waiting on its stream tail", async () => {
    const coordinator = new RemoteTurnCoordinator({ label: "test", onDeviceStatus: () => {} });
    coordinator.trackSentTurn(runtime);
    coordinator.trackSentTurn(runtime);
    const send = (m: ProtocolMessage) => coordinator.handleProtocolMessage(m, runtime);

    send(streamDelta({ message_type: "assistant_message", content: "first", run_id: "run-1", id: "message-1" }));
    send({ type: "turn_finished", runtime, turn_id: "turn-1", run_id: "run-1", stop_reason: "end_turn" });
    send(streamDelta({ message_type: "assistant_message", content: "second", run_id: "run-2", id: "message-2" }));
    send(streamDelta({ message_type: "stop_reason", stop_reason: "end_turn", run_id: "run-1" }));
    send({ type: "turn_finished", runtime, turn_id: "turn-2", run_id: "run-2", stop_reason: "end_turn" });

    const first = await drain(coordinator);
    expect(first.at(-1)).toMatchObject({ type: "result", result: "first", runIds: ["run-1"] });
    const second = await drain(coordinator);
    expect(second.at(-1)).toMatchObject({ type: "result", result: "second", runIds: ["run-2"] });
    coordinator.close();
  });
});
