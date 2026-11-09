import { afterEach, describe, expect, test } from "bun:test";
import { LettaAgentClient, type AnyAgentTool, type SDKMessage } from "../index.js";
import { asAdvanced } from "./advanced-session.js";

type Listener = (event: unknown) => void;
type Command = Record<string, unknown>;

/** A minimal app server: answers requests and lets tests push server events. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static capabilities: Record<string, boolean> = {};
  readyState = 0;
  sent: Command[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  static all(): Command[] {
    return FakeSocket.instances.flatMap((socket) => socket.sent);
  }

  /** Server events go to the stream channel when the client opened one. */
  static push(message: unknown): void {
    const open = FakeSocket.instances.filter((socket) => socket.readyState === 1);
    const target = open.find((socket) => socket.url.includes("channel=stream")) ?? open.at(-1);
    target?.reply(message);
  }

  send(data: string): void {
    const command = JSON.parse(data) as Command;
    this.sent.push(command);
    const id = command.request_id;
    switch (command.type) {
      case "app_server_info":
        return this.reply({
          type: "app_server_info_response", request_id: id, success: true, backend: "local",
          letta_code_version: "test", protocol_version: 1,
          capabilities: {
            agent_management: true, conversation_management: true, memory_management: true,
            runtime_start: true, split_channels: false, ...FakeSocket.capabilities,
          },
        });
      case "runtime_start":
        return this.reply({
          type: "runtime_start_response", request_id: id, success: true,
          runtime: { agent_id: command.agent_id ?? "agent-1", conversation_id: command.conversation_id ?? "conv-new" },
          agent: { id: command.agent_id ?? "agent-1", model: "test/model" }, conversation: null,
          created: { agent: false, conversation: command.conversation_id === undefined },
        });
      case "conversation_retrieve":
        return this.reply({
          type: "conversation_retrieve_response", request_id: id, success: true,
          conversation: { id: command.conversation_id, agent_id: "agent-1" },
        });
      case "runtime_external_tools_update":
        return this.reply({ type: "runtime_external_tools_update_response", request_id: id, success: true });
    }
  }

  reply(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

const remote = () =>
  new LettaAgentClient({
    backend: "remote",
    url: "http://127.0.0.1:4500",
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    requestTimeoutMs: 2_000,
  });

const textTool = (name: string, text: (input: unknown) => string): AnyAgentTool => ({
  name,
  label: name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
  execute: async (_id, input) => ({ content: [{ type: "text", text: text(input) }] }),
});

const sentOfType = (type: string) => FakeSocket.all().filter((command) => command.type === type);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function pushTurn(runtime: Command, runId: string, text: string): void {
  FakeSocket.push({
    type: "stream_delta", runtime,
    delta: { id: `msg-${runId}`, message_type: "assistant_message", content: text, run_id: runId },
  });
  FakeSocket.push({
    type: "stream_delta", runtime,
    delta: { message_type: "stop_reason", stop_reason: "end_turn", run_id: runId },
  });
  FakeSocket.push({
    type: "stream_delta", runtime,
    delta: { message_type: "usage_statistics", prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  FakeSocket.push({ type: "turn_finished", runtime, run_id: runId, stop_reason: "end_turn" });
}

afterEach(() => {
  FakeSocket.instances = [];
  FakeSocket.capabilities = {};
});

describe("session tool policy", () => {
  test("runtime_start carries the session's tool selection on create and resume", async () => {
    const client = remote();
    const options = {
      allowedTools: ["Read", "lookup", "Read"],
      toolset: { base: "none" as const, include: ["Read"] },
      tools: [textTool("lookup", () => "ok")],
    };
    const created = client.createSession("agent-1", options);
    const resumed = client.resumeSession("agent-1", options);
    try {
      await asAdvanced(created).initialize();
      await asAdvanced(resumed).initialize();
      const starts = sentOfType("runtime_start");
      expect(starts).toHaveLength(2);
      for (const start of starts) {
        expect(start.tool_policy).toEqual({
          toolset: { base: "none", include: ["Read"] },
          allowlist: ["Read", "lookup"],
          exclude_interactive: true,
        });
      }
    } finally {
      created.close();
      resumed.close();
    }
  });

  test("per-message tool fields are dropped only when the listener applies the policy", async () => {
    const inputPayload = async (capable: boolean) => {
      FakeSocket.instances = [];
      FakeSocket.capabilities = capable ? { runtime_tool_policy: true } : {};
      const session = remote().resumeSession("agent-1", {
        allowedTools: ["Read"],
        toolset: { base: "none", include: ["Read"] },
      });
      try {
        await session.send("hi");
        return sentOfType("input")[0]!.payload as Command;
      } finally {
        session.close();
      }
    };

    const legacy = await inputPayload(false);
    expect(legacy.client_tool_allowlist).toEqual(["Read"]);
    expect(legacy.client_toolset).toEqual({ base: "none", include: ["Read"] });
    expect(legacy.exclude_interactive_tools).toBe(true);

    const current = await inputPayload(true);
    expect(current).not.toHaveProperty("client_tool_allowlist");
    expect(current).not.toHaveProperty("client_toolset");
    expect(current).not.toHaveProperty("exclude_interactive_tools");
  });
});

describe("runtime-started turns", () => {
  test("stream() yields a task-notification turn tagged with its origin, then the session's own turn", async () => {
    const session = remote().resumeSession("agent-1");
    const runtime = { agent_id: "agent-1", conversation_id: "default" };
    try {
      await asAdvanced(session).initialize();
      const seen: SDKMessage[] = [];
      const consumed = (async () => {
        for await (const message of session.stream()) seen.push(message);
      })();

      FakeSocket.push({
        type: "update_queue", runtime,
        queue: [{ id: "q-1", client_message_id: "cm-bg", kind: "task_notification", source: "task_notification", content: "done", enqueued_at: "" }],
      });
      FakeSocket.push({ type: "update_queue", runtime, queue: [], removed: [{ client_message_id: "cm-bg", disposition: "dequeued" }] });
      pushTurn(runtime, "run-bg", "background finished");
      // The result follows a short grace period for trailing usage.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const background = seen.find((message) => message.type === "result");
      expect(background).toMatchObject({
        type: "result", success: true, result: "background finished",
        origin: "task_notification", runIds: ["run-bg"],
      });

      await session.send("hello");
      pushTurn(runtime, "run-own", "hi there");
      await consumed;

      const results = seen.filter((message) => message.type === "result");
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({ success: true, result: "hi there", runIds: ["run-own"] });
      expect(results[1]).not.toHaveProperty("origin");
    } finally {
      session.close();
    }
  });
});

describe("client.registerTools", () => {
  test("registers tools for many conversations on one connection and dispatches by conversation", async () => {
    FakeSocket.capabilities = { runtime_tool_policy: true };
    const client = remote();
    const calls: string[] = [];
    const worker = (name: string) => textTool("submit", (input) => {
      calls.push(`${name}:${JSON.stringify(input)}`);
      return `submitted by ${name}`;
    });

    const first = await client.registerTools({
      conversations: ["conv-a"], tools: [worker("a")], allowedTools: ["Read", "submit"],
    });
    const second = await client.registerTools({ conversations: ["agent-2"], tools: [worker("b")] });
    expect(first.conversations).toEqual(["conv-a"]);
    await expect(client.registerTools({ conversations: ["conv-a"], tools: [] }))
      .rejects.toThrow("already registered for conv-a");

    const sockets = new Set(FakeSocket.instances.filter((socket) => !socket.url.includes("channel=stream")));
    expect(sockets.size).toBe(1);
    expect(sentOfType("runtime_external_tools_update").map((command) => command.updates)).toEqual([
      [{
        runtimes: [{ agent_id: "agent-1", conversation_id: "conv-a" }],
        external_tools: [{ tools: [expect.objectContaining({ name: "submit" })] }],
        tool_policy: { allowlist: ["Read", "submit"], exclude_interactive: true },
      }],
      [{
        runtimes: [{ agent_id: "agent-2", conversation_id: "default" }],
        external_tools: [{ tools: [expect.objectContaining({ name: "submit" })] }],
        tool_policy: { exclude_interactive: true },
      }],
    ]);

    const control = [...sockets][0]!;
    const callTool = async (requestId: string, runtime: Command) => {
      control.reply({
        type: "external_tool_call_request", request_id: requestId, runtime,
        tool_call_id: `call-${requestId}`, tool_name: "submit", input: { id: requestId },
      });
      await tick();
      return control.sent.find((command) => command.request_id === requestId);
    };
    expect(await callTool("r1", { agent_id: "agent-2", conversation_id: "default" })).toMatchObject({
      type: "external_tool_call_response", result: { content: [{ type: "text", text: "submitted by b" }] },
    });
    expect(await callTool("r2", { agent_id: "agent-1", conversation_id: "conv-a" })).toMatchObject({
      result: { content: [{ type: "text", text: "submitted by a" }] },
    });
    expect(await callTool("r3", { agent_id: "agent-9", conversation_id: "conv-z" })).toMatchObject({
      error: expect.stringContaining("conv-z"),
    });
    expect(calls).toEqual(['b:{"id":"r1"}', 'a:{"id":"r2"}']);

    await second.close();
    expect(sentOfType("runtime_external_tools_update").at(-1)!.updates).toEqual([
      { runtimes: [{ agent_id: "agent-2", conversation_id: "default" }], external_tools: [] },
    ]);
    await first.close();
    expect(control.readyState).toBe(3);
    await client.close();
  });

  test("publishes every registration again after the connection drops", async () => {
    FakeSocket.capabilities = { runtime_tool_policy: true };
    const client = remote();
    await client.registerTools({ conversations: ["conv-a"], tools: [textTool("submit", () => "a")] });
    await client.registerTools({ conversations: ["conv-b"], tools: [textTool("submit", () => "b")] });

    const before = FakeSocket.instances.length;
    for (const socket of [...FakeSocket.instances]) socket.close();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const fresh = FakeSocket.instances.slice(before).flatMap((socket) => socket.sent);
    const republished = fresh.filter((command) => command.type === "runtime_external_tools_update");
    expect(republished).toHaveLength(1);
    expect((republished[0]!.updates as Command[]).map((update) => update.runtimes)).toEqual([
      [{ agent_id: "agent-1", conversation_id: "conv-a" }],
      [{ agent_id: "agent-1", conversation_id: "conv-b" }],
    ]);
    await client.close();
  });

  test("rejects allowedTools when the listener cannot apply a tool policy", async () => {
    const client = remote();
    await expect(client.registerTools({
      conversations: ["conv-a"], tools: [], allowedTools: ["Read"],
    })).rejects.toThrow("runtime tool policies");
    await client.close();
  });
});
