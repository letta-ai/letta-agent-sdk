import type { AppServerClient } from "@letta-ai/letta-code/app-server-client";
import type { AnyAgentTool, ClientToolsetConfig } from "./types.js";

/**
 * A connection's tool selection for every turn on a conversation, including
 * turns the runtime starts itself (task notifications, cron prompts, wakes).
 * Mirrors Letta Code's `RuntimeToolPolicy` wire shape on `runtime_start` and
 * `runtime_external_tools_update`; listeners without the capability ignore it.
 */
export type RuntimeToolPolicy = {
  toolset?: { base?: ClientToolsetConfig["base"]; include?: string[] };
  allowlist?: string[];
  exclude_interactive?: boolean;
};

/** `app_server_info` capability advertising `tool_policy` support. */
const RUNTIME_TOOL_POLICY_CAPABILITY = "runtime_tool_policy";
/** Bounded so a listener that cannot answer never delays session startup long. */
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;

export function clientToolsetPayload(
  toolset: ClientToolsetConfig,
): NonNullable<RuntimeToolPolicy["toolset"]> {
  return {
    ...(toolset.base !== undefined ? { base: toolset.base } : {}),
    ...(toolset.include !== undefined
      ? { include: [...new Set(toolset.include)] }
      : {}),
  };
}

/**
 * Build the policy from the same options a session accepts. SDK sessions are
 * headless, so interactive user-input tools are always excluded.
 */
export function runtimeToolPolicy(
  allowedTools: readonly string[] | undefined,
  toolset: ClientToolsetConfig | undefined,
): RuntimeToolPolicy {
  return {
    ...(toolset !== undefined ? { toolset: clientToolsetPayload(toolset) } : {}),
    ...(allowedTools !== undefined ? { allowlist: [...new Set(allowedTools)] } : {}),
    exclude_interactive: true,
  };
}

/**
 * Whether the connected listener applies `tool_policy` to every turn. Older
 * listeners, and transports that cannot answer `app_server_info`, report false
 * so callers keep sending the equivalent per-message fields.
 */
export async function supportsRuntimeToolPolicy(
  client: Pick<AppServerClient, "info">,
): Promise<boolean> {
  try {
    const info = await client.info({ timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS });
    const capabilities = info.capabilities as Record<string, unknown> | undefined;
    return capabilities?.[RUNTIME_TOOL_POLICY_CAPABILITY] === true;
  } catch {
    return false;
  }
}

/** The part of a registration a session on one of its conversations inherits. */
export type InheritedTools = {
  tools: AnyAgentTool[];
  allowedTools?: string[];
  toolset?: ClientToolsetConfig;
};

/** A session's own tool selection: its `tools` (plus MCP tools) and options. */
export type SessionToolSelection = {
  tools: AnyAgentTool[];
  allowedTools?: string[];
  toolset?: ClientToolsetConfig;
};

/**
 * Where a session reads the registration covering its conversation. `current()`
 * returns null once no registration covers it any more.
 */
export interface InheritedToolSource {
  current(): InheritedTools | null;
  onChange(listener: () => void): () => void;
}

/**
 * Combine a registration with a session's own selection. The session's tools
 * are added on top (its own wins on a name clash). Its `allowedTools` can only
 * narrow the registration's: entries outside the registration's allowlist are
 * dropped unless they name one of the session's own tools. Without its own
 * `allowedTools`, the session gets the registration's plus its own tools.
 */
export function mergeInheritedTools(
  inherited: InheritedTools | null,
  own: SessionToolSelection,
): SessionToolSelection {
  if (!inherited) return own;
  const tools = new Map(inherited.tools.map((tool) => [tool.name, tool]));
  for (const tool of own.tools) tools.set(tool.name, tool);
  const ownNames = new Set(own.tools.map((tool) => tool.name));
  const registered = inherited.allowedTools;
  const allowedTools = registered === undefined
    ? own.allowedTools
    : own.allowedTools === undefined
      ? [...new Set([...registered, ...ownNames])]
      : own.allowedTools.filter((name) => registered.includes(name) || ownNames.has(name));
  const toolset = own.toolset ?? inherited.toolset;
  return {
    tools: [...tools.values()],
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(toolset !== undefined ? { toolset } : {}),
  };
}
