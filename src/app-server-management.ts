import {
  createAppServerClient,
  type AppServerClient,
  type AppServerRequestCommandWithId,
  type AppServerSocketConstructor,
  type AppServerSocketLike,
} from "@letta-ai/letta-code/app-server-client";
import type {
  ManagementQuery,
  ManagementTransport,
} from "./management.js";
import { applyUniqueRequestIds } from "./request-ids.js";
import type {
  ConversationMessagesResult,
  LettaAgent,
  LettaConversation,
} from "./management-types.js";
import type {
  LettaCodeModelEntry,
  LettaCodeRemoteClientOptions,
  ListModelsResult,
} from "./types.js";

type OwnedConnection = { url: string; close(): void };

type ManagementResponse = {
  type: string;
  success: boolean;
  error?: string;
};

type AgentListResponse = ManagementResponse & {
  agents: LettaAgent[];
};

type AgentResponse = ManagementResponse & {
  agent: LettaAgent | null;
};

type ConversationListResponse = ManagementResponse & {
  conversations: LettaConversation[];
};

type ConversationResponse = ManagementResponse & {
  conversation: LettaConversation | null;
};

type ConversationMessagesResponse = ManagementResponse & {
  messages: Record<string, unknown>[];
};

type ListModelsResponse = ManagementResponse & {
  entries?: unknown;
  available_handles?: unknown;
  byok_provider_aliases?: unknown;
};

export type AppServerManagementOptions =
  Partial<LettaCodeRemoteClientOptions> & {
    url?: string;
    connect?: () => Promise<OwnedConnection>;
    /**
     * How long (in milliseconds) an idle control connection lingers before it
     * is released. Defaults to {@link DEFAULT_IDLE_LINGER_MS}.
     */
    idleLingerMs?: number;
  };

/**
 * How long an idle control connection lingers before it is released.
 *
 * Long enough to batch a burst of management calls (for example a screen
 * fetching a list plus a retrieve together) over one connection, short enough
 * that the app-server's single control-client slot frees up quickly for
 * sessions.
 */
const DEFAULT_IDLE_LINGER_MS = 250;

type ActiveConnection = {
  client: AppServerClient;
  ownedConnection: OwnedConnection | null;
  detachDisconnect: () => void;
  unregister: () => void;
};

type RegisteredManagementTransport = {
  releaseIdleConnection(): Promise<void>;
};

type ManagementTransportRegistration = {
  transport: RegisteredManagementTransport;
};

const registeredTransportsByUrl =
  new Map<string, Set<ManagementTransportRegistration>>();

function appServerUrlKey(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    url.hash = "";
    url.searchParams.delete("channel");
    return url.toString();
  } catch {
    return value;
  }
}

function registerManagementTransport(
  url: string,
  transport: RegisteredManagementTransport,
): () => void {
  const key = appServerUrlKey(url);
  const registration = { transport };
  const transports =
    registeredTransportsByUrl.get(key) ??
    new Set<ManagementTransportRegistration>();
  transports.add(registration);
  registeredTransportsByUrl.set(key, transports);
  return () => {
    transports.delete(registration);
    if (transports.size === 0) {
      registeredTransportsByUrl.delete(key);
    }
  };
}

/**
 * Wait for every management transport targeting this app-server to release
 * its control connection. The registry is process-wide so a session created
 * by a different `LettaAgentClient` instance can still take the server's
 * single control slot safely.
 */
export async function releaseAppServerManagementConnections(
  url: string,
): Promise<void> {
  const key = appServerUrlKey(url);
  while (true) {
    const transports = [...(registeredTransportsByUrl.get(key) ?? [])];
    if (transports.length === 0) return;
    await Promise.all(
      transports.map(({ transport }) => transport.releaseIdleConnection()),
    );
  }
}

function ensureResponse<T>(
  response: { success: boolean; error?: string },
  value: T | null | undefined,
  fallback: string,
): T {
  if (!response.success || value == null) {
    throw new Error(response.error ?? fallback);
  }
  return value;
}

function modelEntries(value: unknown): LettaCodeModelEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.handle !== "string" ||
      typeof record.label !== "string" ||
      typeof record.description !== "string"
    ) {
      return [];
    }
    return [{
      ...record,
      id: record.id,
      handle: record.handle,
      label: record.label,
      description: record.description,
    }];
  });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Management transport that speaks the app-server control protocol.
 *
 * Connection lifecycle: the Letta Code app-server currently accepts a single
 * control client at a time — while one control socket is attached, additional
 * control sockets are rejected with close code 1008
 * `"control channel already connected"` (see letta-ai/letta-code
 * `src/websocket/app-server.ts`). Sessions (`AppServerSession`) need that same
 * control slot, so a management transport that holds an idle connection
 * starves any later `resumeSession()`/`createSession()` from the same process
 * (live-reproduced in the letta-mobile reference app, SDK-FEEDBACK.md #00).
 *
 * To stay out of the way, this transport pools a single lazily-connected
 * client while requests are in flight (bursts share one connection and one
 * request-id counter, so responses correlate correctly), then releases the
 * connection shortly after it goes idle ({@link DEFAULT_IDLE_LINGER_MS}) and
 * reconnects lazily on the next request. Before a session connects, all
 * management transports registered for the same app-server URL relinquish
 * their connections; the handoff waits for in-flight work and for the control
 * socket's close event. The inverse contention — a management request issued
 * while a session holds the control slot — cannot be solved client-side and
 * still fails until the app-server allows multiple control clients.
 */
export class AppServerManagementTransport
  implements ManagementTransport
{
  private connectionPromise: Promise<ActiveConnection> | null = null;
  private releasePromise: Promise<void> | null = null;
  private closingConnections = new Set<Promise<void>>();
  private inFlightRequests = 0;
  private idleWaiters = new Set<() => void>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleLingerMs: number;

  constructor(private readonly options: AppServerManagementOptions) {
    this.idleLingerMs = options.idleLingerMs ?? DEFAULT_IDLE_LINGER_MS;
  }

  async listAgents(query: ManagementQuery): Promise<LettaAgent[]> {
    const response = await this.request<AgentListResponse>(
      "agent_list",
      { query },
      "agent_list_response",
    );
    if (!response.success) {
      throw new Error(response.error ?? "Failed to list agents.");
    }
    return response.agents;
  }

  async retrieveAgent(agentId: string): Promise<LettaAgent> {
    const response = await this.request<AgentResponse>(
      "agent_retrieve",
      { agent_id: agentId },
      "agent_retrieve_response",
    );
    return ensureResponse(
      response,
      response.agent,
      `Failed to retrieve agent ${agentId}.`,
    );
  }

  async updateAgent(
    agentId: string,
    body: Record<string, unknown>,
  ): Promise<LettaAgent> {
    const response = await this.request<AgentResponse>(
      "agent_update",
      { agent_id: agentId, body },
      "agent_update_response",
    );
    return ensureResponse(
      response,
      response.agent,
      `Failed to update agent ${agentId}.`,
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    const response = await this.request<ManagementResponse>(
      "agent_delete",
      { agent_id: agentId },
      "agent_delete_response",
    );
    if (!response.success) {
      throw new Error(response.error ?? `Failed to delete agent ${agentId}.`);
    }
  }

  async listModels(): Promise<ListModelsResult> {
    // A bare list_models command (no runtime scope) is answered on the
    // control channel, so no session or conversation is required.
    const response = await this.request<ListModelsResponse>(
      "list_models",
      {},
      "list_models_response",
    );
    if (!response.success) {
      throw new Error(response.error ?? "Failed to list models.");
    }
    const result: ListModelsResult = {
      entries: modelEntries(response.entries),
    };
    if (response.available_handles === null) {
      result.availableHandles = null;
    } else if (Array.isArray(response.available_handles)) {
      result.availableHandles = response.available_handles.filter(
        (handle): handle is string => typeof handle === "string",
      );
    }
    const aliases = stringRecord(response.byok_provider_aliases);
    if (aliases) result.byokProviderAliases = aliases;
    return result;
  }

  async listConversations(
    query: ManagementQuery,
  ): Promise<LettaConversation[]> {
    const response = await this.request<ConversationListResponse>(
      "conversation_list",
      { query },
      "conversation_list_response",
    );
    if (!response.success) {
      throw new Error(response.error ?? "Failed to list conversations.");
    }
    return response.conversations;
  }

  async retrieveConversation(
    conversationId: string,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationResponse>(
      "conversation_retrieve",
      { conversation_id: conversationId },
      "conversation_retrieve_response",
    );
    return ensureResponse(
      response,
      response.conversation,
      `Failed to retrieve conversation ${conversationId}.`,
    );
  }

  async createConversation(
    body: Record<string, unknown>,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationResponse>(
      "conversation_create",
      { body },
      "conversation_create_response",
    );
    return ensureResponse(
      response,
      response.conversation,
      "Failed to create conversation.",
    );
  }

  async updateConversation(
    conversationId: string,
    body: Record<string, unknown>,
  ): Promise<LettaConversation> {
    const response = await this.request<ConversationResponse>(
      "conversation_update",
      { conversation_id: conversationId, body },
      "conversation_update_response",
    );
    return ensureResponse(
      response,
      response.conversation,
      `Failed to update conversation ${conversationId}.`,
    );
  }

  async listConversationMessages(
    conversationId: string,
    query: ManagementQuery,
  ): Promise<ConversationMessagesResult> {
    const response =
      await this.request<ConversationMessagesResponse>(
        "conversation_messages_list",
        { conversation_id: conversationId, query },
        "conversation_messages_list_response",
      );
    if (!response.success) {
      throw new Error(
        response.error ??
          `Failed to list messages for conversation ${conversationId}.`,
      );
    }
    return { messages: response.messages };
  }

  /**
   * Release the pooled control connection instead of waiting out the idle
   * linger. If requests are in flight, wait for them to settle first.
   *
   * The app-server accepts a single control client (see the class docs), so
   * This is called before opening a session to hand the control slot over
   * without a linger-sized or socket-close race window.
   */
  releaseIdleConnection(): Promise<void> {
    this.clearIdleTimer();
    if (this.releasePromise) return this.releasePromise;

    const release = this.releaseConnectionWhenIdle();
    this.releasePromise = release;
    void release.then(
      () => {
        if (this.releasePromise === release) {
          this.releasePromise = null;
        }
      },
      () => {
        if (this.releasePromise === release) {
          this.releasePromise = null;
        }
      },
    );
    return release;
  }

  private async request<TResponse extends { type: string }>(
    type: string,
    body: Record<string, unknown>,
    responseType: string,
  ): Promise<TResponse> {
    if (this.releasePromise) {
      await this.releasePromise;
    }
    if (this.closingConnections.size > 0) {
      await Promise.all([...this.closingConnections]);
    }
    this.clearIdleTimer();
    this.inFlightRequests += 1;
    try {
      // Concurrent requests share the pooled connection (queueing behind the
      // same connect promise) and its request-id counter, so correlation is
      // stable across a burst and across reconnects: a fresh connection gets a
      // fresh client whose pending map starts empty.
      const { client } = await this.acquireConnection();
      const command = {
        type,
        request_id: client.nextRequestId(type),
        ...body,
      } as AppServerRequestCommandWithId;
      const response = await client.request(command, {
        predicate: (message): message is typeof message =>
          message.type === responseType,
      });
      return response as unknown as TResponse;
    } finally {
      this.inFlightRequests -= 1;
      if (this.inFlightRequests === 0) {
        const waiters = [...this.idleWaiters];
        this.idleWaiters.clear();
        for (const resolve of waiters) resolve();
        if (!this.releasePromise) {
          this.scheduleIdleRelease();
        }
      }
    }
  }

  private async releaseConnectionWhenIdle(): Promise<void> {
    if (this.inFlightRequests > 0) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve);
      });
    }

    this.clearIdleTimer();
    const promise = this.connectionPromise;
    try {
      if (promise) {
        this.connectionPromise = null;
        await this.trackClosingConnection(await promise);
      }
      if (this.closingConnections.size > 0) {
        await Promise.all([...this.closingConnections]);
      }
    } catch {
      // A failed connect already closes its partially-created resources.
    }
  }

  private acquireConnection(): Promise<ActiveConnection> {
    if (this.connectionPromise) return this.connectionPromise;
    const promise: Promise<ActiveConnection> = this.openConnection().then(
      (connection) => {
        // Unexpected disconnects (explicit closes do not notify) drop the
        // pooled connection so the next request reconnects lazily.
        connection.detachDisconnect = connection.client.onDisconnect(() => {
          this.discardConnection(promise, connection);
        });
        return connection;
      },
      (error) => {
        if (this.connectionPromise === promise) {
          this.connectionPromise = null;
        }
        throw error;
      },
    );
    this.connectionPromise = promise;
    return promise;
  }

  private async openConnection(): Promise<ActiveConnection> {
    const ownedConnection = this.options.url
      ? null
      : ((await this.options.connect?.()) ?? null);
    const url = this.options.url ?? ownedConnection?.url;
    if (!url) {
      throw new Error("App-server management requires a url or connect hook.");
    }
    const unregister = registerManagementTransport(url, this);

    let client: AppServerClient | null = null;
    try {
      client = applyUniqueRequestIds(createAppServerClient({
        url,
        ...(this.options.authToken !== undefined
          ? { authToken: this.options.authToken }
          : {}),
        ...(this.options.WebSocket
          ? {
              WebSocket:
                this.options.WebSocket as AppServerSocketConstructor,
            }
          : {}),
        ...(this.options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: this.options.requestTimeoutMs }
          : {}),
      }));
      await client.connect();
    } catch (error) {
      try {
        if (client) {
          const controlClosed = waitForSocketClose(client.control);
          client.close();
          ownedConnection?.close();
          await controlClosed;
        } else {
          ownedConnection?.close();
        }
      } catch {
        // Preserve the original connect error after best-effort cleanup.
      } finally {
        unregister();
      }
      throw error;
    }
    return {
      client,
      ownedConnection,
      detachDisconnect: () => {},
      unregister,
    };
  }

  private discardConnection(
    promise: Promise<ActiveConnection>,
    connection: ActiveConnection,
  ): void {
    if (this.connectionPromise === promise) {
      this.connectionPromise = null;
      this.clearIdleTimer();
    }
    void this.trackClosingConnection(connection);
  }

  private trackClosingConnection(
    connection: ActiveConnection,
  ): Promise<void> {
    const closing = closeConnection(connection);
    this.closingConnections.add(closing);
    void closing.then(
      () => this.closingConnections.delete(closing),
      () => this.closingConnections.delete(closing),
    );
    return closing;
  }

  private scheduleIdleRelease(): void {
    if (!this.connectionPromise) return;
    this.clearIdleTimer();
    const timer = setTimeout(() => {
      this.idleTimer = null;
      this.releaseIdleConnection();
    }, this.idleLingerMs);
    this.idleTimer = timer;
    // Do not keep a Node event loop alive just for the linger.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

async function closeConnection(connection: ActiveConnection): Promise<void> {
  connection.detachDisconnect();
  const controlClosed = waitForSocketClose(connection.client.control);
  try {
    connection.client.close();
    connection.ownedConnection?.close();
    await controlClosed;
  } finally {
    connection.unregister();
  }
}

function waitForSocketClose(socket: AppServerSocketLike): Promise<void> {
  if (socket.readyState === 3) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let detach = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      detach();
      resolve();
    };

    if (socket.addEventListener) {
      socket.addEventListener("close", finish);
      detach = () => socket.removeEventListener?.("close", finish);
    } else if (socket.once) {
      socket.once("close", finish);
      detach = () => socket.off?.("close", finish);
    } else if (socket.on) {
      socket.on("close", finish);
      detach = () => socket.off?.("close", finish);
    } else {
      resolve();
      return;
    }

    const timeout = setTimeout(finish, 1_000);
    (timeout as unknown as { unref?: () => void }).unref?.();
    if (socket.readyState === 3) finish();
  });
}
