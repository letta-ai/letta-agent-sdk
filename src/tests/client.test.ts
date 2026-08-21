import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { resolveAppServerChannelUrl } from "@letta-ai/letta-code/app-server-client";
import * as sdk from "../index.js";
import { LettaAgentClient } from "../index.js";
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
    | "delayedApprovalRequest"
    | "manualApprovalWait"
    | "queuedSecond"
    | "hang" = "normal";
  static failNextRuntimeStart = false;
  static deferReflectionSettingsResponse = false;
  static failNextReflectionSettings = false;
  static pendingReflectionSettingsResponse: (() => void) | null = null;
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
    fakeAppServerHandle(command, this);
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
  const socket =
    FakeAppServerSocket.instances.find((instance) =>
      instance.url.includes("channel=control"),
    ) ??
    FakeAppServerSocket.instances.find(
      (instance) => !instance.url.includes("channel=stream"),
    );
  if (!socket) throw new Error("missing fake control socket");
  return socket;
}

function fakeStreamSocket(): FakeAppServerSocket {
  const socket =
    FakeAppServerSocket.instances.find((instance) =>
      instance.url.includes("channel=stream"),
    ) ?? fakeControlSocket();
  if (!socket) throw new Error("missing fake stream socket");
  return socket;
}

/**
 * The outbound stream for this client. New app-server clients use the control
 * socket bidirectionally; older installed packages use the adjacent stream.
 */
function fakeStreamPairOf(control: FakeAppServerSocket): FakeAppServerSocket {
  const index = FakeAppServerSocket.instances.indexOf(control);
  const stream = FakeAppServerSocket.instances[index + 1];
  return stream?.url.includes("channel=stream") ? stream : control;
}

function expectedAppServerSocketCount(): number {
  return new Set([
    resolveAppServerChannelUrl("ws://127.0.0.1:4500/ws", "control"),
    resolveAppServerChannelUrl("ws://127.0.0.1:4500/ws", "stream"),
  ]).size;
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

function fakeAppServerHandle(
  command: Record<string, unknown>,
  sender: FakeAppServerSocket,
): void {
  // Commands always arrive on a control socket; reply to the sending
  // client's own pair so tests can run several client instances at once.
  const control = sender;
  const stream = fakeStreamPairOf(sender);

  if (command.type === "conversation_retrieve") {
    const conversationId = command.conversation_id as string;
    control.serverMessage({
      type: "conversation_retrieve_response",
      request_id: command.request_id,
      success: true,
      conversation: { id: conversationId, agent_id: "agent-from-conversation" },
    });
    return;
  }

  if (command.type === "enable_memfs") {
    control.serverMessage({
      type: "enable_memfs_response",
      request_id: command.request_id,
      success: true,
      memory_directory: "/tmp/memfs",
    });
    return;
  }

  if (command.type === "set_reflection_settings") {
    const respond = () => {
      const success = !FakeAppServerSocket.failNextReflectionSettings;
      FakeAppServerSocket.failNextReflectionSettings = false;
      control.serverMessage({
        type: "set_reflection_settings_response",
        request_id: command.request_id,
        success,
        ...(success
          ? {
              scope: command.scope,
              reflection_settings: command.settings,
            }
          : { error: "reflection settings failed (fake)" }),
      });
    };
    if (FakeAppServerSocket.deferReflectionSettingsResponse) {
      FakeAppServerSocket.pendingReflectionSettingsResponse = respond;
    } else {
      respond();
    }
    return;
  }

  if (command.type === "list_models") {
    control.serverMessage({
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
    control.serverMessage({
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
    control.serverMessage({
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
      control.serverMessage({
        type: "update_device_status",
        runtime: command.runtime,
        device_status: {
          is_online: true,
          is_processing: false,
          current_permission_mode: "acceptEdits",
          current_working_directory: "/workspace/project",
          memory_directory: "/memory/agent-123",
          pending_control_requests: [
            {
              request_id: "approval-1",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                tool_call_id: "call-1",
                input: { command: "pwd" },
                permission_suggestions: [
                  { id: "allow-pwd", text: "Always allow pwd" },
                ],
                blocked_path: "/workspace/project",
                diffs: [
                  {
                    mode: "fallback",
                    fileName: "project",
                    reason: "Not a file edit",
                  },
                ],
              },
            },
          ],
        },
      });
    }
    if (typeof command.request_id === "string") {
      control.serverMessage({
        type: "sync_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: true,
      });
    }
    return;
  }

  if (command.type === "remove_queue_item" && typeof command.request_id === "string") {
    control.serverMessage({
      type: "remove_queue_item_response",
      request_id: command.request_id,
      runtime: command.runtime,
      success: command.item_id !== "missing-item",
      item_id: command.item_id,
    });
    return;
  }

  if (command.type === "abort_message" && typeof command.request_id === "string") {
    control.serverMessage({
      type: "abort_message_response",
      request_id: command.request_id,
      runtime: command.runtime,
      aborted: true,
      success: true,
    });
    return;
  }

  if (command.type === "conversation_messages_list") {
    control.serverMessage({
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
    if (FakeAppServerSocket.failNextRuntimeStart) {
      FakeAppServerSocket.failNextRuntimeStart = false;
      control.serverMessage({
        type: "runtime_start_response",
        request_id: command.request_id,
        success: false,
        runtime: null,
        agent: null,
        conversation: null,
        error: "runtime start failed (fake)",
      });
      return;
    }
    const createdAgent = command.create_agent as Record<string, unknown> | undefined;
    const agentId = (command.agent_id as string | undefined) ?? "agent-created";
    const conversationId =
      command.conversation_id === "default"
        ? "default"
        : ((command.conversation_id as string | undefined) ?? "conv-created");
    control.serverMessage({
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
        control.serverMessage(message);
      }
      stream.serverMessage(message);
    };
    const emitSuccessfulTerminal = (runId: string) => {
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "stop_reason",
          stop_reason: "end_turn",
          run_id: runId,
        },
      });
      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "usage_statistics",
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          step_count: 1,
        },
      });
      emitStream({
        type: "turn_finished",
        runtime,
        turn_id: `turn-${runId}`,
        run_id: runId,
        stop_reason: "end_turn",
      });
    };

    if (FakeAppServerSocket.inputScenario === "queuedSecond") {
      const inputCount = control.sent.filter(
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
      emitSuccessfulTerminal("run-final");
      return;
    }

    if (FakeAppServerSocket.inputScenario === "delayedApprovalRequest") {
      const payload = command.payload as { kind?: string };
      if (payload.kind === "approval_response") {
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
            content: "done after delayed approval",
            run_id: "run-final",
          },
        });
        emitSuccessfulTerminal("run-final");
        return;
      }

      emitStream({
        type: "stream_delta",
        runtime,
        delta: {
          id: "tool-call-1",
          message_type: "approval_request_message",
          tool_calls: [
            {
              tool_call_id: "call-1",
              name: "Read",
              arguments: '{"file_path":"/workspace/readme.md"}',
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
      const request = {
        type: "control_request",
        request_id: "approval-delayed-1",
        runtime,
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          tool_call_id: "call-1",
          input: { file_path: "/workspace/readme.md" },
        },
      };
      queueMicrotask(() => {
        control.serverMessage(request);
        control.serverMessage(request);
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
    emitStream(assistantDelta);
    emitSuccessfulTerminal("run-1");
  }
}

describe("LettaAgentClient", () => {
  test("defaults to the implemented local backend", () => {
    const client = new LettaAgentClient();

    expect(client.backend).toBe("local");
    expect(client.environment).toBeUndefined();
  });

  test("does not export the removed stdio Session implementation", () => {
    expect("Session" in sdk).toBe(false);
  });

  test("creates local app-server sessions without starting transport until use", () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "local",
      appServer: { url: "ws://127.0.0.1:4500/ws", WebSocket: FakeAppServerSocket },
    });
    const session = client.resumeSession("agent-123");

    try {
      expect(FakeAppServerSocket.instances).toHaveLength(0);
    } finally {
      session.close();
    }
  });

  test("rejects the removed local transport override", () => {
    expect(
      () =>
        new LettaAgentClient({
          backend: "local",
          transport: "stdio",
        } as never),
    ).toThrow("Local transport selection has been removed");
  });

  test("requires an explicit agent id for new sessions", () => {
    const client = new LettaAgentClient({ backend: "local" });

    expect(() => client.createSession(undefined as never)).toThrow(
      "createSession() requires a non-empty agent id",
    );
  });

  test("restricts filesystem confinement to SDK-owned local app-server processes", () => {
    const localClient = new LettaAgentClient({ backend: "local" });
    expect(() =>
      localClient.resumeSession("agent-123", {
        filesystemConfinement: "invalid" as "memory",
      }),
    ).toThrow("Invalid filesystemConfinement 'invalid'");
    const externalAppServerClient = new LettaAgentClient({
      backend: "local",
      appServer: { url: "ws://127.0.0.1:4500/ws" },
    });
    expect(() =>
      externalAppServerClient.resumeSession("agent-123", {
        filesystemConfinement: "memory",
        env: { MEMORY_DIR: "/state/memory" },
      }),
    ).toThrow("requires an SDK-owned local app-server process");

    const remoteClient = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
    });
    expect(() =>
      remoteClient.resumeSession("agent-123", {
        filesystemConfinement: "memory",
      }),
    ).toThrow("requires an SDK-owned local app-server process");

    const cloudClient = new LettaAgentClient({ backend: "cloud" });
    expect(() =>
      cloudClient.resumeSession("agent-123", {
        filesystemConfinement: "memory",
      }),
    ).toThrow('only supported with backend: "local"');
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

    const session = client.createSession("agent-123", {
      cwd: "/tmp/project",
      stateless: true,
    });
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.agentId).toBe("agent-123");
      expect(init.conversationId).toBe("conv-created");

      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        agent_id: "agent-123",
        create_conversation: { body: {} },
        cwd: "/tmp/project",
        stateless: true,
      });
      await expect(session.updateModel("openai/gpt-5.2")).rejects.toThrow(
        "unavailable in a stateless session",
      );
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

  test("registers session MCP tools through the app-server external-tool protocol", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });
    const session = client.resumeSession("agent-123", {
      cwd: process.cwd(),
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [
            // fileURLToPath, not URL.pathname: pathname percent-encodes
            // spaces and non-ASCII characters in the checkout path, which
            // breaks spawning the fixture server.
            fileURLToPath(
              new URL(
                "./dist/index.js",
                import.meta.resolve(
                  "@modelcontextprotocol/server-everything/package.json",
                ),
              ),
            ),
          ],
        },
      },
    });

    try {
      const init = await asAdvanced(session).initialize();
      expect(init.tools).toContain("mcp__fixture__echo");
      const registered = JSON.stringify(fakeControlSocket().sent[0]);
      expect(registered).toContain("mcp__fixture__echo");
      expect(registered).toContain("mcp__fixture__get-sum");
    } finally {
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
      computer: { name: "LettaDevelopers" },
    });

    expect(remoteClient.backend).toBe("remote");
    expect(cloudClient.backend).toBe("cloud");
    expect(cloudClient.computer).toEqual({ name: "LettaDevelopers" });
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

  test("rejects conflicting computer and environment selectors", () => {
    expect(() =>
      new LettaAgentClient({
        backend: "cloud",
        computer: "Work laptop",
        environment: "legacy-name",
      }),
    ).toThrow('either "computer" or deprecated "environment"');

    const client = new LettaAgentClient({ backend: "cloud" });
    expect(() =>
      client.resumeSession("agent-123", {
        computer: "Work laptop",
        environment: "legacy-name",
      }),
    ).toThrow("cannot specify both computer and deprecated environment");
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
      toolset: {
        base: "none",
        include: ["Read", "LS", "Glob", "Grep", "Read"],
      },
      allowedTools: ["Read", "LS", "Glob", "Grep", "Read"],
    });
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.agentId).toBe("agent-123");
      expect(init.conversationId).toBe("conv-created");

      const result = await asAdvanced(session).sendAndWaitForResult("hello");
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
          client_tool_allowlist: ["Read", "LS", "Glob", "Grep"],
          client_toolset: {
            base: "none",
            include: ["Read", "LS", "Glob", "Grep"],
          },
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
      await asAdvanced(session).sendAndWaitForResult("hello");

      const inputCommand = fakeControlSocket().sent.find(
        (command): command is Record<string, unknown> =>
          typeof command === "object" && command !== null && "type" in command && command.type === "input",
      );
      const payload = inputCommand?.payload as Record<string, unknown> | undefined;
      // No allowlist by default — the harness default toolset applies…
      expect(payload).not.toHaveProperty("client_tool_allowlist");
      expect(payload).not.toHaveProperty("client_toolset");
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
      await asAdvanced(session).sendAndWaitForResult("hello");

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

  // Regression: an app-server restart used to leave stream() parked forever on
  // a resolve-only promise, because sessions never subscribed to the
  // disconnect signal the transport already exposed.
  test(
    "an app-server disconnect ends a parked stream instead of hanging",
    async () => {
      FakeAppServerSocket.instances = [];
      FakeAppServerSocket.inputScenario = "hang";
      // No requestTimeoutMs: on the default path no per-turn timer is armed,
      // so the disconnect is the only thing that can settle the turn.
      const client = new LettaAgentClient({
        backend: "remote",
        url: "http://127.0.0.1:4500",
        WebSocket: FakeAppServerSocket,
      });

      const session = client.createSession("agent-123");
      try {
        await asAdvanced(session).initialize();
        await session.send("this turn never comes back");

        const messages: unknown[] = [];
        const drained = (async () => {
          for await (const message of session.stream()) messages.push(message);
        })();
        // Let the consumer park in nextMessage() before the socket dies.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // A server-side drop, not a client close: the SDK never asked for it.
        fakeStreamSocket().close();
        await drained;

        expect(messages[0]).toMatchObject({
          type: "error",
          stopReason: "stream_closed",
          errorCode: "stream_closed",
          recoverable: true,
        });
        expect(messages.at(-1)).toMatchObject({
          type: "result",
          success: false,
          errorCode: "stream_closed",
          recoverable: true,
        });
      } finally {
        FakeAppServerSocket.inputScenario = "normal";
        session.close();
      }
    },
    5000,
  );

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

  test("websocket protocol sessions wait for delayed auto-handled approval requests", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "delayedApprovalRequest";
    const decisions: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123", {
      canUseTool: (toolName, input) => {
        decisions.push({ toolName, input });
        return { behavior: "allow" };
      },
    });
    try {
      await asAdvanced(session).initialize();
      const result = await asAdvanced(session).sendAndWaitForResult("read a file");

      expect(result).toMatchObject({
        type: "result",
        success: true,
        stopReason: "end_turn",
        result: "done after delayed approval",
      });
      expect(decisions).toEqual([
        {
          toolName: "Read",
          input: { file_path: "/workspace/readme.md" },
        },
      ]);
      const approvalResponses = fakeControlSocket().sent.filter((command) => {
        const payload = (command as { payload?: { kind?: string } }).payload;
        return payload?.kind === "approval_response";
      });
      expect(approvalResponses).toHaveLength(1);
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
      const result = await asAdvanced(session).sendAndWaitForResult("use a tool");

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
      fakeStreamSocket().serverMessage({
        type: "stream_delta",
        runtime,
        delta: {
          message_type: "usage_statistics",
          total_tokens: 12,
          step_count: 1,
        },
      });
      fakeStreamSocket().serverMessage({
        type: "turn_finished",
        runtime,
        turn_id: "turn-first",
        run_id: "run-first",
        stop_reason: "end_turn",
      });
      firstMessages.push((await firstIterator.next()).value);
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
          message_type: "usage_statistics",
          total_tokens: 12,
          step_count: 1,
        },
      });
      fakeStreamSocket().serverMessage({
        type: "turn_finished",
        runtime,
        turn_id: "turn-second",
        run_id: "run-second",
        stop_reason: "end_turn",
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

  test("send() forwards a caller-supplied otid as the wire otid and client_message_id", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "normal";
    const client = new LettaAgentClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();
      await session.send("hello", { otid: "otid-from-caller" });

      const inputCommand = fakeControlSocket().sent.find(
        (sent) => (sent as { type?: string }).type === "input",
      ) as { payload: { messages: Array<Record<string, unknown>> } } | undefined;
      expect(inputCommand?.payload.messages[0]).toMatchObject({
        role: "user",
        content: "hello",
        otid: "otid-from-caller",
        client_message_id: "otid-from-caller",
      });
    } finally {
      session.close();
    }
  });

  test("send() generates a client message id and omits otid when the caller supplies none", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "normal";
    const client = new LettaAgentClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();
      await session.send("hello");

      const inputCommand = fakeControlSocket().sent.find(
        (sent) => (sent as { type?: string }).type === "input",
      ) as { payload: { messages: Array<Record<string, unknown>> } } | undefined;
      const message = inputCommand?.payload.messages[0];
      expect(typeof message?.client_message_id).toBe("string");
      expect(message?.client_message_id as string).toMatch(/^sdk-message-/);
      expect(message).not.toHaveProperty("otid");
    } finally {
      session.close();
    }
  });

  test("send() rejects an empty caller-supplied otid", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.inputScenario = "normal";
    const client = new LettaAgentClient({
      backend: "remote",
      url: "http://127.0.0.1:4500",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.createSession("agent-123");
    try {
      await asAdvanced(session).initialize();
      await expect(session.send("hello", { otid: "   " })).rejects.toThrow(
        "send() otid must be a non-empty string",
      );
      expect(
        fakeControlSocket().sent.some((sent) => (sent as { type?: string }).type === "input"),
      ).toBe(false);
    } finally {
      session.close();
    }
  });

  test("a caller-supplied otid is the correlation id on queued message updates", async () => {
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
      await session.send("second message", { otid: "otid-queued" });

      const iterator = session.stream();
      expect((await iterator.next()).value).toMatchObject({
        type: "assistant",
        content: "first response",
      });
      expect((await iterator.next()).value).toMatchObject({
        type: "queue_update",
        queue: [expect.objectContaining({ clientMessageId: "otid-queued" })],
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
        pin_global: true,
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

  test("creates remote app-server agents with an explicit pinning preference", async () => {
    for (const pinGlobalAgent of [true, false]) {
      FakeAppServerSocket.instances = [];
      const client = new LettaAgentClient({
        backend: "remote",
        url: "ws://127.0.0.1:4500/ws",
        WebSocket: FakeAppServerSocket,
        pinGlobalAgent,
      });

      await client.createAgent();

      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        create_agent: { pin_global: pinGlobalAgent },
      });
    }
  });

  test("hidden remote app-server agents default to unpinned", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    await client.createAgent({ hidden: true });

    expect(fakeControlSocket().sent[0]).toMatchObject({
      type: "runtime_start",
      create_agent: { pin_global: false },
    });
  });

  test("forwards local app-server agent pinning preferences", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "local",
      appServer: {
        url: "ws://127.0.0.1:4500/ws",
        WebSocket: FakeAppServerSocket,
        pinGlobalAgent: false,
      },
    });

    await client.createAgent();

    expect(fakeControlSocket().sent[0]).toMatchObject({
      type: "runtime_start",
      create_agent: { pin_global: false },
    });
  });

  test("createAgent uses the canonical server-tool defaults when baseTools is omitted", async () => {
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
    expect(command.create_agent?.body).toMatchObject({
      tools: ["web_search", "fetch_webpage"],
      include_base_tools: false,
      include_base_tool_rules: false,
    });
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

  test("default toolset contract: canonical creation pins server defaults and turns use harness client tools", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    // 1. Creation pins the canonical server-side defaults and disables the
    //    API's legacy base-tool union.
    const agentId = await client.createAgent({
      model: "anthropic/claude-sonnet-4",
    });
    const createCommand = fakeControlSocket().sent[0] as {
      create_agent?: { body?: Record<string, unknown> };
    };
    expect(createCommand.create_agent?.body).toMatchObject({
      tools: ["web_search", "fetch_webpage"],
      include_base_tools: false,
      include_base_tool_rules: false,
    });

    // 2. Every turn keeps the harness default toolset (no pinned allowlist)
    //    and excludes interactive user-input tools via the protocol flag.
    FakeAppServerSocket.instances = [];
    const session = client.createSession(agentId);
    try {
      await asAdvanced(session).initialize();
      await asAdvanced(session).sendAndWaitForResult("hello");

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

  test("concurrent listMessages and send on a fresh session share one initialize", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("conv-abc");
    try {
      const [page] = await Promise.all([
        session.listMessages({ limit: 2 }),
        session.send("hello"),
      ]);
      expect(page.messages).toHaveLength(2);

      // Exactly one app-server client: the second caller joins the in-flight
      // initialize instead of opening another connection.
      expect(FakeAppServerSocket.instances).toHaveLength(
        expectedAppServerSocketCount(),
      );
      const sent = fakeControlSocket().sent as Array<{ type?: string }>;
      expect(sent.filter((cmd) => cmd.type === "conversation_retrieve")).toHaveLength(1);
      expect(sent.filter((cmd) => cmd.type === "runtime_start")).toHaveLength(1);
    } finally {
      session.close();
    }
  });

  test("concurrent initialize callers resolve from the same attempt", async () => {
    FakeAppServerSocket.instances = [];
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("conv-abc");
    try {
      const [first, second] = await Promise.all([
        asAdvanced(session).initialize(),
        asAdvanced(session).initialize(),
      ]);
      expect(first).toEqual(second);
      expect(first.conversationId).toBe("conv-abc");
      expect(FakeAppServerSocket.instances).toHaveLength(
        expectedAppServerSocketCount(),
      );
      await expect(asAdvanced(session).initialize()).rejects.toThrow(
        "Session already initialized",
      );
    } finally {
      session.close();
    }
  });

  test("lazy callers wait until post-initialize options finish", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.deferReflectionSettingsResponse = true;
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      dreaming: { trigger: "step-count", stepCount: 3 },
    });
    try {
      const initialize = asAdvanced(session).initialize();
      for (let i = 0; i < 100; i++) {
        if (FakeAppServerSocket.pendingReflectionSettingsResponse) break;
        await Promise.resolve();
      }
      expect(FakeAppServerSocket.pendingReflectionSettingsResponse).not.toBeNull();

      const listMessages = session.listMessages({ limit: 1 });
      await Promise.resolve();
      expect(
        fakeControlSocket().sent.filter(
          (command) =>
            (command as { type?: string }).type ===
            "conversation_messages_list",
        ),
      ).toHaveLength(0);

      FakeAppServerSocket.pendingReflectionSettingsResponse?.();
      const [, page] = await Promise.all([initialize, listMessages]);
      expect(page.messages).toHaveLength(2);
    } finally {
      FakeAppServerSocket.deferReflectionSettingsResponse = false;
      FakeAppServerSocket.pendingReflectionSettingsResponse = null;
      session.close();
    }
  });

  test("failed post-initialize work clears partial session metadata", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.failNextReflectionSettings = true;
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      dreaming: { trigger: "step-count", stepCount: 3 },
    });
    try {
      await expect(asAdvanced(session).initialize()).rejects.toThrow(
        "reflection settings failed (fake)",
      );
      expect(session.agentId).toBeNull();
      expect(session.sessionId).toBeNull();
      expect(session.conversationId).toBeNull();

      const init = await asAdvanced(session).initialize();
      expect(init.agentId).toBe("agent-123");
    } finally {
      FakeAppServerSocket.failNextReflectionSettings = false;
      session.close();
    }
  });

  test("closing during initialization cannot resurrect the session", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.deferReflectionSettingsResponse = true;
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123", {
      dreaming: { trigger: "step-count", stepCount: 3 },
    });
    try {
      const initialize = asAdvanced(session).initialize();
      for (let i = 0; i < 100; i++) {
        if (FakeAppServerSocket.pendingReflectionSettingsResponse) break;
        await Promise.resolve();
      }
      expect(FakeAppServerSocket.pendingReflectionSettingsResponse).not.toBeNull();

      session.close();
      FakeAppServerSocket.pendingReflectionSettingsResponse?.();
      await expect(initialize).rejects.toThrow();
      await expect(asAdvanced(session).initialize()).rejects.toThrow(
        "Session is closed",
      );
      expect(session.agentId).toBeNull();
      expect(session.sessionId).toBeNull();
      expect(session.conversationId).toBeNull();
    } finally {
      FakeAppServerSocket.deferReflectionSettingsResponse = false;
      FakeAppServerSocket.pendingReflectionSettingsResponse = null;
      session.close();
    }
  });

  test("request ids never collide across two concurrent client instances", async () => {
    FakeAppServerSocket.instances = [];
    const makeClient = () =>
      new LettaAgentClient({
        backend: "remote",
        url: "ws://127.0.0.1:4500/ws",
        WebSocket: FakeAppServerSocket,
      });

    const sessionA = makeClient().resumeSession("conv-abc");
    const sessionB = makeClient().resumeSession("conv-abc");
    try {
      await Promise.all([
        asAdvanced(sessionA).initialize(),
        asAdvanced(sessionB).initialize(),
      ]);

      const requestIds = FakeAppServerSocket.instances
        .flatMap((socket) => socket.sent as Array<{ request_id?: unknown }>)
        .map((cmd) => cmd.request_id)
        .filter((id): id is string => typeof id === "string");
      // Both sessions send conversation_retrieve + runtime_start; per-client
      // counters restarting at 1 would collide here (conversation_retrieve-1).
      expect(requestIds.length).toBeGreaterThanOrEqual(4);
      expect(new Set(requestIds).size).toBe(requestIds.length);
    } finally {
      sessionA.close();
      sessionB.close();
    }
  });

  test("a failed initialize clears the single-flight memo so a retry succeeds", async () => {
    FakeAppServerSocket.instances = [];
    FakeAppServerSocket.failNextRuntimeStart = true;
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    const session = client.resumeSession("agent-123");
    try {
      await expect(asAdvanced(session).initialize()).rejects.toThrow(
        "runtime start failed (fake)",
      );

      // The failure must not close the session; a retry opens a fresh
      // connection and completes.
      const init = await asAdvanced(session).initialize();
      expect(init.agentId).toBe("agent-123");
      const page = await session.listMessages();
      expect(page.messages).toHaveLength(2);
    } finally {
      FakeAppServerSocket.failNextRuntimeStart = false;
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
      await asAdvanced(session).sendAndWaitForResult("hello");
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

      await asAdvanced(session).sendAndWaitForResult("hello");
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

      // Device status: every getter performs a correlated, authoritative sync.
      FakeAppServerSocket.deviceStatusOnSync = true;
      const seenStatuses: SessionDeviceStatus[] = [];
      const unsubscribe = session.onDeviceStatus((status) => seenStatuses.push(status));
      const deviceStatus = await session.getDeviceStatus();
      expect(deviceStatus).toMatchObject({
        isOnline: true,
        isProcessing: false,
        permissionMode: "acceptEdits",
        workingDirectory: "/workspace/project",
        memoryDirectory: "/memory/agent-123",
        pendingControlRequests: [
          {
            requestId: "approval-1",
            toolName: "Bash",
            toolCallId: "call-1",
            toolInput: { command: "pwd" },
            permissionSuggestions: [
              { id: "allow-pwd", text: "Always allow pwd" },
            ],
            blockedPath: "/workspace/project",
            diffs: [
              {
                mode: "fallback",
                fileName: "project",
                reason: "Not a file edit",
              },
            ],
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

      // A second read must not reuse the pre-foreground snapshot.
      const syncsSoFar = fakeControlSocket().sent.filter(
        (command) => (command as { type?: string }).type === "sync",
      ).length;
      expect(await session.getDeviceStatus()).toMatchObject({
        permissionMode: "acceptEdits",
        workingDirectory: "/workspace/project",
        memoryDirectory: "/memory/agent-123",
      });
      expect(fakeControlSocket().sent.filter(
        (command) => (command as { type?: string }).type === "sync",
      )).toHaveLength(syncsSoFar + 1);
      expect(seenStatuses).toHaveLength(2);

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
      expect(seenStatuses).toHaveLength(2);
      // Even though a newer-looking push was observed while backgrounded, a
      // getter forces the runtime to replay its authoritative current state.
      expect(await session.getDeviceStatus()).toMatchObject({
        permissionMode: "acceptEdits",
        isProcessing: false,
        workingDirectory: "/workspace/project",
      });
      await expect(session.getDeviceStatus({ timeoutMs: 0 })).rejects.toThrow(
        "Invalid device status timeout",
      );
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

  test("websocket protocol sessions reject unsupported options", () => {
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://127.0.0.1:4500/ws",
      WebSocket: FakeAppServerSocket,
    });

    expect(() =>
      client.resumeSession(
        "agent-123",
        { dreaming: { behavior: "auto-launch" } } as never,
      ),
    ).toThrow("dreaming.behavior is not supported");
  });


  test("keeps environment out of createAgent payloads", async () => {
    const client = new LettaAgentClient({ backend: "local" });

    await expect(
      client.createAgent({ environment: "work-laptop" } as never),
    ).rejects.toThrow("createAgent() does not accept environment");
  });
});
