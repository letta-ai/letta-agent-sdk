import {
  createAppServerClient,
  type AppServerClient,
  type AppServerExternalToolCallHandler,
  type AppServerSocketConstructor,
} from "@letta-ai/letta-code/app-server-client";
import {
  buildCreateAgentRequestForPersonality,
  buildSystemPrompt,
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
} from "@letta-ai/letta-code/agent-presets";
import { releaseAppServerManagementConnections } from "./app-server-management.js";
import {
  buildCanUseToolContext,
  isHeadlessAutoAllowTool,
  requiresRuntimeUserInput,
} from "./interactiveToolPolicy.js";
import { applyUniqueRequestIds } from "./request-ids.js";
import {
  RemoteClientSessionCore,
  ensureSuccess,
  isUnrestrictedPermissionMode,
  mapPermissionMode,
  normalizeSendMessage,
  type ProtocolMessage,
  type RemoteClientRuntimeController,
  type RuntimeSendTurnOptions,
  type RuntimeScope,
  type RuntimeSessionInit,
  type RuntimeSessionMode,
} from "./remote-client-session-core.js";
import type {
  AnyAgentTool,
  CanUseToolContext,
  CanUseToolResponse,
  CreateAgentOptions,
  LettaCodeRemoteClientOptions,
  LettaCodeClientSessionOptions,
  ListModelsResult,
  ListMessagesOptions,
  ListMessagesResult,
  MessageContentItem,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  SendMessage,
  UpdateModelResult,
} from "./types.js";

type RuntimeStartResponse = ProtocolMessage & {
  type: "runtime_start_response";
  success: boolean;
  runtime: RuntimeScope | null;
  agent: (Record<string, unknown> & {
    id?: string;
    model?: string | null;
    model_settings?: Record<string, unknown> | null;
  }) | null;
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
  next_before?: string | null;
  nextBefore?: string | null;
  has_more?: boolean;
  hasMore?: boolean;
  error?: string;
};

type ListModelsResponse = ProtocolMessage & {
  type: "list_models_response";
  success: boolean;
  entries?: unknown;
  available_handles?: unknown;
  byok_provider_aliases?: unknown;
  error?: string;
};

type UpdateModelResponse = ProtocolMessage & {
  type: "update_model_response";
  success: boolean;
  applied_to?: unknown;
  model_id?: unknown;
  model_handle?: unknown;
  model_settings?: unknown;
  error?: string;
};

type UpdateModelPayload = {
  model_id?: string;
  model_handle?: string;
};

type RuntimeStartCommand = Parameters<AppServerClient["runtimeStart"]>[0];

export function agentToolNames(
  agent: Record<string, unknown> | null | undefined,
): string[] | undefined {
  const tools = agent?.tools;
  if (!Array.isArray(tools)) return undefined;
  return tools.flatMap((tool) => {
    if (typeof tool === "string" && tool.length > 0) return [tool];
    if (!tool || typeof tool !== "object") return [];
    const name = (tool as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? [name] : [];
  });
}

export type AppServerSessionOptions = Partial<LettaCodeRemoteClientOptions> & {
  /** Base websocket URL. */
  url?: string;
  /**
   * Internal lazy connection hook. The Node entry point uses this to start a
   * local app-server without pulling process-management code into `/client`.
   */
  connect?: (
    sessionEnv?: Record<string, string>,
  ) => Promise<{ url: string; close(): void }>;
  /**
   * Internal handoff hook used to release a management connection owned by
   * the same SDK client before this session opens its control socket.
   */
  beforeConnect?: () => Promise<void>;
  /** Whether SDK create-agent payloads should add the origin tag automatically. */
  includeSdkOriginTag?: boolean;
};

export type AppServerSessionMode = RuntimeSessionMode;

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

function assertRemoteCreateAgentOptionsSupported(options: CreateAgentOptions): void {
  if (options.allowedTools !== undefined || options.disallowedTools !== undefined) {
    throw new Error("App-server createAgent() does not yet support allowedTools/disallowedTools.");
  }
  if (options.canUseTool !== undefined) {
    throw new Error("App-server createAgent() does not yet support canUseTool callbacks.");
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error("App-server createAgent() does not yet support systemInfoReminder overrides.");
  }
  if (options.dreaming?.behavior !== undefined) {
    throw new Error("App-server createAgent() does not yet support dreaming.behavior overrides.");
  }
}

function normalizeMemoryBlock(block: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...block };
  if (normalized.value === undefined && typeof normalized.content === "string") {
    normalized.value = normalized.content;
  }
  return normalized;
}

function upsertMemoryBlock(
  blocks: Array<Record<string, unknown>>,
  block: Record<string, unknown>,
): void {
  const label = block.label;
  if (typeof label === "string") {
    const existingIndex = blocks.findIndex((candidate) => candidate.label === label);
    if (existingIndex >= 0) {
      blocks[existingIndex] = block;
      return;
    }
  }
  blocks.push(block);
}

export async function createAgentBody(
  options: CreateAgentOptions,
  settings: { includeSdkOriginTag?: boolean } = {},
): Promise<Record<string, unknown>> {
  assertRemoteCreateAgentOptionsSupported(options);

  const includeOriginTag = settings.includeSdkOriginTag ?? true;
  const body: Record<string, unknown> = {
    ...(await buildCreateAgentRequestForPersonality({
      personalityId: options.personality ?? "memo",
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.description !== undefined
        ? { description: options.description }
        : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.tags !== undefined ? { extraTags: options.tags } : {}),
    })),
  };

  if (Array.isArray(body.tags)) {
    body.tags = body.tags.filter(
      (tag) =>
        (includeOriginTag || tag !== LETTA_CODE_ORIGIN_TAG) &&
        (options.memfs !== false || tag !== GIT_MEMORY_ENABLED_TAG),
    );
  }

  if (options.embedding !== undefined) body.embedding = options.embedding;
  if (options.hidden !== undefined) body.hidden = options.hidden;
  // When baseTools is omitted, the harness applies its created-agent
  // defaults (web_search, fetch_webpage). An explicit list is pinned exactly:
  // `tools` alone does not suppress the Letta agent type's defaults, so both
  // default tool attachment and its default tool rules are disabled here.
  if (options.baseTools === undefined) {
    delete body.tools;
    delete body.include_base_tools;
    delete body.include_base_tool_rules;
  } else {
    body.tools = options.baseTools;
    body.include_base_tools = false;
    body.include_base_tool_rules = false;
  }

  if (options.systemPrompt === undefined) {
    if (options.memfs === false) {
      body.system = buildSystemPrompt("default", "standard");
    }
  } else {
    if (typeof options.systemPrompt === "string") {
      if (isPresetSystemPrompt(options.systemPrompt)) {
        throw new Error("createAgent() does not yet support system prompt presets for this backend.");
      }
      body.system = options.systemPrompt;
    } else {
      throw new Error("createAgent() does not yet support system prompt preset objects for this backend.");
    }
  }

  const memoryBlocks = Array.isArray(body.memory_blocks)
    ? body.memory_blocks
        .filter(
          (block): block is Record<string, unknown> =>
            block !== null && typeof block === "object",
        )
        .map((block) => ({ ...block }))
    : [];
  const blockIds: string[] = [];
  for (const item of options.memory ?? []) {
    if (typeof item === "string") {
      throw new Error("App-server createAgent() does not yet support memory preset names.");
    }
    if ("blockId" in item) {
      blockIds.push(item.blockId);
    } else {
      upsertMemoryBlock(
        memoryBlocks,
        normalizeMemoryBlock(item as unknown as Record<string, unknown>),
      );
    }
  }
  if (options.persona !== undefined) {
    upsertMemoryBlock(memoryBlocks, {
      label: "persona",
      value: options.persona,
    });
  }
  if (options.human !== undefined) {
    upsertMemoryBlock(memoryBlocks, { label: "human", value: options.human });
  }
  body.memory_blocks = memoryBlocks;
  if (blockIds.length > 0) body.block_ids = blockIds;

  return body;
}

export function externalToolGroups(tools: AnyAgentTool[] | undefined): Array<Record<string, unknown>> | undefined {
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

export function createExternalToolCallHandler(
  externalTools: Map<string, AnyAgentTool>,
): AppServerExternalToolCallHandler {
  return async (request) => {
    const tool = externalTools.get(request.tool_name);
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

type AppServerApprovalOptions = LettaCodeClientSessionOptions | CreateAgentOptions;

type AppServerApprovalResponseDecision =
  | {
      behavior: "allow";
      message?: string;
      updated_input?: Record<string, unknown> | null;
      selected_permission_suggestion_ids?: string[];
    }
  | {
      behavior: "deny";
      message: string;
    };

export async function resolveAppServerToolApproval(
  options: AppServerApprovalOptions,
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: CanUseToolContext,
): Promise<CanUseToolResponse> {
  const hasCallback = typeof options.canUseTool === "function";
  const toolNeedsRuntimeUserInput = requiresRuntimeUserInput(toolName);

  if (toolNeedsRuntimeUserInput && !hasCallback) {
    return {
      behavior: "deny",
      message: "No canUseTool callback registered",
      interrupt: false,
    };
  }

  if (isUnrestrictedPermissionMode(options.permissionMode) && !toolNeedsRuntimeUserInput) {
    return { behavior: "allow", updatedInput: null, updatedPermissions: [] };
  }

  if (hasCallback) {
    try {
      const result = await options.canUseTool!(toolName, toolInput, context);
      if (result.behavior === "allow") {
        return {
          behavior: "allow",
          message: result.message,
          updatedInput: result.updatedInput ?? null,
          updatedPermissions: result.updatedPermissions ?? [],
        };
      }
      return {
        behavior: "deny",
        message: result.message ?? "Denied by canUseTool callback",
        interrupt: result.interrupt ?? false,
      };
    } catch (error) {
      return {
        behavior: "deny",
        message: error instanceof Error ? error.message : "Callback error",
        interrupt: false,
      };
    }
  }

  if (isHeadlessAutoAllowTool(toolName)) {
    return { behavior: "allow", updatedInput: null, updatedPermissions: [] };
  }

  return {
    behavior: "deny",
    message: "No canUseTool callback registered",
    interrupt: false,
  };
}

function permissionSuggestionId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  if (typeof record.suggestion_id === "string") return record.suggestion_id;
  if (typeof record.permission_suggestion_id === "string") return record.permission_suggestion_id;
  return null;
}

export function toAppServerApprovalDecision(
  decision: CanUseToolResponse,
): AppServerApprovalResponseDecision {
  if (decision.behavior === "deny") {
    return {
      behavior: "deny",
      message: decision.message,
    };
  }

  const selectedPermissionSuggestionIds = (decision.updatedPermissions ?? [])
    .map(permissionSuggestionId)
    .filter((id): id is string => id !== null);

  return {
    behavior: "allow",
    ...(decision.message !== undefined ? { message: decision.message } : {}),
    updated_input: decision.updatedInput ?? null,
    selected_permission_suggestion_ids: selectedPermissionSuggestionIds,
  };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return { ...(value as Record<string, unknown>) };
}

function normalizeListModelsResponse(response: ListModelsResponse): ListModelsResult {
  if (!response.success) {
    throw new Error(response.error ?? "listModels failed");
  }

  const entries = Array.isArray(response.entries)
    ? response.entries.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        if (
          typeof record.id !== "string" ||
          typeof record.handle !== "string" ||
          typeof record.label !== "string" ||
          typeof record.description !== "string"
        ) {
          return [];
        }
        const updateArgs = objectRecord(record.updateArgs);
        return [
          {
            id: record.id,
            handle: record.handle,
            label: record.label,
            description: record.description,
            ...(typeof record.isDefault === "boolean" ? { isDefault: record.isDefault } : {}),
            ...(typeof record.isFeatured === "boolean" ? { isFeatured: record.isFeatured } : {}),
            ...(typeof record.free === "boolean" ? { free: record.free } : {}),
            ...(updateArgs ? { updateArgs } : {}),
          },
        ];
      })
    : [];

  const result: ListModelsResult = { entries };
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

function normalizeUpdateModelResponse(response: UpdateModelResponse): UpdateModelResult {
  if (!response.success) {
    throw new Error(response.error ?? "Failed to update model");
  }
  const result: UpdateModelResult = {};
  if (response.applied_to === "agent" || response.applied_to === "conversation") {
    result.appliedTo = response.applied_to;
  }
  if (typeof response.model_id === "string") result.modelId = response.model_id;
  if (typeof response.model_handle === "string") result.modelHandle = response.model_handle;
  if (response.model_settings === null) {
    result.modelSettings = null;
  } else if (response.model_settings && typeof response.model_settings === "object") {
    result.modelSettings = { ...(response.model_settings as Record<string, unknown>) };
  }
  return result;
}

function runtimeScopeFromMessage(message: ProtocolMessage): RuntimeScope | null {
  if (message.runtime) return message.runtime;
  const agentId = typeof message.agent_id === "string" ? message.agent_id : null;
  const conversationId = typeof message.conversation_id === "string" ? message.conversation_id : null;
  if (agentId && conversationId) {
    return { agent_id: agentId, conversation_id: conversationId };
  }
  return null;
}

export function registerAppServerControlRequestHandler(config: {
  client: AppServerClient;
  getRuntime: () => RuntimeScope | null;
  getOptions: () => AppServerApprovalOptions;
}): () => void {
  return config.client.onMessage((rawMessage, channel) => {
    const message = rawMessage as unknown as ProtocolMessage;
    if (channel !== "control" || message.type !== "control_request") return;
    void respondToAppServerControlRequest(config, message).catch(() => {
      // Permission callback failures are converted into deny responses by resolveAppServerToolApproval().
    });
  });
}

async function respondToAppServerControlRequest(
  config: {
    client: AppServerClient;
    getRuntime: () => RuntimeScope | null;
    getOptions: () => AppServerApprovalOptions;
  },
  message: ProtocolMessage,
): Promise<void> {
  const runtime = runtimeScopeFromMessage(message) ?? config.getRuntime();
  if (!runtime) return;

  const requestId = typeof message.request_id === "string" ? message.request_id : undefined;
  const request = message.request;
  if (!requestId || !request || typeof request !== "object") return;
  const requestRecord = request as Record<string, unknown>;
  if (requestRecord.subtype !== "can_use_tool") return;

  const toolName = typeof requestRecord.tool_name === "string" ? requestRecord.tool_name : "unknown";
  const toolInput =
    requestRecord.input && typeof requestRecord.input === "object" && !Array.isArray(requestRecord.input)
      ? (requestRecord.input as Record<string, unknown>)
      : {};
  const decision = await resolveAppServerToolApproval(
    config.getOptions(),
    toolName,
    toolInput,
    buildCanUseToolContext(requestRecord, requestId),
  );
  config.client.input({
    runtime,
    payload: {
      kind: "approval_response",
      request_id: requestId,
      decision: toAppServerApprovalDecision(decision),
    },
  } as Parameters<AppServerClient["input"]>[0]);
}

export class AppServerRuntimeController implements RemoteClientRuntimeController {
  constructor(
    private readonly client: AppServerClient,
    private readonly options: AppServerSessionOptions,
    private readonly clientToolAllowlist?: readonly string[],
  ) {}

  onMessage(handler: (message: ProtocolMessage, channel?: string) => void): () => void {
    return this.client.onMessage((message, channel) => {
      handler(message as unknown as ProtocolMessage, channel);
    });
  }

  send(command: Record<string, unknown>): void {
    this.client.send(command as unknown as Parameters<AppServerClient["send"]>[0]);
  }

  sendTurnMessage(
    runtime: RuntimeScope,
    message: SendMessage,
    options: RuntimeSendTurnOptions,
  ): void {
    const payload: Record<string, unknown> = {
      kind: "create_message",
      messages: [
        {
          role: "user",
          content: normalizeSendMessage(message),
          client_message_id: options.clientMessageId,
        },
      ],
    };
    if (this.clientToolAllowlist !== undefined) {
      payload.client_tool_allowlist = [...new Set(this.clientToolAllowlist)];
    }
    // SDK sessions are headless: interactive user-input tools are always
    // excluded from the toolset (harnesses without support ignore the flag
    // and the SDK's runtime denial still applies).
    payload.exclude_interactive_tools = true;
    this.client.input({
      runtime,
      payload,
    } as Parameters<AppServerClient["input"]>[0]);
  }

  async abort(runtime: RuntimeScope): Promise<void> {
    await this.client.abort({ runtime } as Parameters<AppServerClient["abort"]>[0]);
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

  async listModels(): Promise<ListModelsResult> {
    const response = (await this.request(
      "list_models",
      {},
      { predicate: (message) => message.type === "list_models_response" },
    )) as ListModelsResponse;
    return normalizeListModelsResponse(response);
  }

  async updateModel(
    runtime: RuntimeScope,
    payload: UpdateModelPayload,
  ): Promise<UpdateModelResult> {
    const response = (await this.request(
      "update_model",
      {
        runtime,
        payload,
      },
      { predicate: (message) => message.type === "update_model_response" },
    )) as UpdateModelResponse;
    return normalizeUpdateModelResponse(response);
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

    return { recovered: true, unsupported: false };
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

    const result: ListMessagesResult = {
      messages: response.messages ?? [],
    };
    const nextBefore =
      typeof response.nextBefore === "string" || response.nextBefore === null
        ? response.nextBefore
        : typeof response.next_before === "string" || response.next_before === null
          ? response.next_before
          : undefined;
    if (nextBefore !== undefined) result.nextBefore = nextBefore;
    const hasMore =
      typeof response.hasMore === "boolean"
        ? response.hasMore
        : typeof response.has_more === "boolean"
          ? response.has_more
          : undefined;
    if (hasMore !== undefined) result.hasMore = hasMore;
    return result;
  }

  close(): void {
    this.client.close();
  }
}

export class AppServerSession extends RemoteClientSessionCore {
  private ownedConnection: { close(): void } | null = null;
  private externalTools = new Map<string, AnyAgentTool>();
  private removeExternalToolHandler: (() => void) | null = null;
  private removeControlRequestHandler: (() => void) | null = null;

  constructor(
    private readonly remoteOptions: AppServerSessionOptions,
    mode: AppServerSessionMode,
  ) {
    super(mode, {
      label: "app-server",
      requestTimeoutMs: remoteOptions.requestTimeoutMs,
    });
    const tools = mode.options.tools;
    for (const tool of tools ?? []) {
      this.externalTools.set(tool.name, tool);
    }
  }

  protected override shouldEnableMemfs(options: LettaCodeClientSessionOptions | CreateAgentOptions): boolean {
    if (this.mode.kind !== "create-agent") return false;
    return (options as CreateAgentOptions).memfs !== false;
  }

  protected override async initializeRuntimeController(): Promise<RuntimeSessionInit> {
    await this.remoteOptions.beforeConnect?.();
    const url = await this.resolveAppServerUrl();
    await releaseAppServerManagementConnections(url);
    const client = applyUniqueRequestIds(createAppServerClient({
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
    }));

    this.removeControlRequestHandler = registerAppServerControlRequestHandler({
      client,
      getRuntime: () => this.runtime,
      getOptions: () => this.currentOptions(),
    });

    if (this.externalTools.size > 0) {
      this.removeExternalToolHandler = client.onExternalToolCall(
        createExternalToolCallHandler(this.externalTools),
      );
    }

    try {
      await client.connect();
      const response = await this.startRuntime(client);
      if (!response.success || !response.runtime) {
        throw new Error(response.error ?? "Failed to start app-server runtime");
      }

      const tools = agentToolNames(response.agent);
      const skillSources = this.currentOptions().skillSources;
      return {
        controller: new AppServerRuntimeController(
          client,
          this.remoteOptions,
          this.currentOptions().allowedTools,
        ),
        runtime: response.runtime,
        model: typeof response.agent?.model === "string" ? response.agent.model : "",
        modelSettings: response.agent?.model_settings ?? null,
        ...(tools !== undefined ? { tools } : {}),
        ...(skillSources !== undefined ? { skillSources: [...skillSources] } : {}),
      };
    } catch (error) {
      this.removeExternalToolHandler?.();
      this.removeExternalToolHandler = null;
      this.removeControlRequestHandler?.();
      this.removeControlRequestHandler = null;
      client.close();
      throw error;
    }
  }

  protected override onCoreClose(): void {
    this.removeExternalToolHandler?.();
    this.removeExternalToolHandler = null;
    this.removeControlRequestHandler?.();
    this.removeControlRequestHandler = null;
    this.ownedConnection?.close();
    this.ownedConnection = null;
  }

  private async resolveAppServerUrl(): Promise<string> {
    if (this.remoteOptions.url) {
      return this.remoteOptions.url;
    }
    if (!this.remoteOptions.connect) {
      throw new Error("App-server session requires a url.");
    }
    const sessionEnv = (
      this.mode.options as { env?: Record<string, string> }
    ).env;
    const connection = await this.remoteOptions.connect(sessionEnv);
    this.ownedConnection = connection;
    return connection.url;
  }

  private async startRuntime(client: AppServerClient): Promise<RuntimeStartResponse> {
    const command = await this.buildRuntimeStartCommand(client);
    const response = (await client.runtimeStart(command)) as unknown as RuntimeStartResponse;
    return response;
  }

  private async buildRuntimeStartCommand(client: AppServerClient): Promise<RuntimeStartCommand> {
    const options = this.mode.options;
    const command: Record<string, unknown> = {
      client_info: {
        name: "@letta-ai/letta-agent-sdk",
        title: "Letta Agent SDK",
      },
      recover_approvals: false,
      force_device_status: true,
    };

    const mode = mapPermissionMode(options.permissionMode);
    if (mode) command.mode = mode;
    if (options.cwd !== undefined) command.cwd = options.cwd;
    // Keep the distinction between omitted (use harness defaults) and []
    // (disable bundled/global/agent/project skills). The app-server runtime is
    // session-scoped, so this must be sent on creation and every resume.
    if (options.skillSources !== undefined) {
      command.skill_sources = [...new Set(options.skillSources)];
    }
    const groups = externalToolGroups(options.tools);
    if (groups) command.external_tools = groups;

    if (this.mode.kind === "create-agent") {
      command.create_agent = {
        body: await createAgentBody(this.mode.options, {
          includeSdkOriginTag: this.remoteOptions.includeSdkOriginTag,
        }),
        // Hidden (worker-style) agents default to unpinned.
        pin_global:
          this.remoteOptions.pinGlobalAgent ??
          (this.mode.options as CreateAgentOptions).hidden !== true,
        // Signal memfs-less (worker-style) creation to the harness so it
        // skips the memfs tag/settings/clone entirely; older harnesses
        // ignore the field, and the client-side enable_memfs skip still
        // applies either way.
        ...((this.mode.options as CreateAgentOptions).memfs === false
          ? { memfs: false }
          : {}),
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

}
