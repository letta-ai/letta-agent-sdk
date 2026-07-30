import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { connectMcpServers } from "../mcp.js";
import { expandMcpToolWildcards } from "../mcp-runtime.js";
import type { McpServerConfig, McpServers } from "../types.js";

const EVERYTHING_SERVER = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);

function stdioServer(): McpServerConfig {
  return {
    command: process.execPath,
    args: [EVERYTHING_SERVER],
  };
}

function stdioServers(name = "test"): McpServers {
  return { [name]: stdioServer() };
}

async function authorizationRequiredServer(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate":
        'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
    });
    response.end(JSON.stringify({ error: "authorization_required" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start authorization test server");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("MCP tool bridge", () => {
  test("lists namespaced tools and proxies calls", async () => {
    const bridge = await connectMcpServers(stdioServers(), { log: () => {} });
    try {
      const names = bridge.tools.map((tool) => tool.name);
      expect(names).toContain("mcp__test__echo");
      expect(names).toContain("mcp__test__get-sum");
      expect(bridge.statuses).toContainEqual({
        name: "test",
        status: "connected",
        tools: expect.arrayContaining(["mcp__test__echo"]),
      });

      const echo = bridge.tools.find((tool) => tool.name === "mcp__test__echo");
      expect(echo?.parameters).toMatchObject({
        type: "object",
        properties: { message: { type: "string" } },
      });
      const result = await echo?.execute("call-1", { message: "hello" });
      expect(result?.content).toEqual([
        { type: "text", text: "Echo: hello" },
      ]);
    } finally {
      await bridge.close();
    }
  });

  test("preserves model-visible MCP errors", async () => {
    const bridge = await connectMcpServers(stdioServers(), { log: () => {} });
    try {
      const echo = bridge.tools.find((tool) => tool.name === "mcp__test__echo");
      const result = await echo?.execute("call-2", {});
      expect(result?.isError).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  test("avoids collisions with custom and normalized MCP names", async () => {
    const bridge = await connectMcpServers(
      {
        "test.one": stdioServer(),
        test_one: stdioServer(),
      },
      {
        reservedToolNames: ["mcp__test_one__echo"],
        log: () => {},
      },
    );
    try {
      const names = bridge.tools.map((tool) => tool.name);
      expect(names).toContain("mcp__test_one__echo_2");
      expect(names).toContain("mcp__test_one__echo_3");
    } finally {
      await bridge.close();
    }
  });

  test("reports an unavailable server without dropping healthy servers", async () => {
    const logs: string[] = [];
    const bridge = await connectMcpServers(
      {
        broken: { command: "/nonexistent/mcp-server" },
        test: stdioServer(),
      },
      { log: (message) => logs.push(message) },
    );
    try {
      expect(bridge.tools.map((tool) => tool.name)).toContain(
        "mcp__test__echo",
      );
      expect(bridge.statuses.find(({ name }) => name === "broken")).toMatchObject(
        { status: "failed", tools: [] },
      );
      expect(logs.some((line) => line.includes('"broken" unavailable'))).toBe(
        true,
      );
    } finally {
      await bridge.close();
    }
  });

  test("reports remote authorization challenges", async () => {
    const server = await authorizationRequiredServer();
    try {
      const bridge = await connectMcpServers(
        { protected: { type: "http", url: server.url } },
        { log: () => {} },
      );
      expect(bridge.statuses).toEqual([
        expect.objectContaining({
          name: "protected",
          status: "needs-auth",
          tools: [],
        }),
      ]);
      await bridge.close();
    } finally {
      await server.close();
    }
  });

  test("expands Claude-style MCP allowlist wildcards", () => {
    expect(
      expandMcpToolWildcards(
        ["Read", "mcp__exa__*", "mcp__github__issues"],
        ["mcp__exa__search", "mcp__exa__fetch", "mcp__other__tool"],
      ),
    ).toEqual([
      "Read",
      "mcp__exa__search",
      "mcp__exa__fetch",
      "mcp__github__issues",
    ]);
  });
});
