import type { Query, QueryOptions, QueryParams } from "./query-types.js";
import type { LettaCodeSession, SDKMessage } from "./types.js";

type CreateQuerySession = (options: QueryOptions) => Promise<LettaCodeSession>;

/** Create one ordinary conversation and stream its query result. */
export function createQuery(
  createSession: CreateQuerySession,
  params: QueryParams,
): Query {
  let session: LettaCodeSession | null = null;
  let closed = false;
  let conversationId: string | null = null;
  let agentId: string | null = null;

  function closeSession(): void {
    conversationId = session?.conversationId ?? conversationId;
    agentId = session?.agentId ?? agentId;
    session?.close();
  }

  const iterator = (async function* runQuery(): AsyncGenerator<
    SDKMessage,
    void,
    unknown
  > {
    try {
      session = await createSession(params.options);
      if (closed) return;
      await session.send(params.prompt);
      yield* session.stream();
    } finally {
      closed = true;
      closeSession();
    }
  })();

  const query = Object.assign(iterator, {
    async interrupt(): Promise<void> {
      await session?.abort();
    },
    close(): void {
      if (closed) return;
      closed = true;
      closeSession();
      void iterator.return();
    },
  });
  return Object.defineProperties(query, {
    conversationId: {
      get: () => session?.conversationId ?? conversationId,
      enumerable: true,
    },
    agentId: {
      get: () => session?.agentId ?? agentId,
      enumerable: true,
    },
  }) as Query;
}
