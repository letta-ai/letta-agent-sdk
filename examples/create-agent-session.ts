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
  "disallowedTools" | "systemInfoReminder"
>;

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

/** Create an agent and resume its default conversation. */
export async function createAgentSession(
  options: ExampleCreateOptions = {},
  client: LettaAgentClient = createExampleClient(),
): Promise<LettaCodeSession> {
  const agentId = await client.createAgent({
    personality: options.personality,
    model: options.model,
    embedding: options.embedding,
    systemPrompt: options.systemPrompt,
    memory: options.memory,
    persona: options.persona,
    human: options.human,
    memfs: options.memfs,
    name: options.name,
    description: options.description,
    hidden: options.hidden,
    baseTools: options.baseTools,
    tags: options.tags,
    dreaming: options.dreaming,
  });
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
