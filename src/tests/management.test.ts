import { describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { AppServerManagementTransport } from "../app-server-management.js";
import { LettaAgentClient as PortableLettaAgentClient } from "../client-entry.js";
import {
  ConversationForkHydrationError,
  LettaAgentClient as NodeLettaAgentClient,
} from "../index.js";
import type { LettaCodeSocketOptions } from "../types.js";
import { asAdvanced } from "./advanced-session.js";

type FetchInput = Parameters<typeof fetch>[0];
type Listener = (event: unknown) => void;

type RecordedRequest = {
  url: URL;
  method: string;
  body?: unknown;
};

const AGENT_FIXTURE: AgentState = {
  id: "agent-1",
  name: "Memo",
  agent_type: "letta_v1_agent",
  blocks: [],
  llm_config: {} as AgentState["llm_config"],
  memory: {} as AgentState["memory"],
  sources: [],
  system: "",
  tags: [],
  tools: [],
};

const USER_MESSAGE_FIXTURE: Message = {
  id: "message-1",
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

function requestBody(init?: RequestInit): unknown {
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

function createManagementFetch(
  requests: RecordedRequest[],
): typeof fetch {
  return (async (
    input: FetchInput | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = requestBody(init);
    requests.push({ url, method, body });

    if (url.pathname === "/v1/agents/" && method === "GET") {
      return jsonResponse([AGENT_FIXTURE]);
    }
    if (url.pathname === "/v1/agents/agent-1" && method === "GET") {
      return jsonResponse(AGENT_FIXTURE);
    }
    if (url.pathname === "/v1/agents/agent-1" && method === "PATCH") {
      return jsonResponse({ ...AGENT_FIXTURE, name: "Renamed", ...body as object });
    }
    if (url.pathname === "/v1/agents/agent-1" && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/models/" && method === "GET") {
      return jsonResponse([
        {
          handle: "anthropic/claude-haiku-4-5",
          name: "claude-haiku-4-5",
          display_name: "Claude Haiku 4.5",
          context_window: 200_000,
        },
        { name: "malformed-without-handle" },
      ]);
    }
    if (url.pathname === "/v1/conversations/" && method === "GET") {
      return jsonResponse([
        { id: "conv-1", agent_id: "agent-1", summary: "First" },
      ]);
    }
    if (
      url.pathname === "/v1/conversations/conv-1" &&
      method === "GET"
    ) {
      return jsonResponse({
        id: "conv-1",
        agent_id: "agent-1",
        summary: "First",
      });
    }
    if (url.pathname === "/v1/conversations/" && method === "POST") {
      return jsonResponse({
        id: "conv-2",
        agent_id: url.searchParams.get("agent_id"),
        ...body as object,
      });
    }
    if (
      url.pathname === "/v1/conversations/conv-1" &&
      method === "PATCH"
    ) {
      return jsonResponse({
        id: "conv-1",
        agent_id: "agent-1",
        ...body as object,
      });
    }
    if (
      url.pathname === "/v1/conversations/conv-1/messages" &&
      method === "GET"
    ) {
      return jsonResponse([USER_MESSAGE_FIXTURE]);
    }
    if (
      url.pathname === "/v1/conversations/conv-source/fork" &&
      method === "POST"
    ) {
      return jsonResponse({
        id: "conv-fork",
        agent_id: "agent-1",
        archived: false,
      });
    }
    if (
      url.pathname === "/v1/conversations/conv-fork" &&
      method === "PATCH"
    ) {
      return jsonResponse({
        id: "conv-fork",
        agent_id: "agent-1",
        archived: true,
      });
    }
    if (
      /^\/v1\/conversations\/[^/]+\/messages\/enqueue$/.test(url.pathname) &&
      method === "POST"
    ) {
      const enqueueBody = body as { client_message_id?: string };
      return jsonResponse(
        {
          client_message_id: enqueueBody.client_message_id,
          workflow_id: "conversation-queue:conv-1",
          super_run_id: "super-run-1",
        },
        { status: 202 },
      );
    }
    return jsonResponse({ detail: "not found" }, { status: 404 });
  }) as typeof fetch;
}

class ManagementSocket {
  static instances: ManagementSocket[] = [];
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly options?: LettaCodeSocketOptions,
  ) {
    ManagementSocket.instances.push(this);
    queueMicrotask(() => this.handleConnect());
  }

  protected handleConnect(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  send(data: string): void {
    const command = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(command);
    this.respond(command);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  protected respond(command: Record<string, unknown>): void {
    const responses: Record<string, Record<string, unknown>> = {
      agent_list: {
        agents: [AGENT_FIXTURE],
      },
      agent_retrieve: {
        agent: AGENT_FIXTURE,
      },
      agent_update: {
        agent: {
          ...AGENT_FIXTURE,
          ...(command.body as object),
        },
      },
      agent_delete: {
        agent_id: command.agent_id,
      },
      list_models: {
        entries: [
          {
            id: "claude-haiku-4-5",
            handle: "anthropic/claude-haiku-4-5",
            label: "Claude Haiku 4.5",
            description: "Fast everyday model.",
            isDefault: true,
          },
        ],
        available_handles: ["anthropic/claude-haiku-4-5"],
        byok_provider_aliases: { "lc-anthropic": "anthropic" },
      },
      conversation_list: {
        conversations: [
          { id: "conv-1", agent_id: "agent-1", summary: "First" },
        ],
      },
      conversation_retrieve: {
        conversation: {
          id: command.conversation_id,
          agent_id: "agent-1",
          summary: "First",
        },
      },
      conversation_create: {
        conversation: {
          id: "conv-2",
          ...(command.body as object),
        },
      },
      conversation_update: {
        conversation: {
          id: command.conversation_id,
          agent_id: "agent-1",
          ...(command.body as object),
        },
      },
      conversation_fork: {
        conversation: {
          id: "conv-fork",
        },
      },
      conversation_messages_list: {
        messages: [USER_MESSAGE_FIXTURE],
      },
    };
    const type = String(command.type);
    const payload = responses[type];
    if (!payload) throw new Error(`Unexpected management command ${type}`);
    queueMicrotask(() => {
      this.emit("message", {
        data: JSON.stringify({
          type: `${type}_response`,
          request_id: command.request_id,
          success: true,
          ...payload,
        }),
      });
    });
  }

  protected emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function exerciseManagementApi(
  client: PortableLettaAgentClient,
): Promise<void> {
  await expect(
    client.agents.list({
      query: "memo",
      tags: ["mobile", "example"],
      matchAllTags: true,
      limit: 20,
      orderBy: "lastRunCompletion",
    }),
  ).resolves.toEqual([AGENT_FIXTURE]);
  await expect(client.agents.retrieve("agent-1")).resolves.toMatchObject({
    id: "agent-1",
  });
  await expect(
    client.agents.update("agent-1", {
      name: "Renamed",
      contextWindowLimit: 32_000,
    }),
  ).resolves.toMatchObject({ id: "agent-1", name: "Renamed" });
  await expect(client.agents.delete("agent-1")).resolves.toBeUndefined();

  const models = await client.models.list();
  expect(models.entries).toHaveLength(1);
  expect(models.entries[0]).toMatchObject({
    handle: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5",
  });
  expect(models.availableHandles).toEqual([
    "anthropic/claude-haiku-4-5",
  ]);

  await expect(
    client.conversations.list({
      agentId: "agent-1",
      summarySearch: "first",
      orderBy: "lastMessageAt",
      order: "desc",
    }),
  ).resolves.toHaveLength(1);
  await expect(
    client.conversations.retrieve("conv-1"),
  ).resolves.toMatchObject({ id: "conv-1", agent_id: "agent-1" });
  await expect(
    client.conversations.create({
      agentId: "agent-1",
      summary: "Mobile thread",
      model: "openai/gpt-5.6",
    }),
  ).resolves.toMatchObject({
    id: "conv-2",
    agent_id: "agent-1",
    summary: "Mobile thread",
  });
  await expect(
    client.conversations.update("conv-1", {
      summary: "Renamed thread",
      archived: false,
    }),
  ).resolves.toMatchObject({
    id: "conv-1",
    summary: "Renamed thread",
  });
  await expect(
    client.conversations.listMessages("conv-1", {
      before: "message-2",
      limit: 50,
      order: "desc",
    }),
  ).resolves.toEqual({
    messages: [USER_MESSAGE_FIXTURE],
  });
}

describe("portable management namespaces", () => {
  test("lists and restores archived conversations over Cloud", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    await expect(
      client.conversations.list({ archiveStatus: "archived" }),
    ).resolves.toHaveLength(1);
    await expect(
      client.conversations.update("conv-1", { archived: false }),
    ).resolves.toMatchObject({ id: "conv-1", archived: false });

    expect(requests.map(({ url, method, body }) => ({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      method,
      body,
    }))).toEqual([
      {
        path: "/v1/conversations/",
        query: { archive_status: "archived" },
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/conversations/conv-1",
        query: {},
        method: "PATCH",
        body: { archived: false },
      },
    ]);
  });

  test("lists and restores archived conversations over the App Server", async () => {
    ManagementSocket.instances = [];
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url: "ws://remote.test/ws",
      WebSocket: ManagementSocket,
    });

    await expect(
      client.conversations.list({ archiveStatus: "archived" }),
    ).resolves.toHaveLength(1);
    await expect(
      client.conversations.update("conv-1", { archived: false }),
    ).resolves.toMatchObject({ id: "conv-1", archived: false });

    expect(
      ManagementSocket.instances.flatMap((socket) => socket.sent),
    ).toEqual([
      expect.objectContaining({
        type: "conversation_list",
        query: { archive_status: "archived" },
      }),
      expect.objectContaining({
        type: "conversation_update",
        conversation_id: "conv-1",
        body: { archived: false },
      }),
    ]);
  });

  test("forks through a selected message and archives the fork over Cloud", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    const fork = await client.conversations.fork("conv-source", {
      messageId: "message-checkpoint",
      hidden: true,
    });
    expect(fork).toMatchObject({
      id: "conv-fork",
      agent_id: "agent-1",
      archived: false,
    });

    await expect(
      client.conversations.update(fork.id, { archived: true }),
    ).resolves.toMatchObject({
      id: "conv-fork",
      archived: true,
    });

    expect(
      requests.map(({ url, method, body }) => ({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        method,
        body,
      })),
    ).toEqual([
      {
        path: "/v1/conversations/conv-source/fork",
        query: {
          hidden: "true",
          message_id: "message-checkpoint",
        },
        method: "POST",
        body: undefined,
      },
      {
        path: "/v1/conversations/conv-fork",
        query: {},
        method: "PATCH",
        body: { archived: true },
      },
    ]);
  });

  test("omits fork query parameters when copying the full history", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    await expect(
      client.conversations.fork("conv-source"),
    ).resolves.toMatchObject({ id: "conv-fork" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe(
      "/v1/conversations/conv-source/fork",
    );
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({});
    expect(requests[0]?.body).toBeUndefined();
  });

  test("enqueues a message over Cloud and returns the acceptance receipt", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    const result = await client.conversations.enqueue("conv-1", "hello", {
      clientMessageId: "client-message-1",
    });
    expect(result).toEqual({
      clientMessageId: "client-message-1",
      workflowId: "conversation-queue:conv-1",
      superRunId: "super-run-1",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe(
      "/v1/conversations/conv-1/messages/enqueue",
    );
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toEqual({
      messages: [
        {
          role: "user",
          content: "hello",
          client_message_id: "client-message-1",
        },
      ],
      client_message_id: "client-message-1",
    });
  });

  test("generates a client message id and forwards runtime settings", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    const result = await client.conversations.enqueue(
      "default",
      [{ type: "text", text: "hello" }],
      {
        agentId: "agent-1",
        permissionMode: "unrestricted",
        workingDirectory: null,
      },
    );
    expect(result.clientMessageId).toBeString();
    expect(result.clientMessageId.length).toBeGreaterThan(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe(
      "/v1/conversations/default/messages/enqueue",
    );
    expect(requests[0]?.body).toEqual({
      agent_id: "agent-1",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          client_message_id: result.clientMessageId,
        },
      ],
      client_message_id: result.clientMessageId,
      settings: {
        working_directory: null,
        permission_mode: "unrestricted",
      },
    });
  });

  test("rejects a default-conversation enqueue without an agent id", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    await expect(
      client.conversations.enqueue("default", "hello"),
    ).rejects.toThrow(
      'enqueue("default", ...) requires options.agentId to identify the agent.',
    );
    await expect(
      client.conversations.enqueue("conv-1", "hello", { clientMessageId: " " }),
    ).rejects.toThrow("Invalid client message id. Expected a non-empty string.");
    await expect(
      client.conversations.enqueue("  ", "hello"),
    ).rejects.toThrow("Invalid conversation id. Expected a non-empty string.");
    expect(requests).toHaveLength(0);
  });

  test("propagates Cloud enqueue rejections and rejects malformed acceptances", async () => {
    const responses = [
      new Response(JSON.stringify({ error: "Conversation not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ client_message_id: "client-message-1" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: (async () => responses.shift()!) as unknown as typeof fetch,
    });

    await expect(
      client.conversations.enqueue("conv-missing", "hello"),
    ).rejects.toThrow("404");
    await expect(
      client.conversations.enqueue("conv-1", "hello"),
    ).rejects.toThrow(
      "Cloud enqueue message response did not include client_message_id, workflow_id, and super_run_id.",
    );
  });

  test("rejects enqueue on the app-server backend as cloud-only", async () => {
    ManagementSocket.instances = [];
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url: "ws://remote.test/ws",
      WebSocket: ManagementSocket,
    });

    await expect(
      client.conversations.enqueue("conv-1", "hello"),
    ).rejects.toThrow(
      'conversations.enqueue() is only available with backend: "cloud".',
    );
  });

  test("rejects an empty fork source before selecting a transport", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    await expect(
      client.conversations.fork("  ", { hidden: true }),
    ).rejects.toThrow(
      "Invalid conversation id. Expected a non-empty string.",
    );
    expect(requests).toHaveLength(0);
  });

  test("rejects an empty fork checkpoint before selecting a transport", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    await expect(
      client.conversations.fork("conv-source", { messageId: "" }),
    ).rejects.toThrow(
      "Invalid message id. Expected a non-empty string.",
    );
    expect(requests).toHaveLength(0);
  });

  test("forks and archives through the App Server protocol", async () => {
    ManagementSocket.instances = [];
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url: "ws://remote.test/ws",
      WebSocket: ManagementSocket,
    });

    const fork = await client.conversations.fork("conv-source", {
      messageId: "message-checkpoint",
      hidden: true,
    });
    expect(fork).toMatchObject({
      id: "conv-fork",
      agent_id: "agent-1",
    });

    await expect(
      client.conversations.update(fork.id, { archived: true }),
    ).resolves.toMatchObject({ id: "conv-fork", archived: true });

    const commands = ManagementSocket.instances.flatMap(
      (socket) => socket.sent,
    );
    expect(commands).toEqual([
      expect.objectContaining({
        type: "conversation_fork",
        conversation_id: "conv-source",
        body: {
          message_id: "message-checkpoint",
          hidden: true,
        },
      }),
      expect.objectContaining({
        type: "conversation_retrieve",
        conversation_id: "conv-fork",
      }),
      expect.objectContaining({
        type: "conversation_update",
        conversation_id: "conv-fork",
        body: { archived: true },
      }),
    ]);
  });

  test("does not retrieve a conversation after an App Server fork failure", async () => {
    class FailingForkSocket extends ManagementSocket {
      protected override respond(command: Record<string, unknown>): void {
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "conversation_fork_response",
              request_id: command.request_id,
              success: false,
              conversation: null,
              error: "Source message was not found.",
            }),
          });
        });
      }
    }

    ManagementSocket.instances = [];
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url: "ws://remote.test/ws",
      WebSocket: FailingForkSocket,
    });

    await expect(
      client.conversations.fork("conv-source", {
        messageId: "message-missing",
      }),
    ).rejects.toThrow("Source message was not found.");

    const commands = ManagementSocket.instances.flatMap(
      (socket) => socket.sent,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "conversation_fork",
      conversation_id: "conv-source",
    });
  });

  test("preserves the fork id when App Server hydration fails", async () => {
    class FailingForkHydrationSocket extends ManagementSocket {
      protected override respond(command: Record<string, unknown>): void {
        const type = String(command.type);
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify(
              type === "conversation_fork"
                ? {
                    type: "conversation_fork_response",
                    request_id: command.request_id,
                    success: true,
                    conversation: { id: "conv-orphan" },
                  }
                : {
                    type: "conversation_retrieve_response",
                    request_id: command.request_id,
                    success: false,
                    conversation: null,
                    error: "Connection closed during hydration.",
                  },
            ),
          });
        });
      }
    }

    ManagementSocket.instances = [];
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url: "ws://remote.test/ws",
      WebSocket: FailingForkHydrationSocket,
    });

    try {
      await client.conversations.fork("conv-source");
      throw new Error("Expected fork hydration to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationForkHydrationError);
      expect((error as ConversationForkHydrationError).conversationId).toBe(
        "conv-orphan",
      );
      expect((error as Error).message).toContain("conv-orphan");
    }
  });

  test("map the portable API to Cloud REST", async () => {
    const requests: RecordedRequest[] = [];
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: createManagementFetch(requests),
    });

    await expect(client.agents.delete("  ")).rejects.toThrow(
      "Invalid agent id. Expected a non-empty string.",
    );
    expect(requests).toHaveLength(0);

    await exerciseManagementApi(client);

    expect(requests.map(({ url, method, body }) => ({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      method,
      body,
    }))).toEqual([
      {
        path: "/v1/agents/",
        query: {
          query_text: "memo",
          tags: "example",
          match_all_tags: "true",
          limit: "20",
          order_by: "last_run_completion",
        },
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/agents/agent-1",
        query: {},
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/agents/agent-1",
        query: {},
        method: "PATCH",
        body: { name: "Renamed", context_window_limit: 32_000 },
      },
      {
        path: "/v1/agents/agent-1",
        query: {},
        method: "DELETE",
        body: undefined,
      },
      {
        path: "/v1/models/",
        query: {},
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/conversations/",
        query: {
          agent_id: "agent-1",
          order: "desc",
          order_by: "last_message_at",
          summary_search: "first",
        },
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/conversations/conv-1",
        query: {},
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/conversations/",
        query: { agent_id: "agent-1" },
        method: "POST",
        body: { summary: "Mobile thread", model: "openai/gpt-5.6" },
      },
      {
        path: "/v1/conversations/conv-1",
        query: {},
        method: "PATCH",
        body: { summary: "Renamed thread", archived: false },
      },
      {
        // The chronological `before` cursor maps to the REST `after` key on
        // descending requests because the API reads cursors relative to sort
        // order.
        path: "/v1/conversations/conv-1/messages",
        query: { after: "message-2", order: "desc", limit: "50" },
        method: "GET",
        body: undefined,
      },
    ]);
    expect(requests[0]?.url.searchParams.getAll("tags")).toEqual([
      "mobile",
      "example",
    ]);
    // Production api.letta.com 404s trailing-slash non-GET agent routes, so
    // the delete URL must never gain a trailing slash.
    const deleteRequest = requests.find(({ method }) => method === "DELETE");
    expect(deleteRequest?.url.toString()).toBe(
      "https://api.test/v1/agents/agent-1",
    );
  });

  test("pages older cloud history with chronological before cursors", async () => {
    // Five messages, message-1 oldest. The mock reproduces the measured REST
    // behavior: cursors are interpreted relative to the requested sort order,
    // and the default order is newest-first.
    const history: Message[] = [1, 2, 3, 4, 5].map((n) => ({
      id: `message-${n}`,
      content: `m${n}`,
      date: `2026-07-28T00:0${n}:00Z`,
      message_type: "user_message",
    }));
    const requests: RecordedRequest[] = [];
    const fetchMock = (async (
      input: FetchInput | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      requests.push({ url, method: init?.method ?? "GET" });
      const order = url.searchParams.get("order") ?? "desc";
      const sequence =
        order === "desc" ? [...history].reverse() : [...history];
      const after = url.searchParams.get("after");
      const before = url.searchParams.get("before");
      let start = 0;
      let end = sequence.length;
      if (after) {
        start = sequence.findIndex((message) => message.id === after) + 1;
      }
      if (before) {
        end = sequence.findIndex((message) => message.id === before);
      }
      const limit = Number(url.searchParams.get("limit") ?? "50");
      return jsonResponse(sequence.slice(start, end).slice(0, limit));
    }) as typeof fetch;

    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: fetchMock,
    });

    // Walk the conversation to its beginning; every page must be strictly
    // older than the previous one with no duplicate ids.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const { messages } = await client.conversations.listMessages("conv-1", {
        limit: 2,
        ...(cursor ? { before: cursor } : {}),
      });
      seen.push(...messages.map((message) => message.id));
      cursor = messages[messages.length - 1]?.id;
    }
    expect(seen).toEqual([
      "message-5",
      "message-4",
      "message-3",
      "message-2",
      "message-1",
    ]);

    // On the wire, descending pagination must have swapped the chronological
    // cursor onto the REST after key.
    const cursorQueries = requests.map(({ url }) =>
      Object.fromEntries(url.searchParams),
    );
    expect(cursorQueries[1]).toEqual({ after: "message-4", limit: "2" });
    expect(cursorQueries[2]).toEqual({ after: "message-2", limit: "2" });

    // Ascending requests already agree with the chronological contract and
    // must pass through unchanged.
    const ascending = await client.conversations.listMessages("conv-1", {
      order: "asc",
      after: "message-2",
      limit: 2,
    });
    expect(ascending.messages.map((message) => message.id)).toEqual([
      "message-3",
      "message-4",
    ]);
    expect(
      Object.fromEntries(requests[requests.length - 1]!.url.searchParams),
    ).toEqual({ after: "message-2", order: "asc", limit: "2" });
  });

  test("maps the same API to app-server protocol commands", async () => {
    ManagementSocket.instances = [];
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url: "ws://remote.test/ws",
      authToken: "remote-token",
      WebSocket: ManagementSocket,
    });

    await exerciseManagementApi(client);

    const commands = ManagementSocket.instances.flatMap(
      (socket) => socket.sent,
    );
    expect(commands.map(({ type }) => type)).toEqual([
      "agent_list",
      "agent_retrieve",
      "agent_update",
      "agent_delete",
      "list_models",
      "conversation_list",
      "conversation_retrieve",
      "conversation_create",
      "conversation_update",
      "conversation_messages_list",
    ]);
    expect(commands[0]).toMatchObject({
      query: {
        query_text: "memo",
        tags: ["mobile", "example"],
        match_all_tags: true,
        limit: 20,
        order_by: "last_run_completion",
      },
    });
    expect(commands[3]).toMatchObject({
      type: "agent_delete",
      agent_id: "agent-1",
    });
    // list_models must stay session-less: a bare command (no runtime scope)
    // is answered on the control channel.
    expect(Object.keys(commands[4] ?? {}).sort()).toEqual([
      "request_id",
      "type",
    ]);
    expect(commands[7]).toMatchObject({
      body: {
        agent_id: "agent-1",
        summary: "Mobile thread",
        model: "openai/gpt-5.6",
      },
    });
    // The app-server backend already speaks chronological cursors, so the
    // Cloud-only order-relative swap must not apply here.
    expect(commands[9]).toMatchObject({
      type: "conversation_messages_list",
      conversation_id: "conv-1",
      query: { before: "message-2", order: "desc", limit: 50 },
    });
    expect(
      ManagementSocket.instances.every(
        (socket) =>
          socket.options?.headers?.Authorization === "Bearer remote-token",
      ),
    ).toBe(true);
    await expect(client.models.list()).resolves.toMatchObject({
      availableHandles: ["anthropic/claude-haiku-4-5"],
      byokProviderAliases: { "lc-anthropic": "anthropic" },
    });
  });

  test("uses the app-server protocol for the Node local backend too", async () => {
    ManagementSocket.instances = [];
    const client = new NodeLettaAgentClient({
      backend: "local",
      appServer: {
        url: "ws://127.0.0.1:4500/ws",
        WebSocket: ManagementSocket,
      },
    });

    await expect(client.agents.list()).resolves.toEqual([
      AGENT_FIXTURE,
    ]);
    expect(
      ManagementSocket.instances.flatMap((socket) => socket.sent),
    ).toEqual([
      expect.objectContaining({ type: "agent_list", query: {} }),
    ]);
  });

  test("surfaces backend failures instead of returning partial entities", async () => {
    class FailingSocket extends ManagementSocket {
      override send(data: string): void {
        const command = JSON.parse(data) as Record<string, unknown>;
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              type: "agent_retrieve_response",
              request_id: command.request_id,
              success: false,
              agent: null,
              error: "agent is not visible",
            }),
          });
        });
      }
    }
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url: "ws://remote.test/ws",
      WebSocket: FailingSocket,
    });

    await expect(client.agents.retrieve("agent-private")).rejects.toThrow(
      "agent is not visible",
    );
  });

  test("surfaces canonical Letta API errors", async () => {
    const client = new PortableLettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "invalid-key",
      fetch: (async () =>
        jsonResponse(
          { detail: "Unauthorized" },
          { status: 401 },
        )) as unknown as typeof fetch,
    });

    await expect(client.agents.list()).rejects.toThrow(
      '401 {"detail":"Unauthorized"}',
    );
  });
});

/** Fake app-server that accepts independent simultaneous client connections. */
class MultiClientAppServerSocket extends ManagementSocket {
  static activeControl: MultiClientAppServerSocket | null = null;
  static rejectedControlSockets = 0;
  static controlCloseDelayMs = 0;
  static agentListResponseDelayMs = 0;
  static agentListRequests = 0;
  private closeScheduled = false;

  static reset(): void {
    MultiClientAppServerSocket.activeControl = null;
    MultiClientAppServerSocket.rejectedControlSockets = 0;
    MultiClientAppServerSocket.controlCloseDelayMs = 0;
    MultiClientAppServerSocket.agentListResponseDelayMs = 0;
    MultiClientAppServerSocket.agentListRequests = 0;
    ManagementSocket.instances = [];
  }

  protected override handleConnect(): void {
    if (!this.url.includes("channel=stream")) {
      MultiClientAppServerSocket.activeControl ??= this;
    }
    super.handleConnect();
  }

  override close(): void {
    if (this.closeScheduled || this.readyState === 3) return;
    this.closeScheduled = true;
    this.readyState = 2;
    const finishClose = () => {
      if (MultiClientAppServerSocket.activeControl === this) {
        MultiClientAppServerSocket.activeControl = null;
      }
      super.close();
    };
    if (
      this.url.includes("channel=control") &&
      MultiClientAppServerSocket.controlCloseDelayMs > 0
    ) {
      setTimeout(
        finishClose,
        MultiClientAppServerSocket.controlCloseDelayMs,
      );
      return;
    }
    finishClose();
  }

  protected override respond(command: Record<string, unknown>): void {
    const type = String(command.type);
    if (type === "agent_list") {
      MultiClientAppServerSocket.agentListRequests += 1;
      if (MultiClientAppServerSocket.agentListResponseDelayMs > 0) {
        setTimeout(
          () => super.respond(command),
          MultiClientAppServerSocket.agentListResponseDelayMs,
        );
        return;
      }
    }
    if (type === "runtime_start") {
      this.serverMessage({
        type: "runtime_start_response",
        request_id: command.request_id,
        success: true,
        runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
        agent: { id: "agent-1", model: "anthropic/claude-haiku-4-5" },
        conversation: { id: "conv-1", agent_id: "agent-1" },
        created: { agent: false, conversation: false },
      });
      return;
    }
    if (type === "sync") {
      if (typeof command.request_id === "string") {
        this.serverMessage({
          type: "sync_response",
          request_id: command.request_id,
          runtime: command.runtime,
          success: true,
        });
      }
      return;
    }
    super.respond(command);
  }

  private serverMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      this.emit("message", { data: JSON.stringify(message) });
    });
  }
}

class DeferredConnectManagementSocket extends ManagementSocket {
  static pending: DeferredConnectManagementSocket[] = [];

  protected override handleConnect(): void {
    DeferredConnectManagementSocket.pending.push(this);
  }

  open(): void {
    super.handleConnect();
  }
}

describe("app-server management connection lifecycle", () => {
  const url = "ws://remote.test/ws";

  function openSockets(): ManagementSocket[] {
    return ManagementSocket.instances.filter(
      (socket) => socket.readyState !== 3,
    );
  }

  test("closes the pooled socket and SDK-owned App Server", async () => {
    ManagementSocket.instances = [];
    let ownedCloseCount = 0;
    const transport = new AppServerManagementTransport({
      connect: async () => ({
        url,
        close: () => {
          ownedCloseCount += 1;
        },
      }),
      WebSocket: ManagementSocket,
    });

    await transport.listAgents({});
    expect(openSockets()).toHaveLength(1);

    await transport.close();
    expect(openSockets()).toHaveLength(0);
    expect(ownedCloseCount).toBe(1);

    await transport.close();
    expect(ownedCloseCount).toBe(1);
  });

  test("closing before first use does not start an App Server", async () => {
    let connectCount = 0;
    const transport = new AppServerManagementTransport({
      connect: async () => {
        connectCount += 1;
        return { url, close: () => {} };
      },
      WebSocket: ManagementSocket,
    });

    await transport.close();
    expect(connectCount).toBe(0);
    await expect(transport.listAgents({})).rejects.toThrow(
      "Management transport is closed",
    );
  });

  test("closing during startup cleans up the connection once it opens", async () => {
    ManagementSocket.instances = [];
    DeferredConnectManagementSocket.pending = [];
    let ownedCloseCount = 0;
    const transport = new AppServerManagementTransport({
      connect: async () => ({
        url,
        close: () => {
          ownedCloseCount += 1;
        },
      }),
      WebSocket: DeferredConnectManagementSocket,
    });

    const request = transport.listAgents({});
    while (DeferredConnectManagementSocket.pending.length === 0) {
      await Bun.sleep(1);
    }
    const close = transport.close();
    DeferredConnectManagementSocket.pending[0]?.open();

    await expect(request).rejects.toThrow("Management transport is closed");
    await close;
    expect(ownedCloseCount).toBe(1);
    expect(openSockets()).toHaveLength(0);
  });

  test("closing rejects an active request and cleans up once", async () => {
    MultiClientAppServerSocket.reset();
    MultiClientAppServerSocket.agentListResponseDelayMs = 100;
    let ownedCloseCount = 0;
    const transport = new AppServerManagementTransport({
      connect: async () => ({
        url,
        close: () => {
          ownedCloseCount += 1;
        },
      }),
      WebSocket: MultiClientAppServerSocket,
    });

    const request = transport.listAgents({});
    while (MultiClientAppServerSocket.agentListRequests === 0) {
      await Bun.sleep(1);
    }
    await transport.close();

    await expect(request).rejects.toThrow("App-server client closed");
    expect(ownedCloseCount).toBe(1);
    expect(openSockets()).toHaveLength(0);
  });

  test("client close releases management without closing an independent session", async () => {
    MultiClientAppServerSocket.reset();
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url,
      WebSocket: MultiClientAppServerSocket,
    });

    await client.agents.list();
    const managementSockets = new Set(ManagementSocket.instances);
    const session = client.resumeSession("conv-1");
    await asAdvanced(session).initialize();
    const sessionSockets = ManagementSocket.instances.filter(
      (socket) => !managementSockets.has(socket),
    );
    expect(sessionSockets.length).toBeGreaterThan(0);

    await client.close();
    expect(sessionSockets.every((socket) => socket.readyState === 1)).toBe(true);
    expect(() => client.agents.list()).toThrow(
      "LettaAgentClient is closed",
    );

    session.close();
  });

  test("a lazy query cannot create a session after client close", async () => {
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url,
      WebSocket: ManagementSocket,
    });
    const query = client.query({
      prompt: "hello",
      options: { model: "test/model", system: "Be concise." },
    });

    await client.close();

    await expect(query.next()).rejects.toThrow("LettaAgentClient is closed");
  });

  test("keeps the management connection pooled while idle", async () => {
    ManagementSocket.instances = [];
    const transport = new AppServerManagementTransport({
      url,
      WebSocket: ManagementSocket,
    });

    await expect(transport.listAgents({})).resolves.toEqual([
      AGENT_FIXTURE,
    ]);
    const socketCount = ManagementSocket.instances.length;
    expect(socketCount).toBeGreaterThan(0);
    expect(openSockets()).toHaveLength(socketCount);

    await Bun.sleep(60);
    expect(openSockets()).toHaveLength(socketCount);
  });

  test("reuses the same pooled connection after an idle period", async () => {
    ManagementSocket.instances = [];
    const transport = new AppServerManagementTransport({
      url,
      WebSocket: ManagementSocket,
    });

    await transport.listAgents({});
    const socketCount = ManagementSocket.instances.length;
    await Bun.sleep(60);
    expect(openSockets()).toHaveLength(socketCount);

    await expect(transport.listConversations({})).resolves.toHaveLength(1);
    expect(ManagementSocket.instances).toHaveLength(socketCount);
    expect(openSockets()).toHaveLength(socketCount);
  });

  test("a burst of requests shares one connection", async () => {
    ManagementSocket.instances = [];
    const transport = new AppServerManagementTransport({
      url,
      WebSocket: ManagementSocket,
    });

    const [agents, conversations] = await Promise.all([
      transport.listAgents({}),
      transport.listConversations({}),
    ]);
    const socketCount = ManagementSocket.instances.length;
    expect(agents).toHaveLength(1);
    expect(conversations).toHaveLength(1);
    // A sequential follow-up reuses the connection too.
    await expect(transport.retrieveAgent("agent-1")).resolves.toMatchObject({
      id: "agent-1",
    });
    expect(ManagementSocket.instances).toHaveLength(socketCount);

    await Bun.sleep(60);
    expect(openSockets()).toHaveLength(socketCount);
  });

  test("management and session connections coexist without handoff", async () => {
    MultiClientAppServerSocket.reset();
    MultiClientAppServerSocket.controlCloseDelayMs = 10;
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url,
      WebSocket: MultiClientAppServerSocket,
    });

    await client.agents.list();
    await client.conversations.list();
    expect(MultiClientAppServerSocket.activeControl).not.toBeNull();
    const managementControl = MultiClientAppServerSocket.activeControl;

    const session = client.resumeSession("conv-1");
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.conversationId).toBe("conv-1");
      expect(init.agentId).toBe("agent-1");
      expect(managementControl?.readyState).toBe(1);
      expect(MultiClientAppServerSocket.rejectedControlSockets).toBe(0);
      expect(MultiClientAppServerSocket.activeControl).toBe(
        managementControl,
      );
    } finally {
      session.close();
    }
  });

  test("a session initializes alongside an in-flight management request", async () => {
    MultiClientAppServerSocket.reset();
    MultiClientAppServerSocket.agentListResponseDelayMs = 20;
    MultiClientAppServerSocket.controlCloseDelayMs = 10;
    const client = new PortableLettaAgentClient({
      backend: "remote",
      url,
      WebSocket: MultiClientAppServerSocket,
    });

    const agentsPromise = client.agents.list();
    while (MultiClientAppServerSocket.agentListRequests === 0) {
      await Bun.sleep(1);
    }

    const session = client.resumeSession("conv-1");
    try {
      const [agents, init] = await Promise.all([
        agentsPromise,
        asAdvanced(session).initialize(),
      ]);
      expect(agents).toHaveLength(1);
      expect(init.conversationId).toBe("conv-1");
      expect(MultiClientAppServerSocket.rejectedControlSockets).toBe(0);
    } finally {
      session.close();
    }
  });

  test("a session coexists with management owned by another client", async () => {
    MultiClientAppServerSocket.reset();
    MultiClientAppServerSocket.controlCloseDelayMs = 10;
    const listClient = new PortableLettaAgentClient({
      backend: "remote",
      url,
      WebSocket: MultiClientAppServerSocket,
    });
    const chatClient = new PortableLettaAgentClient({
      backend: "remote",
      url,
      WebSocket: MultiClientAppServerSocket,
    });

    await listClient.agents.list();
    const managementControl = MultiClientAppServerSocket.activeControl;
    expect(managementControl).not.toBeNull();

    const session = chatClient.resumeSession("conv-1");
    try {
      const init = await asAdvanced(session).initialize();
      expect(init.conversationId).toBe("conv-1");
      expect(managementControl?.readyState).toBe(1);
      expect(MultiClientAppServerSocket.rejectedControlSockets).toBe(0);
    } finally {
      session.close();
    }
  });
});
