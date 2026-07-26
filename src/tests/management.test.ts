import { describe, expect, test } from "bun:test";
import { LettaAgentClient as PortableLettaAgentClient } from "../client-entry.js";
import { LettaAgentClient as NodeLettaAgentClient } from "../index.js";
import type { LettaCodeSocketOptions } from "../types.js";

type FetchInput = Parameters<typeof fetch>[0];
type Listener = (event: unknown) => void;

type RecordedRequest = {
  url: URL;
  method: string;
  body?: unknown;
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
      return jsonResponse([{ id: "agent-1", name: "Memo" }]);
    }
    if (url.pathname === "/v1/agents/agent-1" && method === "GET") {
      return jsonResponse({ id: "agent-1", name: "Memo" });
    }
    if (url.pathname === "/v1/agents/agent-1" && method === "PATCH") {
      return jsonResponse({ id: "agent-1", name: "Renamed", ...body as object });
    }
    if (url.pathname === "/v1/agents/agent-1" && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/models" && method === "GET") {
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
      return jsonResponse([{ id: "message-1", message_type: "user_message" }]);
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
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
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

  private respond(command: Record<string, unknown>): void {
    const responses: Record<string, Record<string, unknown>> = {
      agent_list: {
        agents: [{ id: "agent-1", name: "Memo" }],
      },
      agent_retrieve: {
        agent: { id: command.agent_id, name: "Memo" },
      },
      agent_update: {
        agent: {
          id: command.agent_id,
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
      conversation_messages_list: {
        messages: [{ id: "message-1", message_type: "user_message" }],
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
  ).resolves.toEqual([{ id: "agent-1", name: "Memo" }]);
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
    messages: [{ id: "message-1", message_type: "user_message" }],
  });
}

describe("portable management namespaces", () => {
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
        path: "/v1/models",
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
        path: "/v1/conversations/conv-1/messages",
        query: { before: "message-2", order: "desc", limit: "50" },
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
      { id: "agent-1", name: "Memo" },
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

  test("includes Cloud action, URL, and authentication guidance in errors", async () => {
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
      "Cloud list agents failed — Unauthorized — URL: https://api.test/v1/agents/ — Authentication failed",
    );
  });
});
