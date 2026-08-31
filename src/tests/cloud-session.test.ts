import { describe, expect, spyOn, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import {
  CloudManagedSandboxExpiredError,
  LettaAgentClient,
  type CanUseToolContext,
} from "../index.js";
import type { SessionDeviceStatus } from "../index.js";
import { asAdvanced } from "./advanced-session.js";

type Listener = (event: unknown) => void;
type FetchInput = Parameters<typeof fetch>[0];

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

const RUNTIME_MESSAGE_FIXTURE: Message = {
  id: "msg-from-runtime",
  content: "hello",
  date: "2026-07-28T00:00:00Z",
  message_type: "user_message",
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
  if (init.body instanceof FormData) return init.body;
  return JSON.parse(String(init.body));
}

type CloudFetchMockOptions = {
  /** Simulate a server without conversation-scoped sandbox support: it
   * strips the conversationId body key and never echoes it back. */
  legacySandboxServer?: boolean;
  /** Override the conversation id echoed by a supporting sandbox server. */
  sandboxConversationEcho?: string;
  /** Sandbox ids whose by-id refresh should 404 (TTL reaped). */
  reapedSandboxes?: Set<string>;
  /** Override a by-id refresh response for lifecycle race tests. */
  sandboxRefreshResponse?: (
    sandboxId: string,
    attempt: number,
  ) => Response | Promise<Response> | undefined;
  /** Override agent-level recompile responses for failure-path tests. */
  agentRecompileResponse?: (attempt: number) => Response | undefined;
};

function createCloudFetchMock(
  requests: RecordedRequest[],
  environmentConnections?: Array<Record<string, unknown>>,
  options: CloudFetchMockOptions = {},
): typeof fetch {
  let sandboxCreates = 0;
  let sandboxRefreshes = 0;
  let agentRecompiles = 0;
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

    if (
      parsed.pathname === "/v1/conversations/ephemeral" &&
      method === "POST"
    ) {
      const body = bodyOf(init) as { model?: string } | undefined;
      return Promise.resolve(
        jsonResponse({
          id: "conv-ephemeral",
          agent_id: null,
          model: body?.model,
        }),
      );
    }

    if (parsed.pathname === "/v1/conversations/conv-1" && method === "GET") {
      return Promise.resolve(jsonResponse({ id: "conv-1", agent_id: "agent-from-conv" }));
    }

    const agentSandboxMatch = /^\/v1\/agents\/([^/]+)\/sandboxes$/.exec(parsed.pathname);
    if (agentSandboxMatch && method === "POST") {
      const agentId = decodeURIComponent(agentSandboxMatch[1]!);
      sandboxCreates += 1;
      const body = bodyOf(init) as { conversationId?: string } | undefined;
      const sandboxId = sandboxCreates === 1
        ? `sandbox-${agentId}`
        : `sandbox-${agentId}-r${sandboxCreates}`;
      const conversationEcho =
        body?.conversationId && !options.legacySandboxServer
          ? {
              conversationId:
                options.sandboxConversationEcho ?? body.conversationId,
              resumed: false,
            }
          : {};
      return Promise.resolve(jsonResponse({
        sandboxId,
        deviceId: `device-${agentId}`,
        connectionName: `sandbox-${agentId}-session`,
        ...conversationEcho,
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

    const sandboxFilesMatch = /^\/v1\/sandboxes\/([^/]+)\/files$/.exec(parsed.pathname);
    if (sandboxFilesMatch && method === "POST") {
      const form = init?.body;
      if (!(form instanceof FormData)) {
        return Promise.resolve(jsonResponse(
          { errorCode: "NO_FILES", message: "No files were provided" },
          { status: 400 },
        ));
      }
      const files = form.getAll("file").map((part, index) => {
        const blob = part as Blob & { name?: string };
        const name = blob.name ?? `upload-${index}`;
        return {
          path: `/root/downloads/upload-1/${name}`,
          name,
          mimeType: blob.type,
          size: blob.size,
        };
      });
      return Promise.resolve(jsonResponse({ files }));
    }

    if (sandboxFilesMatch && method === "GET") {
      const path = parsed.searchParams.get("path") ?? "";
      return Promise.resolve(new Response(`download:${path}`, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }));
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
      const postedIds = requests
        .filter((request) => {
          const requestPath = new URL(request.url).pathname;
          return request.method === "POST" && requestPath === parsed.pathname;
        })
        .map((request) => (request.body as { repository_id?: string } | undefined)?.repository_id)
        .filter((id): id is string => typeof id === "string");
      return Promise.resolve(jsonResponse({
        repositories: postedIds.map((id) => ({
          id,
          name: id,
          is_primary: false,
          permissions: "read_write",
        })),
      }));
    }

    if (agentRepositoriesMatch && method === "POST") {
      const body = bodyOf(init) as { repository_id?: string } | undefined;
      const id = body?.repository_id ?? "repo-1";
      return Promise.resolve(jsonResponse({
        success: true,
        repository: {
          id,
          name: id,
          is_primary: false,
          permissions: "read_write",
        },
      }));
    }

    const agentRepositoryMatch = /^\/v1\/agents\/([^/]+)\/repositories\/([^/]+)$/.exec(parsed.pathname);
    if (agentRepositoryMatch && method === "DELETE") {
      return Promise.resolve(jsonResponse({ success: true }));
    }

    const agentRecompileMatch = /^\/v1\/agents\/([^/]+)\/recompile$/.exec(parsed.pathname);
    if (agentRecompileMatch && method === "POST") {
      agentRecompiles += 1;
      const responseOverride = options.agentRecompileResponse?.(agentRecompiles);
      if (responseOverride) return Promise.resolve(responseOverride);
      return Promise.resolve(jsonResponse("recompiled system prompt"));
    }

    const conversationRecompileMatch = /^\/v1\/conversations\/([^/]+)\/recompile$/.exec(parsed.pathname);
    if (conversationRecompileMatch && method === "POST") {
      return Promise.resolve(jsonResponse("recompiled conversation system prompt"));
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
    | "usage_after_stop"
    | "approval"
    | "terminal_error"
    | "stale_idle_then_error"
    | "duplicate_idempotency"
    | "hang" = "normal";
  static syncSucceeds = true;
  static deviceStatusOnSync = false;
  static openConnectionFailuresRemaining = 0;
  private static currentConnectionShouldFail = false;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeCloudSocket.instances.push(this);
    const channel = new URL(url).searchParams.get("channel");
    if (channel === "control") {
      FakeCloudSocket.currentConnectionShouldFail =
        FakeCloudSocket.openConnectionFailuresRemaining > 0;
      if (FakeCloudSocket.currentConnectionShouldFail) {
        FakeCloudSocket.openConnectionFailuresRemaining--;
      }
    }
    const shouldFail = FakeCloudSocket.currentConnectionShouldFail;
    queueMicrotask(() => {
      if (shouldFail) {
        this.readyState = 3;
        this.emit("error", new Error("initial socket open failed"));
        return;
      }
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  static socket(channel: "control" | "stream"): FakeCloudSocket | undefined {
    const matching = FakeCloudSocket.instances
      .filter((socket) => socket.channel === channel)
      .reverse();
    return matching.find((socket) => socket.readyState !== 3) ?? matching[0];
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
        agent_id:
          command.agent_id === undefined
            ? null
            : typeof command.agent_id === "string"
              ? command.agent_id
              : "agent-1",
        conversation_id: typeof command.conversation_id === "string" ? command.conversation_id : "default",
      };
      this.serverMessage({
        type: "runtime_start_response",
        request_id: command.request_id,
        success: true,
        runtime,
        agent: runtime.agent_id
          ? { id: runtime.agent_id, model: "anthropic/claude-sonnet-4" }
          : null,
        conversation: {
          id: runtime.conversation_id,
          agent_id: runtime.agent_id,
          model: "openai/gpt-5.6-luna",
        },
      });
      return;
    }

    if (command.type === "sync") {
      if (FakeCloudSocket.deviceStatusOnSync && command.force_device_status === true) {
        this.serverMessageTo("control", {
          type: "update_device_status",
          runtime: command.runtime,
          device_status: {
            is_online: true,
            is_processing: false,
            current_permission_mode: "acceptEdits",
            current_working_directory: "/workspace/project",
            memory_directory: "/memory/cloud-agent",
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
        this.serverMessage({
          type: "sync_response",
          request_id: command.request_id,
          runtime: command.runtime,
          success: FakeCloudSocket.syncSucceeds,
          ...(FakeCloudSocket.syncSucceeds ? {} : { error: "sync failed" }),
        });
      }
      return;
    }

    if (command.type === "conversation_messages_list") {
      this.serverMessage({
        type: "conversation_messages_list_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: true,
        messages: [RUNTIME_MESSAGE_FIXTURE],
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

    if (payload?.kind === "create_message" && FakeCloudSocket.scenario === "hang") {
      return;
    }

    if (payload?.kind === "create_message" && FakeCloudSocket.scenario === "approval") {
      this.serverMessageTo("control", {
        type: "control_request",
        runtime,
        request_id: "approval-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "pwd" },
          tool_call_id: "toolu-approval-1",
          permission_suggestions: [
            { id: "suggestion-1", text: "Allow Bash(pwd) for this session" },
          ],
          blocked_path: null,
          diffs: [{ mode: "fallback", fileName: "unused.txt", reason: "not a file edit" }],
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

    if (payload?.kind === "create_message" && FakeCloudSocket.scenario === "usage_after_stop") {
      this.finishTurnWithUsageAfterStop(runtime);
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

  private finishTurnWithUsageAfterStop(runtime: unknown): void {
    this.serverMessageTo("stream", {
      type: "stream_delta",
      seq: 501,
      event_seq: 1,
      runtime,
      delta: {
        id: "msg-cloud-usage",
        message_type: "assistant_message",
        content: "usage captured",
        run_id: "run-cloud-usage",
      },
    });
    this.serverMessageTo("stream", {
      type: "stream_delta",
      seq: 502,
      event_seq: 2,
      runtime,
      delta: {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: "run-cloud-usage",
      },
    });
    this.serverMessageTo("control", {
      type: "turn_finished",
      runtime,
      turn_id: "turn-cloud-usage",
      run_id: "run-cloud-usage",
      stop_reason: "end_turn",
    });
    this.serverMessageTo("stream", {
      type: "stream_delta",
      seq: 503,
      event_seq: 3,
      runtime,
      delta: {
        message_type: "usage_statistics",
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        step_count: 3,
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
  FakeCloudSocket.deviceStatusOnSync = false;
  FakeCloudSocket.openConnectionFailuresRemaining = 0;
}

describe("CloudEnvironmentSession", () => {
  test("query rejects agent-scoped managed sandboxes before creating a conversation", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
    });

    await expect(async () => {
      for await (const _message of client.query({
        prompt: "hello",
        options: {
          model: "openai/gpt-5.6-luna",
          system: "Answer directly.",
        },
      })) {
        // The query must fail before opening a stream.
      }
    }).toThrow("requires an explicit computer");
    expect(requests).toHaveLength(0);
  });

  test("query creates an ephemeral conversation without an agent", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      computer: { connectionId: "conn-explicit" },
    });

    const messages = [];
    for await (const message of client.query({
      prompt: "What is 2 + 2?",
      options: {
        model: "openai/gpt-5.6-luna",
        system: "Answer with one number.",
        modelSettings: { parallel_tool_calls: false },
        contextWindowLimit: 64_000,
      },
    })) {
      messages.push(message);
    }

    expect(requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        url: "https://api.test/v1/conversations/ephemeral",
        body: {
          model: "openai/gpt-5.6-luna",
          system: "Answer with one number.",
          model_settings: { parallel_tool_calls: false },
          context_window_limit: 64_000,
        },
      }),
    );
    const runtimeStart = FakeCloudSocket.allSent().find(
      (command) => command.type === "runtime_start",
    );
    expect(runtimeStart).toMatchObject({
      conversation_id: "conv-ephemeral",
    });
    expect(runtimeStart).not.toHaveProperty("agent_id");
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "result", success: true }),
    );
  });

  test("keeps hosted usage after stop ahead of the terminal result", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "usage_after_stop";
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
      await session.send("hello");
      const messages = [];
      for await (const message of session.stream()) messages.push(message);

      expect(messages.map((message) => message.type)).toEqual([
        "assistant",
        "stream_event",
        "result",
      ]);
      expect(messages[1]).toMatchObject({
        type: "stream_event",
        event: {
          message_type: "usage_statistics",
          step_count: 3,
        },
      });
      expect(messages[2]).toMatchObject({
        type: "result",
        success: true,
        runIds: ["run-cloud-usage"],
      });
    } finally {
      session.close();
    }
  });

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

      const result = await asAdvanced(session).sendAndWaitForResult("hello");
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

  test("scopes the managed sandbox to the conversation when the server supports it", async () => {
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
      const init = await session.ready();
      expect(init).toMatchObject({
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

  test("uploads and downloads files through the managed sandbox", async () => {
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
      const uploaded = await session.sandbox!.uploadFiles([
        {
          name: "input.tar.gz",
          data: new Blob(["archive"], { type: "application/gzip" }),
        },
        {
          name: "context.json",
          data: new Blob(["{}"], { type: "application/json" }),
        },
      ]);
      expect(uploaded.files).toEqual([
        {
          path: "/root/downloads/upload-1/input.tar.gz",
          name: "input.tar.gz",
          mimeType: "application/gzip",
          size: 7,
        },
        {
          path: "/root/downloads/upload-1/context.json",
          name: "context.json",
          mimeType: "application/json;charset=utf-8",
          size: 2,
        },
      ]);

      const uploadRequest = requests.find((request) =>
        request.method === "POST" &&
        new URL(request.url).pathname ===
          "/v1/sandboxes/sandbox-agent-from-conv/files"
      );
      expect(uploadRequest).toBeDefined();
      expect(uploadRequest!.headers.authorization).toBe("Bearer sk-test");
      expect(uploadRequest!.headers["content-type"]).toBeUndefined();
      expect((uploadRequest!.body as FormData).getAll("file")).toHaveLength(2);
      expect(requests.indexOf(uploadRequest!)).toBeGreaterThan(
        requests.findIndex((request) =>
          request.method === "POST" &&
          new URL(request.url).pathname ===
            "/v1/agents/agent-from-conv/sandboxes"
        ),
      );

      const path = "/root/downloads/output/result.tar.gz";
      const downloaded = await session.sandbox!.downloadFile(path);
      expect(new TextDecoder().decode(downloaded)).toBe(`download:${path}`);
      expect(requests).toContainEqual(expect.objectContaining({
        method: "GET",
        url: `https://api.test/v1/sandboxes/sandbox-agent-from-conv/files?path=${encodeURIComponent(path)}`,
      }));
    } finally {
      session.close();
    }
  });

  test("does not expose sandbox files for an explicit computer", () => {
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      computer: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("conv-1");
    expect(session.sandbox).toBeUndefined();
    session.close();
  });

  test("clones configured GitHub repositories into a managed sandbox", async () => {
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

    const session = client.resumeSession("conv-1", {
      sandbox: {
        githubRepositories: [
          { owner: "letta-ai", repo: "letta-docs" },
          { owner: "letta-ai", repo: "letta-code" },
        ],
      },
    });
    try {
      await asAdvanced(session).initialize();

      expect(requests).toContainEqual(expect.objectContaining({
        method: "POST",
        url: "https://api.test/v1/agents/agent-from-conv/sandboxes",
        body: {
          conversationId: "conv-1",
          githubRepositories: [
            { owner: "letta-ai", repo: "letta-docs" },
            { owner: "letta-ai", repo: "letta-code" },
          ],
        },
      }));
    } finally {
      session.close();
    }
  });

  test("falls back to the agent-scoped sandbox lifecycle against legacy servers", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests, undefined, { legacySandboxServer: true }),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
    });

    const session = client.resumeSession("conv-1");
    try {
      await asAdvanced(session).initialize();

      // The request still carries conversationId (legacy servers strip
      // unknown body keys), but without the response echo the SDK must stay
      // on the agent-scoped lifecycle.
      expect(requests).toContainEqual(expect.objectContaining({
        method: "POST",
        url: "https://api.test/v1/agents/agent-from-conv/sandboxes",
        body: { conversationId: "conv-1" },
      }));
      expect(requests.some((request) =>
        new URL(request.url).pathname === "/v1/agents/agent-from-conv/sandboxes/refresh"
      )).toBe(true);
      expect(requests.some((request) =>
        new URL(request.url).pathname.startsWith("/v1/sandboxes/")
      )).toBe(false);
    } finally {
      session.close();
    }
  });

  test("rejects a mismatched conversation id echoed by the sandbox server", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests, undefined, {
        sandboxConversationEcho: "conv-other",
      }),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
    });

    const session = client.resumeSession("conv-1");
    try {
      await expect(asAdvanced(session).initialize()).rejects.toThrow(
        "expected conv-1, got conv-other",
      );
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
        await asAdvanced(session).sendAndWaitForResult("hello");
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
    // Recompile is issued after attach (default recompile: true).
    expect(requests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "https://api.test/v1/agents/agent-1/recompile",
      body: undefined,
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      method: "DELETE",
      url: "https://api.test/v1/agents/agent-1/repositories/repo-1",
    }));
    // Recompile is also issued after detach (best-effort, default recompile: true).
    const recompileRequests = requests.filter((r) =>
      r.method === "POST" && r.url === "https://api.test/v1/agents/agent-1/recompile",
    );
    expect(recompileRequests.length).toBe(2);
  });

  test("recompile: false skips system-prompt recompile on attach and detach", async () => {
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
      resources: [{ type: "repository", repositoryId: "repo-1", recompile: false }],
    });
    await asAdvanced(session).initialize();
    session.close();

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(requests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "https://api.test/v1/agents/agent-1/repositories",
      body: { repository_id: "repo-1" },
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      method: "DELETE",
      url: "https://api.test/v1/agents/agent-1/repositories/repo-1",
    }));
    // No recompile requests should be issued.
    expect(requests.filter((r) =>
      r.method === "POST" && r.url === "https://api.test/v1/agents/agent-1/recompile",
    )).toHaveLength(0);
  });

  test("fails initialization when attach-phase recompilation fails", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests, undefined, {
        agentRecompileResponse: () =>
          jsonResponse({ error: "recompile failed" }, { status: 500 }),
      }),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      sandbox: { terminateOnClose: false },
    });

    const session = client.resumeSession("agent-1", {
      resources: [{ type: "repository", repositoryId: "repo-1" }],
    });

    await expect(asAdvanced(session).initialize()).rejects.toThrow(
      '500 {"error":"recompile failed"}',
    );
    expect(requests).toContainEqual(expect.objectContaining({
      method: "DELETE",
      url: "https://api.test/v1/agents/agent-1/repositories/repo-1",
    }));
  });

  test("ignores cleanup recompilation failures after detach", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests, undefined, {
        agentRecompileResponse: (attempt) =>
          attempt === 2
            ? jsonResponse({ error: "cleanup recompile failed" }, { status: 500 })
            : undefined,
      }),
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

    expect(requests.filter((request) =>
      request.method === "POST" &&
      request.url === "https://api.test/v1/agents/agent-1/recompile",
    )).toHaveLength(2);
  });

  test("mixed flags do not recompile cleanup for only opt-out session attachments", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    // Seed repo-2 as an existing attachment; this session only owns repo-1.
    requests.push({
      method: "POST",
      url: "https://api.test/v1/agents/agent-1/repositories",
      headers: {},
      body: { repository_id: "repo-2" },
    });
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
      resources: [
        { type: "repository", repositoryId: "repo-1", recompile: false },
        { type: "repository", repositoryId: "repo-2" },
      ],
    });
    await asAdvanced(session).initialize();
    session.close();

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // repo-2 defaults to recompile: true, so the attachment batch recompiles.
    // Cleanup only removes repo-1, whose resource explicitly opted out.
    const recompileRequests = requests.filter((r) =>
      r.method === "POST" && r.url === "https://api.test/v1/agents/agent-1/recompile",
    );
    expect(recompileRequests).toHaveLength(1);
    expect(requests).toContainEqual(expect.objectContaining({
      method: "DELETE",
      url: "https://api.test/v1/agents/agent-1/repositories/repo-1",
    }));
    expect(requests.filter((request) =>
      request.method === "DELETE" &&
      request.url.endsWith("/repositories/repo-2"),
    )).toHaveLength(0);
  });

  test("batches mixed repository changes into one recompile per lifecycle phase", async () => {
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
      resources: [
        { type: "repository", repositoryId: "repo-1", recompile: false },
        { type: "repository", repositoryId: "repo-2" },
      ],
    });
    await asAdvanced(session).initialize();
    session.close();

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(requests.filter((request) =>
      request.method === "POST" &&
      request.url === "https://api.test/v1/agents/agent-1/recompile",
    )).toHaveLength(2);
    expect(requests.filter((request) =>
      request.method === "POST" &&
      request.url === "https://api.test/v1/agents/agent-1/repositories",
    )).toHaveLength(2);
    expect(requests.filter((request) =>
      request.method === "DELETE" &&
      request.url.includes("/v1/agents/agent-1/repositories/"),
    )).toHaveLength(2);
  });

  test("recompiles a resumed conversation after repository attach and detach", async () => {
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

    const session = client.resumeSession("conv-1", {
      resources: [{ type: "repository", repositoryId: "repo-1" }],
    });
    await asAdvanced(session).initialize();
    session.close();

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const conversationRecompiles = requests.filter((request) =>
      request.method === "POST" &&
      request.url === "https://api.test/v1/conversations/conv-1/recompile",
    );
    expect(conversationRecompiles).toEqual([
      expect.objectContaining({ body: { agent_id: "agent-from-conv" } }),
      expect.objectContaining({ body: { agent_id: "agent-from-conv" } }),
    ]);
  });

  test("cleans up repositories when environment resolution fails", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests, undefined, {
        sandboxConversationEcho: "conv-wrong",
      }),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
    });

    const session = client.resumeSession("conv-1", {
      resources: [{ type: "repository", repositoryId: "repo-1" }],
    });

    await expect(asAdvanced(session).initialize()).rejects.toThrow(
      "Cloud managed sandbox response conversation mismatch",
    );
    expect(requests).toContainEqual(expect.objectContaining({
      method: "DELETE",
      url: "https://api.test/v1/agents/agent-from-conv/repositories/repo-1",
    }));
    expect(requests.filter((request) =>
      request.method === "POST" &&
      request.url === "https://api.test/v1/conversations/conv-1/recompile",
    )).toHaveLength(2);
  });

  test("recompiles when a requested repository is already linked", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    requests.push({
      method: "POST",
      url: "https://api.test/v1/agents/agent-1/repositories",
      headers: {},
      body: { repository_id: "repo-1" },
    });
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

    expect(requests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "https://api.test/v1/agents/agent-1/recompile",
      body: undefined,
    }));
    expect(requests.filter((request) =>
      request.method === "DELETE" &&
      request.url.endsWith("/repositories/repo-1"),
    )).toHaveLength(0);
  });

  test("uses an explicit computer before using the Remote Client websocket", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      computer: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1", {
      model: "anthropic/claude-sonnet-4",
      cwd: "/repo",
      permissionMode: "unrestricted",
      skillSources: [],
      toolset: {
        base: "none",
        include: ["Read", "LS", "Glob", "Grep"],
      },
      allowedTools: ["Read", "LS", "Glob", "Grep"],
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

    await expect(session.recoverPendingApprovals({ timeoutMs: 1_000 })).resolves.toEqual({
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

    const result = await asAdvanced(session).sendAndWaitForResult("hello");
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
        client_tool_allowlist: ["Read", "LS", "Glob", "Grep"],
        client_toolset: {
          base: "none",
          include: ["Read", "LS", "Glob", "Grep"],
        },
      },
    });
    expect(inputCommand.payload).not.toHaveProperty("supports_control_response");
    expect(inputCommand.payload).not.toHaveProperty("source");
    expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 101 });
    expect(streamSocket.sent).toContainEqual({ type: "ack", seq: 102 });

    session.close();
  });

  test("recovers an idle Cloud status transport before sending one input", async () => {
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
    try {
      await asAdvanced(session).initialize();
      expect(FakeCloudSocket.instances).toHaveLength(2);

      // The runtime is live, but no input has been tracked or sent. A Cloud
      // rollout closes one status socket and the paired transport follows.
      FakeCloudSocket.socket("stream")!.close();
      await Promise.resolve();

      const result = await asAdvanced(session).sendAndWaitForResult("hello once");
      expect(result).toMatchObject({
        success: true,
        result: "hello from cloud",
      });

      expect(FakeCloudSocket.instances).toHaveLength(4);
      expect(
        FakeCloudSocket.allSent().filter((command) => command.type === "runtime_start"),
      ).toHaveLength(2);
      const inputs = FakeCloudSocket.allSent().filter((command) => {
        const payload = command.payload as { kind?: string } | undefined;
        return command.type === "input" && payload?.kind === "create_message";
      });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        payload: {
          messages: [expect.objectContaining({ content: "hello once" })],
        },
      });
      expect(
        requests.filter((request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === "/v1/agents/agent-1/sandboxes"
        ),
      ).toHaveLength(1);
    } finally {
      session.close();
    }
  });

  test("retries an initial Cloud transport failure before sending input", async () => {
    resetFakeCloud();
    FakeCloudSocket.openConnectionFailuresRemaining = 1;
    const warningSpy = spyOn(console, "warn").mockImplementation(() => {});
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
    try {
      const result = await asAdvanced(session).sendAndWaitForResult("hello once");
      expect(result).toMatchObject({
        success: true,
        result: "hello from cloud",
      });

      expect(FakeCloudSocket.instances).toHaveLength(4);
      expect(
        FakeCloudSocket.allSent().filter((command) => command.type === "runtime_start"),
      ).toHaveLength(1);
      expect(
        FakeCloudSocket.allSent().filter((command) => {
          const payload = command.payload as { kind?: string } | undefined;
          return command.type === "input" && payload?.kind === "create_message";
        }),
      ).toHaveLength(1);
      expect(
        requests.filter((request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === "/v1/agents/agent-1/sandboxes"
        ),
      ).toHaveLength(1);
      expect(warningSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warningSpy.mock.calls[0]?.[0]))).toEqual({
        event: "cloud_status_transport_connection_failed",
        attempt: 1,
        max_attempts: 2,
        will_retry: true,
        connection_id: "conn-agent-1",
        agent_id: "agent-1",
        conversation_id: "default",
        error_name: "Error",
        error_message:
          "App-server WebSocket failed to open: Error: initial socket open failed",
      });
    } finally {
      session.close();
      warningSpy.mockRestore();
    }
  });

  test("bounds initial Cloud transport retries before runtime start", async () => {
    resetFakeCloud();
    FakeCloudSocket.openConnectionFailuresRemaining = 2;
    const warningSpy = spyOn(console, "warn").mockImplementation(() => {});
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      requestTimeoutMs: 1_000,
      environment: { connectionId: "conn-explicit" },
    });

    const session = client.resumeSession("agent-1");
    try {
      await expect(asAdvanced(session).initialize()).rejects.toThrow(
        "Cloud status WebSocket failed to open for connection conn-explicit",
      );
      expect(FakeCloudSocket.instances).toHaveLength(4);
      expect(
        FakeCloudSocket.allSent().filter((command) => command.type === "runtime_start"),
      ).toHaveLength(0);
      expect(
        FakeCloudSocket.allSent().filter((command) => command.type === "input"),
      ).toHaveLength(0);
      expect(
        warningSpy.mock.calls.map(([line]) => JSON.parse(String(line))),
      ).toEqual([
        expect.objectContaining({
          event: "cloud_status_transport_connection_failed",
          attempt: 1,
          max_attempts: 2,
          will_retry: true,
          connection_id: "conn-explicit",
        }),
        expect.objectContaining({
          event: "cloud_status_transport_connection_failed",
          attempt: 2,
          max_attempts: 2,
          will_retry: false,
          connection_id: "conn-explicit",
        }),
      ]);
    } finally {
      session.close();
      warningSpy.mockRestore();
    }
  });

  test("keeps a Cloud transport drop terminal after input may have dispatched", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "hang";
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
      await session.send("possibly dispatched");
      const messages: unknown[] = [];
      const drained = (async () => {
        for await (const message of session.stream()) messages.push(message);
      })();
      await Promise.resolve();

      FakeCloudSocket.socket("stream")!.close();
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
      await expect(session.send("do not replay")).rejects.toThrow("Session is closed");
      const inputs = FakeCloudSocket.allSent().filter((command) => {
        const payload = command.payload as { kind?: string } | undefined;
        return command.type === "input" && payload?.kind === "create_message";
      });
      expect(inputs).toHaveLength(1);
    } finally {
      FakeCloudSocket.scenario = "normal";
      session.close();
    }
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
      const result = await asAdvanced(session).sendAndWaitForResult("hello");
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
      await expect(session.recoverPendingApprovals({ timeoutMs: 1_000 })).resolves.toEqual({
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

  test("reads device status via getDeviceStatus and onDeviceStatus", async () => {
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
      const runtime = { agent_id: "agent-1", conversation_id: "default" };
      const statusSyncs = () =>
        controlSocket.sent.filter(
          (command) => command.type === "sync" && command.recover_approvals === false,
        );

      // No replay from the device: the request-correlated sync is acknowledged,
      // but the read still times out instead of inventing status.
      await expect(session.getDeviceStatus({ timeoutMs: 50 })).rejects.toThrow(
        "Timed out waiting for cloud device status",
      );
      expect(statusSyncs()).toHaveLength(1);
      expect(statusSyncs()[0]).toMatchObject({
        runtime,
        recover_approvals: false,
        force_device_status: true,
      });

      // The device replays update_device_status in response to the forced sync.
      FakeCloudSocket.deviceStatusOnSync = true;
      const status = await session.getDeviceStatus();
      expect(status).toMatchObject({
        isOnline: true,
        isProcessing: false,
        permissionMode: "acceptEdits",
        workingDirectory: "/workspace/project",
        memoryDirectory: "/memory/cloud-agent",
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
      expect(status.raw).toMatchObject({
        current_permission_mode: "acceptEdits",
        current_working_directory: "/workspace/project",
        memory_directory: "/memory/cloud-agent",
      });
      expect(statusSyncs()).toHaveLength(2);

      // Every getter is fresh, including after a prior snapshot exists.
      expect(await session.getDeviceStatus()).toMatchObject({
        permissionMode: "acceptEdits",
        workingDirectory: "/workspace/project",
        memoryDirectory: "/memory/cloud-agent",
      });
      expect(statusSyncs()).toHaveLength(3);

      // Subscription: every incoming update_device_status is delivered.
      const seen: SessionDeviceStatus[] = [];
      const unsubscribe = session.onDeviceStatus((update) => seen.push(update));
      controlSocket.serverMessage({
        type: "update_device_status",
        runtime,
        device_status: {
          is_online: true,
          is_processing: true,
          current_permission_mode: "unrestricted",
          current_working_directory: "/workspace/elsewhere",
          pending_control_requests: [],
        },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        isOnline: true,
        isProcessing: true,
        permissionMode: "unrestricted",
        workingDirectory: "/workspace/elsewhere",
        memoryDirectory: null,
        pendingControlRequests: [],
      });

      // The getter does not trust a push that may predate foreground resume;
      // it forces an authoritative replay.
      expect(await session.getDeviceStatus()).toMatchObject({
        permissionMode: "acceptEdits",
        isProcessing: false,
        workingDirectory: "/workspace/project",
      });
      expect(statusSyncs()).toHaveLength(4);
      expect(seen).toHaveLength(2);

      // Updates scoped to another runtime are ignored.
      controlSocket.serverMessage({
        type: "update_device_status",
        runtime: { agent_id: "agent-other", conversation_id: "default" },
        device_status: {
          is_online: false,
          is_processing: false,
          current_permission_mode: "standard",
          current_working_directory: null,
          pending_control_requests: [],
        },
      });
      expect(seen).toHaveLength(2);

      // Unsubscribe stops delivery.
      unsubscribe();
      controlSocket.serverMessage({
        type: "update_device_status",
        runtime,
        device_status: {
          is_online: false,
          is_processing: false,
          current_permission_mode: "standard",
          current_working_directory: "/workspace/elsewhere",
          pending_control_requests: [],
        },
      });
      expect(seen).toHaveLength(2);
      expect(await session.getDeviceStatus()).toMatchObject({
        isOnline: true,
        permissionMode: "acceptEdits",
      });
      expect(statusSyncs()).toHaveLength(5);

      // A failed sync rejects immediately even if a status frame was observed.
      FakeCloudSocket.syncSucceeds = false;
      await expect(session.getDeviceStatus()).rejects.toThrow("sync failed");
      FakeCloudSocket.syncSucceeds = true;

      await expect(session.getDeviceStatus({ timeoutMs: 0 })).rejects.toThrow(
        "Invalid device status timeout",
      );

      FakeCloudSocket.deviceStatusOnSync = false;
      const pendingRead = session.getDeviceStatus({ timeoutMs: 1_000 });
      await Promise.resolve();
      session.close();
      await expect(pendingRead).rejects.toThrow(
        "Session closed while waiting for cloud device status",
      );
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
      expect(page.messages).toEqual([RUNTIME_MESSAGE_FIXTURE]);
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
      expect(page.messages).toEqual([RUNTIME_MESSAGE_FIXTURE]);
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

  test("concurrent Cloud listMessages and send share one initialize and connection", async () => {
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
      const [page] = await Promise.all([
        session.listMessages({ limit: 1 }),
        session.send("hello"),
      ]);
      expect(page.messages).toEqual([RUNTIME_MESSAGE_FIXTURE]);

      // A single control+stream pair and a single runtime_start: the second
      // caller joins the in-flight initialize instead of reconnecting.
      expect(FakeCloudSocket.instances).toHaveLength(2);
      expect(
        FakeCloudSocket.allSent().filter((cmd) => cmd.type === "runtime_start"),
      ).toHaveLength(1);
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
      expect(page.messages).toEqual([RUNTIME_MESSAGE_FIXTURE]);
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
      const state = await session.bootstrapState({ limit: 3 });
      expect(state).toMatchObject({
        agentId: "agent-from-conv",
        conversationId: "conv-1",
        messages: [RUNTIME_MESSAGE_FIXTURE],
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

  test("creates Cloud agents directly through the REST API", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
    });

    await expect(client.createAgent({
      model: "anthropic/claude-sonnet-4",
      systemPrompt: "You are a repo assistant.",
      memory: [{ label: "project", value: "Use Bun." }],
      tags: ["team:sdk"],
    })).resolves.toBe("agent-created");

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://api.test/v1/agents/",
      method: "POST",
      headers: {
        authorization: "Bearer sk-test",
        "content-type": "application/json",
      },
      body: {
        model: "anthropic/claude-sonnet-4",
        system: "You are a repo assistant.",
        memory_blocks: expect.arrayContaining([
          expect.objectContaining({ label: "project", value: "Use Bun." }),
        ]),
      },
    });
    const createBody = requests[0]!.body as {
      tags: string[];
      memory_blocks: Array<{ label: string; value: string }>;
      name?: string;
      description?: string;
    };
    expect(createBody.tags).toEqual([
      "origin:letta-code",
      "git-memory-enabled",
      "team:sdk",
    ]);
    expect(createBody.memory_blocks).toEqual([
      { label: "project", value: "Use Bun." },
    ]);
    expect(createBody).not.toHaveProperty("name");
    expect(createBody).not.toHaveProperty("description");

    await expect(client.createAgent({
      model: "anthropic/claude-sonnet-4",
      systemPrompt: "default",
    })).rejects.toThrow(
      "createAgent() does not yet support system prompt presets for this backend",
    );
  });

  test("uses the Letta Code default model for Cloud createAgent", async () => {
    resetFakeCloud();
    const requests: RecordedRequest[] = [];
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock(requests),
      WebSocket: FakeCloudSocket,
    });

    await expect(client.createAgent()).resolves.toBe("agent-created");
    expect(requests[0]?.body).toMatchObject({ model: "letta/auto" });

    await expect(client.createAgent({
      model: "   ",
    })).rejects.toThrow('Unknown model:');

    expect(requests).toHaveLength(1);
  });

  test("responds to Remote Client approval requests through canUseTool", async () => {
    resetFakeCloud();
    FakeCloudSocket.scenario = "approval";
    const requests: RecordedRequest[] = [];
    const decisions: Array<{
      toolName: string;
      input: Record<string, unknown>;
      context: CanUseToolContext | undefined;
    }> = [];
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
      canUseTool: (toolName, input, context) => {
        decisions.push({ toolName, input, context });
        return { behavior: "allow", updatedInput: { command: "echo approved" } };
      },
    });

    const result = await asAdvanced(session).sendAndWaitForResult("run pwd");

    expect(result).toMatchObject({ success: true, result: "approved" });
    expect(decisions).toEqual([
      {
        toolName: "Bash",
        input: { command: "pwd" },
        context: {
          requestId: "approval-1",
          toolCallId: "toolu-approval-1",
          permissionSuggestions: [
            { id: "suggestion-1", text: "Allow Bash(pwd) for this session" },
          ],
          blockedPath: null,
          diffs: [{ mode: "fallback", fileName: "unused.txt", reason: "not a file edit" }],
        },
      },
    ]);
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

  test("legacy two-argument canUseTool callbacks still work for approval requests", async () => {
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
        return { behavior: "allow" };
      },
    });

    const result = await asAdvanced(session).sendAndWaitForResult("run pwd");

    expect(result).toMatchObject({ success: true, result: "approved" });
    expect(decisions).toEqual([{ toolName: "Bash", input: { command: "pwd" } }]);

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
      stateless: true,
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
        stateless: true,
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

    expect(() => new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      sandbox: {
        githubRepositories: Array.from({ length: 11 }, (_, index) => ({
          owner: "letta-ai",
          repo: `repo-${index}`,
        })),
      },
    })).toThrow("Expected at most 10 repositories");

    expect(() => new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      sandbox: {
        githubRepositories: [{ owner: "letta ai", repo: "letta-code" }],
      },
    })).toThrow("githubRepositories[0].owner");

    expect(() => new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createCloudFetchMock([]),
      WebSocket: FakeCloudSocket,
      sandbox: {
        githubRepositories: [{ owner: "letta-ai", repo: "letta/code" }],
      },
    })).toThrow("githubRepositories[0].repo");

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
    const result = await asAdvanced(session).sendAndWaitForResult("trigger failure");

    expect(result).toMatchObject({
      type: "result",
      success: false,
      error: "cloud turn failed",
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
    const result = await asAdvanced(session).sendAndWaitForResult("trigger delayed failure");

    expect(result).toMatchObject({
      type: "result",
      success: false,
      error: "delayed cloud turn failed",
      errorCode: "error",
      errorDetail: "delayed cloud turn failed",
      conversationId: "default",
    });
    expect(FakeCloudSocket.socket("stream")!.sent).toContainEqual({ type: "ack", seq: 301 });
    expect(FakeCloudSocket.socket("stream")!.sent).toContainEqual({ type: "ack", seq: 304 });

    session.close();
  });
});
