import { describe, expect, test } from "bun:test";
import { RemoteEnvironmentClient } from "../remote.js";

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
  test("resolves a stable device id to an online connection", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = createFetchMock((input, init) => {
      const url = urlOf(input);
      requests.push({ url, init });

      if (url === "https://api.test/v1/environments/device-1") {
        return jsonResponse(onlineEnvironment);
      }

      return jsonResponse({ message: "not found" }, { status: 404 });
    });

    const client = new RemoteEnvironmentClient({
      baseUrl: "https://api.test/",
      apiKey: "sk-test",
      fetch: fetchMock,
    });

    const result = await client.resolveEnvironment({ deviceId: "device-1" });

    expect(result).toMatchObject({
      connectionId: "conn-1",
      environment: onlineEnvironment,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer sk-test",
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

});
