/**
 * SDK default client-side toolset.
 *
 * SDK sessions are typically headless, so interactive user-input tools are
 * excluded from the default toolset. Callers opt back in by passing
 * `allowedTools` explicitly (e.g. `allowedTools: [...DEFAULT_CLIENT_TOOLS, "AskUserQuestion"]`).
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
 * the SDK default toolset.
 */
export const EXCLUDED_INTERACTIVE_CLIENT_TOOLS: readonly string[] = [
  "AskUserQuestion",
  "request_user_input",
];

/**
 * Default client-side tool allowlist for SDK sessions.
 *
 * This is the union of the harness (letta-code) toolsets minus interactive
 * user-input tools. It is applied as an intersection filter: the harness still
 * picks the toolset for the session's model, and this list only removes the
 * interactive tools from whichever toolset is active. Tools the harness does
 * not include for the model are unaffected by their presence here.
 */
export const DEFAULT_CLIENT_TOOLS: readonly string[] = [
  // default (Anthropic-style) toolset
  "Bash",
  "Edit",
  "EnterWorktree",
  "memory",
  "Read",
  "Skill",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "Write",
  // codex toolsets
  "exec_command",
  "write_stdin",
  "ApplyPatch",
  "apply_patch",
  "UpdatePlan",
  "update_plan",
  "ViewImage",
  "view_image",
  "memory_apply_patch",
  // gemini toolsets
  "RunShellCommand",
  "run_shell_command",
  "ReadFileGemini",
  "read_file_gemini",
  "ListDirectory",
  "list_directory",
  "GlobGemini",
  "glob_gemini",
  "SearchFileContent",
  "search_file_content",
  "Replace",
  "replace",
  "WriteFileGemini",
  "write_file_gemini",
  "WriteTodos",
  "write_todos",
  "ReadManyFiles",
  "read_many_files",
];

/**
 * Resolve the client tool allowlist for a session.
 *
 * An explicit `allowedTools` wins over the SDK default toolset (including
 * re-adding interactive tools). Custom SDK tool names are always merged in:
 * the harness filters external tools by this allowlist too, and registering
 * a custom tool is already an explicit opt-in.
 */
export function resolveClientToolAllowlist(
  allowedTools: readonly string[] | undefined,
  customToolNames: readonly string[] = [],
): string[] {
  const resolved = [
    ...(allowedTools !== undefined ? allowedTools : DEFAULT_CLIENT_TOOLS),
  ];
  for (const name of customToolNames) {
    if (!resolved.includes(name)) {
      resolved.push(name);
    }
  }
  return resolved;
}
