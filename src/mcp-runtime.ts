import type {
  AnyAgentTool,
  McpServerStatus,
  McpServers,
} from "./types.js";

export interface McpToolBridge {
  tools: AnyAgentTool[];
  statuses: McpServerStatus[];
  close(): Promise<void>;
}

export interface ConnectMcpServersOptions {
  cwd?: string;
  reservedToolNames?: Iterable<string>;
  log?: (message: string) => void;
}

export type McpConnector = (
  servers: McpServers | undefined,
  options?: ConnectMcpServersOptions,
) => Promise<McpToolBridge>;

let connector: McpConnector | null = null;

/** Register the Node implementation without pulling it into `/client`. */
export function registerMcpConnector(value: McpConnector): void {
  connector = value;
}

export async function connectMcpServers(
  servers: McpServers | undefined,
  options: ConnectMcpServersOptions = {},
): Promise<McpToolBridge> {
  if (!servers || Object.keys(servers).length === 0) {
    return { tools: [], statuses: [], close: async () => undefined };
  }
  if (!connector) {
    throw new Error(
      "MCP servers require the Node package entry '@letta-ai/letta-agent-sdk'; they are not available from '@letta-ai/letta-agent-sdk/client'.",
    );
  }
  return connector(servers, options);
}

/** Expand Claude-style MCP wildcards into the exact runtime tool allowlist. */
export function expandMcpToolWildcards(
  allowedTools: string[] | undefined,
  mcpTools: Iterable<string>,
): string[] | undefined {
  if (allowedTools === undefined) return undefined;
  const available = [...mcpTools];
  const expanded: string[] = [];
  for (const entry of allowedTools) {
    if (entry.startsWith("mcp__") && entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      expanded.push(...available.filter((name) => name.startsWith(prefix)));
    } else {
      expanded.push(entry);
    }
  }
  return [...new Set(expanded)];
}
