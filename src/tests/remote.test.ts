import { describe, expect, test } from "bun:test";
import {
  RemoteAgent,
  RemoteEnvironmentClient,
  createRemoteAgent,
} from "../remote.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

type FetchInput = Parameters<typeof fetch>[0];

function createFetchMock(
  handler: (input: FetchInput | URL, init?: RequestInit) => Response,
): typeof fetch {
  return ((input: FetchInput | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init))) as typeof fetch;
}

function urlOf(input: FetchInput | URL): string {
  return input instanceof URL ? input.toString() : String(input);
}

const onlineEnvironment = {
  id: "env-1",
  connectionId: "conn-1",
  deviceId: "device-1",
  connectionName: "work-laptop",
  organizationId: "org-1",
  podId: "pod-1",
  connectedAt: 1,
  lastHeartbeat: 2,
  lastSeenAt: 3,
  firstSeenAt: 0,
};

describe("RemoteEnvironmentClient", () => {
  test("resolves a stable device id and dispatches an ACK-only remote message", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = createFetchMock((input, init) => {
      const url = urlOf(input);
      requests.push({ url, init });

      if (url === "https://api.test/v1/environments/device-1") {
        return jsonResponse(onlineEnvironment);
      }

      if (url === "https://api.test/v1/environments/conn-1/messages") {
        return jsonResponse({ success: true, message: "Message sent to environment" });
      }

      return jsonResponse({ message: "not found" }, { status: 404 });
    });

    const client = new RemoteEnvironmentClient({
      baseUrl: "https://api.test/",
      apiKey: "sk-test",
      fetch: fetchMock,
    });

    const result = await client.sendMessage({
      agentId: "agent-1",
      conversationId: "conv-1",
      target: { deviceId: "device-1" },
      input: "Run the tests",
      options: { clientMessageId: "client-msg-1" },
    });

    expect(result).toMatchObject({
      success: true,
      connectionId: "conn-1",
      clientMessageId: "client-msg-1",
    });

    const dispatchRequest = requests[1];
    expect(dispatchRequest).toBeDefined();
    expect(dispatchRequest!.init?.method).toBe("POST");
    expect(dispatchRequest!.init?.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(dispatchRequest!.init?.body))).toEqual({
      messages: [
        {
          role: "user",
          content: "Run the tests",
          client_message_id: "client-msg-1",
          otid: "client-msg-1",
        },
      ],
      agentId: "agent-1",
      conversationId: "conv-1",
    });
  });

  test("rejects ambiguous connection names instead of guessing", async () => {
    const fetchMock = createFetchMock(() =>
      jsonResponse({
        connections: [
          onlineEnvironment,
          { ...onlineEnvironment, id: "env-2", connectionId: "conn-2" },
        ],
        hasNextPage: false,
      }),
    );
    const client = new RemoteEnvironmentClient({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    });

    await expect(
      client.resolveEnvironment({ connectionName: "work-laptop" }),
    ).rejects.toThrow("Remote environment name is ambiguous");
  });

  test("can fall back to any online environment when preferred target is unavailable", async () => {
    const requests: string[] = [];
    const fetchMock = createFetchMock((input) => {
      const url = urlOf(input);
      requests.push(url);

      if (url === "https://api.test/v1/environments/offline-device") {
        return jsonResponse({ ...onlineEnvironment, connectionId: null });
      }

      return jsonResponse({
        connections: [onlineEnvironment],
        hasNextPage: false,
      });
    });
    const client = new RemoteEnvironmentClient({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    });

    const resolved = await client.resolveEnvironment(
      { deviceId: "offline-device" },
      { fallback: "any_online" },
    );

    expect(resolved.connectionId).toBe("conn-1");
    expect(requests.at(-1)).toBe("https://api.test/v1/environments?onlineOnly=true");
  });

  test("rejects image content until the environment endpoint supports it", async () => {
    const client = new RemoteEnvironmentClient({
      fetch: createFetchMock(() => jsonResponse(onlineEnvironment)),
    });

    await expect(
      client.sendMessage({
        agentId: "agent-1",
        target: { connectionId: "conn-1" },
        input: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc",
            },
          },
        ],
      }),
    ).rejects.toThrow("text content only");
  });
});

describe("RemoteAgent", () => {
  test("createRemoteAgent returns the actor-style remote wrapper", () => {
    const agent = createRemoteAgent({
      agentId: "agent-1",
      target: { connectionId: "conn-1" },
    });

    expect(agent).toBeInstanceOf(RemoteAgent);
  });
});
