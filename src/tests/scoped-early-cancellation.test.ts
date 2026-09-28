import { describe, expect, test } from "bun:test";
import type { ProtocolMessage, RuntimeScope } from "../remote-session-protocol.js";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";
import type { SDKMessage } from "../types.js";

const runtime: RuntimeScope = { agent_id: "agent-test", conversation_id: "conv-test" };
const delta = (message_type: string, fields = {}): ProtocolMessage => ({
  type: "stream_delta", runtime, delta: { message_type, ...fields },
});
const finished = (fields = {}): ProtocolMessage => ({
  type: "turn_finished", runtime, stop_reason: "cancelled", ...fields,
});
const idle: ProtocolMessage = {
  type: "update_loop_status", runtime,
  loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
};
function setup() {
  const turns = new RemoteTurnCoordinator({ label: "test", onDeviceStatus() {} });
  turns.trackSentTurn(runtime);
  return turns;
}
function send(turns: RemoteTurnCoordinator, ...messages: ProtocolMessage[]) {
  for (const message of messages) turns.handleProtocolMessage(message, runtime);
}
async function drain(turns: RemoteTurnCoordinator) {
  turns.close();
  const messages: SDKMessage[] = [];
  for (let message = await turns.nextMessage(); message; message = await turns.nextMessage()) {
    messages.push(message);
  }
  return messages;
}

describe("scoped early cancellation", () => {
  test("settles an explicitly aborted runless turn and isolates the immediate next turn", async () => {
    const turns = setup();
    turns.markAbortRequested();
    send(turns, idle, finished());
    expect(turns.hasInFlightTurn()).toBe(false);
    expect(await turns.nextMessage()).toMatchObject({ type: "loop_status" });
    expect(await turns.nextMessage()).toMatchObject({
      type: "result", success: false, stopReason: "cancelled", errorCode: "interrupted",
    });
    turns.trackSentTurn(runtime);
    send(turns, finished(), delta("status"), delta("user_message"), delta("ping"), idle);
    expect(turns.hasInFlightTurn()).toBe(true);
    send(turns, delta("assistant_message", { content: "next", run_id: "run-next" }),
      finished({ run_id: "run-next", stop_reason: "end_turn" }));
    const results = (await drain(turns)).filter((message) => message.type === "result");
    expect(results).toMatchObject([{ success: true, result: "next", runIds: ["run-next"] }]);
  });

  const guards: Array<[string, boolean, ProtocolMessage, ProtocolMessage?]> = [
    ["no explicit abort", false, finished()],
    ["missing runtime", true, finished({ runtime: undefined })],
    ["top-level scope only", true, finished({ runtime: undefined, ...runtime })],
    ["wrong agent", true, finished({ runtime: { ...runtime, agent_id: "agent-other" } })],
    ["wrong conversation", true, finished({ runtime: { ...runtime, conversation_id: "conv-other" } })],
    ["partial runtime", true, finished({ runtime: { agent_id: runtime.agent_id } })],
    ["runless success", true, finished({ stop_reason: "end_turn" })],
    ["runless failure", true, finished({ stop_reason: "error" })],
    ["known run", true, finished(), delta("assistant_message", { content: "working", run_id: "run-test" })],
    ["wrong run", true, finished({ run_id: "run-other" }), delta("assistant_message", { content: "working", run_id: "run-test" })],
  ];
  for (const [name, abort, terminal, evidence] of guards) {
    test(`rejects ${name}`, async () => {
      const turns = setup();
      if (evidence) send(turns, evidence);
      if (abort) turns.markAbortRequested();
      send(turns, terminal);
      expect(turns.hasInFlightTurn()).toBe(true);
      expect((await drain(turns)).filter((message) => message.type === "result")).toEqual([]);
    });
  }

  test("does not activate a queued turn from a runless receipt", async () => {
    const turns = setup();
    turns.trackSentTurn(runtime);
    send(turns, finished({ run_id: "run-first", stop_reason: "end_turn" }));
    turns.markAbortRequested(); // No active turn: the queued turn was not aborted.
    send(turns, finished());
    send(turns, delta("assistant_message", { content: "next", run_id: "run-next" }),
      finished({ run_id: "run-next", stop_reason: "end_turn" }));
    expect((await drain(turns)).filter((message) => message.type === "result"))
      .toMatchObject([{ success: true }, { success: true, result: "next" }]);
  });
});

describe("existing terminal and evidence behavior", () => {
  for (const usage of [true, false]) {
    test(`settles authoritative terminal with ${usage ? "preceding" : "no"} usage`, async () => {
      const turns = setup();
      send(turns, delta("assistant_message", { content: "done", run_id: "run-test" }));
      if (usage) send(turns, delta("usage_statistics", { total_tokens: 3, run_id: "run-test" }));
      send(turns, delta("stop_reason", { stop_reason: "end_turn", run_id: "run-test" }), idle,
        finished({ run_id: "run-test", stop_reason: "end_turn" }));
      await Bun.sleep(150); // Existing bounded trailing-usage grace must remain intact.
      expect(turns.hasInFlightTurn()).toBe(false);
      expect((await drain(turns)).filter((message) => message.type === "result"))
        .toMatchObject([{ success: true, result: "done", stopReason: "end_turn" }]);
    });
  }

  test("preserves trailing usage before the result", async () => {
    const turns = setup();
    send(turns, delta("stop_reason", { stop_reason: "end_turn", run_id: "run-test" }),
      finished({ run_id: "run-test", stop_reason: "end_turn" }),
      delta("usage_statistics", { total_tokens: 3, run_id: "run-test" }));
    expect((await drain(turns)).map((message) => message.type)).toEqual(["stream_event", "result"]);
  });

  test("cleanup alone cannot evidence-complete a turn, but legacy assistant plus idle can", async () => {
    const turns = setup();
    send(turns, delta("status", { run_id: "run-old" }), delta("user_message", { run_id: "run-old" }), delta("ping"), idle);
    expect(turns.hasInFlightTurn()).toBe(true);
    send(turns, delta("assistant_message", { content: "legacy", run_id: "run-next" }), idle);
    expect((await drain(turns)).filter((message) => message.type === "result"))
      .toMatchObject([{ success: true, result: "legacy", runIds: ["run-next"] }]);
  });

  test("callback-backed pending approval is not completed", async () => {
    const turns = new RemoteTurnCoordinator({ label: "test", autoHandlesToolApprovals: true, onDeviceStatus() {} });
    turns.trackSentTurn(runtime);
    send(turns, finished({ run_id: "run-test", stop_reason: "requires_approval" }), {
      type: "update_loop_status", runtime,
      loop_status: { status: "WAITING_ON_APPROVAL", active_run_ids: ["run-test"] },
    });
    expect(turns.hasInFlightTurn()).toBe(true);
    expect((await drain(turns)).filter((message) => message.type === "result")).toEqual([]);
  });

  for (const stopReason of ["error", "cancelled"]) {
    test(`${stopReason} with a known run cannot contaminate the immediate next turn`, async () => {
      const turns = setup();
      send(turns, finished({ run_id: "run-old", stop_reason: stopReason }));
      turns.trackSentTurn(runtime);
      send(turns, finished({ run_id: "run-old", stop_reason: stopReason }),
        delta("status", { run_id: "run-old" }), idle);
      expect(turns.hasInFlightTurn()).toBe(true);
      send(turns, delta("assistant_message", { content: "next", run_id: "run-next" }),
        finished({ run_id: "run-next", stop_reason: "end_turn" }));
      expect((await drain(turns)).filter((message) => message.type === "result"))
        .toMatchObject([{ success: false, stopReason }, { success: true, result: "next" }]);
    });
  }
});
