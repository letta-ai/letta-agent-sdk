import {
  LettaAgentClient,
  type CreateAgentOptions,
  type LettaCodeClientOptions,
  type LettaCodeClientSessionOptions,
  type LettaCodeSession,
} from "../src/index.js";

/**
 * Shared example client.
 *
 * Pass `backend` to pin a backend. If `backend` is omitted and
 * `LETTA_API_KEY` is set, the client uses Cloud. Otherwise it uses local.
 */
export function createExampleClient(
  options: LettaCodeClientOptions = {},
): LettaAgentClient {
  if (options.backend) {
    return new LettaAgentClient(options);
  }
  if (process.env.LETTA_API_KEY) {
    return new LettaAgentClient({
      backend: "cloud",
      apiKey: process.env.LETTA_API_KEY,
    });
  }
  return new LettaAgentClient({ backend: "local" });
}

type ExampleCreateOptions = Omit<
  CreateAgentOptions,
  | "disallowedTools"
  | "human"
  | "memory"
  | "persona"
  | "systemInfoReminder"
>;

// Keep the examples on the current personality and MemFS model. The omitted
// fields are legacy creation options or internal controls that would distract
// from the session APIs demonstrated here.

const MEMFS_GUIDANCE = `## Persistent memory
This agent has a git-backed memory filesystem. Use memory files for durable
knowledge instead of memory blocks. Keep stable identity and behavior in
system/ files. Keep project notes, learned preferences, and history in focused
Markdown files under reference/. Never store secrets in memory.`;

function withMemfsGuidance(
  systemPrompt: CreateAgentOptions["systemPrompt"],
): CreateAgentOptions["systemPrompt"] {
  return typeof systemPrompt === "string"
    ? `${systemPrompt}\n\n${MEMFS_GUIDANCE}`
    : systemPrompt;
}

function sessionOptionsFrom(
  options: ExampleCreateOptions,
): LettaCodeClientSessionOptions {
  return {
    model: options.model,
    allowedTools: options.allowedTools,
    permissionMode: options.permissionMode,
    cwd: options.cwd,
    skillSources: options.skillSources,
    dreaming: options.dreaming,
    canUseTool: options.canUseTool,
    tools: options.tools,
  };
}

/** Create an agent with the shared example defaults. */
export async function createExampleAgent(
  options: ExampleCreateOptions = {},
  client: LettaAgentClient = createExampleClient(),
): Promise<string> {
  return client.createAgent({
    personality: options.personality,
    model: options.model,
    embedding: options.embedding,
    systemPrompt: withMemfsGuidance(options.systemPrompt),
    memfs: options.memfs ?? true,
    name: options.name,
    description: options.description,
    hidden: options.hidden,
    baseTools: options.baseTools,
    tags: options.tags,
    dreaming: options.dreaming,
  });
}

/** Create an agent and resume its default conversation. */
export async function createAgentSession(
  options: ExampleCreateOptions = {},
  client: LettaAgentClient = createExampleClient(),
): Promise<LettaCodeSession> {
  const agentId = await createExampleAgent(options, client);
  return client.resumeSession(agentId, sessionOptionsFrom(options));
}

/** Resume an existing agent default conversation or a specific conversation. */
export function resumeExampleSession(
  id: string,
  options: LettaCodeClientSessionOptions = {},
  client: LettaAgentClient = createExampleClient(),
): LettaCodeSession {
  return client.resumeSession(id, options);
}

/**
 * Link to view an agent in the hosted chat UI. Hosted chat only loads Cloud
 * agents, so local-backend demos print a note instead of a URL that 404s.
 */
export function formatAgentLink(
  agentId: string | null,
  client: LettaAgentClient,
): string {
  return client.backend === "cloud"
    ? `https://chat.letta.com/agents/${agentId}`
    : `${agentId} (local backend — not visible in hosted chat)`;
}
