import { describe, expect, test } from "bun:test";
import { normalizeSdkMessages } from "../dream/sdk-messages.js";
import type { SDKMessage } from "../types.js";

describe("normalizeSdkMessages", () => {
  test("coalesces streamed tool argument chunks into one logical call", () => {
    const messages: SDKMessage[] = [
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "Bash",
        toolInput: { raw: '{"command":"echo' },
        rawArguments: '{"command":"echo',
        uuid: "message-1",
      },
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "Bash",
        toolInput: { raw: ' hello"}' },
        rawArguments: ' hello"}',
        uuid: "message-1",
      },
      {
        type: "tool_result",
        toolCallId: "call-1",
        content: "hello",
        isError: false,
        uuid: "result-1",
      },
    ];

    const records = normalizeSdkMessages("run it", messages) ?? [];
    const calls = records.flatMap((record) => record.tool_calls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("Bash");
    expect(JSON.parse(calls[0]?.args ?? "{}")).toEqual({
      command: "echo hello",
    });
    expect(
      records.some(
        (record) =>
          record.role === "tool" && record.tool_call_id === calls[0]?.id,
      ),
    ).toBe(true);
  });

  test("redacts Letta API keys from captured trajectories", () => {
    const records = normalizeSdkMessages("inspect", [
      {
        type: "assistant",
        content: "checking environment",
        uuid: "assistant-1",
      },
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "Bash",
        toolInput: { command: "env" },
        rawArguments: '{"command":"env"}',
        uuid: "call-message-1",
      },
      {
        type: "tool_result",
        toolCallId: "call-1",
        content: "LETTA_API_KEY=sk-let-secret-value==",
        isError: false,
        uuid: "result-1",
      },
    ]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("sk-let-secret-value");
    expect(serialized).toContain("[REDACTED_LETTA_API_KEY]");
  });
});
