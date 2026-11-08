import {
  createAppServerClient,
  type AppServerClient,
  type AppServerSocketConstructor,
} from "@letta-ai/letta-code/app-server-client";
import type { ConversationRetrieveResponseMessage } from "@letta-ai/letta-code/app-server-protocol";
import {
  createExternalToolCallHandler,
  externalToolGroups,
  type AppServerSessionOptions,
} from "./app-server-session.js";
import { applyUniqueRequestIds } from "./request-ids.js";
import {
  runtimeToolPolicy,
  supportsRuntimeToolPolicy,
} from "./runtime-tool-policy.js";
import type { RuntimeScope } from "./remote-session-protocol.js";
import type { AnyAgentTool, ClientToolsetConfig } from "./types.js";

/** Options for `client.registerTools()`. */
export interface RegisterToolsOptions {
  /**
   * Conversations that can call these tools. Pass a `conv-xxx` ID for a
   * specific conversation or an `agent-xxx` ID for the agent's default
   * conversation, as with `resumeSession()`.
   */
  conversations: string[];
  /** Client tools, executed in this process like a session's `tools`. */
  tools: AnyAgentTool[];
  /**
   * Tools every turn in these conversations may use, including turns the
   * runtime starts itself (task notifications, cron prompts). Same meaning as
   * the session option.
   */
  allowedTools?: string[];
  /** Base toolset and bundled client tools, as on a session. */
  toolset?: ClientToolsetConfig;
}

/** A live registration returned by `client.registerTools()`. */
export interface ToolRegistration extends AsyncDisposable {
  readonly conversations: readonly string[];
  /** Replace any of the registered options. Omitted fields are kept. */
  update(options: Partial<RegisterToolsOptions>): Promise<void>;
  /** Remove these tools from their conversations. */
  close(): Promise<void>;
}

type Entry = {
  options: RegisterToolsOptions;
  runtimes: RuntimeScope[];
  call: ReturnType<typeof createExternalToolCallHandler>;
};
type Connection = { client: AppServerClient; owned: { close(): void } | null; toolPolicy: boolean };

const RECONNECT_DELAYS_MS = [250, 1_000, 5_000, 15_000];
const runtimeKey = (runtime: { agent_id: string | null; conversation_id: string }) =>
  `${runtime.agent_id}:${runtime.conversation_id}`;

/**
 * Owns one long-lived app-server connection that registers client tools for
 * many conversations. Tool calls are dispatched by the calling conversation,
 * and every registration is published again after a reconnect.
 */
export class ToolRegistry {
  private connection: Promise<Connection> | null = null;
  private readonly entries = new Set<Entry>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: AppServerSessionOptions) {}

  async register(options: RegisterToolsOptions): Promise<ToolRegistration> {
    if (this.closed) throw new Error("LettaAgentClient is closed");
    const entry: Entry = { options, runtimes: [], call: createExternalToolCallHandler(new Map()) };
    await this.apply(entry, options);
    const registry = this;
    return {
      get conversations() {
        return [...entry.options.conversations];
      },
      update: (next) => registry.apply(entry, { ...entry.options, ...next }),
      close: () => registry.remove(entry),
      [Symbol.asyncDispose]: () => registry.remove(entry),
    };
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
    this.disconnect();
  }

  private async apply(entry: Entry, options: RegisterToolsOptions): Promise<void> {
    if (!Array.isArray(options.conversations) || options.conversations.length === 0) {
      throw new Error("registerTools() requires at least one conversation.");
    }
    if (!Array.isArray(options.tools)) throw new Error("registerTools() requires a tools array.");
    const connection = await this.connect();
    if (!connection.toolPolicy && (options.allowedTools || options.toolset)) {
      throw new Error(
        "registerTools() allowedTools and toolset require a Letta Code app server that supports runtime tool policies. Upgrade @letta-ai/letta-code.",
      );
    }
    const runtimes = await Promise.all(
      options.conversations.map((id) => resolveRuntime(connection.client, id)),
    );
    const taken = new Set(
      [...this.entries].filter((other) => other !== entry)
        .flatMap((other) => other.runtimes.map(runtimeKey)),
    );
    const overlap = options.conversations.find((_, index) => taken.has(runtimeKey(runtimes[index]!)));
    if (overlap) throw new Error(`Tools are already registered for ${overlap}.`);

    const keys = new Set(runtimes.map(runtimeKey));
    const dropped = entry.runtimes.filter((runtime) => !keys.has(runtimeKey(runtime)));
    await publish(connection.client, [
      group(runtimes, options),
      ...(dropped.length > 0 ? [{ runtimes: dropped, external_tools: [] }] : []),
    ]);
    entry.options = options;
    entry.runtimes = runtimes;
    entry.call = createExternalToolCallHandler(new Map(options.tools.map((tool) => [tool.name, tool])));
    this.entries.add(entry);
  }

  private async remove(entry: Entry): Promise<void> {
    if (!this.entries.delete(entry)) return;
    if (this.entries.size === 0) {
      // Closing the connection removes everything it registered.
      this.disconnect();
      return;
    }
    const connection = await this.connect();
    await publish(connection.client, [{ runtimes: entry.runtimes, external_tools: [] }]);
  }

  private connect(): Promise<Connection> {
    this.connection ??= this.open().catch((error: unknown) => {
      this.connection = null;
      throw error;
    });
    return this.connection;
  }

  private async open(): Promise<Connection> {
    const owned = this.options.url ? null : await this.options.connect?.();
    const url = this.options.url ?? owned?.url;
    if (!url) throw new Error("registerTools() requires an app-server url.");
    const client = applyUniqueRequestIds(createAppServerClient({
      url,
      ...(this.options.authToken !== undefined ? { authToken: this.options.authToken } : {}),
      ...(this.options.WebSocket
        ? { WebSocket: this.options.WebSocket as AppServerSocketConstructor }
        : {}),
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
    }));
    client.onExternalToolCall((request) => {
      const runtime = request.runtime;
      const entry = runtime &&
        [...this.entries].find((candidate) => candidate.runtimes.some((r) => runtimeKey(r) === runtimeKey(runtime)));
      if (!entry) throw new Error(`No tools registered for conversation ${runtime?.conversation_id}`);
      return entry.call(request);
    });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      owned?.close();
      throw error;
    }
    client.onDisconnect(() => this.onDisconnect(client));
    return { client, owned: owned ?? null, toolPolicy: await supportsRuntimeToolPolicy(client) };
  }

  private disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const connection = this.connection;
    this.connection = null;
    void connection?.then(({ client, owned }) => {
      client.close();
      owned?.close();
    }, () => undefined);
  }

  private onDisconnect(client: AppServerClient): void {
    void this.connection?.then((current) => {
      if (current.client !== client) return;
      current.owned?.close();
      this.connection = null;
      this.scheduleReconnect();
    }, () => undefined);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.entries.size === 0 || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.republish().catch(() => this.scheduleReconnect());
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private async republish(): Promise<void> {
    const connection = await this.connect();
    await publish(connection.client, [...this.entries].map((entry) => group(entry.runtimes, entry.options)));
    this.reconnectAttempt = 0;
  }
}

function group(runtimes: RuntimeScope[], options: RegisterToolsOptions) {
  return {
    runtimes,
    external_tools: externalToolGroups(options.tools) ?? [],
    tool_policy: runtimeToolPolicy(options.allowedTools, options.toolset),
  };
}

async function publish(
  client: AppServerClient,
  updates: Array<{ runtimes: RuntimeScope[]; external_tools: unknown[]; tool_policy?: unknown }>,
): Promise<void> {
  const response = await client.runtimeExternalToolsUpdate(
    { updates } as unknown as Parameters<AppServerClient["runtimeExternalToolsUpdate"]>[0],
  );
  if (!response.success) throw new Error(response.error ?? "Failed to register tools");
}

async function resolveRuntime(client: AppServerClient, id: string): Promise<RuntimeScope> {
  if (!id.startsWith("conv-") && !id.startsWith("local-conv-")) {
    return { agent_id: id, conversation_id: "default" };
  }
  const response = await client.request<ConversationRetrieveResponseMessage>(
    { type: "conversation_retrieve", request_id: client.nextRequestId("conversation_retrieve"), conversation_id: id },
    {
      predicate: (message): message is ConversationRetrieveResponseMessage =>
        message.type === "conversation_retrieve_response",
    },
  );
  if (!response.success || !response.conversation) {
    throw new Error(response.error ?? `Failed to retrieve conversation ${id}`);
  }
  return { agent_id: response.conversation.agent_id ?? null, conversation_id: id };
}
