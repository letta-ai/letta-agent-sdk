import { describe, expect, test } from "bun:test";
import {
  CloudManagedSandboxExpiredError,
  LettaAgentClient,
} from "../index.js";
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

type CloudFetchMockOptions = {
  /** Sandbox ids whose by-id refresh should 404 (TTL reaped). */
  reapedSandboxes?: Set<string>;
  /** Override a by-id refresh response for lifecycle race tests. */
  sandboxRefreshResponse?: (
    sandboxId: string,
    attempt: number,
  ) => Response | Promise<Response> | undefined;
};

function createCloudFetchMock(
  requests: RecordedRequest[],
  environmentConnections?: Array<Record<string, unknown>>,
  options: CloudFetchMockOptions = {},
): typeof fetch {
  let sandboxCreates = 0;
  let sandboxRefreshes = 0;
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

    const agentSandboxMatch = /^\/v1\/agents\/([^/]+)\/sandboxes$/.exec(parsed.pathname);
    if (agentSandboxMatch && method === "POST") {
      const agentId = decodeURIComponent(agentSandboxMatch[1]!);
      sandboxCreates += 1;
      const sandboxId = sandboxCreates === 1
        ? `sandbox-${agentId}`
        : `sandbox-${agentId}-r${sandboxCreates}`;
      return Promise.resolve(jsonResponse({
        sandboxId,
        deviceId: `device-${agentId}`,
        connectionName: `sandbox-${agentId}-session`,
      }));
    }

    const sandboxRefreshMatch = /^\/v1\/sandboxes\/([^/]+)\/refresh$/.exec(parsed.pathname);
    if (sandboxRefreshMatch && method === "POST") {
      const sandboxId = decodeURIComponent(sandboxRefreshMatch[1]!);
      sandboxRefreshes += 1;
      const responseOverride = options.sandboxRefreshResponse?.(
        sandboxId,
        sandboxRefreshes,
      );
      if (responseOverride) return Promise.resolve(responseOverride);
      if (options.reapedSandboxes?.has(sandboxId)) {
        return Promise.resolve(jsonResponse(
          { errorCode: "SANDBOX_NOT_FOUND", message: `Sandbox ${sandboxId} no longer exists` },
          { status: 404 },
        ));
      }
      const body = bodyOf(init) as { ttlMinutes?: number } | undefined;
      return Promise.resolve(jsonResponse({
        success: true,
        sandboxId,
        ttlMinutes: body?.ttlMinutes ?? 5,
      }));
    }

    const sandboxTerminateMatch = /^\/v1\/sandboxes\/([^/]+)\/terminate$/.exec(parsed.pathname);
    if (sandboxTerminateMatch && method === "POST") {
      return Promise.resolve(jsonResponse({ success: true, message: "terminated" }));
    }

    const agentSandboxRefreshMatch = /^\/v1\/agents\/([^/]+)\/sandboxes\/refresh$/.exec(parsed.pathname);
    if (agentSandboxRefreshMatch && method === "POST") {
      const agentId = decodeURIComponent(agentSandboxRefreshMatch[1]!);
      const body = bodyOf(init) as { ttlMinutes?: number } | undefined;
      return Promise.resolve(jsonResponse({
        success: true,
        sandboxId: `sandbox-${agentId}`,
        ttlMinutes: body?.ttlMinutes ?? 5,
      }));
    }

    if (agentSandboxMatch && method === "DELETE") {
      return Promise.resolve(jsonResponse({ success: true, message: "terminated" }));
    }

    const managedEnvironmentMatch = /^\/v1\/environments\/device-(.+)$/.exec(parsed.pathname);
    if (managedEnvironmentMatch && method === "GET") {
      const agentId = decodeURIComponent(managedEnvironmentMatch[1]!);
      return Promise.resolve(jsonResponse({
        id: `env-${agentId}`,
        connectionId: `conn-${agentId}`,
        deviceId: `device-${agentId}`,
        connectionName: `sandbox-${agentId}-session`,
        organizationId: "org-test",
        podId: null,
        connectedAt: 1,
        lastHeartbeat: 1,
        lastSeenAt: 1,
        firstSeenAt: 1,
      }));
    }

    const agentRepositoriesMatch = /^\/v1\/agents\/([^/]+)\/repositories$/.exec(parsed.pathname);
    if (agentRepositoriesMatch && method === "GET") {
      return Promise.resolve(jsonResponse({ repositories: requests.some((request) => {
        const requestPath = new URL(request.url).pathname;
        return request.method === "POST" && requestPath === parsed.pathname;
      }) ? [{ id: "repo-1", name: "repo-1", is_primary: false }] : [] }));
    }

    if (agentRepositoriesMatch && method === "POST") {
      const body = bodyOf(init) as { repository_id?: string } | undefined;
      return Promise.resolve(jsonResponse({ success: true, repository: { id: body?.repository_id ?? "repo-1" } }));
    }

    const agentRepositoryMatch = /^\/v1\/agents\/([^/]+)\/repositories\/([^/]+)$/.exec(parsed.pathname);
    if (agentRepositoryMatch && method === "DELETE") {
      return Promise.resolve(jsonResponse({ success: true }));
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
  test("creates, refreshes, and cleans up a managed Cloud sandbox with terminateOnClose", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      sandbox: { ttlMinutes: 2, terminateOnClose: true },
    });

    const session = client.resumeSession("agent-1");
    try {
      const init = await asAdvanced(session).initialize();
      expect(init).toMatchObject({
        type: "init",
        agentId: "agent-1",
        conversationId: "default",
      });

      expect(requests).toContainEqual(expect.objectContaining({
        method: "POST",
        url: "https://api.test/v1/agents/agent-1/sandboxes",
        body: {},
      }));
      expect(requests).toContainEqual(expect.objectContaining({
        method: "POST",
        url: "https://api.test/v1/agents/agent-1/sandboxes/refresh",
        body: { ttlMinutes: 2 },
      }));
      expect(requests).toContainEqual(expect.objectContaining({
        method: "GET",
        url: "https://api.test/v1/environments/device-agent-1",
      }));

      const controlSocket = FakeCloudSocket.socket("control")!;
      expect(new URL(controlSocket.url).pathname).toBe("/v1/environments/conn-agent-1/status/ws");

      const result = await asAdvanced(session).runTurn("hello");
      expect(result).toMatchObject({ success: true, result: "hello from cloud" });
      expect(requests.filter((request) =>
        new URL(request.url).pathname === "/v1/agents/agent-1/sandboxes/refresh"
      )).toHaveLength(2);
    } finally {
      session.close();
    }

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(requests.filter((request) =>
      new URL(request.url).pathname === "/v1/agents/agent-1/sandboxes/refresh"
    )).toHaveLength(3);
    expect(requests).toContainEqual(expect.objectContaining({
      method: "DELETE",
      url: "https://api.test/v1/agents/agent-1/sandboxes",
    }));
  });

  test("leaves managed Cloud sandbox cleanup to TTL by default", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
    });

    const session = client.resumeSession("agent-1");
    await asAdvanced(session).initialize();
    session.close();

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(requests.some((request) =>
      new URL(request.url).pathname === "/v1/agents/agent-1/sandboxes" &&
        request.method === "DELETE"
    )).toBe(false);
  });

  test("uses the conversation-scoped sandbox lifecycle without response feature detection", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
    });

    const session = client.resumeSession("conv-1");
    try {
      const init = await asAdvanced(session).initialize();
      expect(init).toMatchObject({
        type: "init",
        agentId: "agent-from-conv",
        conversationId: "conv-1",
      });

      expect(requests).toContainEqual(expect.objectContaining({
        method: "POST",
        url: "https://api.test/v1/agents/agent-from-conv/sandboxes",
        body: { conversationId: "conv-1" },
      }));
      // Refreshes go by sandbox id — never the agent-scoped "latest active"
      // route, whose target another conversation's create could displace.
      expect(requests.some((request) =>
        new URL(request.url).pathname === "/v1/sandboxes/sandbox-agent-from-conv/refresh"
      )).toBe(true);
      expect(requests.some((request) =>
        new URL(request.url).pathname === "/v1/agents/agent-from-conv/sandboxes/refresh"
      )).toBe(false);
    } finally {
      session.close();
    }
  });

  test("surfaces a typed pre-turn error when a conversation sandbox expires", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const reapedSandboxes = new Set<string>();
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests, undefined, { reapedSandboxes }),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
    });

    const session = client.resumeSession("conv-1");
    try {
      await asAdvanced(session).initialize();
      reapedSandboxes.add("sandbox-agent-from-conv");

      // The next turn's refresh happens before its input frame is sent. The
      // caller can therefore create a new SDK session for this conversation
      // and retry without duplicating the message.
      let thrown: unknown;
      try {
        await asAdvanced(session).runTurn("hello");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CloudManagedSandboxExpiredError);
      expect(thrown).toMatchObject({
        code: "managed_sandbox_expired",
        sandboxId: "sandbox-agent-from-conv",
        conversationId: "conv-1",
      });
      expect(FakeCloudSocket.allSent().some((command) =>
        command.type === "input"
      )).toBe(false);

      const creates = requests.filter((request) =>
        request.method === "POST" &&
          new URL(request.url).pathname === "/v1/agents/agent-from-conv/sandboxes"
      );
      expect(creates).toHaveLength(1);
    } finally {
      session.close();
    }
  });

  test("terminates a conversation sandbox by id when terminateOnClose is set", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      sandbox: { terminateOnClose: true },
    });

    const session = client.resumeSession("conv-1");
    await asAdvanced(session).initialize();
    session.close();

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(requests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "https://api.test/v1/sandboxes/sandbox-agent-from-conv/terminate",
    }));
    expect(requests.some((request) =>
      request.method === "DELETE" &&
        new URL(request.url).pathname === "/v1/agents/agent-from-conv/sandboxes"
    )).toBe(false);
  });

  test("waits for an in-flight refresh before terminating on close", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    let releaseRefresh = () => {};
    const pendingRefresh = new Promise<Response>((resolve) => {
      releaseRefresh = () => resolve(jsonResponse({
        success: true,
        sandboxId: "sandbox-agent-from-conv",
        ttlMinutes: 5,
      }));
    });
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests, undefined, {
        sandboxRefreshResponse: (_sandboxId, attempt) =>
          attempt === 2 ? pendingRefresh : undefined,
      }),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      sandbox: { refreshIntervalMs: 1, terminateOnClose: true },
    });

    const session = client.resumeSession("conv-1");
    try {
      await asAdvanced(session).initialize();
      for (let i = 0; i < 20; i += 1) {
        const refreshes = requests.filter((request) =>
          new URL(request.url).pathname.endsWith("/refresh")
        );
        if (refreshes.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      session.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests.some((request) =>
        new URL(request.url).pathname.endsWith("/terminate")
      )).toBe(false);

      releaseRefresh();
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(requests).toContainEqual(expect.objectContaining({
        method: "POST",
        url: "https://api.test/v1/sandboxes/sandbox-agent-from-conv/terminate",
      }));
    } finally {
      releaseRefresh();
      session.close();
    }
  });


  test("attaches Cloud repository resources for the session and detaches on close", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      sandbox: { terminateOnClose: false },
    });

    const session = client.resumeSession("agent-1", {
      resources: [{ type: "repository", repositoryId: "repo-1" }],
    });
    await asAdvanced(session).initialize();
    session.close();

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(requests).toContainEqual(expect.objectContaining({
      method: "GET",
      url: "https://api.test/v1/agents/agent-1/repositories",
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "https://api.test/v1/agents/agent-1/repositories",
      body: { repository_id: "repo-1" },
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      method: "DELETE",
      url: "https://api.test/v1/agents/agent-1/repositories/repo-1",
    }));
  });

  test("uses an explicit environment before using the Remote Client websocket", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
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
      permissionMode: "unrestricted",
      skillSources: [],
      dreaming: { trigger: "step-count", stepCount: 3 },
    });
    const init = await asAdvanced(session).initialize();

    expect(init).toMatchObject({
      type: "init",
      agentId: "agent-1",
      conversationId: "default",
      skillSources: [],
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
      skill_sources: [],
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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

    await expect(client.createAgent({
      model: "anthropic/claude-sonnet-4",
      systemPrompt: "default",
    })).rejects.toThrow(
      "createAgent() does not yet support system prompt presets for this backend",
    );
  });

  test("rejects Cloud createAgent without an explicit model", async () => {
    resetFakeCloud();
    resetFakeAppServer();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      appServer: {
        url: "ws://app-server.test/ws",
        WebSocket: FakeAppServerSocket,
      },
    });

    await expect(client.createAgent({
      systemPrompt: "You are a repo assistant.",
    })).rejects.toThrow("Constellation createAgent() requires an explicit model");
    await expect(client.createAgent({
      model: "   ",
    })).rejects.toThrow("Constellation createAgent() requires an explicit model");

    expect(requests).toHaveLength(0);
    expect(FakeAppServerSocket.instances).toHaveLength(0);
  });

  test("responds to Remote Client approval requests through canUseTool", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "approval";
    const requests: RecordedRequest[] = [];
    const decisions: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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

  test("validates managed Cloud sandbox options and environment exclusivity", () => {
    expect(() => new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      environment: { connectionId: "conn-explicit" },
      sandbox: { ttlMinutes: 5 },
    })).toThrow("cannot specify both environment and sandbox options");

    expect(() => new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      sandbox: { ttlMinutes: 61 },
    })).toThrow("Invalid sandbox.ttlMinutes");

    const clientWithEnvironment = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      environment: { connectionId: "conn-explicit" },
    });
    expect(() => clientWithEnvironment.resumeSession("agent-1", {
      sandbox: { ttlMinutes: 5 },
    })).toThrow("cannot specify sandbox options when the client has a default environment");

    const clientWithSandbox = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      sandbox: { ttlMinutes: 5 },
    });
    expect(() => clientWithSandbox.resumeSession("agent-1", {
      environment: { connectionId: "conn-explicit" },
    })).toThrow("cannot specify an environment when the client has default sandbox options");

    expect(() => new LettaAgentClient({
      backend: "remote",
      url: "ws://app-server.test/ws",
      sandbox: { ttlMinutes: 5 },
    } as never)).toThrow('sandbox options are only valid with backend: "cloud"');
  });

  test("reports terminal Cloud loop errors instead of idle success", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "terminal_error";
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
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
    const client = new LettaAgentClient({
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
