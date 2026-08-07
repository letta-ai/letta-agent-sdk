import type { ClientToolsetConfig } from "./types.js";

/**
 * Bundled client tools the SDK loads on demand when a caller names them in
 * `allowedTools`.
 *
 * This set is a filter, never an authority: a name it does not contain is
 * dropped rather than forwarded, because the harness fails the turn outright
 * on an unrecognized `client_toolset.include` entry. A tool missing here is
 * therefore only a missed convenience — the caller can still load it with an
 * explicit `toolset`.
 */
const LOADABLE_CLIENT_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "LS",
  "Read",
  "Write",
]);

/**
 * Resolve the request-scoped toolset to send with a turn.
 *
 * `allowedTools` is a visibility filter applied to the tools the harness has
 * loaded, so naming a bundled tool there does not load it. Without this,
 * `allowedTools: ["Read", "LS", "Glob", "Grep"]` yields a session that can
 * only call `Read` — the other three were never loaded, and the caller sees
 * an agent that silently fails to find anything instead of an error.
 *
 * An explicit `toolset` always wins; it is the caller stating exactly which
 * base and additions they want.
 */
export function resolveClientToolset(
  toolset: ClientToolsetConfig | undefined,
  allowedTools: readonly string[] | undefined,
): ClientToolsetConfig | undefined {
  if (toolset !== undefined) return toolset;
  if (allowedTools === undefined) return undefined;

  const include = [
    ...new Set(allowedTools.filter((name) => LOADABLE_CLIENT_TOOLS.has(name))),
  ];
  return include.length > 0 ? { include } : undefined;
}
