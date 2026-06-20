import { describe, expect, test } from "bun:test";
import { LettaCodeClient } from "../index.js";
import { asAdvanced } from "./advanced-session.js";

type Listener = (event: unknown) => void;
type FetchInput = Parameters<typeof fetch>[0];

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function urlOf(input: FetchInput | URL): string {
  return input instanceof URL ? input.toString() : String(input);
}

function headersOf(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function bodyOf(init?: RequestInit): unknown {
  if (!init?.body) return undefined;
  return JSON.parse(String(init.body));
}

function createCloudFetchMock(
  requests: RecordedRequest[],
  environmentConnections?: Array<Record<string, unknown>>,
): typeof fetch {
  return ((input: FetchInput | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      headers: headersOf(init),
      body: bodyOf(init),
    });

    if (parsed.pathname === "/v1/agents/" && method === "POST") {
      return Promise.resolve(jsonResponse({ id: "agent-created" }));
    }

    if (parsed.pathname === "/v1/conversations/" && method === "POST") {
      return Promise.resolve(jsonResponse({ id: "conv-created", agent_id: parsed.searchParams.get("agent_id") }));
    }

    if (parsed.pathname === "/v1/conversations/conv-1" && method === "GET") {
      return Promise.resolve(jsonResponse({ id: "conv-1", agent_id: "agent-from-conv" }));
    }

    if (parsed.pathname === "/v1/environments" && method === "GET") {
      return Promise.resolve(jsonResponse({
        connections: environmentConnections ?? [
          {
            id: "env-explicit",
            connectionId: "conn-explicit",
            deviceId: "device-explicit",
            connectionName: "explicit-env",
            connectedAt: 1,
          },
        ],
        hasNextPage: false,
      }));
    }

    return Promise.resolve(jsonResponse({ message: `unexpected ${method} ${parsed.pathname}` }, { status: 404 }));
  }) as typeof fetch;
}

class FakeCloudSocket {
  static instances: FakeCloudSocket[] = [];
  static scenario:
    | "normal"
    | "approval"
    | "terminal_error"
    | "stale_idle_then_error"
    | "duplicate_idempotency" = "normal";
  static syncSucceeds = true;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeCloudSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  static socket(channel: "control" | "stream"): FakeCloudSocket | undefined {
    return FakeCloudSocket.instances.find((socket) => socket.channel === channel);
  }

  static allSent(): Array<Record<string, unknown>> {
    return FakeCloudSocket.instances.flatMap((socket) => socket.sent);
  }

  get channel(): "control" | "stream" | null {
    const channel = new URL(this.url).searchParams.get("channel");
    return channel === "control" || channel === "stream" ? channel : null;
  }

  send(data: string): void {
    const command = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(command);
    this.fakeDeviceHandle(command);
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

  serverMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private fakeDeviceHandle(command: Record<string, unknown>): void {
    if (command.type === "runtime_start") {
      const runtime = {
        agent_id: typeof command.agent_id === "string" ? command.agent_id : "agent-1",
        conversation_id: typeof command.conversation_id === "string" ? command.conversation_id : "default",
      };
      this.serverMessage({
        type: "runtime_start_response",
        request_id: command.request_id,
        success: true,
        runtime,
        agent: { id: runtime.agent_id, model: "anthropic/claude-sonnet-4" },
        conversation: { id: runtime.conversation_id, agent_id: runtime.agent_id },
      });
      return;
    }

    if (command.type === "sync" && typeof command.request_id === "string") {
      this.serverMessage({
        type: "sync_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: FakeCloudSocket.syncSucceeds,
        ...(FakeCloudSocket.syncSucceeds ? {} : { error: "sync failed" }),
      });
      return;
    }

    if (command.type === "conversation_messages_list") {
      this.serverMessage({
        type: "conversation_messages_list_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: true,
        messages: [{ id: "msg-from-runtime" }],
      });
      return;
    }

    if (command.type === "set_reflection_settings") {
      this.serverMessage({
        type: "set_reflection_settings_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: true,
      });
      return;
    }

    if (command.type === "update_model") {
      this.serverMessage({
        type: "update_model_response",
        request_id: command.request_id,
        success: true,
        model_handle: (command.payload as Record<string, unknown> | undefined)?.model_handle,
      });
      return;
    }

    if (command.type === "update_toolset") {
      this.serverMessage({
        type: "update_toolset_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: true,
        current_toolset_preference: command.toolset_preference,
      });
      return;
    }

    if (command.type !== "input") return;
    const runtime = command.runtime;
    const payload = command.payload as Record<string, unknown> | undefined;

    if (payload?.kind === "create_message" && FakeCloudSocket.scenario === "approval") {
      this.serverMessageTo("control", {
        type: "control_request",
        runtime,
        request_id: "approval-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "pwd" },
        },
      });
      return;
    }

    if (payload?.kind === "create_message" && FakeCloudSocket.scenario === "terminal_error") {
      this.finishTurnWithTerminalError(runtime);
      return;
    }

    if (payload?.kind === "create_message" && FakeCloudSocket.scenario === "stale_idle_then_error") {
      this.finishTurnAfterStaleIdle(runtime);
      return;
    }

    if (payload?.kind === "create_message" && FakeCloudSocket.scenario === "duplicate_idempotency") {
      this.finishTurnWithDuplicateIdempotency(runtime);
      return;
    }

    if (payload?.kind === "approval_response") {
      this.finishTurn(runtime, "approved");
      return;
    }

    if (payload?.kind === "create_message") {
      this.finishTurn(runtime, "hello from cloud");
    }
  }

  private finishTurn(runtime: unknown, content: string): void {
    this.serverMessageTo("stream", {
      type: "stream_delta",
      seq: 101,
      event_seq: 1,
      runtime,
      delta: {
        id: "msg-cloud",
        message_type: "assistant_message",
        content,
        run_id: "run-cloud",
      },
    });
    this.serverMessageTo("stream", {
      type: "update_loop_status",
      seq: 102,
      event_seq: 2,
      runtime,
      loop_status: {
        status: "WAITING_ON_INPUT",
        active_run_ids: ["run-cloud"],
      },
    });
  }

  private finishTurnWithDuplicateIdempotency(runtime: unknown): void {
    const assistantFrame = {
      type: "stream_delta",
      idempotency_key: "assistant-dup",
      runtime,
      delta: {
        id: "msg-cloud-dup",
        message_type: "assistant_message",
        content: "hello once",
        run_id: "run-cloud",
      },
    };
    this.serverMessageTo("stream", { ...assistantFrame, seq: 401, event_seq: 1 });
    this.serverMessageTo("stream", { ...assistantFrame, seq: 402, event_seq: 1 });
    this.serverMessageTo("stream", {
      type: "update_loop_status",
      seq: 403,
      event_seq: 2,
      runtime,
      loop_status: {
        status: "WAITING_ON_INPUT",
        active_run_ids: ["run-cloud"],
      },
    });
  }

  private finishTurnWithTerminalError(runtime: unknown): void {
    this.serverMessageTo("stream", {
      type: "update_loop_status",
      seq: 201,
      event_seq: 1,
      runtime,
      loop_status: {
        status: "WAITING_ON_INPUT",
        active_run_ids: [],
      },
    });
    this.serverMessageTo("stream", {
      type: "stream_delta",
      seq: 202,
      event_seq: 2,
      runtime,
      delta: {
        id: "msg-error",
        message_type: "loop_error",
        message: "cloud turn failed",
        stop_reason: "error",
        is_terminal: true,
      },
    });
  }

  private finishTurnAfterStaleIdle(runtime: unknown): void {
    this.serverMessageTo("stream", {
      type: "update_loop_status",
      seq: 301,
      event_seq: 1,
      runtime,
      loop_status: {
        status: "WAITING_ON_INPUT",
        active_run_ids: [],
      },
    });
    setTimeout(() => {
      this.serverMessageTo("stream", {
        type: "update_loop_status",
        seq: 302,
        event_seq: 2,
        runtime,
        loop_status: {
          status: "SENDING_API_REQUEST",
          active_run_ids: [],
        },
      });
      this.serverMessageTo("stream", {
        type: "update_loop_status",
        seq: 303,
        event_seq: 3,
        runtime,
        loop_status: {
          status: "WAITING_ON_INPUT",
          active_run_ids: [],
        },
      });
      this.serverMessageTo("stream", {
        type: "stream_delta",
        seq: 304,
        event_seq: 4,
        runtime,
        delta: {
          id: "msg-delayed-error",
          message_type: "loop_error",
          message: "delayed cloud turn failed",
          stop_reason: "error",
          is_terminal: true,
        },
      });
    }, 150);
  }

  private serverMessageTo(channel: "control" | "stream", message: unknown): void {
    (FakeCloudSocket.socket(channel) ?? this).serverMessage(message);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function resetFakeCloud(): void {
  FakeCloudSocket.instances = [];
  FakeCloudSocket.scenario = "normal";
  FakeCloudSocket.syncSucceeds = true;
}

class FakeAppServerSocket {
  static instances: FakeAppServerSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeAppServerSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  send(data: string): void {
    const command = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(command);

    if (command.type === "runtime_start") {
      this.serverMessage({
        type: "runtime_start_response",
        request_id: command.request_id,
        success: true,
        runtime: { agent_id: "agent-created", conversation_id: "conv-created" },
        agent: { id: "agent-created", model: "anthropic/claude-sonnet-4" },
        conversation: { id: "conv-created", agent_id: "agent-created" },
      });
    }

    if (command.type === "enable_memfs") {
      this.serverMessage({
        type: "enable_memfs_response",
        request_id: command.request_id,
        success: true,
      });
    }
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

  private serverMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function resetFakeAppServer(): void {
  FakeAppServerSocket.instances = [];
}

describe("CloudEnvironmentSession", () => {
  test("requires an explicit environment while SDK-managed Cloud sandboxes are unavailable", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
    });

    const session = client.resumeSession("agent-1");
    await expect(asAdvanced(session).initialize()).rejects.toThrow(
      "Cloud backend requires an environment target until managed Cloud sandboxes land",
    );

    await expect(asAdvanced(client.createSession("agent-1")).initialize()).rejects.toThrow(
      "Cloud backend requires an environment target until managed Cloud sandboxes land",
    );
    await expect(asAdvanced(client.resumeSession("conv-1")).initialize()).rejects.toThrow(
      "Cloud backend requires an environment target until managed Cloud sandboxes land",
    );

    expect(requests).toHaveLength(0);
    expect(FakeCloudSocket.instances).toHaveLength(0);
  });

  test("uses an explicit environment before using the Remote Client websocket", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1", {
      model: "anthropic/claude-sonnet-4",
      cwd: "/repo",
      permissionMode: "bypassPermissions",
      sleeptime: { trigger: "step-count", stepCount: 3 },
    });
    const init = await asAdvanced(session).initialize();

    expect(init).toMatchObject({
      type: "init",
      agentId: "agent-1",
      conversationId: "default",
    });
    expect(requests.some((request) => new URL(request.url).pathname.includes("/sandboxes"))).toBe(false);

    const controlSocket = FakeCloudSocket.socket("control")!;
    const streamSocket = FakeCloudSocket.socket("stream")!;
    const wsUrl = new URL(controlSocket.url);
    expect(wsUrl.protocol).toBe("wss:");
    expect(wsUrl.pathname).toBe("/v1/environments/conn-explicit/status/ws");
    expect(wsUrl.searchParams.get("agentId")).toBe("agent-1");
    expect(wsUrl.searchParams.get("conversationId")).toBe("default");
    expect(wsUrl.searchParams.get("channel")).toBe("control");
    expect(new URL(streamSocket.url).searchParams.get("channel")).toBe("stream");
    expect(wsUrl.searchParams.has("token")).toBe(false);
    expect(controlSocket.options?.headers?.Authorization).toBe("Bearer sk-test");
    expect(streamSocket.options?.headers?.Authorization).toBe("Bearer sk-test");
    expect(controlSocket.sent[0]).toMatchObject({
      type: "runtime_start",
      agent_id: "agent-1",
      conversation_id: "default",
      recover_approvals: false,
      force_device_status: true,
      mode: "unrestricted",
      cwd: "/repo",
    });
    expect(controlSocket.sent).toContainEqual(expect.objectContaining({
      type: "set_reflection_settings",
      settings: { trigger: "step-count", step_count: 3 },
      scope: "both",
    }));
    expect(controlSocket.sent).toContainEqual(expect.objectContaining({
      type: "update_model",
      payload: { model_handle: "anthropic/claude-sonnet-4" },
    }));
    expect(controlSocket.sent.some((command) => command.type === "change_device_state")).toBe(false);

    await asAdvanced(session).updateToolset("developer");
    expect(controlSocket.sent).toContainEqual(expect.objectContaining({
      type: "update_toolset",
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      toolset_preference: "developer",
    }));

    await expect(asAdvanced(session).recoverPendingApprovals({ timeoutMs: 1_000 })).resolves.toEqual({
      recovered: true,
      unsupported: false,
    });
    expect(controlSocket.sent.some((command) => command.type === "recover_pending_approvals")).toBe(false);
    expect(controlSocket.sent).toContainEqual(expect.objectContaining({
      type: "sync",
      recover_approvals: true,
      force_device_status: true,
      request_id: expect.any(String),
    }));

    const result = await asAdvanced(session).runTurn("hello");
    expect(result).toMatchObject({
      type: "result",
      success: true,
      result: "hello from cloud",
      conversationId: "default",
      runIds: ["run-cloud"],
    });
    const inputCommand = controlSocket.sent.find((command) => command.type === "input")!;
    expect(inputCommand).toMatchObject({
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      payload: {
        kind: "create_message",
        messages: [expect.objectContaining({ role: "user", content: "hello" })],
      },
    });
    expect(inputCommand.payload).not.toHaveProperty("supports_control_response");
    expect(inputCommand.payload).not.toHaveProperty("source");
    expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 101 });
    expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 102 });

    session.close();
  });

  test("attaches to an explicit environment without creating a sandbox", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      webSocketAuth: "query",
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    await asAdvanced(session).initialize();

    expect(requests.some((request) => new URL(request.url).pathname.includes("/sandboxes"))).toBe(false);
    const socketUrl = new URL(FakeCloudSocket.instances[0]!.url);
    expect(socketUrl.pathname).toBe("/v1/environments/conn-explicit/status/ws");
    expect(socketUrl.searchParams.get("token")).toBe("sk-test");
    expect(FakeCloudSocket.instances[0]!.options).toBeUndefined();
    expect(new URL(FakeCloudSocket.socket("control")!.url).searchParams.get("token")).toBe("sk-test");
    expect(new URL(FakeCloudSocket.socket("stream")!.url).searchParams.get("token")).toBe("sk-test");
    expect(FakeCloudSocket.socket("control")!.options).toBeUndefined();
    expect(FakeCloudSocket.socket("stream")!.options).toBeUndefined();
    session.close();
  });

  test("acks duplicate Cloud idempotency frames but emits them once", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "duplicate_idempotency";
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    try {
      const result = await asAdvanced(session).runTurn("hello");
      expect(result).toMatchObject({
        success: true,
        result: "hello once",
      });
      const streamSocket = FakeCloudSocket.socket("stream")!;
      expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 401 });
      expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 402 });
      expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 403 });
    } finally {
      session.close();
    }
  });

  test("surfaces failed Cloud sync recovery responses", async () => {
    resetFakeCloud();
    FakeCloudSocket.syncSucceeds = false;
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    try {
      await asAdvanced(session).initialize();
      await expect(asAdvanced(session).recoverPendingApprovals({ timeoutMs: 1_000 })).resolves.toEqual({
        recovered: false,
        unsupported: false,
        detail: "sync failed",
      });
    } finally {
      session.close();
    }
  });

  test("sends recovery sync on Cloud stream event sequence gaps", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    try {
      await asAdvanced(session).initialize();
      const controlSocket = FakeCloudSocket.socket("control")!;
      const streamSocket = FakeCloudSocket.socket("stream")!;
      const syncCount = controlSocket.sent.filter((command) => command.type === "sync").length;
      streamSocket.serverMessage({
        type: "update_loop_status",
        seq: 501,
        event_seq: 1,
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
      });
      streamSocket.serverMessage({
        type: "update_loop_status",
        seq: 502,
        event_seq: 3,
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
      });
      expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 501 });
      expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 502 });
      expect(controlSocket.sent.filter((command) => command.type === "sync").length).toBe(syncCount + 1);
      expect(controlSocket.sent.at(-1)).toMatchObject({
        type: "sync",
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        recover_approvals: true,
        force_device_status: true,
      });
    } finally {
      session.close();
    }
  });

  test("lists default-conversation messages through runtime protocol instead of Cloud REST", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    try {
      const page = await session.listMessages({ limit: 1 });
      expect(page.messages).toEqual([{ id: "msg-from-runtime" }]);
      expect(page.hasMore).toBeUndefined();
      expect(page.nextBefore).toBeUndefined();
      expect(requests.some((request) =>
        new URL(request.url).pathname === "/v1/conversations/default/messages"
      )).toBe(false);
      expect(FakeCloudSocket.socket("control")!.sent).toContainEqual(expect.objectContaining({
        type: "conversation_messages_list",
        conversation_id: "default",
        query: { limit: 1 },
      }));
    } finally {
      session.close();
    }
  });

  test("lists resumed conversation messages through runtime protocol instead of Cloud REST", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("conv-1");
    try {
      const page = await session.listMessages({ limit: 2, order: "desc" });
      expect(page.messages).toEqual([{ id: "msg-from-runtime" }]);
      expect(
        requests.some((request) =>
          new URL(request.url).pathname === "/v1/conversations/conv-1/messages"
        ),
      ).toBe(false);
      expect(FakeCloudSocket.socket("control")!.sent).toContainEqual(
        expect.objectContaining({
          type: "conversation_messages_list",
          conversation_id: "conv-1",
          query: { order: "desc", limit: 2 },
        }),
      );
    } finally {
      session.close();
    }
  });

  test("lists explicit Cloud conversation ids through runtime protocol instead of Cloud REST", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    try {
      const page = await session.listMessages({ conversationId: "conv-explicit", limit: 1 });
      expect(page.messages).toEqual([{ id: "msg-from-runtime" }]);
      expect(
        requests.some((request) =>
          new URL(request.url).pathname === "/v1/conversations/conv-explicit/messages"
        ),
      ).toBe(false);
      expect(FakeCloudSocket.socket("control")!.sent).toContainEqual(
        expect.objectContaining({
          type: "conversation_messages_list",
          conversation_id: "conv-explicit",
          query: { limit: 1 },
        }),
      );
    } finally {
      session.close();
    }
  });

  test("bootstraps resumed Cloud conversations from runtime history", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("conv-1");
    try {
      const state = await asAdvanced(session).bootstrapState({ limit: 3 });
      expect(state).toMatchObject({
        agentId: "agent-from-conv",
        conversationId: "conv-1",
        messages: [{ id: "msg-from-runtime" }],
      });
      expect(state.hasMore).toBeUndefined();
      expect(state.nextBefore).toBeUndefined();
      expect(state).not.toHaveProperty("hasPendingApproval");
      expect(state).not.toHaveProperty("timings");
      expect(
        requests.some((request) =>
          new URL(request.url).pathname === "/v1/conversations/conv-1/messages"
        ),
      ).toBe(false);
      expect(FakeCloudSocket.socket("control")!.sent).toContainEqual(
        expect.objectContaining({
          type: "conversation_messages_list",
          conversation_id: "conv-1",
          query: { limit: 3 },
        }),
      );
    } finally {
      session.close();
    }
  });

  test("uses bearer auth from headers for Cloud REST, environment polling, and websocket upgrades", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      headers: { Authorization: "Bearer sk-header", "x-project-id": "project-1" },
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: "explicit-env",
    });

    const session = client.resumeSession("agent-1");
    await asAdvanced(session).initialize();

    const environmentRequest = requests.find((request) => new URL(request.url).pathname === "/v1/environments");
    expect(requests.some((request) => new URL(request.url).pathname.includes("/sandboxes"))).toBe(false);
    expect(environmentRequest?.headers.authorization).toBe("Bearer sk-header");
    expect(environmentRequest?.headers["x-project-id"]).toBe("project-1");
    expect(FakeCloudSocket.socket("control")!.options?.headers).toEqual({
      Authorization: "Bearer sk-header",
      "x-project-id": "project-1",
    });
    expect(FakeCloudSocket.socket("stream")!.options?.headers).toEqual({
      Authorization: "Bearer sk-header",
      "x-project-id": "project-1",
    });

    session.close();
  });

  test("creates Cloud agents through the local app-server harness", async () => {
    resetFakeCloud();
    resetFakeAppServer();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      appServer: {
        url: "ws://app-server.test/ws",
        WebSocket: FakeAppServerSocket,
        requestTimeoutMs: 1_000,
      },
    });

    await expect(client.createAgent({
      model: "anthropic/claude-sonnet-4",
      systemPrompt: "You are a repo assistant.",
      memory: [{ label: "project", value: "Use Bun." }],
      tags: ["team:sdk"],
    })).resolves.toBe("agent-created");

    expect(requests).toHaveLength(0);
    const controlSocket = FakeAppServerSocket.instances.find((socket) => new URL(socket.url).searchParams.get("channel") === "control")!;
    const runtimeStart = controlSocket.sent.find((command) => command.type === "runtime_start")!;
    expect(runtimeStart).toMatchObject({
      create_agent: {
        pin_global: true,
        body: {
          model: "anthropic/claude-sonnet-4",
          system: "You are a repo assistant.",
          memory_blocks: [{ label: "project", value: "Use Bun." }],
        },
      },
    });
    expect((runtimeStart.create_agent as { body: Record<string, unknown> }).body.tags).toEqual([
      "team:sdk",
      "origin:letta-code",
    ]);
    expect(controlSocket.sent).toContainEqual(expect.objectContaining({ type: "enable_memfs" }));

    await expect(client.createAgent({ systemPrompt: "default" })).rejects.toThrow(
      "App-server createAgent() does not yet support system prompt presets",
    );
  });

  test("responds to Remote Client approval requests through canUseTool", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "approval";
    const requests: RecordedRequest[] = [];
    const decisions: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1", {
      canUseTool: (toolName, input) => {
        decisions.push({ toolName, input });
        return { behavior: "allow", updatedInput: { command: "echo approved" } };
      },
    });

    const result = await asAdvanced(session).runTurn("run pwd");

    expect(result).toMatchObject({ success: true, result: "approved" });
    expect(decisions).toEqual([{ toolName: "Bash", input: { command: "pwd" } }]);
    const approvalCommand = FakeCloudSocket.socket("control")!.sent.find((command) => {
      const payload = command.payload as Record<string, unknown> | undefined;
      return command.type === "input" && payload?.kind === "approval_response";
    });
    expect(approvalCommand).toMatchObject({
      payload: {
        kind: "approval_response",
        request_id: "approval-1",
        decision: {
          behavior: "allow",
          updated_input: { command: "echo approved" },
          selected_permission_suggestion_ids: [],
        },
      },
    });

    session.close();
  });

  test("executes SDK-hosted external tool requests from the Cloud websocket", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1", {
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
        {
          name: "throw_ticket",
          label: "Throw ticket",
          description: "Always throws",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            throw new Error("tool exploded");
          },
        },
      ],
    });

    try {
      const init = await asAdvanced(session).initialize();
      expect(init.tools).toBeUndefined();

      const controlSocket = FakeCloudSocket.socket("control")!;
      const runtimeStart = controlSocket.sent.find((command) => command.type === "runtime_start")!;
      expect(runtimeStart).toMatchObject({
        external_tools: [
          {
            tools: expect.arrayContaining([
              expect.objectContaining({
                name: "lookup_ticket",
                label: "Lookup ticket",
                description: "Lookup a ticket by id",
                parameters: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
              }),
              expect.objectContaining({ name: "throw_ticket" }),
            ]),
          },
        ],
      });
      controlSocket.serverMessage({
        type: "external_tool_call_request",
        request_id: "external-tool-1",
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        tool_call_id: "tool-call-1",
        tool_name: "lookup_ticket",
        input: { id: "LET-9239" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(controlSocket.sent.at(-1)).toMatchObject({
        type: "external_tool_call_response",
        request_id: "external-tool-1",
        result: {
          content: [{ type: "text", text: "tool-call-1:LET-9239" }],
        },
      });

      controlSocket.serverMessage({
        type: "external_tool_call_request",
        request_id: "external-tool-missing",
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        tool_call_id: "tool-call-missing",
        tool_name: "missing_ticket",
        input: {},
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(controlSocket.sent.at(-1)).toMatchObject({
        type: "external_tool_call_response",
        request_id: "external-tool-missing",
        error: "Unknown external tool: missing_ticket",
      });

      controlSocket.serverMessage({
        type: "external_tool_call_request",
        request_id: "external-tool-thrown",
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        tool_call_id: "tool-call-thrown",
        tool_name: "throw_ticket",
        input: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controlSocket.sent.at(-1)).toMatchObject({
        type: "external_tool_call_response",
        request_id: "external-tool-thrown",
        error: "tool exploded",
      });
    } finally {
      session.close();
    }
  });

  test("rejects SDK-managed sandbox options until Cloud sandbox support lands", () => {
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      environment: { connectionId: "conn-explicit" },
    });

    expect(() => client.resumeSession("agent-1", {
      sandbox: { lifecycle: "ephemeral" },
    } as never)).toThrow(
      "does not accept SDK-managed sandbox options yet",
    );
    expect(() => client.createSession("agent-1", {
      sandbox: { lifecycle: "ephemeral" },
    } as never)).toThrow(
      "does not accept SDK-managed sandbox options yet",
    );

    expect(() => new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      sandbox: { lifecycle: "ephemeral" },
    } as never)).toThrow(
      "Cloud backend SDK-managed sandboxes are not available yet",
    );
  });

  test("reports terminal Cloud loop errors instead of idle success", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "terminal_error";
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    const result = await asAdvanced(session).runTurn("trigger failure");

    expect(result).toMatchObject({
      type: "result",
      success: false,
      error: "error",
      errorCode: "error",
      errorDetail: "cloud turn failed",
      conversationId: "default",
    });
    expect(FakeCloudSocket.socket("stream")!.sent).toContainEqual({ type: "ack", seq: 201 });
    expect(FakeCloudSocket.socket("stream")!.sent).toContainEqual({ type: "ack", seq: 202 });

    session.close();
  });

  test("ignores stale idle status before Cloud turn activity", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "stale_idle_then_error";
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    const result = await asAdvanced(session).runTurn("trigger delayed failure");

    expect(result).toMatchObject({
      type: "result",
      success: false,
      error: "error",
      errorCode: "error",
      errorDetail: "delayed cloud turn failed",
      conversationId: "default",
    });
    expect(FakeCloudSocket.socket("stream")!.sent).toContainEqual({ type: "ack", seq: 301 });
    expect(FakeCloudSocket.socket("stream")!.sent).toContainEqual({ type: "ack", seq: 304 });

    session.close();
  });
});
