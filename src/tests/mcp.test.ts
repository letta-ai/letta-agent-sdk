import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { connectMcpServers } from "../mcp.js";
import type { McpServerConfig } from "../types.js";

const EVERYTHING_SERVER = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);

function stdioServer(name = "test"): McpServerConfig {
  return {
    name,
    command: process.execPath,
    args: [EVERYTHING_SERVER],
  };
}

describe("MCP tool bridge", () => {
  test("lists namespaced tools and proxies calls", async () => {
    const bridge = await connectMcpServers([stdioServer()], { log: () => {} });
    try {
      const names = bridge.tools.map((tool) => tool.name);
      expect(names).toContain("mcp__test__echo");
      expect(names).toContain("mcp__test__get-sum");

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

  test("surfaces MCP call validation failures", async () => {
    const bridge = await connectMcpServers([stdioServer()], { log: () => {} });
    try {
      const echo = bridge.tools.find((tool) => tool.name === "mcp__test__echo");
      expect(echo?.execute("call-2", {})).rejects.toThrow();
    } finally {
      await bridge.close();
    }
  });

  test("avoids collisions with custom and other MCP tools", async () => {
    const bridge = await connectMcpServers(
      [stdioServer(), stdioServer()],
      {
        reservedToolNames: ["mcp__test__echo"],
        log: () => {},
      },
    );
    try {
      const names = bridge.tools.map((tool) => tool.name);
      expect(names).toContain("mcp__test__echo_2");
      expect(names).toContain("mcp__test__echo_3");
    } finally {
      await bridge.close();
    }
  });

  test("skips an unavailable server without dropping healthy servers", async () => {
    const logs: string[] = [];
    const bridge = await connectMcpServers(
      [
        { name: "broken", command: "/nonexistent/mcp-server" },
        stdioServer(),
      ],
      { log: (message) => logs.push(message) },
    );
    try {
      expect(bridge.tools.map((tool) => tool.name)).toContain(
        "mcp__test__echo",
      );
      expect(logs.some((line) => line.includes('"broken" unavailable'))).toBe(
        true,
      );
    } finally {
      await bridge.close();
    }
  });
});
