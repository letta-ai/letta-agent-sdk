import { spawn, execFile } from "node:child_process";
import { mkdir, lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  LettaAgentClient,
  type AnyAgentTool,
  type LettaCodeSession,
  type SDKResultMessage,
} from "../src/index.js";

export const PROFILE_COMMANDS = {
  unit: ["bun", ["test"]],
  check: ["bun", ["run", "check"]],
  build: ["bun", ["run", "build"]],
  "local-app-server-test": [
    "bun",
    ["test", "src/tests/local-app-server.test.ts"],
  ],
} as const;

export type CommandProfile = keyof typeof PROFILE_COMMANDS;
export type Outcome =
  | "reproduced"
  | "not_reproduced"
  | "inconclusive"
  | "infrastructure_failure";
export type Confidence = "low" | "medium" | "high";

export interface CommandAttempt {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface PilotReport {
  schemaVersion: 1;
  input: {
    problemStatement: string;
    sourceUrl?: string;
    commandProfile: CommandProfile;
  };
  repository: {
    revision: string;
    dirtyStatus: string;
  };
  attempts: CommandAttempt[];
  outcome: Outcome;
  summary: string;
  confidence: Confidence;
  policyViolation: boolean;
  unexpectedTools: string[];
  agentResult: {
    success: boolean;
    errorCode?: string;
    stopReason?: string;
    errorDetail?: string;
  };
}

export interface ExecutorState {
  selectedProfile: CommandProfile;
  attempts: CommandAttempt[];
  executed: boolean;
}

interface AgentAssessment {
  outcome: Outcome;
  summary: string;
  confidence: Confidence;
}

interface ExecuteOptions {
  timeoutMs?: number;
  envSource?: NodeJS.ProcessEnv;
  safeHome?: string;
}

const ALLOWED_TOOL_NAMES = new Set([
  "read_repository_file",
  "search_repository",
  "run_reproduction_command",
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_FILES = 2_000;
const MAX_MATCHES = 50;
const MAX_TOOL_OUTPUT = 16_000;
const MAX_LOG_OUTPUT = 24_000;
const execFileAsync = promisify(execFile);

export function authorizePilotTool(toolName: string) {
  return ALLOWED_TOOL_NAMES.has(toolName)
    ? { behavior: "allow" as const }
    : {
        behavior: "deny" as const,
        message: "The repro pilot permits only its three repository tools.",
        interrupt: true,
      };
}

export function parseProfile(value: string): CommandProfile {
  if (Object.hasOwn(PROFILE_COMMANDS, value)) return value as CommandProfile;
  throw new Error(`Unknown command profile: ${value}`);
}

export function commandArgv(profile: CommandProfile): string[] {
  const [command, args] = PROFILE_COMMANDS[profile];
  return [command, ...args];
}

export function boundedInput(
  value: string | undefined,
  name: string,
  maxLength: number,
  required: boolean,
): string | undefined {
  const normalized = value?.trim();
  if (required && !normalized) throw new Error(`${name} is required`);
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new Error(`${name} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function resolveRepositoryPath(
  repositoryRoot: string,
  requestedPath: string,
): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0") || isAbsolute(requestedPath)) {
    throw new Error("Repository path must be a non-empty relative path");
  }
  const root = await realpath(repositoryRoot);
  const lexicalTarget = resolve(root, requestedPath);
  if (!isWithin(root, lexicalTarget)) throw new Error("Path escapes repository root");
  const target = await realpath(lexicalTarget);
  if (!isWithin(root, target)) throw new Error("Path resolves outside repository root");
  return target;
}

export function sanitizeText(
  input: string,
  secrets: readonly string[] = [],
  maxLength = MAX_LOG_OUTPUT,
): string {
  let output = input.replace(/\u001b\[[0-9;]*m/g, "");
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  output = output
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|github[_-]?token)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]")
    .replace(/https:\/\/hooks\.(?:slack\.com\/services|zapier\.com\/hooks\/catch)\/[^\s"'<>]+/gi, "[REDACTED]");
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n...[truncated ${output.length - maxLength} characters]`;
}

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  safeHome: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: safeHome,
    XDG_CONFIG_HOME: resolve(safeHome, ".config"),
    CI: "true",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const key of ["TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export async function executeCommandArgv(
  argv: readonly string[],
  repositoryRoot: string,
  secrets: readonly string[] = [],
  options: ExecuteOptions = {},
): Promise<CommandAttempt> {
  if (argv.length === 0) throw new Error("Command argv must not be empty");
  const root = await realpath(repositoryRoot);
  const recordedArgv = [...argv];
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 8 * 60_000;
  const safeHome = options.safeHome ?? resolve(process.env.RUNNER_TEMP ?? root, "grumble-safe-home");
  await mkdir(safeHome, { recursive: true });

  return await new Promise((resolveAttempt) => {
    const child = spawn(recordedArgv[0]!, recordedArgv.slice(1), {
      cwd: root,
      env: buildChildEnvironment(options.envSource ?? process.env, safeHome),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveAttempt({
        argv: recordedArgv,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: sanitizeText(stdout, secrets),
        stderr: sanitizeText(stderr, secrets),
        ...(error ? { error: sanitizeText(error, secrets, 2_000) } : {}),
      });
    };

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_LOG_OUTPUT * 2) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_LOG_OUTPUT * 2) stderr += String(chunk);
    });
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref?.();
    }, timeoutMs);
  });
}

export async function executeFixedCommand(
  profile: CommandProfile,
  repositoryRoot: string,
  secrets: readonly string[] = [],
  options: ExecuteOptions = {},
): Promise<CommandAttempt> {
  return executeCommandArgv(commandArgv(profile), repositoryRoot, secrets, options);
}

export async function executeSelectedProfileOnce(
  state: ExecutorState,
  requestedProfile: unknown,
  execute: (profile: CommandProfile) => Promise<CommandAttempt>,
): Promise<CommandAttempt> {
  if (requestedProfile !== state.selectedProfile) {
    throw new Error("Requested profile does not match the workflow-selected profile");
  }
  if (state.executed) throw new Error("The reproduction command may execute only once");
  state.executed = true;
  const attempt = await execute(state.selectedProfile);
  state.attempts.push(attempt);
  return attempt;
}

async function readRepositoryFile(root: string, path: string): Promise<string> {
  const target = await resolveRepositoryPath(root, path);
  const stat = await lstat(target);
  if (!stat.isFile()) throw new Error("Path is not a regular file");
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes`);
  const contents = await readFile(target, "utf8");
  return sanitizeText(contents, [], MAX_TOOL_OUTPUT);
}

export async function searchRepository(
  repositoryRoot: string,
  query: string,
): Promise<string> {
  if (!query || query.length > 200 || query.includes("\0")) {
    throw new Error("Search query must contain 1-200 characters");
  }
  const root = await realpath(repositoryRoot);
  const matches: string[] = [];
  let filesVisited = 0;
  let bytesRead = 0;

  const visit = async (directory: string): Promise<void> => {
    if (matches.length >= MAX_MATCHES || filesVisited >= MAX_SEARCH_FILES || bytesRead >= MAX_SEARCH_BYTES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES || filesVisited >= MAX_SEARCH_FILES || bytesRead >= MAX_SEARCH_BYTES) break;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const lexicalPath = resolve(directory, entry.name);
      const stat = await lstat(lexicalPath);
      if (stat.isSymbolicLink()) continue;
      const actualPath = await realpath(lexicalPath);
      if (!isWithin(root, actualPath)) throw new Error("Search encountered a path outside repository root");
      if (stat.isDirectory()) {
        await visit(actualPath);
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      filesVisited++;
      bytesRead += stat.size;
      if (bytesRead > MAX_SEARCH_BYTES) break;
      const contents = await readFile(actualPath);
      if (contents.includes(0)) continue;
      const text = contents.toString("utf8");
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.includes(query)) continue;
        matches.push(`${relative(root, actualPath)}:${index + 1}:${line.slice(0, 300)}`);
        if (matches.length >= MAX_MATCHES) break;
      }
    }
  };

  await visit(root);
  return sanitizeText(
    matches.length > 0 ? matches.join("\n") : "No literal matches found.",
    [],
    MAX_TOOL_OUTPUT,
  );
}

function textToolResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

export function createPilotTools(
  repositoryRoot: string,
  state: ExecutorState,
  secrets: readonly string[],
  execute: (profile: CommandProfile) => Promise<CommandAttempt> = (profile) =>
    executeFixedCommand(profile, repositoryRoot, secrets),
): AnyAgentTool[] {
  return [
    {
      name: "read_repository_file",
      label: "Read Repository File",
      description: "Read one UTF-8 file inside the checked-out repository. Paths must be relative.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (_id, args) => {
        try {
          return textToolResult(await readRepositoryFile(repositoryRoot, (args as { path: string }).path));
        } catch (error) {
          return textToolResult(error instanceof Error ? error.message : String(error), true);
        }
      },
    },
    {
      name: "search_repository",
      label: "Search Repository",
      description: "Search tracked source-like files for a bounded literal string. This is not regex or shell search.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (_id, args) => {
        try {
          return textToolResult(await searchRepository(repositoryRoot, (args as { query: string }).query));
        } catch (error) {
          return textToolResult(error instanceof Error ? error.message : String(error), true);
        }
      },
    },
    {
      name: "run_reproduction_command",
      label: "Run Reproduction Command",
      description: `Run the single workflow-approved profile '${state.selectedProfile}' once. It accepts only that profile name and no command or argv.`,
      parameters: {
        type: "object",
        properties: {
          profile: { type: "string", enum: [state.selectedProfile] },
        },
        required: ["profile"],
        additionalProperties: false,
      },
      execute: async (_id, args) => {
        try {
          const attempt = await executeSelectedProfileOnce(
            state,
            (args as { profile?: unknown }).profile,
            execute,
          );
          return textToolResult(JSON.stringify(attempt));
        } catch (error) {
          return textToolResult(error instanceof Error ? error.message : String(error), true);
        }
      },
    },
  ];
}

function parseAssessment(text: string): AgentAssessment | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    const value = JSON.parse(candidate) as Partial<AgentAssessment>;
    const outcomes: Outcome[] = ["reproduced", "not_reproduced", "inconclusive", "infrastructure_failure"];
    const confidences: Confidence[] = ["low", "medium", "high"];
    if (
      outcomes.includes(value.outcome as Outcome) &&
      confidences.includes(value.confidence as Confidence) &&
      typeof value.summary === "string"
    ) {
      return value as AgentAssessment;
    }
  } catch {
    return null;
  }
  return null;
}

export function buildReport(input: {
  problemStatement: string;
  sourceUrl?: string;
  commandProfile: CommandProfile;
  revision: string;
  dirtyStatus: string;
  attempts: CommandAttempt[];
  assessment: AgentAssessment | null;
  policyViolation: boolean;
  unexpectedTools: string[];
  terminalResult?: SDKResultMessage;
  infrastructureError?: string;
  secrets?: readonly string[];
}): PilotReport {
  const evidence = input.attempts[0];
  let outcome: Outcome;
  if (input.policyViolation) {
    outcome = "inconclusive";
  } else if (input.infrastructureError || !input.terminalResult || !input.terminalResult.success) {
    outcome = "infrastructure_failure";
  } else if (!evidence || evidence.timedOut || evidence.exitCode === null) {
    outcome = "inconclusive";
  } else if (input.assessment?.outcome === "infrastructure_failure") {
    outcome = "infrastructure_failure";
  } else if (evidence.exitCode === 0) {
    outcome = "not_reproduced";
  } else {
    outcome = input.assessment?.outcome === "reproduced" ? "reproduced" : "inconclusive";
  }

  let confidence: Confidence = input.assessment?.confidence ?? "low";
  if (!evidence || evidence.timedOut || evidence.exitCode === null || input.policyViolation) confidence = "low";
  if (outcome === "infrastructure_failure" && confidence === "high") confidence = "medium";

  const secrets = input.secrets ?? [];
  const policySummary = input.policyViolation
    ? `The pilot stopped because the session exposed unexpected tools: ${[
        ...new Set(input.unexpectedTools),
      ].sort().join(", ") || "unknown"}.`
    : undefined;
  const terminalError = !input.terminalResult?.success
    ? [
        input.terminalResult?.errorCode,
        input.terminalResult?.error,
        input.terminalResult?.errorDetail,
      ].filter(Boolean).join(": ")
    : undefined;
  const summary = sanitizeText(
    policySummary ??
      input.infrastructureError ??
      terminalError ??
      input.assessment?.summary ??
      "The agent did not return a valid assessment.",
    secrets,
    4_000,
  );
  return {
    schemaVersion: 1,
    input: {
      problemStatement: sanitizeText(input.problemStatement, secrets, 4_000),
      ...(input.sourceUrl ? { sourceUrl: sanitizeText(input.sourceUrl, secrets, 500) } : {}),
      commandProfile: input.commandProfile,
    },
    repository: {
      revision: input.revision,
      dirtyStatus: sanitizeText(input.dirtyStatus, secrets, 8_000),
    },
    attempts: input.attempts.map((attempt) => ({
      ...attempt,
      stdout: sanitizeText(attempt.stdout, secrets),
      stderr: sanitizeText(attempt.stderr, secrets),
      ...(attempt.error ? { error: sanitizeText(attempt.error, secrets, 2_000) } : {}),
    })),
    outcome,
    summary,
    confidence,
    policyViolation: input.policyViolation,
    unexpectedTools: [...new Set(input.unexpectedTools)].sort(),
    agentResult: {
      success: input.terminalResult?.success ?? false,
      ...(input.terminalResult?.errorCode ? { errorCode: input.terminalResult.errorCode } : {}),
      ...(input.terminalResult?.stopReason ? { stopReason: input.terminalResult.stopReason } : {}),
      ...(input.terminalResult?.errorDetail
        ? { errorDetail: sanitizeText(input.terminalResult.errorDetail, secrets, 2_000) }
        : {}),
    },
  };
}

export function renderMarkdown(report: PilotReport): string {
  const attempts = report.attempts.length === 0
    ? "No approved reproduction command executed."
    : report.attempts.map((attempt) => [
        `### \`${attempt.argv.join(" ")}\``,
        `- Exit code: ${attempt.exitCode ?? "unavailable"}`,
        `- Timed out: ${attempt.timedOut}`,
        `- Duration: ${attempt.durationMs} ms`,
        "",
        "```text",
        [attempt.stdout, attempt.stderr].filter(Boolean).join("\n"),
        "```",
      ].join("\n")).join("\n\n");
  return [
    "# Grumble reproduction pilot",
    "",
    `- Outcome: **${report.outcome}**`,
    `- Confidence: **${report.confidence}**`,
    `- Revision: \`${report.repository.revision}\``,
    `- Command profile: \`${report.input.commandProfile}\``,
    `- Policy violation: ${report.policyViolation}`,
    "",
    "## Input",
    "",
    report.input.problemStatement,
    ...(report.input.sourceUrl ? ["", `Source: ${report.input.sourceUrl}`] : []),
    "",
    "## Summary",
    "",
    report.summary,
    "",
    "## Attempts",
    "",
    attempts,
    "",
    "## Final git status --short",
    "",
    "```text",
    report.repository.dirtyStatus || "(clean)",
    "```",
    "",
  ].join("\n");
}

async function gitOutput(root: string, args: string[], safeHome: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: buildChildEnvironment(process.env, safeHome),
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function writeReports(outputDirectory: string, report: PilotReport): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "grumble-repro-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, "grumble-repro-report.md"), renderMarkdown(report));
}

async function main(): Promise<void> {
  const repositoryRoot = await realpath(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const runnerTemp = await realpath(process.env.RUNNER_TEMP ?? "/tmp");
  const outputDirectory = resolve(runnerTemp, "grumble-repro-pilot");
  const problemStatement = boundedInput(process.env.PILOT_PROBLEM_STATEMENT, "problem_statement", 4_000, true)!;
  const sourceUrl = boundedInput(process.env.PILOT_SOURCE_URL, "source_url", 500, false);
  const commandProfile = parseProfile(process.env.PILOT_COMMAND_PROFILE ?? "");
  const safeHome = resolve(runnerTemp, "grumble-safe-home");
  await mkdir(safeHome, { recursive: true });
  const state: ExecutorState = { selectedProfile: commandProfile, attempts: [], executed: false };
  const unexpectedTools: string[] = [];
  let secrets: string[] = [];
  let revision = "unavailable";
  let policyViolation = false;
  let terminalResult: SDKResultMessage | undefined;
  let infrastructureError: string | undefined;
  let session: LettaCodeSession | undefined;

  try {
    const agentId = boundedInput(
      process.env.GRUMBLE_REPRO_AGENT_ID,
      "GRUMBLE_REPRO_AGENT_ID",
      200,
      true,
    )!;
    const apiKey = boundedInput(process.env.LETTA_API_KEY, "LETTA_API_KEY", 2_000, true)!;
    secrets = [apiKey, agentId];
    revision = await gitOutput(repositoryRoot, ["rev-parse", "HEAD"], safeHome);
    const tools = createPilotTools(repositoryRoot, state, secrets, (profile) =>
      executeFixedCommand(profile, repositoryRoot, secrets, { safeHome }));
    const client = new LettaAgentClient({
      backend: "local",
      appServer: { harnessBackend: "api", pinGlobalAgent: false },
    });
    session = client.createSession(agentId, {
      // Keep Grumble's system prompt and model configuration, but do not load
      // persistent memory, skills, mods, or prior transcript state.
      cwd: repositoryRoot,
      stateless: true,
      skillSources: [],
      toolset: { base: "none" },
      allowedTools: [...ALLOWED_TOOL_NAMES],
      permissionMode: "strict",
      canUseTool: (toolName) => {
        const decision = authorizePilotTool(toolName);
        if (decision.behavior === "allow") return decision;
        policyViolation = true;
        unexpectedTools.push(toolName);
        return decision;
      },
      tools,
    });

    const bootstrap = await session.bootstrapState({ limit: 1 });
    const attachedTools = (bootstrap.tools ?? []).filter(
      (toolName) => !ALLOWED_TOOL_NAMES.has(toolName),
    );
    if (bootstrap.tools === undefined) {
      policyViolation = true;
      unexpectedTools.push("tool_inventory_unavailable");
    } else if (attachedTools.length > 0) {
      policyViolation = true;
      unexpectedTools.push(...attachedTools);
    } else {
      const prompt = [
        "Attempt to reproduce the following Agent SDK issue or test failure using only the repository tools provided.",
        "Do not propose or make fixes. Read relevant files, then run the approved reproduction command exactly once.",
        `Approved command profile: ${commandProfile}`,
        sourceUrl ? `Inert source reference (do not fetch it): ${sourceUrl}` : "",
        "",
        problemStatement,
        "",
        "Your final response must be only JSON with this shape:",
        '{"outcome":"reproduced|not_reproduced|inconclusive|infrastructure_failure","summary":"evidence-based summary","confidence":"low|medium|high"}',
      ].filter(Boolean).join("\n");
      await session.send(prompt);
      for await (const message of session.stream()) {
        if (message.type === "tool_call" && !ALLOWED_TOOL_NAMES.has(message.toolName)) {
          policyViolation = true;
          unexpectedTools.push(message.toolName);
        } else if (message.type === "error") {
          infrastructureError ??= message.message;
        } else if (message.type === "result") {
          terminalResult = message;
        }
      }
    }
  } catch (error) {
    infrastructureError = error instanceof Error ? error.message : String(error);
  } finally {
    session?.close();
  }

  let dirtyStatus = "";
  try {
    dirtyStatus = await gitOutput(repositoryRoot, ["status", "--short"], safeHome);
  } catch (error) {
    infrastructureError ??= `Unable to record git status: ${error instanceof Error ? error.message : String(error)}`;
  }

  const assessment = parseAssessment(terminalResult?.result ?? "");
  const report = buildReport({
    problemStatement,
    sourceUrl,
    commandProfile,
    revision,
    dirtyStatus,
    attempts: state.attempts,
    assessment,
    policyViolation,
    unexpectedTools,
    terminalResult,
    infrastructureError,
    secrets,
  });
  await writeReports(outputDirectory, report);
  console.log(`Grumble repro pilot finished: ${report.outcome} (${report.confidence} confidence)`);
  if (report.outcome === "infrastructure_failure") process.exitCode = 2;
  else if (report.policyViolation) process.exitCode = 3;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(sanitizeText(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exitCode = 2;
  });
}
