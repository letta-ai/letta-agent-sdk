import {
  createAgent,
  createSession,
  type CreateAgentOptions,
  type CreateSessionOptions,
  type DreamingOptions,
  type LettaCodeSession,
} from "../src/index.js";

type ExampleAgentSessionOptions = Omit<
  CreateAgentOptions,
  "disallowedTools" | "systemInfoReminder" | "dreaming"
> & {
  dreaming?: Omit<DreamingOptions, "behavior">;
};

/** Create an agent and open its first app-server conversation. */
export async function createAgentSession(
  options: ExampleAgentSessionOptions = {},
): Promise<LettaCodeSession> {
  const {
    allowedTools,
    permissionMode,
    cwd,
    canUseTool,
    tools,
    dreaming,
    ...agentOptions
  } = options;
  const agentId = await createAgent({ ...agentOptions, dreaming });
  const sessionOptions: CreateSessionOptions = {
    model: options.model,
    allowedTools,
    permissionMode,
    cwd,
    skillSources: options.skillSources,
    dreaming,
    canUseTool,
    tools,
  };
  return createSession(agentId, sessionOptions);
}
