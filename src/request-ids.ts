/**
 * Collision-free request-id generation for request/response correlation.
 *
 * AppServerClient's built-in nextRequestId() is a bare per-instance counter
 * that restarts at 1, so two client instances (for example two session
 * objects, or a session plus a management request) each emit ids like
 * `conversation_retrieve-1`. When more than one connection is involved the
 * app-server can deliver request-correlated responses where both ids look
 * identical, and the wrong caller's pending request resolves (or times out).
 *
 * Ids generated here embed a per-client random nonce plus a process-wide
 * monotonic counter, so no two clients in the same process can ever emit the
 * same id, and cross-process collisions are vanishingly unlikely.
 */

let processRequestCounter = 0;

/** Create a request-id generator scoped to one client/connection instance. */
export function createRequestIdGenerator(): (prefix?: string) => string {
  const nonce = Math.random().toString(36).slice(2, 10);
  return (prefix = "req") => `${prefix}-${nonce}-${++processRequestCounter}`;
}

/**
 * Replace a client's request-id generator with a collision-free one.
 * Returns the same client for call-site convenience.
 */
export function applyUniqueRequestIds<
  TClient extends { nextRequestId(prefix?: string): string },
>(client: TClient): TClient {
  client.nextRequestId = createRequestIdGenerator();
  return client;
}
