import type { AppServerClient } from "@letta-ai/letta-code/app-server-client";
import type { ClientToolsetConfig } from "./types.js";

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
    const info = await client.info();
    const capabilities = info.capabilities as Record<string, unknown> | undefined;
    return capabilities?.[RUNTIME_TOOL_POLICY_CAPABILITY] === true;
  } catch {
    return false;
  }
}
