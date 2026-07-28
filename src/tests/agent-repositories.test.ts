import { describe, expect, test } from "bun:test";
import { createAgentRepositoriesClient } from "../agent-repositories.js";
import { LettaAgentClient as PortableLettaAgentClient } from "../client-entry.js";
import { LettaAgentClient as NodeLettaAgentClient } from "../index.js";

type FetchInput = Parameters<typeof fetch>[0];

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

function repository(id = "repo-1") {
  return {
    id,
    name: "knowledge-base",
    is_primary: false,
    permissions: "read" as const,
  };
}

function cloudClient(
  requests: RecordedRequest[],
  handler: (
    url: URL,
    method: string,
    body: unknown,
  ) => Response,
): PortableLettaAgentClient {
  const fetchMock = (async (
    input: FetchInput | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    return handler(url, method, body);
  }) as typeof fetch;
  return new PortableLettaAgentClient({
    backend: "cloud",
    apiBaseUrl: "https://api.test",
    apiKey: "sk-test",
    fetch: fetchMock,
  });
}

describe("client.agents.repositories", () => {
  test("lists and normalizes persistent repository relationships", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(requests, () =>
      jsonResponse({
        repositories: [
          repository(),
          {
            id: "repo-memory",
            name: "memory",
            is_primary: true,
            permissions: "read_write",
          },
        ],
      })
    );

    await expect(client.agents.repositories.list("agent-1")).resolves.toEqual([
      {
        id: "repo-1",
        name: "knowledge-base",
        isPrimary: false,
        permissions: "read",
      },
      {
        id: "repo-memory",
        name: "memory",
        isPrimary: true,
        permissions: "read_write",
      },
    ]);
    expect(requests.map(({ url, method }) => ({
      path: url.pathname,
      method,
    }))).toEqual([
      { path: "/v1/agents/agent-1/repositories", method: "GET" },
    ]);
  });

  test("attaches, waits for visibility, then recompiles the default conversation", async () => {
    const requests: RecordedRequest[] = [];
    let attached = false;
    let visibilityChecks = 0;
    const client = cloudClient(requests, (url, method) => {
      if (url.pathname.endsWith("/repositories") && method === "POST") {
        attached = true;
        return jsonResponse({ success: true, repository: repository() });
      }
      if (url.pathname.endsWith("/repositories") && method === "GET") {
        visibilityChecks += 1;
        return jsonResponse({
          repositories:
            attached
              ? [{
                ...repository(),
                permissions:
                  visibilityChecks > 1 ? "read" : "read_write",
              }]
              : [],
        });
      }
      if (url.pathname.endsWith("/recompile") && method === "POST") {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    });

    await expect(
      client.agents.repositories.attach("agent-1", "repo-1", {
        permissions: "read",
      }),
    ).resolves.toEqual({
      id: "repo-1",
      name: "knowledge-base",
      isPrimary: false,
      permissions: "read",
    });

    expect(requests.map(({ url, method, body }) => ({
      path: url.pathname,
      method,
      body,
    }))).toEqual([
      {
        path: "/v1/agents/agent-1/repositories",
        method: "POST",
        body: { repository_id: "repo-1", permissions: "read" },
      },
      {
        path: "/v1/agents/agent-1/repositories",
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/agents/agent-1/repositories",
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/agents/agent-1/recompile",
        method: "POST",
        body: undefined,
      },
    ]);
  });

  test("can attach without recompiling", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(requests, (url, method) => {
      if (method === "POST") {
        return jsonResponse({ success: true, repository: repository() });
      }
      return jsonResponse({ repositories: [repository()] });
    });

    await client.agents.repositories.attach("agent-1", "repo-1", {
      recompile: false,
    });

    expect(requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
  });

  test("detaches, waits for absence, then recompiles", async () => {
    const requests: RecordedRequest[] = [];
    let attached = true;
    let visibilityChecks = 0;
    const client = cloudClient(requests, (url, method) => {
      if (url.pathname.endsWith("/repositories/repo-1") && method === "DELETE") {
        attached = false;
        return jsonResponse({ success: true });
      }
      if (url.pathname.endsWith("/repositories") && method === "GET") {
        visibilityChecks += 1;
        return jsonResponse({
          repositories:
            attached || visibilityChecks === 1 ? [repository()] : [],
        });
      }
      if (url.pathname.endsWith("/recompile") && method === "POST") {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    });

    await expect(
      client.agents.repositories.detach("agent-1", "repo-1"),
    ).resolves.toBeUndefined();

    expect(requests.map(({ url, method }) => ({
      path: url.pathname,
      method,
    }))).toEqual([
      {
        path: "/v1/agents/agent-1/repositories/repo-1",
        method: "DELETE",
      },
      { path: "/v1/agents/agent-1/repositories", method: "GET" },
      { path: "/v1/agents/agent-1/repositories", method: "GET" },
      { path: "/v1/agents/agent-1/recompile", method: "POST" },
    ]);
  });

  test("treats an already-detached relationship as success and repairs the prompt", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(requests, (url, method) => {
      if (method === "DELETE") {
        return jsonResponse(
          { message: "Repository link not found" },
          { status: 404 },
        );
      }
      if (url.pathname.endsWith("/repositories")) {
        return jsonResponse({ repositories: [] });
      }
      return jsonResponse({ success: true });
    });

    await expect(
      client.agents.repositories.detach("agent-1", "repo-1"),
    ).resolves.toBeUndefined();
    expect(requests.map(({ method }) => method)).toEqual([
      "DELETE",
      "GET",
      "POST",
    ]);
  });

  test("propagates recompile failures after the relationship becomes visible", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(requests, (url, method) => {
      if (url.pathname.endsWith("/repositories") && method === "POST") {
        return jsonResponse({ success: true, repository: repository() });
      }
      if (url.pathname.endsWith("/repositories") && method === "GET") {
        return jsonResponse({ repositories: [repository()] });
      }
      return jsonResponse(
        {
          detail: "Prompt compilation failed",
          reason_text: "Repository projection unavailable",
        },
        { status: 500 },
      );
    });

    await expect(
      client.agents.repositories.attach("agent-1", "repo-1"),
    ).rejects.toThrow(
      '500 {"detail":"Prompt compilation failed","reason_text":"Repository projection unavailable"}',
    );
    expect(requests.slice(0, 2).map(({ method }) => method)).toEqual([
      "POST",
      "GET",
    ]);
    expect(requests.slice(2).every(({ url, method }) =>
      method === "POST" && url.pathname.endsWith("/recompile")
    )).toBe(true);
  });

  test("does not poll or recompile when attachment fails", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(requests, () =>
      jsonResponse({ message: "Repository not found" }, { status: 404 })
    );

    await expect(
      client.agents.repositories.attach("agent-1", "repo-missing"),
    ).rejects.toThrow("Repository not found");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
  });

  test("detach remains effective when recompilation fails and is safe to retry", async () => {
    const requests: RecordedRequest[] = [];
    let attached = true;
    const client = cloudClient(requests, (url, method) => {
      if (method === "DELETE") {
        if (!attached) {
          return jsonResponse(
            { message: "Repository link not found" },
            { status: 404 },
          );
        }
        attached = false;
        return jsonResponse({ success: true });
      }
      if (url.pathname.endsWith("/repositories")) {
        return jsonResponse({ repositories: [] });
      }
      return jsonResponse(
        { detail: "Prompt compilation failed" },
        { status: 500 },
      );
    });

    await expect(
      client.agents.repositories.detach("agent-1", "repo-1"),
    ).rejects.toThrow("Prompt compilation failed");
    expect(attached).toBe(false);

    await expect(
      client.agents.repositories.detach("agent-1", "repo-1", {
        recompile: false,
      }),
    ).resolves.toBeUndefined();
  });

  test("fails before recompiling when relationship visibility times out", async () => {
    let recompiles = 0;
    const client = createAgentRepositoriesClient(
      () => ({
        listAgentRepositories: async () => [],
        attachAgentRepository: async () => ({
          id: "repo-1",
          name: "knowledge-base",
          isPrimary: false,
          permissions: "read_write",
        }),
        detachAgentRepository: async () => {},
        recompileAgentSystemPrompt: async () => {
          recompiles += 1;
        },
      }),
      { timeoutMs: 0, pollIntervalMs: 0 },
    );

    await expect(
      client.attach("agent-1", "repo-1"),
    ).rejects.toThrow(
      "Cloud attach agent repository did not become visible for agent-1: repo-1",
    );
    expect(recompiles).toBe(0);
  });

  test("validates ids and permissions before making a request", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(requests, () =>
      jsonResponse({ repositories: [] })
    );

    await expect(
      client.agents.repositories.list(" "),
    ).rejects.toThrow("Invalid agent id");
    await expect(
      client.agents.repositories.attach("agent-1", ""),
    ).rejects.toThrow("Invalid repository id");
    await expect(
      client.agents.repositories.attach("agent-1", "repo-1", {
        permissions: "owner" as "read",
      }),
    ).rejects.toThrow("Invalid repository permissions");
    await expect(
      client.agents.repositories.attach("agent-1", "repo-1", {
        recompile: true as false,
      }),
    ).rejects.toThrow("Invalid repository recompile target");
    expect(requests).toHaveLength(0);
  });

  test("encodes agent and repository ids", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(requests, (url, method) => {
      if (method === "DELETE") return jsonResponse({ success: true });
      if (url.pathname.endsWith("/repositories")) {
        return jsonResponse({ repositories: [] });
      }
      return jsonResponse({ success: true });
    });

    await client.agents.repositories.detach(
      "agent/with space",
      "repo/with space",
      { recompile: false },
    );

    expect(requests[0]?.url.pathname).toBe(
      "/v1/agents/agent%2Fwith%20space/repositories/repo%2Fwith%20space",
    );
  });

  test("fails closed on local and remote backends without opening a connection", () => {
    const remote = new PortableLettaAgentClient({
      backend: "remote",
      url: "ws://remote.test/ws",
    });
    const local = new NodeLettaAgentClient({ backend: "local" });

    expect(() => remote.agents.repositories).toThrow(
      'client.agents.repositories is only available with backend: "cloud".',
    );
    expect(() => local.agents.repositories).toThrow(
      'client.agents.repositories is only available with backend: "cloud".',
    );
  });
});
