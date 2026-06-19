import {
  createAppServerClient,
  type AppServerClient,
  type AppServerExternalToolCallHandler,
  type AppServerSocketConstructor,
} from "@letta-ai/letta-code/app-server-client";
import { startLocalAppServer, type LocalAppServerHandle } from "./local-app-server.js";
import {
  RemoteClientSessionCore,
  ensureSuccess,
  mapPermissionMode,
  normalizeSendMessage,
  type ProtocolMessage,
  type RemoteClientRuntimeController,
  type RuntimeScope,
  type RuntimeSessionInit,
  type RuntimeSessionMode,
  type RuntimeTurnResult,
} from "./remote-client-session-core.js";
import type {
  AnyAgentTool,
  CreateAgentOptions,
  LettaCodeRemoteClientOptions,
  LettaCodeClientSessionOptions,
  ListMessagesOptions,
  ListMessagesResult,
  MessageContentItem,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  SendMessage,
} from "./types.js";

type RuntimeStartResponse = ProtocolMessage & {
  type: "runtime_start_response";
  success: boolean;
  runtime: RuntimeScope | null;
  agent: (Record<string, unknown> & { id?: string; model?: string | null }) | null;
  conversation: (Record<string, unknown> & { id?: string; agent_id?: string }) | null;
  error?: string;
};

type ConversationRetrieveResponse = ProtocolMessage & {
  type: "conversation_retrieve_response";
  success: boolean;
  conversation: (Record<string, unknown> & { id?: string; agent_id?: string }) | null;
  error?: string;
};

type ConversationMessagesListResponse = ProtocolMessage & {
  type: "conversation_messages_list_response";
  success: boolean;
  messages: unknown[];
  error?: string;
};

type RuntimeStartCommand = Parameters<AppServerClient["runtimeStart"]>[0];

type InputCommand = Parameters<AppServerClient["runTurn"]>[0];

export type AppServerSessionOptions = Partial<LettaCodeRemoteClientOptions> & {
  /** Base websocket URL. Remote sessions require this; local sessions may omit
   * it to spawn an SDK-owned app-server lazily at initialize(). */
  url?: string;
  /** Spawn a local app-server when url is omitted. */
  local?: boolean;
  /** Optional local app-server listen URL. Defaults to ws://127.0.0.1:0. */
  localListen?: string;
  /** Timeout for local app-server startup. */
  localStartupTimeoutMs?: number;
  /** Extra environment variables for SDK-owned local app-server processes. */
  localEnv?: Record<string, string | undefined>;
  /**
   * Cloud status websockets fan out device frames to every subscriber rather
   * than honoring local app-server's split control/stream channels. Enable this
   * for cloud-backed sessions so assistant deltas are not double-counted.
   */
  ignoreControlStreamDeltas?: boolean;
};

export type AppServerSessionMode = RuntimeSessionMode;

const SDK_AGENT_ORIGIN_TAG = "origin:letta-code";

function isPresetSystemPrompt(value: string): boolean {
  return [
    "default",
    "letta-claude",
    "letta-codex",
    "letta-gemini",
    "claude",
    "codex",
    "gemini",
  ].includes(value);
}

function includeSdkAgentOriginTag(tags: string[] | undefined): string[] {
  const normalizedTags: string[] = [];
  let hasOriginTag = false;

  for (const tag of tags ?? []) {
    if (tag === SDK_AGENT_ORIGIN_TAG) {
      if (hasOriginTag) continue;
      hasOriginTag = true;
    }
    normalizedTags.push(tag);
  }

  if (!hasOriginTag) {
    normalizedTags.push(SDK_AGENT_ORIGIN_TAG);
  }

  return normalizedTags;
}

function assertRemoteCreateAgentOptionsSupported(options: CreateAgentOptions): void {
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error("App-server createAgent() does not yet support allowedTools/disallowedTools.");
  }
  if (options.canUseTool !== undefined) {
    throw new Error("App-server createAgent() does not yet support canUseTool callbacks.");
  }
  if (options.skillSources !== undefined) {
    throw new Error("App-server createAgent() does not yet support skillSources overrides.");
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error("App-server createAgent() does not yet support systemInfoReminder overrides.");
  }
  if (options.sleeptime?.behavior !== undefined) {
    throw new Error("App-server createAgent() does not yet support sleeptime.behavior overrides.");
  }
}

export function assertRemoteSessionOptionsSupported(
  action: string,
  options: LettaCodeClientSessionOptions,
): void {
  if (options.systemPrompt !== undefined) {
    throw new Error(`App-server ${action}() does not yet support systemPrompt overrides for existing agents.`);
  }
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error(`App-server ${action}() does not yet support allowedTools/disallowedTools.`);
  }
  if (options.canUseTool !== undefined) {
    throw new Error(`App-server ${action}() does not yet support canUseTool callbacks.`);
  }
  if (options.skillSources !== undefined) {
    throw new Error(`App-server ${action}() does not yet support skillSources overrides.`);
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error(`App-server ${action}() does not yet support systemInfoReminder overrides.`);
  }
  if (options.memfs === false) {
    throw new Error(`App-server ${action}() does not yet support disabling memfs through the SDK.`);
  }
  if (options.sleeptime?.behavior !== undefined) {
    throw new Error(`App-server ${action}() does not yet support sleeptime.behavior overrides.`);
  }
  if (options.memfsStartup !== undefined) {
    throw new Error(`App-server ${action}() does not use memfsStartup; app-server owns its startup synchronization.`);
  }
  if (options.includePartialMessages !== undefined) {
    throw new Error(`App-server ${action}() streams app-server deltas directly and does not support includePartialMessages.`);
  }
}

function normalizeMemoryBlock(block: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...block };
  if (normalized.value === undefined && typeof normalized.content === "string") {
    normalized.value = normalized.content;
  }
  return normalized;
}

export function createAgentBody(options: CreateAgentOptions): Record<string, unknown> {
  assertRemoteCreateAgentOptionsSupported(options);

  const body: Record<string, unknown> = {
    tags: includeSdkAgentOriginTag(options.tags),
  };

  if (options.model !== undefined) body.model = options.model;
  if (options.embedding !== undefined) body.embedding = options.embedding;

  if (options.systemPrompt !== undefined) {
    if (typeof options.systemPrompt === "string") {
      if (isPresetSystemPrompt(options.systemPrompt)) {
        throw new Error("App-server createAgent() does not yet support system prompt presets.");
      }
      body.system = options.systemPrompt;
    } else {
      throw new Error("App-server createAgent() does not yet support system prompt preset objects.");
    }
  }

  const memoryBlocks: Array<Record<string, unknown>> = [];
  const blockIds: string[] = [];
  for (const item of options.memory ?? []) {
    if (typeof item === "string") {
      throw new Error("App-server createAgent() does not yet support memory preset names.");
    }
    if ("blockId" in item) {
      blockIds.push(item.blockId);
    } else {
      memoryBlocks.push(normalizeMemoryBlock(item as unknown as Record<string, unknown>));
    }
  }
  if (options.persona !== undefined) {
    memoryBlocks.push({ label: "persona", value: options.persona });
  }
  if (options.human !== undefined) {
    memoryBlocks.push({ label: "human", value: options.human });
  }
  if (memoryBlocks.length > 0) body.memory_blocks = memoryBlocks;
  if (blockIds.length > 0) body.block_ids = blockIds;

  return body;
}

function externalToolGroups(tools: AnyAgentTool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      tools: tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      })),
    },
  ];
}

class AppServerRuntimeController implements RemoteClientRuntimeController {
  constructor(
    private readonly client: AppServerClient,
    private readonly options: AppServerSessionOptions,
  ) {}

  onMessage(handler: (message: ProtocolMessage, channel?: string) => void): () => void {
    return this.client.onMessage((message, channel) => {
      if (
        this.options.ignoreControlStreamDeltas === true &&
        channel === "control" &&
        message.type === "stream_delta"
      ) {
        return;
      }
      handler(message as unknown as ProtocolMessage, channel);
    });
  }

  send(command: Record<string, unknown>): void {
    this.client.send(command as unknown as Parameters<AppServerClient["send"]>[0]);
  }

  request(
    type: string,
    body: Record<string, unknown>,
    options: { timeoutMs?: number; predicate?: (message: ProtocolMessage) => boolean } = {},
  ): Promise<ProtocolMessage> {
    const request = this.client.request.bind(this.client) as unknown as (
      commandType: string,
      commandBody: Record<string, unknown>,
      requestOptions?: {
        timeoutMs?: number;
        predicate?: (message: ProtocolMessage) => boolean;
      },
    ) => Promise<ProtocolMessage>;
    return request(type, body, options);
  }

  async runTurnMessage(
    runtime: RuntimeScope,
    message: SendMessage,
    options: { timeoutMs?: number } = {},
  ): Promise<RuntimeTurnResult> {
    const command: InputCommand = {
      runtime,
      payload: {
        kind: "create_message",
        messages: [
          {
            role: "user",
            content: normalizeSendMessage(message),
          },
        ],
      },
    } as InputCommand;

    const turn = await this.client.runTurn(command, {
      allowLoopStatusFallback: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    return {
      runtime: turn.runtime,
      stopReason: turn.stopReason,
      runIds: turn.runIds,
    };
  }

  async recoverPendingApprovals(
    runtime: RuntimeScope,
    options: RecoverPendingApprovalsOptions = {},
  ): Promise<RecoverPendingApprovalsResult> {
    const response = await this.client.sync(
      {
        runtime,
        recover_approvals: true,
        force_device_status: true,
      },
      options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    );

    if (!response.success) {
      return {
        recovered: false,
        unsupported: false,
        detail: response.error ?? "Failed to recover pending approvals",
      };
    }

    return { recovered: true, pendingApproval: false, unsupported: false };
  }

  async listMessages(
    conversationId: string,
    options: ListMessagesOptions = {},
  ): Promise<ListMessagesResult> {
    const query: Record<string, unknown> = {};
    if (options.before !== undefined) query.before = options.before;
    if (options.after !== undefined) query.after = options.after;
    if (options.order !== undefined) query.order = options.order;
    if (options.limit !== undefined) query.limit = options.limit;

    const response = (await this.request(
      "conversation_messages_list",
      {
        conversation_id: conversationId,
        ...(Object.keys(query).length > 0 ? { query } : {}),
      },
      { predicate: (message) => message.type === "conversation_messages_list_response" },
    )) as ConversationMessagesListResponse;

    if (!response.success) {
      throw new Error(response.error ?? "listMessages failed");
    }

    return {
      messages: response.messages ?? [],
      nextBefore: null,
      hasMore: false,
    };
  }

  close(): void {
    this.client.close();
  }
}

export class AppServerSession extends RemoteClientSessionCore {
  private ownedAppServer: LocalAppServerHandle | null = null;
  private externalTools = new Map<string, AnyAgentTool>();
  private removeExternalToolHandler: (() => void) | null = null;

  constructor(
    private readonly remoteOptions: AppServerSessionOptions,
    mode: AppServerSessionMode,
  ) {
    super(mode, {
      label: "app-server",
      requestTimeoutMs: remoteOptions.requestTimeoutMs,
      capabilities: {
        enableMemfs: true,
        reflectionSettings: true,
        updateModel: true,
        changeDeviceState: true,
        updateToolset: true,
      },
    });
    const tools = mode.kind === "create-agent" ? mode.options.tools : mode.options.tools;
    for (const tool of tools ?? []) {
      this.externalTools.set(tool.name, tool);
    }
  }

  protected override shouldEnableMemfs(options: LettaCodeClientSessionOptions | CreateAgentOptions): boolean {
    return options.memfs === true || (this.mode.kind === "create-agent" && options.memfs !== false);
  }

  protected override async initializeRuntimeController(): Promise<RuntimeSessionInit> {
    const url = await this.resolveAppServerUrl();
    const client = createAppServerClient({
      url,
      ...(this.remoteOptions.authToken !== undefined
        ? { authToken: this.remoteOptions.authToken }
        : {}),
      ...(this.remoteOptions.WebSocket
        ? { WebSocket: this.remoteOptions.WebSocket as AppServerSocketConstructor }
        : {}),
      ...(this.remoteOptions.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.remoteOptions.requestTimeoutMs }
        : {}),
    });

    if (this.externalTools.size > 0) {
      this.removeExternalToolHandler = client.onExternalToolCall(this.handleExternalToolCall);
    }

    try {
      await client.connect();
      const response = await this.startRuntime(client);
      if (!response.success || !response.runtime) {
        throw new Error(response.error ?? "Failed to start app-server runtime");
      }

      return {
        controller: new AppServerRuntimeController(client, this.remoteOptions),
        runtime: response.runtime,
        model: typeof response.agent?.model === "string" ? response.agent.model : "",
        tools: Array.from(this.externalTools.keys()),
      };
    } catch (error) {
      this.removeExternalToolHandler?.();
      this.removeExternalToolHandler = null;
      client.close();
      throw error;
    }
  }

  protected override onCoreClose(): void {
    this.removeExternalToolHandler?.();
    this.removeExternalToolHandler = null;
    this.ownedAppServer?.close();
    this.ownedAppServer = null;
  }

  private async resolveAppServerUrl(): Promise<string> {
    if (this.remoteOptions.url) {
      return this.remoteOptions.url;
    }
    if (this.remoteOptions.local !== true) {
      throw new Error("App-server session requires a url unless local app-server spawning is enabled.");
    }
    this.ownedAppServer = await startLocalAppServer({
      listen: this.remoteOptions.localListen,
      startupTimeoutMs: this.remoteOptions.localStartupTimeoutMs,
      env: this.remoteOptions.localEnv,
    });
    return this.ownedAppServer.url;
  }

  private async startRuntime(client: AppServerClient): Promise<RuntimeStartResponse> {
    const command = await this.buildRuntimeStartCommand(client);
    const response = (await client.runtimeStart(command)) as unknown as RuntimeStartResponse;
    return response;
  }

  private async buildRuntimeStartCommand(client: AppServerClient): Promise<RuntimeStartCommand> {
    const options = this.mode.kind === "create-agent" ? this.mode.options : this.mode.options;
    const command: Record<string, unknown> = {
      client_info: {
        name: "@letta-ai/letta-code-sdk",
        title: "Letta Code SDK",
      },
      recover_approvals: false,
      force_device_status: true,
    };

    const mode = mapPermissionMode(options.permissionMode);
    if (mode) command.mode = mode;
    if (options.cwd !== undefined) command.cwd = options.cwd;
    const groups = externalToolGroups(options.tools);
    if (groups) command.external_tools = groups;

    if (this.mode.kind === "create-agent") {
      command.create_agent = {
        body: createAgentBody(this.mode.options),
        pin_global: true,
      };
      return command as RuntimeStartCommand;
    }

    if (this.mode.agentId) {
      command.agent_id = this.mode.agentId;
      if (this.mode.newConversation) {
        command.create_conversation = { body: {} };
      } else if (this.mode.defaultConversation) {
        command.conversation_id = "default";
      }
      return command as RuntimeStartCommand;
    }

    if (this.mode.conversationId) {
      const agentId = await this.resolveConversationAgentId(client, this.mode.conversationId);
      command.agent_id = agentId;
      command.conversation_id = this.mode.conversationId;
      return command as RuntimeStartCommand;
    }

    throw new Error(
      "App-server createSession() requires an agent id. Call createAgent() first or pass an agent id.",
    );
  }

  private async resolveConversationAgentId(
    client: AppServerClient,
    conversationId: string,
  ): Promise<string> {
    const request = client.request.bind(client) as unknown as (
      commandType: string,
      commandBody: Record<string, unknown>,
      options?: { predicate?: (message: ProtocolMessage) => boolean },
    ) => Promise<ProtocolMessage>;
    const response = (await request(
      "conversation_retrieve",
      { conversation_id: conversationId },
      { predicate: (message) => message.type === "conversation_retrieve_response" },
    )) as ConversationRetrieveResponse;
    if (!response.success || !response.conversation?.agent_id) {
      throw new Error(response.error ?? `Failed to retrieve conversation ${conversationId}`);
    }
    return response.conversation.agent_id;
  }

  private handleExternalToolCall: AppServerExternalToolCallHandler = async (request) => {
    const tool = this.externalTools.get(request.tool_name);
    if (!tool) {
      throw new Error(`Unknown external tool: ${request.tool_name}`);
    }
    const result = await tool.execute(request.tool_call_id, request.input);
    return {
      content: result.content.map((part) => ({
        type: part.type,
        ...(part.text !== undefined ? { text: part.text } : {}),
        ...(part.data !== undefined ? { data: part.data } : {}),
        ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
      })),
    };
  };
}
