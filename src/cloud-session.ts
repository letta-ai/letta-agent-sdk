import type Letta from "@letta-ai/letta-client";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { AgentCreateParams } from "@letta-ai/letta-client/resources/agents/agents";
import {
  createAppServerClient,
  type AppServerClient,
} from "@letta-ai/letta-code/app-server-client";
import { createAgentBody } from "./agent-creation.js";
import {
  AppServerRuntimeController,
  agentToolNames,
  createExternalToolCallHandler,
  externalToolGroups,
  registerAppServerControlRequestHandler,
} from "./app-server-session.js";
import { createCloudStatusTransportConstructor } from "./cloud-status-transport.js";
import {
  connectMcpServers,
  expandMcpToolWildcards,
  type McpToolBridge,
} from "./mcp-runtime.js";
import { CloudManagementTransport } from "./cloud-management.js";
import {
  createCloudClient,
  getCloudApiKey,
  normalizeCloudApiBaseUrl,
} from "./cloud-client.js";
import {
  RemoteEnvironmentClient,
  type RemoteEnvironmentTarget,
} from "./remote.js";
import { applyUniqueRequestIds } from "./request-ids.js";
import {
  RemoteClientSessionCore,
  mapPermissionMode,
  type ProtocolMessage,
  type RuntimeScope,
  type RuntimeSessionInit,
  type RuntimeSessionMode,
} from "./remote-client-session-core.js";
import type {
  AnyAgentTool,
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeCloudClientOptions,
  LettaCodeEnvironment,
  LettaCodeSocketConstructor,
  RepositoryResource,
} from "./types.js";
import {
  type LettaCodeCloudSandboxOptions,
  validateCloudSandboxOptions,
} from "./cloud-sandbox.js";
import {
  downloadSandboxFile,
  type SandboxFileUpload,
  type SandboxFileUploadResult,
  type SandboxFilesClient,
  uploadSandboxFiles,
} from "./sandbox-files.js";

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_SANDBOX_TTL_MINUTES = 5;
const DEFAULT_SANDBOX_READY_TIMEOUT_MS = 120_000;
const DEFAULT_SANDBOX_READY_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REPOSITORY_ATTACH_TIMEOUT_MS = 10_000;
const DEFAULT_REPOSITORY_ATTACH_POLL_INTERVAL_MS = 250;
const SDK_AGENT_ORIGIN = "@letta-ai/letta-agent-sdk";

type CloudRuntimeStartResponse = ProtocolMessage & {
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

type CloudConversation = Record<string, unknown> & {
  id?: string;
  agent_id?: string;
};

type CloudAgentSandbox = Record<string, unknown> & {
  sandboxId?: string;
  deviceId?: string;
  connectionName?: string;
  conversationId?: string;
  resumed?: boolean;
};

type CloudAgentSandboxRefresh = Record<string, unknown> & {
  success?: boolean;
  sandboxId?: string;
  ttlMinutes?: number;
};

type ManagedCloudSandbox = {
  agentId: string;
  /** Non-null when the server confirmed conversation scoping by echoing the
   * conversationId (legacy servers strip unknown body keys and answer
   * without it, so the sandbox falls back to the agent-scoped lifecycle). */
  conversationId: string | null;
  sandboxId: string;
  deviceId: string;
  connectionName: string;
  ttlMinutes: number;
  readyTimeoutMs: number;
  readyPollIntervalMs: number;
  refreshIntervalMs: number;
  terminateOnClose: boolean;
};

type ResolvedCloudConnection = {
  connectionId: string;
};

class CloudManagedSandboxOwnershipError extends Error {}

/**
 * The Cloud API reaped a conversation-scoped managed sandbox before the SDK
 * could refresh it. The failed refresh happens before the next turn is sent,
 * so callers can safely create a new SDK session for {@link conversationId}
 * and retry that turn.
 */
export class CloudManagedSandboxExpiredError extends Error {
  readonly code = "managed_sandbox_expired" as const;

  constructor(
    readonly sandboxId: string,
    readonly conversationId: string,
  ) {
    super(
      `Cloud managed sandbox ${sandboxId} expired. Resume conversation ${conversationId} with a new SDK session and retry the turn.`,
    );
    this.name = "CloudManagedSandboxExpiredError";
  }
}

type CloudSessionMode = Extract<RuntimeSessionMode, { kind: "session" }>;

function getWebSocketConstructor(
  websocketOverride?: LettaCodeSocketConstructor,
): LettaCodeSocketConstructor {
  const resolved =
    websocketOverride ??
    (globalThis as { WebSocket?: LettaCodeSocketConstructor }).WebSocket;
  if (!resolved) {
    throw new Error("No WebSocket implementation available for cloud backend.");
  }
  return resolved;
}

function cloudWebSocketHeaders(options: LettaCodeCloudClientOptions): Record<string, string> | undefined {
  const headers = { ...(options.headers ?? {}) };
  delete headers.authorization;
  delete headers.Authorization;
  const apiKey = getCloudApiKey(options);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof APIError && error.status === 404;
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`Invalid ${name}. Expected a positive integer.`);
  }
}

export function validateCloudClientOptions(options: LettaCodeCloudClientOptions): void {
  validatePositiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
  validateCloudSandboxOptions(options.sandbox, "sandbox");
  if (options.computer !== undefined && options.environment !== undefined) {
    throw new Error(
      "Letta Cloud clients cannot specify both computer and deprecated environment.",
    );
  }
  if (
    (options.computer !== undefined || options.environment !== undefined) &&
    options.sandbox !== undefined
  ) {
    const field = options.computer !== undefined ? "computer" : "environment";
    throw new Error(
      `Letta Cloud sessions cannot specify both ${field} and sandbox options.`,
    );
  }
  if (
    options.webSocketAuth !== undefined &&
    options.webSocketAuth !== "header" &&
    options.webSocketAuth !== "query"
  ) {
    throw new Error("Invalid webSocketAuth. Valid values: header, query.");
  }
}

function environmentToRemoteTarget(
  environment: LettaCodeEnvironment,
): RemoteEnvironmentTarget {
  if (typeof environment === "string") {
    return { connectionName: environment };
  }
  if ("name" in environment) {
    return { connectionName: environment.name };
  }
  if ("id" in environment) {
    return { environmentId: environment.id };
  }
  if ("connectionId" in environment) {
    return { connectionId: environment.connectionId };
  }
  if ("deviceId" in environment) {
    return { deviceId: environment.deviceId };
  }
  throw new Error("Unknown cloud environment selector.");
}

function buildCloudStatusWebSocketUrl(params: {
  apiBaseUrl?: string;
  connectionId: string;
  agentId: string;
  conversationId: string;
  apiKey?: string;
  authMode: "header" | "query";
}): string {
  const base = new URL(normalizeCloudApiBaseUrl(params.apiBaseUrl));
  if (base.protocol === "http:") {
    base.protocol = "ws:";
  } else if (base.protocol === "https:") {
    base.protocol = "wss:";
  } else if (base.protocol !== "ws:" && base.protocol !== "wss:") {
    throw new Error(`Unsupported cloud apiBaseUrl protocol: ${base.protocol}`);
  }
  base.pathname = `/v1/environments/${encodeURIComponent(params.connectionId)}/status/ws`;
  base.searchParams.set("agentId", params.agentId);
  base.searchParams.set("conversationId", params.conversationId);
  base.searchParams.set("channel", "stream");
  if (params.authMode === "query" && params.apiKey) {
    base.searchParams.set("token", params.apiKey);
  }
  return base.toString();
}

function isCloudConversation(value: unknown): value is CloudConversation & { id: string } {
  return Boolean(value && typeof value === "object" && typeof (value as CloudConversation).id === "string");
}

function isCloudAgentSandbox(
  value: unknown,
): value is CloudAgentSandbox & { sandboxId: string; deviceId: string; connectionName: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as CloudAgentSandbox).sandboxId === "string" &&
      typeof (value as CloudAgentSandbox).deviceId === "string" &&
      typeof (value as CloudAgentSandbox).connectionName === "string",
  );
}

function isCloudAgentSandboxRefresh(
  value: unknown,
): value is CloudAgentSandboxRefresh & { success: boolean; sandboxId: string; ttlMinutes: number } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as CloudAgentSandboxRefresh).success === "boolean" &&
      typeof (value as CloudAgentSandboxRefresh).sandboxId === "string" &&
      typeof (value as CloudAgentSandboxRefresh).ttlMinutes === "number",
  );
}

function isRetryableManagedSandboxResolveError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Remote environment is offline") ||
    message.toLowerCase().includes("not found") ||
    message.includes("(404)")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function externalToolsByName(tools: AnyAgentTool[] | undefined): Map<string, AnyAgentTool> {
  const result = new Map<string, AnyAgentTool>();
  for (const tool of tools ?? []) {
    result.set(tool.name, tool);
  }
  return result;
}

export async function createCloudAgent(
  client: Letta,
  agentOptions: CreateAgentOptions,
): Promise<string> {
  const body = await createAgentBody(agentOptions);
  const agent = await client.agents.create(body as AgentCreateParams);
  if (typeof agent.id !== "string" || agent.id.length === 0) {
    throw new Error("Cloud create agent response did not include an agent id.");
  }
  return agent.id;
}

export function assertCloudSessionOptionsSupported(
  action: string,
  options: LettaCodeClientSessionOptions,
): void {
  validateCloudSandboxOptions(options.sandbox, "sandbox");
  if (options.environment !== undefined && options.sandbox !== undefined) {
    throw new Error(`Letta Cloud ${action}() cannot specify both environment and sandbox options.`);
  }
}

export class CloudEnvironmentSession extends RemoteClientSessionCore {
  readonly sandbox: SandboxFilesClient | undefined;
  private connectionId: string | null = null;
  private removeExternalToolHandler: (() => void) | null = null;
  private removeControlRequestHandler: (() => void) | null = null;
  private externalTools = new Map<string, AnyAgentTool>();
  private mcpBridge: McpToolBridge | null = null;
  private mcpCleanup: Promise<void> = Promise.resolve();
  private managedSandbox: ManagedCloudSandbox | null = null;
  private sandboxRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private sandboxRefreshInFlight: Promise<void> | null = null;
  private sandboxLifecycleClosing = false;
  private attachedRepositoryIds = new Set<string>();
  private repositoryIdsRequiringCleanupRecompile = new Set<string>();
  private readonly repositoryManagement: CloudManagementTransport;
  private readonly cloudMode: CloudSessionMode;

  constructor(
    private readonly cloudOptions: LettaCodeCloudClientOptions,
    mode: CloudSessionMode,
    private readonly apiClient: Letta = createCloudClient(cloudOptions),
  ) {
    super(mode, {
      label: "cloud",
      requestTimeoutMs: cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    });
    this.cloudMode = mode;
    this.repositoryManagement = new CloudManagementTransport(apiClient);
    this.sandbox = this.effectiveEnvironment() === undefined
      ? {
          uploadFiles: (files) => this.uploadFilesToManagedSandbox(files),
          downloadFile: (path) => this.downloadFileFromManagedSandbox(path),
        }
      : undefined;
    const tools = mode.options.tools;
    this.externalTools = externalToolsByName(tools);
  }

  protected override async initializeRuntimeController(): Promise<RuntimeSessionInit> {
    await this.mcpCleanup;
    if (!this.closed) this.sandboxLifecycleClosing = false;
    const resolved = await this.resolveRuntime();
    const connection = await this.resolveConnectionForRuntime(resolved.runtime).catch(
      async (error: unknown) => {
        await this.cleanupSessionRepositories(
          resolved.runtime.agent_id,
          resolved.runtime.conversation_id,
        );
        throw error;
      },
    );
    this.connectionId = connection.connectionId;

    const options = this.currentOptions();
    this.mcpBridge = await connectMcpServers(
      "mcpServers" in options ? options.mcpServers : undefined,
      {
        cwd: options.cwd,
        reservedToolNames: this.externalTools.keys(),
      },
    );
    for (const tool of this.mcpBridge.tools) {
      this.externalTools.set(tool.name, tool);
    }

    try {
      return await this.openCloudTransport(
        resolved.runtime,
        connection.connectionId,
      );
    } catch (error) {
      await this.closeMcpBridge();
      await this.cleanupManagedSandbox();
      await this.cleanupSessionRepositories(
        resolved.runtime.agent_id,
        resolved.runtime.conversation_id,
      );
      throw error;
    }
  }

  private async openCloudTransport(
    runtime: RuntimeScope,
    connectionId: string,
  ): Promise<RuntimeSessionInit> {
    const apiKey = getCloudApiKey(this.cloudOptions);
    const url = buildCloudStatusWebSocketUrl({
      apiBaseUrl: this.cloudOptions.apiBaseUrl,
      connectionId,
      agentId: runtime.agent_id,
      conversationId: runtime.conversation_id,
      apiKey,
      authMode: this.cloudOptions.webSocketAuth ?? "header",
    });
    const client = applyUniqueRequestIds(createAppServerClient({
      url,
      WebSocket: createCloudStatusTransportConstructor({
        url,
        WebSocket: getWebSocketConstructor(this.cloudOptions.WebSocket),
        ...((this.cloudOptions.webSocketAuth ?? "header") === "header"
          ? { headers: cloudWebSocketHeaders(this.cloudOptions) }
          : {}),
        pingIntervalMs:
          this.cloudOptions.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
        runtime,
      }),
      requestTimeoutMs: this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    }));
    const options = this.currentOptions();
    this.installTransportHandlers(client);

    try {
      await client.connect();
      const response = await this.startCloudRuntime(client, runtime);
      if (!response.success || !response.runtime) {
        throw new Error(response.error ?? "Failed to start Cloud status runtime");
      }

      this.watchTransportDisconnect(client, { recoverWhenIdle: true });

      const tools = agentToolNames(response.agent);
      const skillSources = options.skillSources;
      const clientToolset = "toolset" in options ? options.toolset : undefined;
      const mcpToolNames = this.mcpBridge?.tools.map((tool) => tool.name) ?? [];
      const allowedTools = expandMcpToolWildcards(
        options.allowedTools,
        mcpToolNames,
      );
      const availableTools =
        tools === undefined && mcpToolNames.length === 0
          ? undefined
          : [...(tools ?? []), ...mcpToolNames];
      return {
        controller: new AppServerRuntimeController(
          client,
          {
            requestTimeoutMs: this.cloudOptions.requestTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
          },
          allowedTools,
          clientToolset,
        ),
        runtime: response.runtime,
        model: typeof response.agent?.model === "string" ? response.agent.model : "",
        modelSettings: response.agent?.model_settings ?? null,
        ...(availableTools !== undefined ? { tools: availableTools } : {}),
        ...(skillSources !== undefined ? { skillSources: [...skillSources] } : {}),
      };
    } catch (error) {
      this.cleanupTransportHandlers();
      client.close();
      throw error;
    }
  }

  private installTransportHandlers(client: AppServerClient): void {
    this.cleanupTransportHandlers();
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
  }

  private cleanupTransportHandlers(): void {
    this.removeExternalToolHandler?.();
    this.removeExternalToolHandler = null;
    this.removeControlRequestHandler?.();
    this.removeControlRequestHandler = null;
  }

  protected override async recoverIdleTransport(
    runtime: RuntimeScope,
  ): Promise<RuntimeSessionInit> {
    const connection = await this.resolveRecoveryConnection(runtime);
    this.connectionId = connection.connectionId;
    return this.openCloudTransport(runtime, connection.connectionId);
  }

  private async resolveRecoveryConnection(
    runtime: RuntimeScope,
  ): Promise<ResolvedCloudConnection> {
    const sandbox = this.managedSandbox;
    if (sandbox) {
      await this.refreshManagedSandbox(sandbox);
      return this.waitForManagedSandboxConnection(sandbox);
    }
    const environment = this.effectiveEnvironment();
    if (!environment) {
      throw new Error("Cloud idle transport recovery lost its execution target");
    }
    return this.resolveExplicitConnection(environment);
  }

  protected override onIdleTransportDisconnect(): void {
    this.cleanupTransportHandlers();
  }

  protected override onRecoveredTransportDiscarded(): void {
    this.cleanupTransportHandlers();
  }

  private async startCloudRuntime(
    client: AppServerClient,
    runtime: RuntimeScope,
  ): Promise<CloudRuntimeStartResponse> {
    const options = this.currentOptions();
    const command: Record<string, unknown> = {
      client_info: {
        name: SDK_AGENT_ORIGIN,
        title: "Letta Agent SDK",
      },
      agent_id: runtime.agent_id,
      conversation_id: runtime.conversation_id,
      recover_approvals: false,
      force_device_status: true,
    };

    const mode = mapPermissionMode(options.permissionMode);
    if (mode) command.mode = mode;
    if (options.cwd !== undefined) command.cwd = options.cwd;
    if (this.cloudMode.options.stateless === true) command.stateless = true;
    if (options.skillSources !== undefined) {
      command.skill_sources = [...new Set(options.skillSources)];
    }
    const groups = externalToolGroups([...this.externalTools.values()]);
    if (groups) command.external_tools = groups;

    return (await client.runtimeStart(
      command as Parameters<AppServerClient["runtimeStart"]>[0],
    )) as unknown as CloudRuntimeStartResponse;
  }

  protected override async afterRuntimeInitialized(): Promise<void> {
    if (!this.controller || !this.runtime) return;
    this.controller.send({
      type: "sync",
      runtime: this.runtime,
      recover_approvals: true,
      force_device_status: true,
    });
  }

  protected override async beforeTurn(): Promise<void> {
    const sandbox = this.managedSandbox;
    if (!sandbox) return;
    await this.refreshManagedSandbox(sandbox);
  }

  private async uploadFilesToManagedSandbox(
    files: readonly SandboxFileUpload[],
  ): Promise<SandboxFileUploadResult> {
    const sandbox = await this.requireManagedSandboxForFileTransfer();
    return uploadSandboxFiles(this.apiClient, sandbox.sandboxId, files);
  }

  private async downloadFileFromManagedSandbox(path: string): Promise<Uint8Array> {
    const sandbox = await this.requireManagedSandboxForFileTransfer();
    return downloadSandboxFile(this.apiClient, sandbox.sandboxId, path);
  }

  private async requireManagedSandboxForFileTransfer(): Promise<ManagedCloudSandbox> {
    if (this.effectiveEnvironment() !== undefined) {
      throw new Error("Sandbox file transfer requires an SDK-managed Cloud sandbox.");
    }
    await this.ready();
    const sandbox = this.managedSandbox;
    if (!sandbox) {
      throw new Error("SDK-managed Cloud sandbox is unavailable.");
    }
    await this.refreshManagedSandbox(sandbox);
    return sandbox;
  }

  protected override onCoreClose(): void {
    this.cleanupTransportHandlers();
    this.mcpCleanup = this.closeMcpBridge();
    void this.cleanupManagedSandbox();
    if (this.runtime?.agent_id) {
      void this.cleanupSessionRepositories(
        this.runtime.agent_id,
        this.runtime.conversation_id,
      );
    }
  }

  protected override async onCoreDisposed(): Promise<void> {
    await this.mcpCleanup;
  }

  private closeMcpBridge(): Promise<void> {
    const bridge = this.mcpBridge;
    this.mcpBridge = null;
    for (const tool of bridge?.tools ?? []) this.externalTools.delete(tool.name);
    return bridge?.close() ?? Promise.resolve();
  }

  private async resolveRuntime(): Promise<{ runtime: RuntimeScope }> {
    let agentId = this.cloudMode.agentId;
    let conversationId = this.cloudMode.conversationId;

    if (!agentId && conversationId) {
      const conversation = await this.retrieveConversation(conversationId);
      if (!conversation.agent_id) {
        throw new Error(`Cloud conversation ${conversationId} did not include an agent id.`);
      }
      agentId = conversation.agent_id;
    }

    if (!agentId) {
      throw new Error(
        "Letta Cloud createSession()/resumeSession() requires an agent id or conversation id.",
      );
    }

    const shouldRecompileRepositories =
      await this.attachSessionRepositories(agentId);

    try {
      if (this.cloudMode.newConversation) {
        const conversation = await this.createConversation(agentId);
        conversationId = conversation.id;
      } else if (this.cloudMode.defaultConversation) {
        conversationId = "default";
      }

      if (!conversationId) {
        throw new Error(
          "Letta Cloud createSession()/resumeSession() requires an agent id or conversation id.",
        );
      }

      if (shouldRecompileRepositories) {
        await this.recompileSystemPrompt(agentId, conversationId);
      }

      return { runtime: { agent_id: agentId, conversation_id: conversationId } };
    } catch (error) {
      await this.cleanupSessionRepositories(agentId, conversationId);
      throw error;
    }
  }

  private async attachSessionRepositories(agentId: string): Promise<boolean> {
    const resources = this.repositoryResources();
    if (resources.length === 0) return false;

    const existing = await this.repositoryManagement.listAgentRepositories(
      agentId,
    );
    const existingIds = new Set(existing.map((repository) => repository.id));

    try {
      for (const resource of resources) {
        if (existingIds.has(resource.repositoryId) || this.attachedRepositoryIds.has(resource.repositoryId)) {
          continue;
        }
        await this.repositoryManagement.attachAgentRepository(
          agentId,
          resource.repositoryId,
          undefined,
        );
        await this.waitForAgentRepository(agentId, resource.repositoryId);
        this.attachedRepositoryIds.add(resource.repositoryId);
      }
    } catch (error) {
      await this.cleanupSessionRepositories(agentId);
      throw error;
    }

    // Recompile even when every requested repository was already linked: the
    // target conversation may still have been compiled before those links
    // existed. One recompile after the full batch produces the desired state.
    const shouldRecompile = resources.some(
      (resource) => resource.recompile !== false,
    );
    this.repositoryIdsRequiringCleanupRecompile = new Set(
      resources
        .filter(
          (resource) =>
            resource.recompile !== false &&
            this.attachedRepositoryIds.has(resource.repositoryId),
        )
        .map((resource) => resource.repositoryId),
    );
    return shouldRecompile;
  }

  private async cleanupSessionRepositories(
    agentId: string,
    conversationId?: string,
  ): Promise<void> {
    const repositoryIds = [...this.attachedRepositoryIds];
    const repositoryIdsRequiringRecompile =
      this.repositoryIdsRequiringCleanupRecompile;
    this.attachedRepositoryIds.clear();
    this.repositoryIdsRequiringCleanupRecompile = new Set<string>();
    const recompileAfterDetach = await Promise.all(repositoryIds.map(async (repositoryId) => {
      try {
        await this.repositoryManagement.detachAgentRepository(
          agentId,
          repositoryId,
        );
        return repositoryIdsRequiringRecompile.has(repositoryId);
      } catch {
        // Best-effort cleanup: only repositories this SDK session attached are removed.
        return false;
      }
    }));
    // Best-effort recompile after detach so remaining conversations drop stale
    // repository projections. Errors are swallowed because this runs on close.
    if (recompileAfterDetach.some(Boolean)) {
      try {
        await this.recompileSystemPrompt(agentId, conversationId);
      } catch {
        // Best-effort: cleanup must not throw.
      }
    }
  }

  private async recompileSystemPrompt(
    agentId: string,
    conversationId?: string,
  ): Promise<void> {
    const usesAgentPrompt = !conversationId || conversationId === "default";
    if (usesAgentPrompt) {
      await this.repositoryManagement.recompileAgentSystemPrompt(agentId);
      return;
    }
    await this.repositoryManagement.recompileConversationSystemPrompt(
      agentId,
      conversationId,
    );
  }

  private repositoryResources(): RepositoryResource[] {
    const resources = this.cloudMode.options.resources ?? [];
    const seen = new Set<string>();
    const result: RepositoryResource[] = [];
    for (const resource of resources) {
      if (resource.type !== "repository") {
        throw new Error(`Unsupported Cloud session resource type: ${String(resource.type)}`);
      }
      if (typeof resource.repositoryId !== "string" || resource.repositoryId.length === 0) {
        throw new Error("Cloud session repository resources require repositoryId.");
      }
      if (seen.has(resource.repositoryId)) continue;
      seen.add(resource.repositoryId);
      result.push(resource);
    }
    return result;
  }

  private async waitForAgentRepository(agentId: string, repositoryId: string): Promise<void> {
    const deadline = Date.now() + DEFAULT_REPOSITORY_ATTACH_TIMEOUT_MS;
    while (true) {
      const repositories = await this.repositoryManagement.listAgentRepositories(
        agentId,
      );
      if (repositories.some((repository) => repository.id === repositoryId)) return;
      if (Date.now() >= deadline) {
        throw new Error(`Cloud attach agent repository did not become visible for ${agentId}: ${repositoryId}`);
      }
      await sleep(DEFAULT_REPOSITORY_ATTACH_POLL_INTERVAL_MS);
    }
  }

  private async createConversation(agentId: string): Promise<{ id: string; agent_id?: string }> {
    const conversation = await this.apiClient.conversations.create({
      agent_id: agentId,
    });
    if (!isCloudConversation(conversation)) {
      throw new Error("Cloud createSession() response did not include a conversation id.");
    }
    return { id: conversation.id, agent_id: conversation.agent_id };
  }

  private async retrieveConversation(conversationId: string): Promise<{ id: string; agent_id?: string }> {
    const conversation = await this.apiClient.conversations.retrieve(
      conversationId,
    );
    if (!isCloudConversation(conversation)) {
      throw new Error(`Cloud resumeSession() could not retrieve conversation ${conversationId}.`);
    }
    return { id: conversation.id, agent_id: conversation.agent_id };
  }

  private async resolveConnectionForRuntime(
    runtime: RuntimeScope,
  ): Promise<ResolvedCloudConnection> {
    const environment = this.effectiveEnvironment();
    const sandboxOptions = this.effectiveSandboxOptions();
    if (environment !== undefined) {
      if (sandboxOptions !== undefined) {
        throw new Error("Letta Cloud sessions cannot specify both environment and sandbox options.");
      }
      return this.resolveExplicitConnection(environment);
    }
    return this.createManagedSandboxConnection(runtime);
  }

  private async resolveExplicitConnection(
    environment: LettaCodeEnvironment,
  ): Promise<{ connectionId: string }> {
    const target = environmentToRemoteTarget(environment);
    const resolved = await this.remoteEnvironmentClient().resolveEnvironment(target);
    return { connectionId: resolved.connectionId };
  }

  private async createManagedSandboxConnection(
    runtime: RuntimeScope,
  ): Promise<ResolvedCloudConnection> {
    // Scope the managed sandbox to the conversation when one exists: the
    // server treats create-with-conversationId as create-or-resume, so
    // sessions of the same conversation share one sandbox and sessions of
    // different conversations stop contending for a single per-agent one.
    const conversationId =
      runtime.conversation_id && runtime.conversation_id !== "default"
        ? runtime.conversation_id
        : undefined;
    const sandbox = await this.createManagedSandbox(
      runtime.agent_id,
      conversationId,
    );
    this.managedSandbox = sandbox;

    if (this.sandboxLifecycleClosing) {
      await this.cleanupManagedSandbox();
      throw new Error("Cloud managed sandbox session closed during initialization.");
    }

    try {
      await this.refreshManagedSandbox(sandbox);
      const connection = await this.waitForManagedSandboxConnection(sandbox);
      this.startManagedSandboxRefresh(sandbox);
      return { connectionId: connection.connectionId };
    } catch (error) {
      await this.cleanupManagedSandbox();
      throw error;
    }
  }

  private async createManagedSandbox(
    agentId: string,
    conversationId?: string,
  ): Promise<ManagedCloudSandbox> {
    const sandboxOptions = this.resolvedSandboxOptions();
    const githubRepositories = sandboxOptions.githubRepositories;
    const body = await this.apiClient.post<unknown>(
      `/v1/agents/${encodeURIComponent(agentId)}/sandboxes`,
      {
        body: {
          ...(conversationId ? { conversationId } : {}),
          ...(githubRepositories && githubRepositories.length > 0
            ? { githubRepositories }
            : {}),
        },
      },
    );
    if (!isCloudAgentSandbox(body)) {
      throw new Error("Cloud create managed sandbox response did not include sandbox connection details.");
    }

    const responseConversationId =
      typeof body.conversationId === "string" ? body.conversationId : null;
    if (
      responseConversationId !== null &&
      responseConversationId !== conversationId
    ) {
      throw new Error(
        `Cloud managed sandbox response conversation mismatch: expected ${conversationId ?? "none"}, got ${responseConversationId}.`,
      );
    }

    const ttlMinutes = sandboxOptions.ttlMinutes ?? DEFAULT_SANDBOX_TTL_MINUTES;
    const readyTimeoutMs = sandboxOptions.readyTimeoutMs
      ?? DEFAULT_SANDBOX_READY_TIMEOUT_MS;
    const readyPollIntervalMs = sandboxOptions.readyPollIntervalMs
      ?? DEFAULT_SANDBOX_READY_POLL_INTERVAL_MS;
    const defaultRefreshIntervalMs = Math.max(
      1_000,
      Math.floor(ttlMinutes * 60_000 * 0.8),
    );

    return {
      agentId,
      conversationId: responseConversationId,
      sandboxId: body.sandboxId,
      deviceId: body.deviceId,
      connectionName: body.connectionName,
      ttlMinutes,
      readyTimeoutMs,
      readyPollIntervalMs,
      refreshIntervalMs: sandboxOptions.refreshIntervalMs ?? defaultRefreshIntervalMs,
      // Default to TTL cleanup: terminating on close kills a sandbox that
      // other sessions of the same conversation (or a reconnecting client)
      // may still be using; the server-side TTL bounds leaked sandboxes.
      terminateOnClose: sandboxOptions.terminateOnClose ?? false,
    };
  }

  private async refreshManagedSandbox(sandbox: ManagedCloudSandbox): Promise<void> {
    if (this.sandboxRefreshInFlight) {
      await this.sandboxRefreshInFlight;
      return;
    }

    this.sandboxRefreshInFlight = this.refreshManagedSandboxOnce(sandbox);
    try {
      await this.sandboxRefreshInFlight;
    } finally {
      this.sandboxRefreshInFlight = null;
    }
  }

  private async refreshManagedSandboxOnce(sandbox: ManagedCloudSandbox): Promise<void> {
    if (sandbox.conversationId) {
      // Conversation-scoped sandboxes refresh by id — no "latest active"
      // indirection, so ownership changes are structurally impossible.
      let body: unknown;
      try {
        body = await this.apiClient.post(
          `/v1/sandboxes/${encodeURIComponent(sandbox.sandboxId)}/refresh`,
          { body: { ttlMinutes: sandbox.ttlMinutes } },
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
        // The current control and stream WebSockets are bound to this
        // sandbox's ephemeral connection id. Recreating only the sandbox would
        // leave both sockets targeting the dead connection, so surface a
        // pre-turn error and let the caller resume the same conversation with
        // a new SDK session.
        throw new CloudManagedSandboxExpiredError(
          sandbox.sandboxId,
          sandbox.conversationId,
        );
      }
      if (!isCloudAgentSandboxRefresh(body) || !body.success) {
        throw new Error("Cloud refresh managed sandbox response did not confirm refresh.");
      }
      return;
    }

    const body = await this.apiClient.post<unknown>(
      `/v1/agents/${encodeURIComponent(sandbox.agentId)}/sandboxes/refresh`,
      {
        body: { ttlMinutes: sandbox.ttlMinutes },
      },
    );
    if (!isCloudAgentSandboxRefresh(body) || !body.success) {
      throw new Error("Cloud refresh managed sandbox response did not confirm refresh.");
    }
    if (body.sandboxId !== sandbox.sandboxId) {
      throw new CloudManagedSandboxOwnershipError(
        `Cloud managed sandbox ownership changed for agent ${sandbox.agentId}: expected ${sandbox.sandboxId}, got ${body.sandboxId}.`,
      );
    }
  }

  private async terminateManagedSandbox(sandbox: ManagedCloudSandbox): Promise<void> {
    if (sandbox.conversationId) {
      // Terminate exactly this sandbox — the agent-scoped DELETE targets the
      // agent's "latest active" sandbox, which may not be ours.
      try {
        await this.apiClient.post(
          `/v1/sandboxes/${encodeURIComponent(sandbox.sandboxId)}/terminate`,
          { body: {} },
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return;
    }

    // Agent-scoped: refresh first so the ownership check confirms the
    // "latest active" sandbox the DELETE will target is still ours.
    await this.refreshManagedSandbox(sandbox);

    try {
      await this.apiClient.delete(
        `/v1/agents/${encodeURIComponent(sandbox.agentId)}/sandboxes`,
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async waitForManagedSandboxConnection(
    sandbox: ManagedCloudSandbox,
  ): Promise<{ connectionId: string }> {
    const deadline = Date.now() + sandbox.readyTimeoutMs;
    let lastError: unknown;

    while (true) {
      try {
        const resolved = await this.remoteEnvironmentClient().resolveEnvironment({
          deviceId: sandbox.deviceId,
        });
        return { connectionId: resolved.connectionId };
      } catch (error) {
        lastError = error;
        if (!isRetryableManagedSandboxResolveError(error) || Date.now() >= deadline) {
          break;
        }
        const remainingMs = Math.max(0, deadline - Date.now());
        await sleep(Math.min(sandbox.readyPollIntervalMs, remainingMs));
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Cloud managed sandbox ${sandbox.sandboxId} did not come online within ${sandbox.readyTimeoutMs}ms: ${detail}`,
    );
  }

  private startManagedSandboxRefresh(sandbox: ManagedCloudSandbox): void {
    this.stopManagedSandboxRefresh();
    this.sandboxRefreshTimer = setInterval(() => {
      void this.refreshManagedSandbox(sandbox).catch((error) => {
        if (
          error instanceof CloudManagedSandboxOwnershipError ||
          error instanceof CloudManagedSandboxExpiredError
        ) {
          this.stopManagedSandboxRefresh();
        }
      });
    }, sandbox.refreshIntervalMs);
    (this.sandboxRefreshTimer as { unref?: () => void }).unref?.();
  }

  private stopManagedSandboxRefresh(): void {
    if (!this.sandboxRefreshTimer) return;
    clearInterval(this.sandboxRefreshTimer);
    this.sandboxRefreshTimer = null;
  }

  private async cleanupManagedSandbox(): Promise<void> {
    this.sandboxLifecycleClosing = true;
    this.stopManagedSandboxRefresh();
    const sandbox = this.managedSandbox;
    this.managedSandbox = null;

    // Do not race termination against a refresh already in flight. In
    // particular, this ensures cleanup observes the final refresh outcome
    // before issuing the by-id terminate request.
    try {
      await this.sandboxRefreshInFlight;
    } catch {
      // Expiration/refresh failures do not prevent best-effort cleanup.
    }

    if (!sandbox || !sandbox.terminateOnClose) return;
    try {
      await this.terminateManagedSandbox(sandbox);
    } catch {
      // Best-effort cleanup: Cloud TTL still bounds leaked managed sandboxes.
    }
  }

  private remoteEnvironmentClient(): RemoteEnvironmentClient {
    return new RemoteEnvironmentClient({}, this.apiClient);
  }

  private effectiveEnvironment(): LettaCodeEnvironment | undefined {
    const modeComputer = this.mode.kind === "session"
      ? this.mode.options.computer ?? this.mode.options.environment
      : undefined;
    return modeComputer ??
      this.cloudOptions.computer ??
      this.cloudOptions.environment;
  }

  private effectiveSandboxOptions(): LettaCodeCloudSandboxOptions | undefined {
    const modeSandbox = this.mode.kind === "session"
      ? this.mode.options.sandbox
      : undefined;
    return modeSandbox ?? this.cloudOptions.sandbox;
  }

  private resolvedSandboxOptions(): LettaCodeCloudSandboxOptions {
    return this.effectiveSandboxOptions() ?? {};
  }
}
