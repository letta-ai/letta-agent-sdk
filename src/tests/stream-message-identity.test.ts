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

function streamDelta(
  runtime: RuntimeScope,
  delta: Record<string, unknown>,
): ProtocolMessage {
  return { type: "stream_delta", runtime, delta };
}
