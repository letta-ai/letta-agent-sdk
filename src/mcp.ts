import {
  type ConnectedMcpServer,
  connectMcpServer,
  type McpServerConfig as LettaMcpServerConfig,
  type McpToolDefinition,
} from "@letta-ai/letta-code/mcp-client";
import type {
  ConnectMcpServersOptions,
  McpToolBridge,
} from "./mcp-runtime.js";
import type {
  AgentToolResultContent,
  AnyAgentTool,
  McpServerConfig,
  McpServerStatus,
  McpServers,
} from "./types.js";

const EMPTY_BRIDGE: McpToolBridge = {
  tools: [],
  statuses: [],
  close: async () => undefined,
};

const CLIENT_INFO = {
  name: "@letta-ai/letta-agent-sdk",
  version: "1",
};

type NamedMcpServer = {
  name: string;
  config: McpServerConfig;
};

type ConnectionResult =
  | {
      server: NamedMcpServer;
      connection: ConnectedMcpServer;
    }
  | {
      server: NamedMcpServer;
      error: unknown;
    };

/**
 * Connect session-scoped MCP servers through Letta Code's transport-neutral
 * client and expose their tools through the external-tool protocol. A broken
 * server is reported but cannot prevent healthy servers from loading.
 */
export async function connectMcpServers(
  servers: McpServers | undefined,
  options: ConnectMcpServersOptions = {},
): Promise<McpToolBridge> {
  const namedServers = Object.entries(servers ?? {}).map(([name, config]) => ({
    name,
    config,
  }));
  if (namedServers.length === 0) return EMPTY_BRIDGE;

  const log = options.log ?? ((message: string) => console.error(message));
  const results = await Promise.all(
    namedServers.map(async (server): Promise<ConnectionResult> => {
      try {
        const connection = await connectMcpServer(
          toLettaMcpServerConfig(server, options.cwd),
          {
            clientInfo: CLIENT_INFO,
            stderr: "inherit",
          },
        );
        return { server, connection };
      } catch (error) {
        return { server, error };
      }
    }),
  );

  const connections: ConnectedMcpServer[] = [];
  const tools: AnyAgentTool[] = [];
  const statuses: McpServerStatus[] = [];
  const taken = new Set(options.reservedToolNames ?? []);

  for (const result of results) {
    if ("error" in result) {
      const error = errorMessage(result.error);
      const status: McpServerStatus = {
        name: result.server.name,
        status: isAuthorizationError(result.error) ? "needs-auth" : "failed",
        tools: [],
        error,
      };
      statuses.push(status);
      log(`MCP server "${result.server.name}" unavailable: ${error}`);
      continue;
    }

    connections.push(result.connection);
    const toolNames: string[] = [];
    for (const tool of result.connection.tools) {
      const name = uniqueName(
        `mcp__${sanitize(result.server.name)}__${sanitize(tool.name)}`,
        taken,
      );
      toolNames.push(name);
      tools.push(bridgeTool(result.connection, result.server.name, tool, name));
    }
    statuses.push({
      name: result.server.name,
      status: "connected",
      tools: toolNames,
    });
    log(
      `MCP server "${result.server.name}" connected (${toolNames.length} tool${toolNames.length === 1 ? "" : "s"})`,
    );
  }

  let closed = false;
  return {
    tools,
    statuses,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        connections.map((connection) => connection.close()),
      );
    },
  };
}

function toLettaMcpServerConfig(
  server: NamedMcpServer,
  sessionCwd: string | undefined,
): LettaMcpServerConfig {
  const config = server.config;
  if (config.type === "http" || config.type === "sse") {
    return {
      name: server.name,
      transport: config.type,
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
    };
  }
  return {
    name: server.name,
    transport: "stdio",
    command: config.command,
    args: config.args ?? [],
    ...(config.env ? { env: config.env } : {}),
    ...(config.cwd ?? sessionCwd
      ? { cwd: config.cwd ?? sessionCwd }
      : {}),
  };
}

function bridgeTool(
  connection: ConnectedMcpServer,
  serverName: string,
  tool: McpToolDefinition,
  name: string,
): AnyAgentTool {
  return {
    name,
    label: tool.title ?? tool.name,
    description:
      tool.description && tool.description.trim().length > 0
        ? tool.description
        : `The ${tool.name} tool from the ${serverName} MCP server.`,
    parameters: tool.inputSchema,
    execute: async (_toolCallId, args, signal) => {
      const result = await connection.callTool(
        tool.name,
        isRecord(args) ? args : {},
        signal ? { signal } : undefined,
      );
      return {
        content: toToolResultContent(result.content),
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
}

function toToolResultContent(content: unknown[]): AgentToolResultContent[] {
  const mapped: AgentToolResultContent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      mapped.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      mapped.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
      continue;
    }
    mapped.push({ type: "text", text: JSON.stringify(block) });
  }
  return mapped;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${name}_${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

function isAuthorizationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "UnauthorizedError" ||
    /\b(unauthorized|authorization[_ -]required|needs[_ -]auth)\b/i.test(
      error.message,
    )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
