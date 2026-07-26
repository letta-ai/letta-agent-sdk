import { describe, expect, test } from "bun:test";
import { LettaAgentClient, Session } from "../index.js";
import type { SessionDeviceStatus } from "../index.js";
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
  static deviceStatusOnSync = false;
  static reportedAgentTools: Array<{ name: string }> | undefined;
  static inputScenario:
    | "normal"
    | "autoApprovalContinuation"
    | "manualApprovalWait"
    | "queuedSecond"
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

const FAKE_MODEL_ENTRIES = [
  {
    id: "sonnet-low",
    handle: "anthropic/claude-sonnet-4",
    label: "Claude Sonnet 4",
    description: "Sonnet low reasoning",
    isDefault: true,
    updateArgs: { reasoning_effort: "low", context_window: 200_000 },
  },
  {
    id: "sonnet-high",
    handle: "anthropic/claude-sonnet-4",
    label: "Claude Sonnet 4",
    description: "Sonnet high reasoning",
    updateArgs: { reasoning_effort: "high", context_window: 200_000 },
  },
  {
    id: "opus",
    handle: "anthropic/claude-opus-4",
    label: "Claude Opus 4",
    description: "Opus",
  },
];

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

  if (command.type === "list_models") {
    fakeControlSocket().serverMessage({
      type: "list_models_response",
      request_id: command.request_id,
      success: true,
      entries: FAKE_MODEL_ENTRIES,
      available_handles: ["anthropic/claude-sonnet-4", "anthropic/claude-opus-4"],
      byok_provider_aliases: { "lc-anthropic": "anthropic" },
    });
    return;
  }

  if (command.type === "update_model") {
    const payload = command.payload as Record<string, unknown> | undefined;
    const byId = FAKE_MODEL_ENTRIES.find((entry) => entry.id === payload?.model_id);
    const byHandle = FAKE_MODEL_ENTRIES.find((entry) => entry.handle === payload?.model_handle);
    const modelHandle =
      (typeof payload?.model_handle === "string" ? payload.model_handle : undefined) ??
      byId?.handle;
    fakeControlSocket().serverMessage({
      type: "update_model_response",
      request_id: command.request_id,
      success: true,
      runtime: command.runtime,
      applied_to: "conversation",
      model_id:
        (typeof payload?.model_id === "string" ? payload.model_id : undefined) ??
        byHandle?.id,
      model_handle: modelHandle,
      model_settings: {
        model: modelHandle,
        context_window:
          typeof byId?.updateArgs?.context_window === "number"
            ? byId.updateArgs.context_window
            : undefined,
        reasoning: { reasoning_effort: byId?.updateArgs?.reasoning_effort },
      },
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

  if (command.type === "sync") {
    if (FakeAppServerSocket.deviceStatusOnSync && command.force_device_status === true) {
      fakeControlSocket().serverMessage({
        type: "update_device_status",
        runtime: command.runtime,
        device_status: {
          is_online: true,
          is_processing: false,
          current_permission_mode: "acceptEdits",
          current_working_directory: "/workspace/project",
          pending_control_requests: [
            {
              request_id: "approval-1",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                tool_call_id: "call-1",
                input: { command: "pwd" },
                permission_suggestions: [],
                blocked_path: null,
              },
            },
          ],
        },
      });
    }
    if (typeof command.request_id === "string") {
      fakeControlSocket().serverMessage({
        type: "sync_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: true,
      });
    }
    return;
  }

  if (command.type === "remove_queue_item" && typeof command.request_id === "string") {
    fakeControlSocket().serverMessage({
      type: "remove_queue_item_response",
      request_id: command.request_id,
      runtime: command.runtime,
      success: command.item_id !== "missing-item",
      item_id: command.item_id,
    });
    return;
  }

  if (command.type === "abort_message" && typeof command.request_id === "string") {
    fakeControlSocket().serverMessage({
      type: "abort_message_response",
      request_id: command.request_id,
      runtime: command.runtime,
      aborted: true,
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

    if (FakeAppServerSocket.inputScenario === "queuedSecond") {
      const inputCount = fakeControlSocket().sent.filter(
        (sent) => (sent as { type?: string }).type === "input",
      ).length;
      const payload = command.payload as { messages?: Array<Record<string, unknown>> };
      const clientMessageId = payload.messages?.[0]?.client_message_id;
      if (inputCount === 1) {
        emitStream({
          type: "stream_delta",
          runtime,
          delta: {
            id: "msg-first",
            message_type: "assistant_message",
            content: "first response",
            run_id: "run-first",
          },
        });
      } else {
        emitStream({
          type: "update_queue",
          runtime,
          queue: [
            {
              id: "queue-1",
              client_message_id: clientMessageId,
              kind: "message",
              source: "user",
              content: "second message",
              enqueued_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      return;
    }

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

describe("LettaAgentClient", () => {
  test("defaults to the implemented local backend", () => {
    const client = new LettaAgentClient();

    expect(client.backend).toBe("local");
    expect(client.environment).toBeUndefined();
  });

  test("creates local app-server sessions without starting transport until use", () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({ backend: "local", transport: "stdio" });
    const session = client.resumeSession("agent-123");

    try {
      expect(session).toBeInstanceOf(Session);
      await expect(asAdvanced(session).updateToolset("developer")).rejects.toThrow(
        "updateToolset() is not supported by this session",
      );
      await expect(session.getDeviceStatus()).rejects.toThrow(
        "getDeviceStatus() is not supported by the legacy stdio transport",
      );
      expect(() => session.onDeviceStatus(() => {})).toThrow(
        "onDeviceStatus() is not supported by the legacy stdio transport",
      );
    } finally {
      session.close();
    }
  });

  test("rejects environment overrides on local sessions", () => {
    const client = new LettaAgentClient({ backend: "local" });

    expect(() =>
      client.resumeSession("agent-123", { environment: "work-laptop" }),
    ).toThrow('environment overrides are only valid with backend: "cloud"');
  });

  test("rejects environment on remote app-server clients", () => {
    expect(() =>
      new LettaAgentClient({
        backend: "remote",
        url: "wss://example.com/ws",
        environment: "work-laptop",
      } as never),
    ).toThrow("remote url selects the app-server runtime");

    const client = new LettaAgentClient({
      backend: "remote",
      url: "wss://example.com/ws",
    });
    expect(() =>
      client.resumeSession("agent-123", { environment: "work-laptop" }),
    ).toThrow("remote url selects the app-server runtime");
  });

  test("local backend uses app-server when an agent id is provided", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const remoteClient = new LettaAgentClient({
      backend: "remote",
      url: "wss://example.com/ws",
    });
    const cloudClient = new LettaAgentClient({
      backend: "cloud",
      environment: { name: "LettaDevelopers" },
    });

    expect(remoteClient.backend).toBe("remote");
    expect(cloudClient.backend).toBe("cloud");
    expect(cloudClient.environment).toEqual({ name: "LettaDevelopers" });
  });

  test("passes remote auth tokens to app-server websocket upgrades", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123", {
      cwd: "/tmp/project",
      allowedTools: ["Bash", "Read", "Write", "Edit", "Read"],
    });
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
        payload: {
          kind: "create_message",
          client_tool_allowlist: ["Bash", "Read", "Write", "Edit"],
        },
      });
      const payload = inputCommand?.payload as Record<string, unknown> | undefined;
      expect(payload).not.toHaveProperty("supports_control_response");
      expect(payload).not.toHaveProperty("source");
    } finally {
      session.close();
    }
  });

  test("excludes interactive tools by default without pinning an allowlist", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();
      await asAdvanced(session).runTurn("hello");

      const inputCommand = fakeControlSocket().sent.find(
        (command): command is Record<string, unknown> =>
          typeof command === "object" && command !== null && "type" in command && command.type === "input",
      );
      const payload = inputCommand?.payload as Record<string, unknown> | undefined;
      // No allowlist by default — the harness default toolset applies…
      expect(payload).not.toHaveProperty("client_tool_allowlist");
      // …with interactive user-input tools excluded via the protocol flag.
      expect(payload?.exclude_interactive_tools).toBe(true);
    } finally {
      session.close();
    }
  });

  test("interactive tools stay excluded even with an explicit allowlist", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123", {
      allowedTools: ["Bash", "Read"],
    });
    try {
      await asAdvanced(session).initialize();
      await asAdvanced(session).runTurn("hello");

      const inputCommand = fakeControlSocket().sent.find(
        (command): command is Record<string, unknown> =>
          typeof command === "object" && command !== null && "type" in command && command.type === "input",
      );
      const payload = inputCommand?.payload as Record<string, unknown> | undefined;
      expect(payload?.client_tool_allowlist).toEqual(["Bash", "Read"]);
      expect(payload?.exclude_interactive_tools).toBe(true);
    } finally {
      session.close();
    }
  });

  test("websocket protocol sessions respond to can_use_tool control requests through the shared approval bridge", async () => {
    FakeAppServerSocket.instances = [];
    const approvals: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const client = new LettaAgentClient({
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

  test("websocket protocol transport failures emit streamed error before failed result", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "hang";
    const client = new LettaAgentClient({
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

  test("websocket protocol sessions wait through auto-handled requires_approval stops", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "autoApprovalContinuation";
    const client = new LettaAgentClient({
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

  test("websocket protocol sessions terminalize only genuine pending approvals", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "manualApprovalWait";
    const client = new LettaAgentClient({
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

  test("websocket protocol sessions let the listener queue sends during an active turn", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "queuedSecond";
    const client = new LettaAgentClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();
      await session.send("first message");
      await session.send("second message");

      const inputCommands = fakeControlSocket().sent.filter(
        (sent) => (sent as { type?: string }).type === "input",
      ) as Array<{ payload: { messages: Array<{ client_message_id?: string }> } }>;
      expect(inputCommands).toHaveLength(2);
      const firstClientMessageId = inputCommands[0]?.payload.messages[0]?.client_message_id;
      const secondClientMessageId = inputCommands[1]?.payload.messages[0]?.client_message_id;
      expect(typeof firstClientMessageId).toBe("string");
      expect(typeof secondClientMessageId).toBe("string");

      const firstMessages: unknown[] = [];
      const firstIterator = session.stream();
      firstMessages.push((await firstIterator.next()).value);
      firstMessages.push((await firstIterator.next()).value);

      expect(firstMessages[0]).toMatchObject({
        type: "assistant",
        content: "first response",
      });
      expect(firstMessages[1]).toMatchObject({
        type: "queue_update",
        queue: [
          expect.objectContaining({
            id: "queue-1",
            clientMessageId: secondClientMessageId,
          }),
        ],
      });

      const runtime = { agent_id: "agent-123", conversation_id: "conv-created" };
      fakeStreamSocket().serverMessage({
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "stop_reason",
          stop_reason: "end_turn",
          run_id: "run-first",
        },
      });
      firstMessages.push((await firstIterator.next()).value);
      expect(firstMessages.at(-1)).toMatchObject({
        type: "result",
        success: true,
        result: "first response",
      });

      fakeStreamSocket().serverMessage({
        type: "update_queue",
        runtime,
        queue: [],
      });
      fakeStreamSocket().serverMessage({
        type: "stream_delta",
        runtime,
        delta: {
          id: "msg-second",
          message_type: "assistant_message",
          content: "second response",
          run_id: "run-second",
        },
      });
      fakeStreamSocket().serverMessage({
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "stop_reason",
          stop_reason: "end_turn",
          run_id: "run-second",
        },
      });

      const secondMessages: unknown[] = [];
      for await (const message of session.stream()) {
        secondMessages.push(message);
      }
      expect(secondMessages).toContainEqual({ type: "queue_update", queue: [] });
      expect(secondMessages).toContainEqual(
        expect.objectContaining({ type: "assistant", content: "second response" }),
      );
      expect(secondMessages.at(-1)).toMatchObject({
        type: "result",
        success: true,
        result: "second response",
      });
    } finally {
      FakeAppServerSocket.inputScenario = "normal";
      session.close();
    }
  });

  test("creates remote app-server agents through runtime_start", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
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
          tags: ["origin:letta-code", "git-memory-enabled", "sdk-test"],
          memory_blocks: expect.arrayContaining([
            { label: "persona", value: "Helpful TypeScript assistant" },
          ]),
        },
      },
    });
  });

  test("createAgent leaves server-side tools to the harness defaults when baseTools is omitted", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    await client.createAgent({
      model: "anthropic/claude-sonnet-4",
    });

    const command = fakeControlSocket().sent[0] as {
      create_agent?: { body?: Record<string, unknown> };
    };
    // The harness applies its created-agent defaults (web_search,
    // fetch_webpage); the SDK does not pin them client-side.
    expect(command.create_agent?.body).not.toHaveProperty("tools");
    expect(command.create_agent?.body).not.toHaveProperty("include_base_tools");
  });

  test("baseTools: [] attaches no server-side tools", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    await client.createAgent({
      model: "anthropic/claude-sonnet-4",
      baseTools: [],
    });

    expect(fakeControlSocket().sent[0]).toMatchObject({
      type: "runtime_start",
      create_agent: {
        body: {
          tools: [],
          include_base_tools: false,
          include_base_tool_rules: false,
        },
      },
    });
  });

  test("an explicit baseTools list overrides the default server-side tools", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    await client.createAgent({
      model: "anthropic/claude-sonnet-4",
      baseTools: ["web_search"],
    });

    expect(fakeControlSocket().sent[0]).toMatchObject({
      type: "runtime_start",
      create_agent: {
        body: {
          tools: ["web_search"],
          include_base_tools: false,
          include_base_tool_rules: false,
        },
      },
    });
  });

  test("default toolset contract: harness owns both defaults; SDK only excludes interactive tools", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    // 1. Creation sends no tool fields — the harness applies its
    //    created-agent defaults (web_search, fetch_webpage).
    const agentId = await client.createAgent({
      model: "anthropic/claude-sonnet-4",
    });
    const createCommand = fakeControlSocket().sent[0] as {
      create_agent?: { body?: Record<string, unknown> };
    };
    expect(createCommand.create_agent?.body).not.toHaveProperty("tools");
    expect(createCommand.create_agent?.body).not.toHaveProperty("include_base_tools");

    // 2. Every turn keeps the harness default toolset (no pinned allowlist)
    //    and excludes interactive user-input tools via the protocol flag.
    FakeAppServerSocket.instances = [];
    const session = client.createSession(agentId);
    try {
      await asAdvanced(session).initialize();
      await asAdvanced(session).runTurn("hello");

      const inputCommand = fakeControlSocket().sent.find(
        (command): command is Record<string, unknown> =>
          typeof command === "object" && command !== null && "type" in command && command.type === "input",
      );
      const payload = inputCommand?.payload as Record<string, unknown> | undefined;
      expect(payload).not.toHaveProperty("client_tool_allowlist");
      expect(payload?.exclude_interactive_tools).toBe(true);
    } finally {
      session.close();
    }
  });

  test("forwards an empty skillSources override when creating app-server agents", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    await client.createAgent({
      model: "anthropic/claude-sonnet-4",
      skillSources: [],
    });

    expect(fakeControlSocket().sent[0]).toMatchObject({
      type: "runtime_start",
      skill_sources: [],
      create_agent: expect.any(Object),
    });
  });

  test("forwards skillSources on app-server session creation and resume", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const created = client.createSession("agent-123", { skillSources: [] });
    try {
      const init = await asAdvanced(created).initialize();
      expect(init.skillSources).toEqual([]);
      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        agent_id: "agent-123",
        skill_sources: [],
      });
    } finally {
      created.close();
    }

    FakeAppServerSocket.instances = [];
    const resumed = client.resumeSession("agent-123", {
      skillSources: ["project", "agent"],
    });
    try {
      const init = await asAdvanced(resumed).initialize();
      expect(init.skillSources).toEqual(["project", "agent"]);
      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        agent_id: "agent-123",
        skill_sources: ["project", "agent"],
      });
    } finally {
      resumed.close();
    }
  });

  test("resumes remote conversations by resolving their agent first", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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

  test("custom client-side tools register, stay in the default allowlist, execute locally, and return results", async () => {
    FakeAppServerSocket.instances = [];
    const executions: Array<{ toolCallId: string; input: unknown }> = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      tools: [
        {
          name: "get_weather",
          label: "Get weather",
          description: "Get the weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          execute: async (toolCallId, input) => {
            executions.push({ toolCallId, input });
            return {
              content: [
                { type: "text", text: `sunny in ${(input as { city: string }).city}` },
              ],
              details: { temperatureC: 21 },
            };
          },
        },
      ],
    });

    try {
      await asAdvanced(session).initialize();

      // Registered with the harness at runtime start.
      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        external_tools: [
          {
            tools: [{ name: "get_weather", label: "Get weather" }],
          },
        ],
      });

      // No default allowlist is sent, so the custom tool is never filtered
      // by the harness; interactive tools are excluded via the flag instead.
      await asAdvanced(session).runTurn("hello");
      const inputCommand = fakeControlSocket().sent.find(
        (command): command is Record<string, unknown> =>
          typeof command === "object" && command !== null && "type" in command && command.type === "input",
      );
      const payload = inputCommand?.payload as Record<string, unknown> | undefined;
      expect(payload).not.toHaveProperty("client_tool_allowlist");
      expect(payload?.exclude_interactive_tools).toBe(true);

      // Harness asks the SDK to execute the tool; it runs client-side and
      // the result is sent back over the wire.
      fakeControlSocket().serverMessage({
        type: "external_tool_call_request",
        request_id: "external-tool-42",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        tool_call_id: "tool-call-42",
        tool_name: "get_weather",
        input: { city: "Tokyo" },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(executions).toEqual([
        { toolCallId: "tool-call-42", input: { city: "Tokyo" } },
      ]);
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "external_tool_call_response",
        request_id: "external-tool-42",
        result: {
          content: [{ type: "text", text: "sunny in Tokyo" }],
        },
      });
    } finally {
      session.close();
    }
  });

  test("explicit allowedTools remains authoritative over registered custom tools", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      allowedTools: ["Read"],
      tools: [
        {
          name: "get_weather",
          label: "Get weather",
          description: "Get the weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          execute: async () => ({
            content: [{ type: "text", text: "sunny" }],
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
            tools: [{ name: "get_weather" }],
          },
        ],
      });

      await asAdvanced(session).runTurn("hello");
      const inputCommand = fakeControlSocket().sent.find(
        (command): command is Record<string, unknown> =>
          typeof command === "object" && command !== null && "type" in command && command.type === "input",
      );
      const payload = inputCommand?.payload as Record<string, unknown> | undefined;
      expect(payload?.client_tool_allowlist).toEqual(["Read"]);
      expect(payload?.exclude_interactive_tools).toBe(true);
    } finally {
      session.close();
    }
  });

  test("websocket protocol sessions apply model dreaming and list messages", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      model: "anthropic/claude-opus-4",
      dreaming: { trigger: "step-count", stepCount: 3 },
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

      await session.changeDeviceState({ cwd: "/workspace/method" });
      const cwdOnlyDeviceState = fakeControlSocket().sent.at(-1) as {
        payload?: Record<string, unknown>;
      };
      expect(cwdOnlyDeviceState).toMatchObject({
        type: "change_device_state",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        payload: { cwd: "/workspace/method" },
      });
      expect(cwdOnlyDeviceState.payload).not.toHaveProperty("mode");

      await session.changeDeviceState({ permissionMode: "unrestricted" });
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "change_device_state",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        payload: { mode: "unrestricted" },
      });
      await expect(session.changeDeviceState({})).rejects.toThrow(
        "Expected cwd or permissionMode",
      );

      await session.sendCommand({
        type: "change_device_state",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        payload: { cwd: "/workspace/next" },
      });
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "change_device_state",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        payload: { cwd: "/workspace/next" },
      });

      const syncResponse = await session.sendCommand<{ type: "sync_response"; success: boolean }>(
        {
          type: "sync",
          runtime: { agent_id: "agent-123", conversation_id: "default" },
          recover_approvals: false,
        },
        { responseType: "sync_response" },
      );
      expect(syncResponse.success).toBe(true);

      await expect(session.recoverPendingApprovals({ timeoutMs: 1_000 })).resolves.toEqual({
        recovered: true,
        unsupported: false,
      });
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "sync",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        recover_approvals: true,
        force_device_status: true,
      });

      await expect(session.removeQueuedMessage("queue-1")).resolves.toEqual({
        itemId: "queue-1",
        removed: true,
      });
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "remove_queue_item",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        item_id: "queue-1",
      });

      await expect(session.removeQueuedMessage("missing-item")).resolves.toEqual({
        itemId: "missing-item",
        removed: false,
      });
      await expect(session.removeQueuedMessage("  ")).rejects.toThrow(
        "Invalid queue item id",
      );

      // Device status: sync-triggered getter plus cached reads and pushes.
      FakeAppServerSocket.deviceStatusOnSync = true;
      const seenStatuses: SessionDeviceStatus[] = [];
      const unsubscribe = session.onDeviceStatus((status) => seenStatuses.push(status));
      const deviceStatus = await session.getDeviceStatus();
      expect(deviceStatus).toMatchObject({
        isOnline: true,
        isProcessing: false,
        permissionMode: "acceptEdits",
        workingDirectory: "/workspace/project",
        pendingControlRequests: [
          {
            requestId: "approval-1",
            toolName: "Bash",
            toolCallId: "call-1",
            toolInput: { command: "pwd" },
          },
        ],
      });
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "sync",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        recover_approvals: false,
        force_device_status: true,
      });
      // The subscription observed the same sync-triggered push.
      expect(seenStatuses).toHaveLength(1);
      expect(seenStatuses[0]).toBe(deviceStatus);

      // Cached read: no additional sync round-trip.
      const syncsSoFar = fakeControlSocket().sent.filter(
        (command) => (command as { type?: string }).type === "sync",
      ).length;
      expect(await session.getDeviceStatus()).toBe(deviceStatus);
      expect(fakeControlSocket().sent.filter(
        (command) => (command as { type?: string }).type === "sync",
      )).toHaveLength(syncsSoFar);

      // Unsubscribe stops delivery.
      unsubscribe();
      fakeControlSocket().serverMessage({
        type: "update_device_status",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
        device_status: {
          is_online: true,
          is_processing: true,
          current_permission_mode: "unrestricted",
          current_working_directory: "/workspace/method",
          pending_control_requests: [],
        },
      });
      expect(seenStatuses).toHaveLength(1);
      expect(await session.getDeviceStatus()).toMatchObject({
        permissionMode: "unrestricted",
        isProcessing: true,
        workingDirectory: "/workspace/method",
        pendingControlRequests: [],
      });
    } finally {
      FakeAppServerSocket.deviceStatusOnSync = false;
      session.close();
    }
  });

  test("websocket protocol sessions list models, apply reasoning effort, and abort", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      model: "lc-anthropic/claude-sonnet-4",
      reasoningEffort: "high",
    });

    try {
      await asAdvanced(session).initialize();

      expect(fakeControlSocket().sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "list_models" }),
          expect.objectContaining({
            type: "update_model",
            payload: {
              model_id: "sonnet-high",
              model_handle: "lc-anthropic/claude-sonnet-4",
            },
          }),
        ]),
      );

      const catalog = await session.listModels();
      expect(catalog.entries.map((entry) => entry.id)).toEqual([
        "sonnet-low",
        "sonnet-high",
        "opus",
      ]);
      expect(catalog.availableHandles).toEqual([
        "anthropic/claude-sonnet-4",
        "anthropic/claude-opus-4",
      ]);
      expect(catalog.byokProviderAliases).toEqual({ "lc-anthropic": "anthropic" });

      const updateResult = await session.updateModel({
        model: "anthropic/claude-sonnet-4",
        reasoningEffort: "low",
      });
      expect(updateResult).toMatchObject({
        appliedTo: "conversation",
        modelId: "sonnet-low",
        modelHandle: "anthropic/claude-sonnet-4",
      });
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "update_model",
        payload: { model_id: "sonnet-low" },
      });

      await session.abort();
      expect(fakeControlSocket().sent.at(-1)).toMatchObject({
        type: "abort_message",
        runtime: { agent_id: "agent-123", conversation_id: "default" },
      });
    } finally {
      session.close();
    }
  });

  test("websocket protocol sessions reject unsupported stdio-only options", () => {
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    expect(() =>
      client.resumeSession("agent-123", { dreaming: { behavior: "auto-launch" } }),
    ).toThrow("does not yet support dreaming.behavior");
  });


  test("keeps environment out of createAgent payloads", async () => {
    const client = new LettaAgentClient({ backend: "local" });

    await expect(
      client.createAgent({ environment: "work-laptop" } as never),
    ).rejects.toThrow("createAgent() does not accept environment");
  });
});
