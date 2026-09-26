import { describe, expect, test } from "bun:test";
import type { ProtocolMessage, RuntimeScope } from "../remote-session-protocol.js";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";

const runtime: RuntimeScope = {
  agent_id: "agent-test",
  conversation_id: "conv-test",
};

function coordinator(): RemoteTurnCoordinator {
  return new RemoteTurnCoordinator({ label: "test", onDeviceStatus() {} });
}

function assistant(runId: string): ProtocolMessage {
  return {
    type: "stream_delta",
    runtime,
    delta: { message_type: "assistant_message", content: "working", run_id: runId },
  } as ProtocolMessage;
}

function idle(activeRunIds: string[]): ProtocolMessage {
  return {
    type: "update_loop_status",
    runtime,
    loop_status: { status: "WAITING_ON_INPUT", active_run_ids: activeRunIds },
  } as ProtocolMessage;
}

function turnFinished(runId: string, stopReason: string): ProtocolMessage {
  return {
    type: "turn_finished",
    runtime,
    turn_id: `turn-${runId}`,
    run_id: runId,
    stop_reason: stopReason,
  } as ProtocolMessage;
}

/** Completes one turn through turn_finished, as letta-code 0.30.3+ does. */
async function completeTurnWithTurnFinished(turns: RemoteTurnCoordinator): Promise<void> {
  turns.trackSentTurn(runtime);
  turns.handleProtocolMessage(assistant("run-first"), runtime);
  turns.handleProtocolMessage(turnFinished("run-first", "end_turn"), runtime);
  expect(await turns.nextMessage()).toMatchObject({ type: "assistant" });
  expect(await turns.nextMessage()).toMatchObject({ type: "result", success: true });
}

async function drainAfterClose(turns: RemoteTurnCoordinator): Promise<unknown[]> {
  turns.close();
  const rest: unknown[] = [];
  for (let message = await turns.nextMessage(); message; message = await turns.nextMessage()) {
    rest.push(message);
  }
  return rest;
}

describe("idle loop status that still lists a run", () => {
  test("keeps the turn open until the run's turn_finished", async () => {
    const turns = coordinator();
    await completeTurnWithTurnFinished(turns);

    turns.trackSentTurn(runtime);
    turns.handleProtocolMessage(assistant("run-continued"), runtime);
    turns.handleProtocolMessage(idle(["run-continued"]), runtime);
    expect(await turns.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await turns.nextMessage()).toMatchObject({
      type: "loop_status",
      status: "WAITING_ON_INPUT",
      activeRunIds: ["run-continued"],
    });
    expect(turns.hasInFlightTurn()).toBe(true);

    turns.handleProtocolMessage(assistant("run-continued"), runtime);
    turns.handleProtocolMessage(turnFinished("run-continued", "end_turn"), runtime);
    expect(await turns.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await turns.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      stopReason: "end_turn",
      runIds: ["run-continued"],
    });
    expect(turns.hasInFlightTurn()).toBe(false);
    expect(await drainAfterClose(turns)).toEqual([]);
  });

  test("closes the turn on a later idle status with no runs", async () => {
    const turns = coordinator();
    await completeTurnWithTurnFinished(turns);

    turns.trackSentTurn(runtime);
    turns.handleProtocolMessage(assistant("run-continued"), runtime);
    turns.handleProtocolMessage(idle(["run-continued"]), runtime);
    turns.handleProtocolMessage(idle([]), runtime);
    expect(await turns.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await turns.nextMessage()).toMatchObject({ type: "loop_status" });
    expect(await turns.nextMessage()).toMatchObject({ type: "loop_status" });
    expect(await turns.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      runIds: ["run-continued"],
    });
    expect(await drainAfterClose(turns)).toEqual([]);
  });

  test("still ends the turn on a server that has not sent turn_finished", async () => {
    const turns = coordinator();
    turns.trackSentTurn(runtime);
    turns.handleProtocolMessage(assistant("run-legacy"), runtime);
    turns.handleProtocolMessage(idle(["run-legacy"]), runtime);
    expect(await turns.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await turns.nextMessage()).toMatchObject({ type: "loop_status" });
    expect(await turns.nextMessage()).toMatchObject({
      type: "result",
      success: true,
      runIds: ["run-legacy"],
    });
    expect(await drainAfterClose(turns)).toEqual([]);
  });

  test("still ends an aborted turn on idle", async () => {
    const turns = coordinator();
    await completeTurnWithTurnFinished(turns);

    turns.trackSentTurn(runtime);
    turns.handleProtocolMessage(assistant("run-aborted"), runtime);
    turns.markAbortRequested();
    turns.handleProtocolMessage(idle(["run-aborted"]), runtime);
    expect(await turns.nextMessage()).toMatchObject({ type: "assistant" });
    expect(await turns.nextMessage()).toMatchObject({ type: "loop_status" });
    expect(await turns.nextMessage()).toMatchObject({
      type: "result",
      success: false,
      stopReason: "interrupted",
    });

    // The cancelled turn_finished that trails the abort belongs to a settled run.
    turns.handleProtocolMessage(turnFinished("run-aborted", "cancelled"), runtime);
    expect(await drainAfterClose(turns)).toEqual([]);
  });
});
