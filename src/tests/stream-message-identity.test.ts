import { describe, expect, test } from "bun:test";
import type { WireMessage } from "../protocol.js";
import type { ProtocolMessage, RuntimeScope } from "../remote-session-protocol.js";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";
import { Session } from "../session.js";
import type { SDKMessage } from "../types.js";

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

  test("preserves OTIDs and replay cursors on legacy stdio text messages", async () => {
    const wireMessages = [
      textWireMessage("assistant_message", "assistant-uuid", {
        content: "answer",
        otid: "assistant-otid",
        seq_id: 71,
      }),
      textWireMessage("reasoning_message", "reasoning-uuid", {
        reasoning: "thought",
        otid: "reasoning-otid",
        seq_id: 72,
      }),
    ];
    const session = new Session({ agentId: "agent-1" });
    const transport = {
      async *messages() {
        yield* wireMessages;
      },
      async write() {},
    };
    (session as unknown as { transport: typeof transport }).transport = transport;

    await (
      session as unknown as { runBackgroundPump(): Promise<void> }
    ).runBackgroundPump();

    const queued = (
      session as unknown as { streamQueue: Array<{ message: SDKMessage }> }
    ).streamQueue.map((entry) => entry.message);
    expect(queued[0]).toMatchObject({
      type: "assistant",
      uuid: "assistant-uuid",
      otid: "assistant-otid",
      seqId: 71,
      runId: "run-stdio",
    });
    expect(queued[1]).toMatchObject({
      type: "reasoning",
      uuid: "reasoning-uuid",
      otid: "reasoning-otid",
      seqId: 72,
      runId: "run-stdio",
    });
  });
});

function streamDelta(
  runtime: RuntimeScope,
  delta: Record<string, unknown>,
): ProtocolMessage {
  return { type: "stream_delta", runtime, delta };
}

function textWireMessage(
  messageType: "assistant_message" | "reasoning_message",
  uuid: string,
  fields: Record<string, unknown>,
): WireMessage {
  return {
    type: "message",
    message_type: messageType,
    uuid,
    run_id: "run-stdio",
    ...fields,
  } as WireMessage;
}
