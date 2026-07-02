import { describe, expect, test } from "bun:test";
import { LettaAgentClient } from "../index.js";

type FetchInput = Parameters<typeof fetch>[0];

type RecordedRequest = {
  url: string;
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

function createFetchMock(
  requests: RecordedRequest[],
  handler: (parsed: URL, method: string) => Response,
): typeof fetch {
  return ((input: FetchInput | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url, method, body });
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

describe("RepositoriesClient.files.update", () => {
  test("issues POST /v1/repositories/:id/files/content", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () =>
        jsonResponse({ path: "a.txt", content_sha256: "sha", commit_sha: "c1" }),
      ),
    );

    const result = await client.repositories.files.update("repo-1", {
      path: "a.txt",
      content: "next",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1/repositories/repo-1/files/content",
    );
    expect(requests[0]?.body).toEqual({ path: "a.txt", content: "next" });
    expect(result).toEqual({ path: "a.txt", contentSha256: "sha", commitSha: "c1" });
  });

  test("sends the typed content_sha256 precondition and new_path", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () =>
        jsonResponse({ path: "b.txt", content_sha256: "sha", commit_sha: "c2" }),
      ),
    );

    await client.repositories.files.update("repo-1", {
      path: "a.txt",
      newPath: "b.txt",
      precondition: { contentSha256: "expected-sha" },
    });

    expect(requests[0]?.body).toEqual({
      path: "a.txt",
      new_path: "b.txt",
      precondition: { type: "content_sha256", content_sha256: "expected-sha" },
    });
  });
});

describe("RepositoriesClient.files.delete", () => {
  test("issues DELETE /v1/repositories/:id/files/content with the path body", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () =>
        jsonResponse({ success: true, commit_sha: "c3" }),
      ),
    );

    const result = await client.repositories.files.delete("repo-1", { path: "a.txt" });

    expect(requests[0]?.method).toBe("DELETE");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1/repositories/repo-1/files/content",
    );
    expect(requests[0]?.body).toEqual({ path: "a.txt" });
    expect(result).toEqual({ success: true, commitSha: "c3" });
  });
});

describe("RepositoriesClient.versions.list", () => {
  test("returns the commits array from the server response", async () => {
    const requests: RecordedRequest[] = [];
    const commits = [
      { sha: "s1", message: "Update a.txt", timestamp: "2024-01-01T00:00:00Z", author_name: "Ari" },
      { sha: "s2", message: "Create a.txt", timestamp: "2024-01-01T00:00:00Z", author_name: null },
    ];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse({ path: "a.txt", commits })),
    );

    const result = await client.repositories.versions.list("repo-1", { path: "a.txt" });

    expect(new URL(requests[0]!.url).pathname).toBe("/v1/repositories/repo-1/versions");
    expect(result).toEqual(commits);
  });
});
