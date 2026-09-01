/**
 * Dynamic workflow runtime
 *
 * A small orchestration layer over the Letta Agent SDK that mirrors the
 * Claude Code dynamic-workflow contract (https://code.claude.com/docs/en/workflows):
 *
 * - agent(task, opts)          spawn one worker agent, resolve to its result
 * - reason(task, opts)         run one tool-less stage as an agent-free query
 * - parallel(thunks)           run tasks concurrently, barrier until all settle
 * - pipeline(items, ...stages) run each item through stages independently
 * - phase(title) / log(msg)    progress narration
 *
 * agent() and reason() resolve to null on failure instead of rejecting, so
 * fan-outs degrade per-item: filter results with .filter(Boolean).
 *
 * Use agent() for stages that need tools, a sandbox, or server-side tools;
 * use reason() for stages that only think over text (judges, synthesizers,
 * extractors). reason() runs on stateless conversations with agent_id: null —
 * no agent is created or deleted.
 */

import { LettaAgentClient } from '../../src/index.js';
import type {
  CanUseToolCallback,
  LettaCodeClientSessionOptions,
  LettaCodeCloudSandboxOptions,
  PermissionMode,
  SDKResultMessage,
} from '../../src/index.js';

const DEFAULT_MODEL = process.env.LETTA_WORKFLOW_MODEL ?? 'haiku';
const MAX_CONCURRENT = Number(process.env.LETTA_WORKFLOW_CONCURRENCY ?? 4);

const COLORS = {
  phase: '\x1b[1m\x1b[35m',
  ok: '\x1b[32m',
  fail: '\x1b[31m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
};

export interface AgentOptions {
  /** Display label for progress lines (defaults to a prompt prefix). */
  label?: string;
  /** JSON schema for structured output; agent() returns the parsed value. */
  schema?: object;
  model?: string;
  /** Client-side tool allowlist for the worker session. */
  allowedTools?: string[];
  /** Server-side tools attached to the worker agent (e.g. web_search). */
  baseTools?: string[];
  /** Per-worker managed sandbox (cloud backend only). */
  sandbox?: LettaCodeCloudSandboxOptions;
  cwd?: string;
  /** Defaults to 'unrestricted'. Use 'strict' to route every call through canUseTool. */
  permissionMode?: PermissionMode;
  /** Approval callback, required for a stage that runs under 'strict'. */
  canUseTool?: CanUseToolCallback;
}

export const stats = { agents: 0, failures: 0, costUsd: 0 };

class Semaphore {
  private queue: Array<() => void> = [];
  constructor(private available: number) {}
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.available++;
  }
}

const slots = new Semaphore(MAX_CONCURRENT);
const pendingCleanup: Array<Promise<void>> = [];

let workflowClient = new LettaAgentClient();

/** Route workers through a different client, e.g. cloud with managed sandboxes. */
export function setWorkflowClient(client: LettaAgentClient): void {
  workflowClient = client;
}

// Agent-free queries run over the Letta API through a local app-server, so
// they need LETTA_API_KEY regardless of where the tool-using workers run.
// The letta-code local backend has no ephemeral-conversation support.
let queryClient: LettaAgentClient | null = null;

function getQueryClient(): LettaAgentClient {
  if (!process.env.LETTA_API_KEY) {
    throw new Error(
      'reason() runs agent-free queries against the Letta API; set LETTA_API_KEY.',
    );
  }
  queryClient ??= new LettaAgentClient({
    backend: 'local',
    appServer: { harnessBackend: 'api', requestTimeoutMs: 300_000 },
  });
  return queryClient;
}

/**
 * Sandbox + cwd for a cloud worker that should read a GitHub repository.
 *
 * Managed sandboxes clone into /root/workspace/<repo>. Pointing cwd there
 * matters for more than convenience: a worker left in /root has the agent
 * state tree (/root/.letta/agents) below it, and the harness's cross-agent
 * memory guard denies every recursive path tool — LS, Glob, Grep — from a
 * directory that contains it.
 */
export function sandboxRepo(ref: string): { sandbox: LettaCodeCloudSandboxOptions; cwd: string } {
  const [owner, repo] = ref.split('/');
  if (!owner || !repo) throw new Error(`Expected owner/repo, got "${ref}"`);
  return {
    sandbox: { githubRepositories: [{ owner, repo }] },
    cwd: `/root/workspace/${repo}`,
  };
}

let currentPhase = '';

export function phase(title: string): void {
  currentPhase = title;
  console.log(`\n${COLORS.phase}── ${title} ──${COLORS.reset}`);
}

export function log(message: string): void {
  console.log(`${COLORS.dim}${message}${COLORS.reset}`);
}

/** Pull a JSON value out of a model reply that may include fences or prose. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start === -1 || end <= start) throw new Error('no JSON in reply');
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

/**
 * Spawn one worker agent for a task and resolve to its final output.
 *
 * Each call creates an ephemeral hidden agent (no memfs, no server tools),
 * runs the task as a one-shot conversation, and deletes the agent. With
 * `schema`, the reply is parsed as JSON (one reformat retry) and the parsed
 * value is returned; otherwise the raw final text is returned.
 */
export async function agent<T = string>(
  task: string,
  opts: AgentOptions = {},
): Promise<T | null> {
  const label = opts.label ?? task.replace(/\s+/g, ' ').slice(0, 60);
  await slots.acquire();
  const started = Date.now();
  let agentId: string | null = null;
  try {
    agentId = await workflowClient.createAgent({
      model: opts.model ?? DEFAULT_MODEL,
      memfs: false,
      hidden: true,
      baseTools: opts.baseTools ?? [],
    });

    const tools = opts.allowedTools ?? [];
    const sessionOptions: LettaCodeClientSessionOptions = {
      model: opts.model ?? DEFAULT_MODEL,
      // base 'none' keeps a worker's toolset to exactly what the stage names,
      // instead of the harness default plus an allowlist on top of it.
      toolset: { base: 'none', include: tools },
      allowedTools: tools,
      permissionMode: opts.permissionMode ?? 'unrestricted',
      canUseTool: opts.canUseTool,
      cwd: opts.cwd,
      sandbox: opts.sandbox,
    };

    const instruction = opts.schema
      ? `${task}\n\nYour final message is parsed by a script, not read by a human. Respond with ONLY a JSON instance conforming to this JSON Schema — the data itself, no markdown fences, no prose, and no schema keywords like "type", "properties", or "required":\n${JSON.stringify(opts.schema)}`
      : `${task}\n\nYour final message is returned to an orchestrating script as a raw value. Return only the requested output, no preamble.`;

    let result = await workflowClient.prompt(instruction, agentId, sessionOptions);
    stats.agents++;
    stats.costUsd += result.totalCostUsd ?? 0;

    // Turns fail transiently often enough that one retry is worth it: in a
    // fan-out, a single unlucky worker otherwise drops a whole file or claim.
    if (!result.success && result.recoverable !== false) {
      result = await workflowClient.prompt(instruction, agentId, sessionOptions);
      stats.costUsd += result.totalCostUsd ?? 0;
    }

    if (!result.success || !result.result) {
      stats.failures++;
      const detail = [result.errorCode ?? 'no output', result.error ?? result.errorDetail]
        .filter(Boolean)
        .join(': ');
      console.log(`${COLORS.fail}✗${COLORS.reset} ${label} ${COLORS.dim}(${detail})${COLORS.reset}`);
      return null;
    }

    let value: unknown = result.result.trim();
    if (opts.schema) {
      try {
        value = extractJson(result.result);
      } catch {
        result = await workflowClient.prompt(
          `Reformat the following as ONLY a JSON value matching this schema, nothing else:\n${JSON.stringify(opts.schema)}\n\n${result.result}`,
          agentId,
          sessionOptions,
        );
        stats.costUsd += result.totalCostUsd ?? 0;
        try {
          value = extractJson(result.result ?? '');
        } catch {
          stats.failures++;
          console.log(`${COLORS.fail}✗${COLORS.reset} ${label} ${COLORS.dim}(unparseable reply)${COLORS.reset}`);
          return null;
        }
      }
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${COLORS.ok}✓${COLORS.reset} ${currentPhase ? `[${currentPhase}] ` : ''}${label} ${COLORS.dim}(${seconds}s)${COLORS.reset}`);
    return value as T;
  } catch (error) {
    stats.failures++;
    console.log(`${COLORS.fail}✗${COLORS.reset} ${label} ${COLORS.dim}(${error instanceof Error ? error.message : String(error)})${COLORS.reset}`);
    return null;
  } finally {
    slots.release();
    if (agentId) {
      pendingCleanup.push(workflowClient.agents.delete(agentId).catch(() => {}));
    }
  }
}

export interface ReasonOptions {
  /** Display label for progress lines (defaults to a prompt prefix). */
  label?: string;
  /** JSON schema for structured output; reason() returns the parsed value. */
  schema?: object;
  model?: string;
  /** System prompt for the ephemeral conversation. */
  system?: string;
}

/**
 * Run one tool-less stage as an agent-free query.
 *
 * Each call creates a stateless conversation (agent_id: null) via
 * client.query(), streams it to completion, and resolves to the final text
 * (or the parsed value when `schema` is set). No agent is created or
 * deleted. Use this for judges, synthesizers, extractors, and any other
 * stage that only reasons over text it is given.
 */
export async function reason<T = string>(
  task: string,
  opts: ReasonOptions = {},
): Promise<T | null> {
  const label = opts.label ?? task.replace(/\s+/g, ' ').slice(0, 60);
  await slots.acquire();
  const started = Date.now();
  try {
    const client = getQueryClient();
    const system =
      opts.system ??
      'You are one stage of a scripted workflow. Your final message is parsed by a script, not read by a human. Return only the requested output, no preamble.';
    const prompt = opts.schema
      ? `${task}\n\nRespond with ONLY a JSON instance conforming to this JSON Schema — the data itself, no markdown fences, no prose, and no schema keywords like "type", "properties", or "required":\n${JSON.stringify(opts.schema)}`
      : task;

    let result: SDKResultMessage | undefined;
    for await (const message of client.query({
      prompt,
      options: {
        model: opts.model ?? DEFAULT_MODEL,
        system,
        allowedTools: [],
      },
    })) {
      if (message.type === 'result') result = message;
    }

    stats.agents++;
    stats.costUsd += result?.totalCostUsd ?? 0;

    if (!result?.success || typeof result.result !== 'string') {
      stats.failures++;
      const detail = result?.error ?? result?.errorCode ?? 'no output';
      console.log(`${COLORS.fail}✗${COLORS.reset} ${label} ${COLORS.dim}(${detail})${COLORS.reset}`);
      return null;
    }

    let value: unknown = result.result.trim();
    if (opts.schema) {
      try {
        value = extractJson(result.result);
      } catch {
        stats.failures++;
        console.log(`${COLORS.fail}✗${COLORS.reset} ${label} ${COLORS.dim}(unparseable reply)${COLORS.reset}`);
        return null;
      }
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${COLORS.ok}✓${COLORS.reset} ${currentPhase ? `[${currentPhase}] ` : ''}${label} ${COLORS.dim}(${seconds}s)${COLORS.reset}`);
    return value as T;
  } catch (error) {
    stats.failures++;
    console.log(`${COLORS.fail}✗${COLORS.reset} ${label} ${COLORS.dim}(${error instanceof Error ? error.message : String(error)})${COLORS.reset}`);
    return null;
  } finally {
    slots.release();
  }
}

/**
 * Run tasks concurrently and barrier until all settle. A thunk that throws
 * resolves to null in the result array; the call itself never rejects.
 */
export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
  return Promise.all(thunks.map((thunk) => thunk().catch(() => null)));
}

type Stage = (prev: any, item: any, index: number) => any;

/**
 * Run each item through all stages independently — no barrier between
 * stages, so item A can be in stage 2 while item B is still in stage 1.
 * A stage that throws drops that item to null and skips its remaining stages.
 */
export async function pipeline(items: any[], ...stages: Stage[]): Promise<any[]> {
  return Promise.all(
    items.map(async (item, index) => {
      let value: any = item;
      for (const stage of stages) {
        try {
          value = await stage(value, item, index);
        } catch {
          return null;
        }
      }
      return value;
    }),
  );
}

/** Print run totals and wait for worker-agent deletions. Call once at the end of a workflow script. */
export async function printSummary(): Promise<void> {
  await Promise.allSettled(pendingCleanup);
  const cost = stats.costUsd > 0 ? `, $${stats.costUsd.toFixed(4)}` : '';
  console.log(
    `\n${COLORS.dim}${stats.agents} agents, ${stats.failures} failures${cost}${COLORS.reset}`,
  );
}
