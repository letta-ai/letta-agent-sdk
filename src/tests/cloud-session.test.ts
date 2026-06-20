import { describe, expect, test } from "bun:test";
import { LettaCodeClient } from "../index.js";

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

function createCloudFetchMock(requests: RecordedRequest[]): typeof fetch {
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

    if (parsed.pathname === "/v1/conversations/default/messages" && method === "GET") {
      return Promise.resolve(jsonResponse({ messages: [{ id: "msg-1" }], hasMore: false }));
    }

    if (parsed.pathname === "/v1/agents/agent-1/sandboxes" && method === "POST") {
      return Promise.resolve(jsonResponse({
        sandboxId: "sandbox-1",
        deviceId: "device-sandbox",
        connectionName: "sandbox-agent-1",
      }));
    }

    if (parsed.pathname === "/v1/agents/agent-1/sandboxes/refresh" && method === "POST") {
      return Promise.resolve(jsonResponse({ success: true }));
    }

    if (parsed.pathname === "/v1/agents/agent-1/sandboxes" && method === "DELETE") {
      return Promise.resolve(jsonResponse({ success: true }));
    }

    if (parsed.pathname === "/v1/environments" && method === "GET") {
      return Promise.resolve(jsonResponse({
        connections: [
          {
            id: "env-sandbox",
            connectionId: "conn-sandbox",
            deviceId: "device-sandbox",
            connectionName: "sandbox-agent-1",
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
  static scenario: "normal" | "approval" | "terminal_error" | "stale_idle_then_error" = "normal";
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
    if (command.type === "recover_pending_approvals") {
      this.serverMessage({
        type: "recover_pending_approvals_response",
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

    if (command.type !== "input") return;
    const runtime = command.runtime;
    const payload = command.payload as Record<string, unknown> | undefined;

    if (payload?.kind === "create_message" && FakeCloudSocket.scenario === "approval") {
      this.serverMessage({
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

    if (payload?.kind === "approval_response") {
      this.finishTurn(runtime, "approved");
      return;
    }

    if (payload?.kind === "create_message") {
      this.finishTurn(runtime, "hello from cloud");
    }
  }

  private finishTurn(runtime: unknown, content: string): void {
    this.serverMessage({
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
    this.serverMessage({
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

  private finishTurnWithTerminalError(runtime: unknown): void {
    this.serverMessage({
      type: "update_loop_status",
      seq: 201,
      event_seq: 1,
      runtime,
      loop_status: {
        status: "WAITING_ON_INPUT",
        active_run_ids: [],
      },
    });
    this.serverMessage({
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
    this.serverMessage({
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
      this.serverMessage({
        type: "update_loop_status",
        seq: 302,
        event_seq: 2,
        runtime,
        loop_status: {
          status: "SENDING_API_REQUEST",
          active_run_ids: [],
        },
      });
      this.serverMessage({
        type: "update_loop_status",
        seq: 303,
        event_seq: 3,
        runtime,
        loop_status: {
          status: "WAITING_ON_INPUT",
          active_run_ids: [],
        },
      });
      this.serverMessage({
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

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function resetFakeCloud(): void {
  FakeCloudSocket.instances = [];
  FakeCloudSocket.scenario = "normal";
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
  test("creates and refreshes a Cloud agent sandbox before using the Remote Client websocket", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaCodeClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      sandbox: { ttlMinutes: 7, pollIntervalMs: 1, readyTimeoutMs: 50 },
    });

    const session = client.resumeSession("agent-1", {
      model: "anthropic/claude-sonnet-4",
      cwd: "/repo",
      permissionMode: "bypassPermissions",
    });
    const init = await session.initialize();

    expect(init).toMatchObject({
      type: "init",
      agentId: "agent-1",
      conversationId: "default",
    });
    expect(requests.slice(0, 3).map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "POST /v1/agents/agent-1/sandboxes",
      "POST /v1/agents/agent-1/sandboxes/refresh",
      "GET /v1/environments",
    ]);
    expect(requests[1]!.body).toEqual({ ttlMinutes: 7 });
    expect(requests[0]!.headers.authorization ?? requests[0]!.headers.Authorization).toBe("Bearer sk-test");

    const socket = FakeCloudSocket.instances[0]!;
    const wsUrl = new URL(socket.url);
    expect(wsUrl.protocol).toBe("wss:");
    expect(wsUrl.pathname).toBe("/v1/environments/conn-sandbox/status/ws");
    expect(wsUrl.searchParams.get("agentId")).toBe("agent-1");
    expect(wsUrl.searchParams.get("conversationId")).toBe("default");
    expect(wsUrl.searchParams.get("channel")).toBe("stream");
    expect(wsUrl.searchParams.has("token")).toBe(false);
    expect(socket.options?.headers?.Authorization).toBe("Bearer sk-test");
    expect(socket.sent[0]).toMatchObject({ type: "sync", recover_approvals: true });
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: "update_model",
      payload: { model_handle: "anthropic/claude-sonnet-4" },
    }));
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: "change_device_state",
      payload: { cwd: "/repo", mode: "unrestricted" },
    }));

    await expect(session.recoverPendingApprovals({ timeoutMs: 1_000 })).resolves.toEqual({
      recovered: true,
      pendingApproval: false,
      unsupported: false,
    });

    const result = await session.runTurn("hello");
    expect(result).toMatchObject({
      type: "result",
      success: true,
      result: "hello from cloud",
      conversationId: "default",
      runIds: ["run-cloud"],
    });
    const inputCommand = socket.sent.find((command) => command.type === "input")!;
    expect(inputCommand).toMatchObject({
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      payload: {
        kind: "create_message",
        supports_control_response: true,
        messages: [expect.objectContaining({ role: "user", content: "hello" })],
      },
    });
    expect(socket.sent).toContainEqual({ type: "ack", seq: 101 });
    expect(socket.sent).toContainEqual({ type: "ack", seq: 102 });
    expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/sandboxes/refresh"))).toHaveLength(2);

    session.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.test/v1/agents/agent-1/sandboxes",
    });
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
    await session.initialize();

    expect(requests.some((request) => new URL(request.url).pathname.includes("/sandboxes"))).toBe(false);
    const socketUrl = new URL(FakeCloudSocket.instances[0]!.url);
    expect(socketUrl.pathname).toBe("/v1/environments/conn-explicit/status/ws");
    expect(socketUrl.searchParams.get("token")).toBe("sk-test");
    expect(FakeCloudSocket.instances[0]!.options).toBeUndefined();
    session.close();
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
      sandbox: { pollIntervalMs: 1, readyTimeoutMs: 50 },
    });

    const session = client.resumeSession("agent-1");
    await session.initialize();

    const sandboxRequest = requests.find((request) => new URL(request.url).pathname.endsWith("/sandboxes"));
    const environmentRequest = requests.find((request) => new URL(request.url).pathname === "/v1/environments");
    expect(sandboxRequest?.headers.authorization).toBe("Bearer sk-header");
    expect(sandboxRequest?.headers["x-project-id"]).toBe("project-1");
    expect(environmentRequest?.headers.authorization).toBe("Bearer sk-header");
    expect(environmentRequest?.headers["x-project-id"]).toBe("project-1");
    expect(FakeCloudSocket.instances[0]!.options?.headers).toEqual({
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
    })).resolves.toBe("agent-created");

    expect(requests).toHaveLength(0);
    const controlSocket = FakeAppServerSocket.instances.find((socket) => new URL(socket.url).searchParams.get("channel") === "control")!;
    const runtimeStart = controlSocket.sent.find((command) => command.type === "runtime_start")!;
    expect(runtimeStart).toMatchObject({
      create_agent: {
        pin_global: false,
        body: {
          model: "anthropic/claude-sonnet-4",
          system: "You are a repo assistant.",
          memory_blocks: [{ label: "project", value: "Use Bun." }],
        },
      },
    });
    expect((runtimeStart.create_agent as { body: Record<string, unknown> }).body.tags).toBeUndefined();
    expect(controlSocket.sent).not.toContainEqual(expect.objectContaining({ type: "enable_memfs" }));

    await expect(client.createAgent({ tags: ["team:sdk"] })).rejects.toThrow(
      "Cloud backend createAgent() cannot set tags until Cloud supports tags on agent creation",
    );

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
      sandbox: { pollIntervalMs: 1, readyTimeoutMs: 50 },
    });

    const session = client.resumeSession("agent-1", {
      canUseTool: (toolName, input) => {
        decisions.push({ toolName, input });
        return { behavior: "allow" };
      },
    });

    const result = await session.runTurn("run pwd");

    expect(result).toMatchObject({ success: true, result: "approved" });
    expect(decisions).toEqual([{ toolName: "Bash", input: { command: "pwd" } }]);
    const approvalCommand = FakeCloudSocket.instances[0]!.sent.find((command) => {
      const payload = command.payload as Record<string, unknown> | undefined;
      return command.type === "input" && payload?.kind === "approval_response";
    });
    expect(approvalCommand).toMatchObject({
      payload: {
        kind: "approval_response",
        request_id: "approval-1",
        decision: { behavior: "allow", updatedInput: null, updatedPermissions: [] },
      },
    });

    session.close();
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
      sandbox: { lifecycle: "external" },
    });

    const session = client.resumeSession("agent-1");
    const result = await session.runTurn("trigger failure");

    expect(result).toMatchObject({
      type: "result",
      success: false,
      error: "error",
      errorCode: "error",
      errorDetail: "cloud turn failed",
      stopReason: "error",
      conversationId: "default",
    });
    expect(FakeCloudSocket.instances[0]!.sent).toContainEqual({ type: "ack", seq: 201 });
    expect(FakeCloudSocket.instances[0]!.sent).toContainEqual({ type: "ack", seq: 202 });

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
      sandbox: { lifecycle: "external" },
    });

    const session = client.resumeSession("agent-1");
    const result = await session.runTurn("trigger delayed failure");

    expect(result).toMatchObject({
      type: "result",
      success: false,
      error: "error",
      errorCode: "error",
      errorDetail: "delayed cloud turn failed",
      stopReason: "error",
      conversationId: "default",
    });
    expect(FakeCloudSocket.instances[0]!.sent).toContainEqual({ type: "ack", seq: 301 });
    expect(FakeCloudSocket.instances[0]!.sent).toContainEqual({ type: "ack", seq: 304 });

    session.close();
  });
});
