import type { AgentFreeQueryOptions, Query, QueryParams } from "./query-types.js";
import type { LettaCodeSession, SDKMessage } from "./types.js";

type CreateAgentFreeSession = (
  options: AgentFreeQueryOptions,
) => Promise<LettaCodeSession>;

/** Create one agent-free ephemeral conversation and stream its query result. */
export function createQuery(
  createSession: CreateAgentFreeSession,
  params: QueryParams,
): Query {
  let session: LettaCodeSession | null = null;
  let closed = false;

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
