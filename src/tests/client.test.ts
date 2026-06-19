import { describe, expect, test } from "bun:test";
import { LettaCodeClient, Session } from "../index.js";

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
  readyState = 0;
  sent: unknown[] = [];
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
      agent: { id: agentId, model: "anthropic/claude-sonnet-4" },
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
    if (FakeAppServerSocket.mirrorStreamToControl) {
      fakeControlSocket().serverMessage(assistantDelta);
      fakeControlSocket().serverMessage(stopDelta);
    }
    fakeStreamSocket().serverMessage(assistantDelta);
    fakeStreamSocket().serverMessage(stopDelta);
  }
}

describe("LettaCodeClient", () => {
  test("defaults to the implemented local backend", () => {
    const client = new LettaCodeClient();

    expect(client.backend).toBe("local");
    expect(client.environment).toBeUndefined();
  });

  test("creates local sessions without starting the subprocess until use", () => {
    const client = new LettaCodeClient({ backend: "local" });
    const session = client.resumeSession("agent-123");

    try {
      expect(session).toBeInstanceOf(Session);
    } finally {
      session.close();
    }
  });

  test("rejects environment overrides on local sessions", () => {
    const client = new LettaCodeClient({ backend: "local" });

    expect(() =>
      client.resumeSession("agent-123", { environment: "work-laptop" }),
    ).toThrow("environment overrides are only valid for remote/cloud backends");
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

  test("throws a clear placeholder error when non-local backends are used", () => {
    const client = new LettaCodeClient({
      backend: "cloud",
      environment: "LettaDevelopers",
    });

    expect(() => client.resumeSession("agent-123")).toThrow(
      "backend 'cloud' is not implemented yet",
    );
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
      const init = await session.initialize();
      expect(init.agentId).toBe("agent-123");
      expect(init.conversationId).toBe("conv-created");

      const result = await session.runTurn("hello");
      expect(result.success).toBe(true);
      expect(result.result).toBe("hello from app-server");
      expect(result.runIds).toEqual(["run-1"]);

      expect(fakeControlSocket().sent[0]).toMatchObject({
        type: "runtime_start",
        agent_id: "agent-123",
        create_conversation: { body: {} },
        cwd: "/tmp/project",
      });
      expect(fakeControlSocket().sent[1]).toMatchObject({
        type: "input",
        runtime: { agent_id: "agent-123", conversation_id: "conv-created" },
      });
    } finally {
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
      const init = await session.initialize();
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
      const init = await session.initialize();
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
      await session.initialize();
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


  test("keeps environment out of createAgent payloads", async () => {
    const client = new LettaCodeClient({ backend: "local" });

    await expect(
      client.createAgent({ environment: "work-laptop" } as never),
    ).rejects.toThrow("createAgent() does not accept environment");
  });
});
