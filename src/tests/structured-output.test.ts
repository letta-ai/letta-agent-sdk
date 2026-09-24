import { expect, test } from "bun:test";
import {
  AppServerRuntimeController,
} from "../app-server-session.js";
import { RemoteTurnCoordinator } from "../remote-turn-coordinator.js";
import { createStructuredOutputTool, parseStructuredOutput } from "../structured-output.js";
import { streamStructuredTurns, resolveStructuredMode, registerStructuredOutputTool } from "../structured-output-session.js";
import type { SDKMessage } from "../types.js";

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

test("portable tool reports validation errors to the model and accepts a retry", async () => {
  const results: unknown[] = [];
  const tool = createStructuredOutputTool(outputFormat, (result) => results.push(result));
  const bad = await tool.execute("call-1", { bugs: [] });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]?.text).toContain("answer");
  const good = await tool.execute("call-2", { answer: "ok" });
  expect(good.isError).toBeUndefined();
  expect(results).toMatchObject([{ success: false }, { success: true, value: { answer: "ok" } }]);
});

test("StructuredOutput coexists with caller tools and an explicit allowlist", () => {
  const callerTool = {
    name: "Lookup", label: "Lookup", description: "Look up an item",
    parameters: { type: "object" },
    execute: async () => ({ content: [{ type: "text" as const, text: "found" }] }),
  };
  const mode = { kind: "agent-free" as const,
    options: { outputFormat, tools: [callerTool], allowedTools: ["Lookup"] } };
  registerStructuredOutputTool(mode, () => {});
  expect(mode.options.tools.map((tool) => tool.name)).toEqual(["Lookup", "StructuredOutput"]);
  expect(mode.options.allowedTools).toEqual(["Lookup", "StructuredOutput"]);
});

test("catalog capability selects native only for explicitly supported resolved model", async () => {
  const controller = { listModels: async () => ({ entries: [
    { id: "luna", handle: "openai/luna", supportsStructuredOutputs: true },
    { id: "sonnet", handle: "anthropic/sonnet", supportsStructuredOutputs: false },
  ] }) };
  expect(await resolveStructuredMode(controller as never, "openai/luna")).toBe("native");
  expect(await resolveStructuredMode(controller as never, "anthropic/sonnet")).toBe("portable");
  expect(await resolveStructuredMode(controller as never, "unknown")).toBe("portable");
});

test("a valid portable tool return ends the turn with the validated value", async () => {
  const messages: SDKMessage[] = [
    { type: "tool_result", toolCallId: "call-2", content: "accepted", isError: false, uuid: "tool-2" },
    { type: "result", success: false, errorCode: "interrupted", durationMs: 1,
      conversationId: "conv-1" },
  ];
  let aborted = 0;
  const emitted = [];
  for await (const message of streamStructuredTurns({
    nextMessage: async () => messages.shift() ?? null,
    send: async () => {}, abort: async () => { aborted++; },
    format: outputFormat, mode: () => "portable",
    accepted: () => ({ valid: true, value: { answer: "ok" }, detail: "", toolCallId: "call-2" }),
  })) emitted.push(message);
  expect(aborted).toBe(1);
  expect(emitted.at(-1)).toMatchObject({ success: true, structuredOutput: { answer: "ok" } });
});

test("missing portable calls get two corrective turns then a detailed failure", async () => {
  const sent: string[] = [];
  const messages: SDKMessage[] = Array.from({ length: 3 }, () => ({
    type: "result", success: true, durationMs: 1, conversationId: "conv-1",
  }));
  const stream = streamStructuredTurns({
    nextMessage: async () => messages.shift() ?? null,
    send: async (text) => { sent.push(String(text)); },
    abort: async () => {},
    format: outputFormat,
    mode: () => "portable",
    accepted: () => ({ valid: false, value: undefined, detail: "StructuredOutput was not called." }),
  });
  const emitted = [];
  for await (const message of stream) emitted.push(message);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain("Call StructuredOutput");
  expect(emitted.at(-1)).toMatchObject({ success: false, errorCode: "structured_output_error",
    errorDetail: expect.stringContaining("not called") });
});

test("native parse failure is corrected in the same conversation", async () => {
  const sent: string[] = [];
  const messages: SDKMessage[] = [
    { type: "result", success: false, errorCode: "structured_output_error",
      errorDetail: "not valid JSON", durationMs: 1, conversationId: "conv-1" },
    { type: "result", success: true, structuredOutput: { answer: "yes" },
      durationMs: 1, conversationId: "conv-1" },
  ];
  const emitted = [];
  for await (const message of streamStructuredTurns({
    nextMessage: async () => messages.shift() ?? null,
    send: async (text) => { sent.push(String(text)); },
    abort: async () => {}, format: outputFormat, mode: () => "native",
    accepted: () => ({ valid: false, value: undefined, detail: "" }),
  })) emitted.push(message);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("not valid JSON");
  expect(emitted.at(-1)).toMatchObject({ success: true, structuredOutput: { answer: "yes" } });
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
