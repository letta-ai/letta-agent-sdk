/**
 * SDK default toolsets.
 *
 * SDK sessions are headless, so interactive user-input tools are excluded
 * from the toolset by default via the harness's `exclude_interactive_tools`
 * protocol flag — the harness owns the interactive set, so the SDK does not
 * pin toolset names. Callers opt back in by listing an interactive tool in
 * `allowedTools`.
 */

/**
 * Server-side tools attached to new SDK agents by default. Matches the
 * letta-code CLI's default for created agents. Pass `baseTools: []` to attach
 * none, or an explicit list to override.
 */
export const DEFAULT_BASE_TOOLS: readonly string[] = [
  "web_search",
  "fetch_webpage",
];

/**
 * Interactive user-input tools (and their per-toolset variants) excluded from
 * SDK sessions by default. The authoritative set lives in the harness
 * (interactive-policy); this list exists so the SDK can detect an explicit
 * opt-in via `allowedTools`.
 */
export const EXCLUDED_INTERACTIVE_CLIENT_TOOLS: readonly string[] = [
  "AskUserQuestion",
  "request_user_input",
];

/**
 * Whether a session should ask the harness to exclude interactive
 * user-input tools. Listing one in `allowedTools` is the explicit opt-in.
 */
export function shouldExcludeInteractiveTools(
  allowedTools: readonly string[] | undefined,
): boolean {
  return !allowedTools?.some((name) =>
    EXCLUDED_INTERACTIVE_CLIENT_TOOLS.includes(name),
  );
}

/**
 * Resolve the client tool allowlist for a session.
 *
 * Undefined `allowedTools` sends no allowlist — the harness default toolset
 * applies (minus interactive tools, excluded separately). When an explicit
 * allowlist is given, custom SDK tool names are merged in: the harness
 * filters external tools by the allowlist too, and registering a custom tool
 * is already an explicit opt-in.
 */
export function resolveClientToolAllowlist(
  allowedTools: readonly string[] | undefined,
  customToolNames: readonly string[] = [],
): string[] | undefined {
  if (allowedTools === undefined) return undefined;
  const resolved = [...allowedTools];
  for (const name of customToolNames) {
    if (!resolved.includes(name)) {
      resolved.push(name);
    }
  }
  return resolved;
}
