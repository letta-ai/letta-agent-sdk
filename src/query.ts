import type {
  CreateAgentOptions,
  LettaAgentClientQueryParams,
  LettaCodeClientSessionOptions,
  LettaCodeSession,
  Query,
  QueryPrompt,
  SDKMessage,
  SendMessage,
} from "./types.js";
import { validateCreateSessionOptions } from "./validation.js";

interface QueryClient {
  createAgent(options?: CreateAgentOptions): Promise<string>;
  createSession(
    agentId: string,
    options?: LettaCodeClientSessionOptions,
  ): LettaCodeSession;
}

function isPromptStream(prompt: QueryPrompt): prompt is AsyncIterable<SendMessage> {
  return (
    typeof prompt !== "string" &&
    prompt !== null &&
    typeof (prompt as AsyncIterable<SendMessage>)[Symbol.asyncIterator] ===
      "function"
  );
}

async function* prompts(prompt: QueryPrompt): AsyncGenerator<SendMessage> {
  if (isPromptStream(prompt)) {
    yield* prompt;
    return;
  }
  yield prompt;
}

function anonymousQueryOptions(
  options: LettaCodeClientSessionOptions,
): {
  agentOptions: CreateAgentOptions;
  sessionOptions: LettaCodeClientSessionOptions;
} {
  if (options.stateless === false) {
    throw new Error(
      "query() without agentId always creates a stateless hidden agent; stateless cannot be false.",
    );
  }

  const { model, ...rest } = options;
  const sessionOptions: LettaCodeClientSessionOptions = {
    ...rest,
    stateless: true,
  };
  validateCreateSessionOptions(sessionOptions);

  return {
    agentOptions: {
      ...(model !== undefined ? { model } : {}),
      hidden: true,
      memfs: false,
    },
    sessionOptions,
  };
}

/**
 * Run one or more prompts and stream the resulting SDK messages.
 *
 * An explicit agentId creates a new conversation on that persistent agent.
 * Without an agentId, query() creates a hidden non-MemFS agent and runs its
 * conversation in stateless mode.
 */
export function createQuery(
  client: QueryClient,
  params: LettaAgentClientQueryParams,
): Query {
  return (async function* runQuery(): AsyncGenerator<SDKMessage, void, unknown> {
    let session: LettaCodeSession | null = null;

    try {
      let agentId = params.agentId;
      let sessionOptions = params.options ?? {};

      if (agentId === undefined) {
        const anonymous = anonymousQueryOptions(sessionOptions);
        agentId = await client.createAgent(anonymous.agentOptions);
        sessionOptions = anonymous.sessionOptions;
      }

      session = client.createSession(agentId, sessionOptions);
      for await (const prompt of prompts(params.prompt)) {
        await session.send(prompt);
        yield* session.stream();
      }
    } finally {
      session?.close();
    }
  })();
}
