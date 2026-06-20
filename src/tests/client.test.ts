import { describe, expect, test } from "bun:test";
import { LettaCodeClient, Session } from "../index.js";
import { asAdvanced } from "./advanced-session.js";

type Listener = (event: unknown) => void;
type FetchInput = Parameters<typeof fetch>[0];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createFetchMock(
  handler: (input: FetchInput | URL, init?: RequestInit) => Response,
): typeof fetch {
  return ((input: FetchInput | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init))) as typeof fetch;
}

function urlOf(input: FetchInput | URL): string {
  return input instanceof URL ? input.toString() : String(input);
}

class FakeAppServerSocket {
  static instances: FakeAppServerSocket[] = [];
  static mirrorStreamToControl = false;
  static reportedAgentTools: Array<{ name: string }> | undefined;
  static inputScenario:
    | "normal"
    | "autoApprovalContinuation"
    | "manualApprovalWait"
    | "hang" = "normal";
  readyState = 0;
  sent: unknown[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeAppServerSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  send(data: string): void {
    const command = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(command);
    fakeAppServerHandle(command);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: Listener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  once(type: string, listener: Listener): void {
    const onceListener = (event: unknown) => {
      this.removeEventListener(type, onceListener);
      listener(event);
    };
    this.addEventListener(type, onceListener);
  }

  serverMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function fakeControlSocket(): FakeAppServerSocket {
  const socket = FakeAppServerSocket.instances.find((instance) =>
    instance.url.includes("channel=control"),
  );
  if (!socket) throw new Error("missing fake control socket");
  return socket;
}

function fakeStreamSocket(): FakeAppServerSocket {
  const socket = FakeAppServerSocket.instances.find((instance) =>
    instance.url.includes("channel=stream"),
  );
  if (!socket) throw new Error("missing fake stream socket");
  return socket;
}

function fakeAppServerHandle(command: Record<string, unknown>): void {
  if (command.type === "conversation_retrieve") {
    const conversationId = command.conversation_id as string;
    fakeControlSocket().serverMessage({
      type: "conversation_retrieve_response",
      request_id: command.request_id,
      success: true,
      conversation: { id: conversationId, agent_id: "agent-from-conversation" },
    });
    return;
  }

  if (command.type === "enable_memfs") {
    fakeControlSocket().serverMessage({
      type: "enable_memfs_response",
      request_id: command.request_id,
      success: true,
      memory_directory: "/tmp/memfs",
    });
    return;
  }

  if (command.type === "set_reflection_settings") {
    fakeControlSocket().serverMessage({
      type: "set_reflection_settings_response",
      request_id: command.request_id,
      success: true,
      scope: command.scope,
      reflection_settings: command.settings,
    });
    return;
  }

  if (command.type === "update_model") {
    fakeControlSocket().serverMessage({
      type: "update_model_response",
      request_id: command.request_id,
      success: true,
      runtime: command.runtime,
      model_handle: (command.payload as Record<string, unknown>)?.model_handle,
    });
    return;
  }

  if (command.type === "update_toolset") {
    fakeControlSocket().serverMessage({
      type: "update_toolset_response",
      request_id: command.request_id,
      success: true,
      runtime: command.runtime,
      current_toolset_preference: command.toolset_preference,
    });
    return;
  }

  if (command.type === "sync" && typeof command.request_id === "string") {
    fakeControlSocket().serverMessage({
      type: "sync_response",
      request_id: command.request_id,
      runtime: command.runtime,
      success: true,
    });
    return;
  }

  if (command.type === "conversation_messages_list") {
    fakeControlSocket().serverMessage({
      type: "conversation_messages_list_response",
      request_id: command.request_id,
      success: true,
      messages: [
        { id: "msg-user", role: "user", content: "hello" },
        { id: "msg-assistant", role: "assistant", content: "hi" },
      ],
    });
    return;
  }

  if (command.type === "runtime_start") {
    const createdAgent = command.create_agent as Record<string, unknown> | undefined;
    const agentId = (command.agent_id as string | undefined) ?? "agent-created";
    const conversationId =
      command.conversation_id === "default"
        ? "default"
        : ((command.conversation_id as string | undefined) ?? "conv-created");
    fakeControlSocket().serverMessage({
      type: "runtime_start_response",
      request_id: command.request_id,
      success: true,
      runtime: { agent_id: agentId, conversation_id: conversationId },
      agent: {
        id: agentId,
        model: "anthropic/claude-sonnet-4",
        ...(FakeAppServerSocket.reportedAgentTools !== undefined
          ? { tools: FakeAppServerSocket.reportedAgentTools }
          : {}),
      },
      conversation: { id: conversationId, agent_id: agentId },
      created: {
        agent: createdAgent !== undefined,
        conversation: command.create_conversation !== undefined,
      },
    });
    return;
  }

  if (command.type === "input") {
    const runtime = command.runtime;
    const emitStream = (message: unknown) => {
      if (FakeAppServerSocket.mirrorStreamToControl) {
        fakeControlSocket().serverMessage(message);
      }
      fakeStreamSocket().serverMessage(message);
    };

    if (FakeAppServerSocket.inputScenario === "autoApprovalContinuation") {
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          id: "tool-call-1",
          message_type: "approval_request_message",
          tool_calls: [
            {
              tool_call_id: "call-1",
              name: "Bash",
              arguments: '{"command":"pwd"}',
            },
          ],
          run_id: "run-approval",
        },
      });
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "stop_reason",
          stop_reason: "requires_approval",
          run_id: "run-approval",
        },
      });
      emitStream({
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "EXECUTING_CLIENT_SIDE_TOOL",
          active_run_ids: ["run-approval"],
        },
      });
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          id: "tool-result-1",
          message_type: "tool_return_message",
          tool_call_id: "call-1",
          tool_return: "ok",
          status: "success",
          run_id: "run-approval",
        },
      });
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          id: "msg-after-tool",
          message_type: "assistant_message",
          content: "done after tool",
          run_id: "run-final",
        },
      });
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "stop_reason",
          stop_reason: "end_turn",
          run_id: "run-final",
        },
      });
      return;
    }

    if (FakeAppServerSocket.inputScenario === "manualApprovalWait") {
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          id: "tool-call-1",
          message_type: "approval_request_message",
          tool_calls: [
            {
              tool_call_id: "call-1",
              name: "Bash",
              arguments: '{"command":"rm -rf tmp"}',
            },
          ],
          run_id: "run-approval",
        },
      });
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "stop_reason",
          stop_reason: "requires_approval",
          run_id: "run-approval",
        },
      });
      emitStream({
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "WAITING_ON_APPROVAL",
          active_run_ids: ["run-approval"],
        },
      });
      return;
    }

    if (FakeAppServerSocket.inputScenario === "hang") {
      return;
    }

    const assistantDelta = {
      type: "stream_delta",
      runtime,
      delta: {
        id: "msg-1",
        message_type: "assistant_message",
        content: "hello from app-server",
        run_id: "run-1",
      },
    };
    const stopDelta = {
      type: "stream_delta",
      runtime,
      delta: {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-1",
      },
    };
    emitStream(assistantDelta);
    emitStream(stopDelta);
  }
}

describe("LettaCodeClient", () => {
  test("defaults to the implemented local backend", () => {
    const client = new LettaCodeClient();

    expect(client.backend).toBe("local");
    expect(client.environment).toBeUndefined();
  });

  test("creates local app-server sessions without starting transport until use", () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "local",
      appServer: { url: "ws://127.0.0.1:4500/ws", WebSocket: FakeAppServerSocket },
    });
    const session = client.resumeSession("agent-123");

    try {
      expect(session).not.toBeInstanceOf(Session);
      expect(FakeAppServerSocket.instances).toHaveLength(0);
    } finally {
      session.close();
    }
  });

  test("explicit local stdio transport keeps legacy Session fallback", async () => {
    const client = new LettaCodeClient({ backend: "local", transport: "stdio" });
    const session = client.resumeSession("agent-123");

    try {
      expect(session).toBeInstanceOf(Session);
      await expect(asAdvanced(session).updateToolset("developer")).rejects.toThrow(
        "Local stdio sessions do not support updateToolset",
      );
    } finally {
      session.close();
    }
  });

  test("rejects environment overrides on local sessions", () => {
    const client = new LettaCodeClient({ backend: "local" });

    expect(() =>
      client.resumeSession("agent-123", { environment: "work-laptop" }),
    ).toThrow("environment overrides are only valid for cloud backends");
  });

  test("rejects environment on remote app-server clients", () => {
    expect(() =>
      new LettaCodeClient({
        backend: "remote",
        url: "wss://example.com/ws",
        environment: "work-laptop",
      } as never),
    ).toThrow("remote url selects the app-server runtime");

    const client = new LettaCodeClient({
      backend: "remote",
      url: "wss://example.com/ws",
    });
    expect(() =>
      client.resumeSession("agent-123", { environment: "work-laptop" }),
    ).toThrow("remote url selects the app-server runtime");
  });

  test("local backend uses app-server when an agent id is provided", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "local",
      appServer: { url: "ws://127.0.0.1:4500/ws", WebSocket: FakeAppServerSocket },
    });

    const session = client.createSession("agent-123", { cwd: "/tmp/project" });
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.agentId).toBe("agent-123");
      expect(init.conversationId).toBe("conv-created");

      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        agent_id: "agent-123",
        create_conversation: { body: {} },
        cwd: "/tmp/project",
      });
    } finally {
      session.close();
    }
  });

  test("app-server init tools are backend-reported, not SDK external tools", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.reportedAgentTools = [{ name: "Bash" }, { name: "Read" }];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      tools: [
        {
          name: "lookup_ticket",
          label: "Lookup ticket",
          description: "Lookup a ticket by id",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.tools).toEqual(["Bash", "Read"]);
      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        external_tools: [
          {
            tools: [expect.objectContaining({ name: "lookup_ticket" })],
          },
        ],
      });
    } finally {
      FakeAppServerSocket.reportedAgentTools = undefined;
      session.close();
    }
  });

  test("constructs remote backend and keeps cloud construction typed", () => {
    const remoteClient = new LettaCodeClient({
      backend: "remote",
      url: "wss://example.com/ws",
    });
    const cloudClient = new LettaCodeClient({
      backend: "cloud",
      environment: { name: "LettaDevelopers" },
    });

    expect(remoteClient.backend).toBe("remote");
    expect(cloudClient.backend).toBe("cloud");
    expect(cloudClient.environment).toEqual({ name: "LettaDevelopers" });
  });

  test("passes remote auth tokens to app-server websocket upgrades", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      authToken: " super-secret-token\n",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();

      expect(fakeControlSocket().options).toEqual({
        headers: { Authorization: "Bearer super-secret-token" },
      });
      expect(fakeStreamSocket().options).toEqual({
        headers: { Authorization: "Bearer super-secret-token" },
      });
    } finally {
      session.close();
    }
  });

  test("constructs cloud backend sessions without using the local fallback", () => {
    const client = new LettaCodeClient({
      backend: "cloud",
      environment: "LettaDevelopers",
    });

    const session = client.resumeSession("agent-123");
    expect(session.agentId).toBeNull();
    expect(session.conversationId).toBeNull();
    session.close();
  });

  test("starts remote app-server sessions and runs a turn", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123", { cwd: "/tmp/project" });
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.agentId).toBe("agent-123");
      expect(init.conversationId).toBe("conv-created");

      const result = await asAdvanced(session).runTurn("hello");
      expect(result.success).toBe(true);
      expect(result.result).toBe("hello from app-server");
      expect(result.runIds).toEqual(["run-1"]);

      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        agent_id: "agent-123",
        create_conversation: { body: {} },
        cwd: "/tmp/project",
      });
      const inputCommand = fakeControlSocket().sent.find(
        (command): command is Record<string, unknown> =>
          typeof command === "object" && command !== null && "type" in command && command.type === "input",
      );
      expect(inputCommand).toMatchObject({
        type: "input",
        runtime: { agent_id: "agent-123", conversation_id: "conv-created" },
        payload: { kind: "create_message" },
      });
      const payload = inputCommand?.payload as Record<string, unknown> | undefined;
      expect(payload).not.toHaveProperty("supports_control_response");
      expect(payload).not.toHaveProperty("source");
    } finally {
      session.close();
    }
  });

  test("app-server sessions respond to can_use_tool control requests through the shared approval bridge", async () => {
    FakeAppServerSocket.instances = [];
    const approvals: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123", {
      canUseTool: (toolName, input) => {
        approvals.push({ toolName, input });
        return {
          behavior: "allow",
          message: "approved",
          updatedInput: { command: "pwd" },
          updatedPermissions: [],
        };
      },
    });

    try {
      await asAdvanced(session).initialize();
      fakeControlSocket().serverMessage({
        type: "control_request",
        request_id: "approval-1",
        agent_id: "agent-from-request",
        conversation_id: "conv-from-request",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "pwd" },
        },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(approvals).toEqual([{ toolName: "Bash", input: { command: "pwd" } }]);
      const approvalCommand = fakeControlSocket().sent.find(
        (command): command is Record<string, unknown> => {
          if (!command || typeof command !== "object") return false;
          const payload = (command as { payload?: { kind?: string } }).payload;
          return (command as { type?: string }).type === "input" && payload?.kind === "approval_response";
        },
      );
      expect(approvalCommand).toMatchObject({
        type: "input",
        runtime: { agent_id: "agent-from-request", conversation_id: "conv-from-request" },
        payload: {
          kind: "approval_response",
          request_id: "approval-1",
          decision: {
            behavior: "allow",
            message: "approved",
            updated_input: { command: "pwd" },
            selected_permission_suggestion_ids: [],
          },
        },
      });
    } finally {
      session.close();
    }
  });

  test("app-server transport failures emit streamed error before failed result", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "hang";
    const client = new LettaCodeClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
      requestTimeoutMs: 5,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();
      await session.send("this will time out");
      const messages: unknown[] = [];
      for await (const message of session.stream()) {
        messages.push(message);
      }

      expect(messages[0]).toMatchObject({
        type: "error",
        stopReason: "error",
      });
      expect(messages.at(-1)).toMatchObject({
        type: "result",
        success: false,
        errorCode: "error",
      });
    } finally {
      FakeAppServerSocket.inputScenario = "normal";
      session.close();
    }
  });

  test("app-server sessions wait through auto-handled requires_approval stops", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "autoApprovalContinuation";
    const client = new LettaCodeClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();
      const messages: unknown[] = [];
      await session.send("use a tool");
      for await (const message of session.stream()) {
        messages.push(message);
      }

      const result = messages.at(-1) as { type?: string; success?: boolean; stopReason?: string };
      expect(result).toMatchObject({ type: "result", success: true, stopReason: "end_turn" });
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "Bash",
        }),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          toolCallId: "call-1",
          content: "ok",
        }),
      );
      expect(result.stopReason).not.toBe("requires_approval");
    } finally {
      FakeAppServerSocket.inputScenario = "normal";
      session.close();
    }
  });

  test("app-server sessions terminalize only genuine pending approvals", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "manualApprovalWait";
    const client = new LettaCodeClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();
      const result = await asAdvanced(session).runTurn("use a tool");

      expect(result).toMatchObject({
        type: "result",
        success: false,
        approvalConflict: true,
        stopReason: "requires_approval",
      });
    } finally {
      FakeAppServerSocket.inputScenario = "normal";
      session.close();
    }
  });

  test("creates remote app-server agents through runtime_start", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const agentId = await client.createAgent({
      model: "anthropic/claude-sonnet-4",
      persona: "Helpful TypeScript assistant",
      tags: ["sdk-test"],
    });

    expect(agentId).toBe("agent-created");
    expect(fakeControlSocket().sent[0]).toMatchObject({
      type: "runtime_start",
      create_agent: {
        body: {
          model: "anthropic/claude-sonnet-4",
          tags: ["sdk-test", "origin:letta-code"],
          memory_blocks: [
            { label: "persona", value: "Helpful TypeScript assistant" },
          ],
        },
      },
    });
  });

  test("resumes remote conversations by resolving their agent first", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("conv-abc");
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.agentId).toBe("agent-from-conversation");
      expect(init.conversationId).toBe("conv-abc");
      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "conversation_retrieve",
        conversation_id: "conv-abc",
      });
      expect(fakeControlSocket().sent[1]).toMatchObject({
        type: "runtime_start",
        agent_id: "agent-from-conversation",
        conversation_id: "conv-abc",
      });
    } finally {
      session.close();
    }
  });

  test("resumes local-backend conversation ids through remote app-server", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("local-conv-63");
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.agentId).toBe("agent-from-conversation");
      expect(init.conversationId).toBe("local-conv-63");
      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "conversation_retrieve",
        conversation_id: "local-conv-63",
      });
      expect(fakeControlSocket().sent[1]).toMatchObject({
        type: "runtime_start",
        agent_id: "agent-from-conversation",
        conversation_id: "local-conv-63",
      });
    } finally {
      session.close();
    }
  });

  test("registers SDK tools as app-server external tools", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      tools: [
        {
          name: "lookup_ticket",
          label: "Lookup ticket",
          description: "Lookup a ticket by id",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          execute: async (toolCallId, input) => ({
            content: [
              { type: "text", text: `${toolCallId}:${(input as { id: string }).id}` },
            ],
          }),
        },
      ],
    });

    try {
      await asAdvanced(session).initialize();
      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        external_tools: [
          {
            tools: [
              {
                name: "lookup_ticket",
                label: "Lookup ticket",
                description: "Lookup a ticket by id",
              },
            ],
          },
        ],
      });

      fakeControlSocket().serverMessage({
        type: "external_tool_call_request",
        request_id: "external-tool-1",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        tool_call_id: "tool-call-1",
        tool_name: "lookup_ticket",
        input: { id: "LET-9239" },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "external_tool_call_response",
        request_id: "external-tool-1",
        result: {
          content: [{ type: "text", text: "tool-call-1:LET-9239" }],
        },
      });
    } finally {
      session.close();
    }
  });

  test("app-server sessions apply model sleeptime and list messages", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaCodeClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      model: "anthropic/claude-opus-4",
      sleeptime: { trigger: "step-count", stepCount: 3 },
    });

    try {
      await asAdvanced(session).initialize();
      expect(fakeControlSocket().sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "set_reflection_settings",
            settings: { trigger: "step-count", step_count: 3 },
          }),
          expect.objectContaining({
            type: "update_model",
            payload: { model_handle: "anthropic/claude-opus-4" },
          }),
        ]),
      );

      const page = await session.listMessages({ limit: 2, order: "desc" });
      expect(page.messages).toHaveLength(2);
      expect(page.hasMore).toBeUndefined();
      expect(page.nextBefore).toBeUndefined();
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "conversation_messages_list",
        conversation_id: "default",
        query: { limit: 2, order: "desc" },
      });

      await asAdvanced(session).updateToolset("developer");
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "update_toolset",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        toolset_preference: "developer",
      });

      await expect(asAdvanced(session).recoverPendingApprovals({ timeoutMs: 1_000 })).resolves.toEqual({
        recovered: true,
        unsupported: false,
      });
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "sync",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        recover_approvals: true,
        force_device_status: true,
      });
    } finally {
      session.close();
    }
  });

  test("app-server sessions reject unsupported stdio-only options", () => {
    const client = new LettaCodeClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    expect(() =>
      client.resumeSession("agent-123", { sleeptime: { behavior: "auto-launch" } }),
    ).toThrow("does not yet support sleeptime.behavior");
  });


  test("keeps environment out of createAgent payloads", async () => {
    const client = new LettaCodeClient({ backend: "local" });

    await expect(
      client.createAgent({ environment: "work-laptop" } as never),
    ).rejects.toThrow("createAgent() does not accept environment");
  });
});
