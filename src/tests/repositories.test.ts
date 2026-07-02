import { describe, expect, test } from "bun:test";
import { LettaAgentClient } from "../index.js";

type FetchInput = Parameters<typeof fetch>[0];

type RecordedRequest = {
  url: string;
  method: string;
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createFetchMock(
  requests: RecordedRequest[],
  handler: (parsed: URL, method: string) => Response,
): typeof fetch {
  return ((input: FetchInput | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    return Promise.resolve(handler(new URL(url), method));
  }) as typeof fetch;
}

function cloudClient(fetchMock: typeof fetch): LettaAgentClient {
  return new LettaAgentClient({
    backend: "cloud",
    apiKey: "test-key",
    apiBaseUrl: "https://api.letta.com",
    fetch: fetchMock,
  });
}

describe("RepositoriesClient.delete", () => {
  test("issues DELETE /v1/repositories/:id and resolves on success", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse({ success: true })),
    );

    await expect(client.repositories.delete("repo-1")).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("DELETE");
    expect(new URL(requests[0]!.url).pathname).toBe("/v1/repositories/repo-1");
  });

  test("encodes the repository id in the path", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse({ success: true })),
    );

    await client.repositories.delete("repo/with space");

    expect(new URL(requests[0]!.url).pathname).toBe("/v1/repositories/repo%2Fwith%20space");
  });

  test("throws with the server message when the repository is missing", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () =>
        jsonResponse({ message: "Repository not found" }, { status: 404 }),
      ),
    );

    await expect(client.repositories.delete("missing")).rejects.toThrow(
      "Repository not found",
    );
  });
});
