import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  ConnectMcpServersOptions,
  McpToolBridge,
} from "./mcp-runtime.js";
import type {
  AgentToolResultContent,
  AnyAgentTool,
  McpServerConfig,
} from "./types.js";

const EMPTY_BRIDGE: McpToolBridge = {
  tools: [],
  close: async () => undefined,
};

const CLIENT_INFO = {
  name: "@letta-ai/letta-agent-sdk",
  version: "1",
};

/**
 * Connect stdio MCP servers and expose their tools through Letta Code's
 * external-tool protocol. A broken server is skipped so it cannot prevent the
 * rest of a session from starting.
 */
export async function connectMcpServers(
  servers: readonly McpServerConfig[] | undefined,
  options: ConnectMcpServersOptions = {},
): Promise<McpToolBridge> {
  if (!servers || servers.length === 0) return EMPTY_BRIDGE;

  const log = options.log ?? ((message: string) => console.error(message));
  const clients: Client[] = [];
  const tools: AnyAgentTool[] = [];
  const taken = new Set(options.reservedToolNames ?? []);

  for (const server of servers) {
    let client: Client | null = null;
    try {
      client = new Client(CLIENT_INFO);
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env: {
            ...getDefaultEnvironment(),
            ...normalizeEnvironment(server.env),
          },
          cwd: server.cwd ?? options.cwd,
          stderr: "inherit",
        }),
      );

      const listed = await client.listTools();
      clients.push(client);
      for (const tool of listed.tools) {
        const name = uniqueName(
          `mcp__${sanitize(server.name)}__${sanitize(tool.name)}`,
          taken,
        );
        tools.push(
          bridgeTool(client, server.name, tool, name),
        );
      }
      log(
        `MCP server "${server.name}" connected (${listed.tools.length} tool${listed.tools.length === 1 ? "" : "s"})`,
      );
    } catch (error) {
      if (client && !clients.includes(client)) {
        await client.close().catch(() => undefined);
      }
      log(`MCP server "${server.name}" unavailable: ${String(error)}`);
    }
  }

  if (clients.length === 0) return EMPTY_BRIDGE;

  let closed = false;
  return {
    tools,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(
        clients.map((client) => client.close().catch(() => undefined)),
      );
    },
  };
}

function normalizeEnvironment(
  env: McpServerConfig["env"],
): Record<string, string> {
  if (!env) return {};
  if (!Array.isArray(env)) return env;

  const result: Record<string, string> = {};
  for (const entry of env) {
    result[entry.name] = entry.value;
  }
  return result;
}

interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

function bridgeTool(
  client: Client,
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
    parameters: toolParameters(tool.inputSchema),
    execute: async (_toolCallId, args, signal) => {
      const result = await client.callTool(
        {
          name: tool.name,
          arguments: isRecord(args) ? args : {},
        },
        undefined,
        signal ? { signal } : undefined,
      );
      const content = toToolResultContent(result.content);
      if (result.isError) {
        throw new Error(
          content
            .map((item) => item.text ?? "")
            .filter(Boolean)
            .join("\n") || `${tool.name} failed`,
        );
      }
      return { content };
    },
  };
}

function toolParameters(inputSchema: unknown): Record<string, unknown> {
  if (isRecord(inputSchema) && inputSchema.type === "object") {
    return inputSchema;
  }
  return { type: "object", properties: {} };
}

function toToolResultContent(content: unknown): AgentToolResultContent[] {
  if (!Array.isArray(content)) return [];
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
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
