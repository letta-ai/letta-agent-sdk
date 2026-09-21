import { expect, test } from "bun:test";
import {
  AppServerRuntimeController,
  assertStructuredOutputsSupported,
} from "../app-server-session.js";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";
import { parseStructuredOutput } from "../structured-output.js";

const outputFormat = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
};

test("parses and validates structured output", () => {
  expect(parseStructuredOutput('{"answer":"ok"}', outputFormat)).toEqual({
    success: true,
    value: { answer: "ok" },
  });
  expect(parseStructuredOutput("{}", outputFormat)).toMatchObject({
    success: false,
  });
  expect(parseStructuredOutput('{"answer":42}', outputFormat)).toMatchObject({
    success: false,
  });
  expect(parseStructuredOutput("not json", outputFormat)).toMatchObject({
    success: false,
  });
});

test("a tool boundary prevents pre-tool JSON from becoming the final output", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
  const coordinator = new RemoteTurnCoordinator({
    label: "test",
    onDeviceStatus() {},
  });
  coordinator.trackSentTurn(runtime, undefined, outputFormat);
  coordinator.handleProtocolMessage({
    type: "stream_delta",
    runtime,
    delta: {
      id: "assistant-before-tool",
      message_type: "assistant_message",
      content: '{"answer":"stale"}',
      run_id: "run-1",
    },
  }, runtime);
  coordinator.handleProtocolMessage({
    type: "stream_delta",
    runtime,
    delta: {
      id: "tool-1",
      message_type: "tool_call_message",
      tool_calls: [{ tool_call_id: "call-1", name: "Read", arguments: "{}" }],
      run_id: "run-1",
    },
  }, runtime);
  coordinator.handleProtocolMessage({
    type: "turn_finished",
    runtime,
    run_id: "run-1",
    stop_reason: "end_turn",
  }, runtime);

  let result;
  while (result?.type !== "result") result = await coordinator.nextMessage();
  expect(result).toMatchObject({
    success: false,
    errorCode: "structured_output_error",
  });
});

test("validates the final assistant response after a tool continuation", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
  const coordinator = new RemoteTurnCoordinator({
    label: "test",
    onDeviceStatus() {},
  });
  coordinator.trackSentTurn(runtime, undefined, outputFormat);
  for (const delta of [
    {
      id: "assistant-reused",
      message_type: "assistant_message",
      content: "Calling a tool",
      run_id: "run-1",
    },
    {
      id: "tool-1",
      message_type: "tool_call_message",
      tool_calls: [{ tool_call_id: "call-1", name: "Read", arguments: "{}" }],
      run_id: "run-1",
    },
    {
      id: "assistant-reused",
      message_type: "assistant_message",
      content: '{"answer":"after tool"}',
      run_id: "run-1",
    },
  ]) {
    coordinator.handleProtocolMessage({ type: "stream_delta", runtime, delta }, runtime);
  }
  coordinator.handleProtocolMessage({
    type: "turn_finished",
    runtime,
    run_id: "run-1",
    stop_reason: "end_turn",
  }, runtime);

  let result;
  while (result?.type !== "result") result = await coordinator.nextMessage();
  expect(result).toMatchObject({
    success: true,
    structuredOutput: { answer: "after tool" },
  });
});

test("rejects harnesses that do not advertise structured outputs", async () => {
  const client = {
    async info() {
      return { capabilities: { structured_outputs: false } };
    },
  };
  await expect(
    assertStructuredOutputsSupported(client as never, { outputFormat }),
  ).rejects.toThrow("does not support outputFormat");
});

test("translates outputFormat to the app-server response_format wire contract", () => {
  const sent: unknown[] = [];
  const client = {
    input(command: unknown) {
      sent.push(command);
    },
  };
  const controller = new AppServerRuntimeController(client as never, {}, undefined, undefined);
  controller.sendTurnMessage(
    { agent_id: null, conversation_id: "conv-agent-free" },
    "hello",
    { clientMessageId: "cm-1", outputFormat },
  );
  expect(sent[0]).toMatchObject({
    runtime: { agent_id: null, conversation_id: "conv-agent-free" },
    payload: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response_schema",
          schema: outputFormat.schema,
          strict: true,
        },
      },
    },
  });
});
