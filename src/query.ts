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

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function isPromptStream(prompt: QueryPrompt): prompt is AsyncIterable<SendMessage> {
  return (
    typeof prompt !== "string" &&
    prompt !== null &&
    typeof (prompt as AsyncIterable<SendMessage>)[Symbol.asyncIterator] ===
      "function"
  );
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

async function* streamPromptInput(
  session: LettaCodeSession,
  prompt: AsyncIterable<SendMessage>,
  isClosed: () => boolean,
): AsyncGenerator<SDKMessage, void, unknown> {
  const iterator = prompt[Symbol.asyncIterator]();
  let inputDone = false;
  let inputError: unknown;
  let sentTurns = 0;
  let completedTurns = 0;
  let changed = deferred();

  const signalChange = () => {
    changed.resolve();
    changed = deferred();
  };

  const inputPump = (async () => {
    try {
      while (!isClosed()) {
        const next = await iterator.next();
        if (next.done || isClosed()) break;
        await session.send(next.value);
        sentTurns += 1;
        signalChange();
      }
    } catch (error) {
      inputError = error;
    } finally {
      inputDone = true;
      signalChange();
    }
  })();

  try {
    while (!isClosed()) {
      if (completedTurns < sentTurns) {
        for await (const message of session.stream()) {
          yield message;
          if (message.type === "result") completedTurns += 1;
        }
        continue;
      }
      if (inputDone) {
        if (inputError !== undefined) throw inputError;
        break;
      }
      const nextChange = changed.promise;
      if (completedTurns >= sentTurns && !inputDone) await nextChange;
    }
    if (!isClosed()) await inputPump;
  } finally {
    void iterator.return?.().catch(() => {
      // Closing a query is best-effort cancellation for arbitrary input iterables.
    });
  }
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
  let session: LettaCodeSession | null = null;
  let closed = false;

  const iterator = (async function* runQuery(): AsyncGenerator<
    SDKMessage,
    void,
    unknown
  > {
    try {
      let agentId = params.agentId;
      let sessionOptions = params.options ?? {};

      if (agentId === undefined) {
        const anonymous = anonymousQueryOptions(sessionOptions);
        agentId = await client.createAgent(anonymous.agentOptions);
        sessionOptions = anonymous.sessionOptions;
      }

      if (closed) return;
      session = client.createSession(agentId, sessionOptions);
      if (isPromptStream(params.prompt)) {
        yield* streamPromptInput(session, params.prompt, () => closed);
      } else {
        await session.send(params.prompt);
        yield* session.stream();
      }
    } finally {
      closed = true;
      session?.close();
    }
  })();

  return Object.assign(iterator, {
    async interrupt(): Promise<void> {
      await session?.abort();
    },
    close(): void {
      if (closed) return;
      closed = true;
      session?.close();
      void iterator.return();
    },
  });
}
