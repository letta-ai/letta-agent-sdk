import { describe, expect, test } from "bun:test";
import { LettaAgentClient } from "../client-entry.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

type FetchInput = Parameters<typeof fetch>[0];

function createFetchMock(
  handler: (url: URL, init?: RequestInit) => Response,
): typeof fetch {
  return ((input: FetchInput | URL, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input)), init))) as typeof fetch;
}

const onlineComputer = {
  id: "env-1",
  connectionId: "conn-1",
  deviceId: "device-1",
  connectionName: "Work laptop",
  organizationId: "org-1",
  podId: "pod-1",
  connectedAt: 10,
  lastHeartbeat: 20,
  lastSeenAt: 30,
  firstSeenAt: 1,
  metadata: {
    os: "darwin",
    workingDirectory: "/workspace/project",
  },
};

function cloudClient(fetchMock: typeof fetch): LettaAgentClient {
  return new LettaAgentClient({
    backend: "cloud",
    apiBaseUrl: "https://api.test",
    apiKey: "sk-test",
    fetch: fetchMock,
  });
}

describe("client.computers", () => {
  test("a pre-obtained namespace rejects requests after client close", async () => {
    let calls = 0;
    const client = cloudClient(
      createFetchMock(() => {
        calls += 1;
        return jsonResponse({ connections: [], hasNextPage: false });
      }),
    );
    const computers = client.computers;

    await client.close();

    await expect(computers.list()).rejects.toThrow("LettaAgentClient is closed");
    expect(calls).toBe(0);
  });

  test("lists computers with filters and normalizes product-facing fields", async () => {
    const requests: URL[] = [];
    const client = cloudClient(
      createFetchMock((url) => {
        requests.push(url);
        return jsonResponse({
          connections: [
            onlineComputer,
            {
              ...onlineComputer,
              id: "env-2",
              deviceId: "device-2",
              connectionId: null,
              connectionName: "Home desktop",
              connectedAt: null,
            },
          ],
          hasNextPage: true,
        });
      }),
    );

    const result = await client.computers.list({
      limit: 2,
      after: "env-previous",
      onlineOnly: false,
    });

    expect(result).toEqual({
      computers: [
        {
          id: "env-1",
          deviceId: "device-1",
          connectionId: "conn-1",
          name: "Work laptop",
          status: "online",
          connectedAt: 10,
          lastSeenAt: 30,
          metadata: {
            os: "darwin",
            workingDirectory: "/workspace/project",
          },
        },
        {
          id: "env-2",
          deviceId: "device-2",
          connectionId: null,
          name: "Home desktop",
          status: "offline",
          connectedAt: null,
          lastSeenAt: 30,
          metadata: {
            os: "darwin",
            workingDirectory: "/workspace/project",
          },
        },
      ],
      hasNextPage: true,
    });
    expect(requests[0]?.pathname).toBe("/v1/environments");
    expect(requests[0]?.searchParams.get("limit")).toBe("2");
    expect(requests[0]?.searchParams.get("after")).toBe("env-previous");
    expect(requests[0]?.searchParams.get("onlineOnly")).toBe("false");
  });

  test("gets and resolves a computer by stable device ID", async () => {
    const client = cloudClient(
      createFetchMock((url) => {
        expect(url.pathname).toBe("/v1/environments/device-1");
        return jsonResponse(onlineComputer);
      }),
    );

    await expect(client.computers.get("device-1")).resolves.toMatchObject({
      name: "Work laptop",
      deviceId: "device-1",
      status: "online",
    });
    await expect(
      client.computers.resolve({ deviceId: "device-1" }),
    ).resolves.toMatchObject({
      connectionId: "conn-1",
      computer: { name: "Work laptop", deviceId: "device-1" },
    });
  });

  test("resolves a unique computer name and reports ambiguous candidates", async () => {
    let ambiguous = false;
    const client = cloudClient(
      createFetchMock(() =>
        jsonResponse({
          connections: ambiguous
            ? [
                onlineComputer,
                {
                  ...onlineComputer,
                  id: "env-2",
                  deviceId: "device-2",
                  connectionId: "conn-2",
                },
              ]
            : [
                onlineComputer,
                {
                  ...onlineComputer,
                  id: "env-offline",
                  deviceId: "device-offline",
                  connectionId: null,
                },
              ],
          hasNextPage: false,
        })
      ),
    );

    await expect(client.computers.resolve("Work laptop")).resolves.toMatchObject({
      connectionId: "conn-1",
      computer: { name: "Work laptop" },
    });

    ambiguous = true;
    await expect(client.computers.resolve({ name: "Work laptop" })).rejects.toThrow(
      "device-1, online",
    );
    await expect(client.computers.resolve({ name: "Work laptop" })).rejects.toThrow(
      "Select one by deviceId",
    );
  });

  test("is only available on the Cloud backend", () => {
    const client = new LettaAgentClient({
      backend: "remote",
      url: "ws://localhost:4500",
    });
    expect(() => client.computers).toThrow(
      'client.computers is only available with backend: "cloud"',
    );
  });
});
