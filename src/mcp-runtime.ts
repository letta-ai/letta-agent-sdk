import type { AnyAgentTool, McpServerConfig } from "./types.js";

export interface McpToolBridge {
  tools: AnyAgentTool[];
  close(): Promise<void>;
}

export interface ConnectMcpServersOptions {
  cwd?: string;
  reservedToolNames?: Iterable<string>;
  log?: (message: string) => void;
}

export type McpConnector = (
  servers: readonly McpServerConfig[] | undefined,
  options?: ConnectMcpServersOptions,
) => Promise<McpToolBridge>;

let connector: McpConnector | null = null;

/** Register the Node stdio implementation without pulling it into `/client`. */
export function registerMcpConnector(value: McpConnector): void {
  connector = value;
}

export async function connectMcpServers(
  servers: readonly McpServerConfig[] | undefined,
  options: ConnectMcpServersOptions = {},
): Promise<McpToolBridge> {
  if (!servers || servers.length === 0) {
    return { tools: [], close: async () => undefined };
  }
  if (!connector) {
    throw new Error(
      "MCP stdio servers require the Node package entry '@letta-ai/letta-agent-sdk'; they are not available from '@letta-ai/letta-agent-sdk/client'.",
    );
  }
  return connector(servers, options);
}
