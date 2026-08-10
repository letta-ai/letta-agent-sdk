import type {
  BootstrapStateOptions,
  BootstrapStateResult,
  ChangeDeviceStateOptions,
  CreateAgentOptions,
  GetDeviceStatusOptions,
  LettaCodeClientSessionOptions,
  LettaCodeSession,
  LettaCodeModelEntry,
  ListModelsResult,
  ListMessagesOptions,
  ListMessagesResult,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  RemoveQueuedMessageResult,
  SDKInitMessage,
  SDKMessage,
  SDKProtocolCommand,
  SDKProtocolMessage,
  SDKResultMessage,
  SendCommandOptions,
  SendMessage,
  SessionDeviceStatus,
  UpdateModelOptions,
  UpdateModelResult,
} from "./types.js";
import { RemoteTurnCoordinator } from "./remote-turn-coordinator.js";

export {
  ensureSuccess,
  isUnrestrictedPermissionMode,
  mapPermissionMode,
  normalizePermissionMode,
  normalizeSendMessage,
} from "./remote-session-protocol.js";
import {
  ensureSuccess,
  getContextWindow,
  getReasoningEffort,
  mapPermissionMode,
  modelPayloadWithoutReasoning,
  normalizeUpdateModelInput,
  resolveDreamingSettings,
  sameContextCandidates,
  toBaseModelHandle,
  type NormalizedUpdateModelInput,
  type RemoteClientSessionCoreConfig,
  type RemoteClientRuntimeController,
  type RuntimeScope,
  type RuntimeSessionInit,
  type RuntimeSessionMode,
  type UpdateModelPayload,
} from "./remote-session-protocol.js";
export type {
  ProtocolMessage,
  RemoteClientRuntimeController,
  RuntimeRequestOptions,
  RuntimeScope,
  RuntimeSendTurnOptions,
  RuntimeSessionInit,
  RuntimeSessionMode,
  RuntimeTurnResult,
} from "./remote-session-protocol.js";

export abstract class RemoteClientSessionCore implements LettaCodeSession {
  protected controller: RemoteClientRuntimeController | null = null;
  protected runtime: RuntimeScope | null = null;
  protected initialized = false;
  protected closed = false;
  protected _agentId: string | null = null;
  protected _sessionId: string | null = null;
  protected _conversationId: string | null = null;
  protected _model = "";
  protected _modelSettings: Record<string, unknown> | null = null;

  private readonly label: string;
  private readonly requestTimeoutMs: number | undefined;
  private initializePromise: Promise<SDKInitMessage> | null = null;
  private removeMessageHandler: (() => void) | null = null;
  private detachTransportDisconnect: (() => void) | null = null;
  private idleTransportDisconnected = false;
  private transportRecoveryPromise: Promise<void> | null = null;
  private transportDisconnectGeneration = 0;
  private readonly turns: RemoteTurnCoordinator;
  private toolNames: string[] | undefined;
  private deviceStatusListeners = new Set<(status: SessionDeviceStatus) => void>();
  private deviceStatusRefreshCancels = new Set<(error: Error) => void>();

  protected constructor(
    protected readonly mode: RuntimeSessionMode,
    config: RemoteClientSessionCoreConfig,
  ) {
    this.label = config.label;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.turns = new RemoteTurnCoordinator({
      label: config.label,
      requestTimeoutMs: config.requestTimeoutMs,
      autoHandlesToolApprovals:
        mode.kind === "session" && typeof mode.options.canUseTool === "function",
      onDeviceStatus: (status) => this.emitDeviceStatus(status),
    });
  }

  /**
   * Initialize the session.
   *
   * Single-flight: the first caller starts initialization and every
   * concurrent caller (including the lazily-initializing entry points such
   * as send()/stream()/listMessages()) awaits the same promise, so a fresh
   * session never opens more than one runtime connection. A failed attempt
   * clears the memo so a later call can retry; it only releases the
   * resources that failed attempt created.
   */
  async initialize(): Promise<SDKInitMessage> {
    if (this.closed) {
      throw new Error("Session is closed");
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }
    if (this.initialized) {
      throw new Error("Session already initialized");
    }

    const attempt = this.performInitialize();
    const memo = attempt
      .catch((error: unknown) => {
        // Tear down only this attempt's partial state. Never close() the
        // session here: a failed remote attempt is retryable.
        this.cleanupFailedInitialize();
        throw error;
      })
      .finally(() => {
        // Keep only the in-flight promise. Once it settles, preserve the
        // existing API: a later explicit initialize() either retries a
        // failure or throws "already initialized" after success.
        if (this.initializePromise === memo) {
          this.initializePromise = null;
        }
      });
    this.initializePromise = memo;
    return memo;
  }

  private async performInitialize(): Promise<SDKInitMessage> {
    const init = await this.initializeRuntimeController();
    this.controller = init.controller;
    this.runtime = init.runtime;
    this._agentId = init.runtime.agent_id;
    this._conversationId = init.runtime.conversation_id;
    this._sessionId = `${init.runtime.agent_id}:${init.runtime.conversation_id}`;
    this._modelSettings = init.modelSettings ?? null;
    this._model =
      typeof init.model === "string"
        ? init.model
        : typeof this._modelSettings?.model === "string"
          ? this._modelSettings.model
          : "";
    this.toolNames = init.tools;
    this.removeMessageHandler = this.controller.onMessage((message) => {
      if (this.runtime) this.turns.handleProtocolMessage(message, this.runtime);
    });

    await this.afterRuntimeInitialized();
    await this.applyPostInitializeOptions();
    if (this.closed) {
      throw new Error("Session is closed");
    }

    // This is the lifecycle commit point. Lazy entry points must continue to
    // await initializePromise until every post-initialize option is applied.
    this.initialized = true;

    const initMessage: SDKInitMessage = {
      type: "init",
      agentId: init.runtime.agent_id,
      sessionId: this._sessionId,
      conversationId: init.runtime.conversation_id,
      model: this._model,
    };
    if (this.toolNames !== undefined) initMessage.tools = this.toolNames;
    if (init.skillSources !== undefined) {
      initMessage.skillSources = init.skillSources;
    }
    return initMessage;
  }

  /**
   * Release the partial state a failed initialize attempt created without
   * closing the session, so a later initialize() can retry.
   */
  private cleanupFailedInitialize(): void {
    this.removeMessageHandler?.();
    this.removeMessageHandler = null;
    this.detachTransportDisconnect?.();
    this.detachTransportDisconnect = null;
    this.controller?.close();
    this.controller = null;
    // Subclass-owned resources (spawned connections, sandboxes, handlers)
    // are attempt-scoped too; their cleanup hooks are idempotent.
    this.onCoreClose();
    this.runtime = null;
    this._agentId = null;
    this._conversationId = null;
    this._sessionId = null;
    this._modelSettings = null;
    this._model = "";
    this.toolNames = undefined;
    this.initialized = false;
  }

  async send(message: SendMessage): Promise<void> {
    if (this.closed) throw new Error("Session is closed");
    if (!this.initialized) {
      await this.initialize();
    }
    await this.recoverIdleTransportIfNeeded();
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }

    await this.beforeTurn();

    const controller = this.controller;
    const runtime = this.runtime;
    if (!controller || !runtime) {
      throw new Error("Session transport disconnected before the turn was sent");
    }
    const turn = this.turns.trackSentTurn(runtime);
    try {
      controller.sendTurnMessage(runtime, message, {
        clientMessageId: turn.clientMessageId,
      });
    } catch (error) {
      this.turns.removeTrackedTurn(turn);
      throw error;
    }
  }

  async sendAndWaitForResult(message: SendMessage): Promise<SDKResultMessage> {
    if (this.turns.hasInFlightTurn()) {
      throw new Error(
        `A turn is already in flight for this ${this.label} session. Use send() and stream() to let the listener queue messages.`,
      );
    }
    await this.send(message);
    for await (const msg of this.stream()) {
      if (msg.type === "result") {
        return msg;
      }
    }
    return {
      type: "result",
      success: false,
      error: "stream_closed",
      errorCode: "stream_closed",
      recoverable: false,
      errorDetail: "Stream ended before terminal result",
      durationMs: Date.now() - this.turns.activeTurnStartedAt,
      conversationId: this._conversationId,
    };
  }

  async *stream(): AsyncGenerator<SDKMessage> {
    while (true) {
      const msg = await this.turns.nextMessage();
      if (!msg) break;
      yield msg;
      if (msg.type === "result") break;
    }
  }

  async abort(): Promise<void> {
    if (!this.initialized) return;
    if (!this.controller || !this.runtime) return;
    this.turns.markAbortRequested();
    await this.controller.abort(this.runtime);
  }

  async sendCommand(command: SDKProtocolCommand): Promise<void>;
  async sendCommand<TResponse extends SDKProtocolMessage = SDKProtocolMessage>(
    command: SDKProtocolCommand,
    options: SendCommandOptions,
  ): Promise<TResponse>;
  async sendCommand<TResponse extends SDKProtocolMessage = SDKProtocolMessage>(
    command: SDKProtocolCommand,
    options?: SendCommandOptions,
  ): Promise<void | TResponse> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller) {
      throw new Error("Session is not initialized");
    }
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error("Invalid command. Expected a protocol command object.");
    }
    if (typeof command.type !== "string" || command.type.length === 0) {
      throw new Error("Invalid command. Expected a non-empty type.");
    }

    if (!options || (!options.responseType && !options.predicate && options.timeoutMs === undefined)) {
      this.controller.send(command);
      return;
    }

    const { type, ...body } = command;
    const response = await this.controller.request(type, body, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      predicate: options.predicate
        ? (message) => options.predicate?.(message as SDKProtocolMessage) === true
        : options.responseType
          ? (message) => message.type === options.responseType
          : undefined,
    });
    return response as TResponse;
  }

  async listModels(): Promise<ListModelsResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller) {
      throw new Error("Session is not initialized");
    }
    return this.controller.listModels();
  }

  async updateModel(update: string | UpdateModelOptions): Promise<UpdateModelResult> {
    if (this.mode.kind === "session" && this.mode.options.stateless === true) {
      throw new Error(
        "updateModel() is unavailable in a stateless session because it changes persisted agent configuration.",
      );
    }
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    return this.applyModelUpdate(update);
  }

  private async applyModelUpdate(
    update: string | UpdateModelOptions,
  ): Promise<UpdateModelResult> {
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    const normalized = normalizeUpdateModelInput(update);
    const payload = await this.resolveUpdateModelPayload(normalized);
    const result = await this.controller.updateModel(this.runtime, payload);

    if (result.modelHandle !== undefined) {
      this._model = result.modelHandle;
    } else if (payload.model_handle !== undefined) {
      this._model = payload.model_handle;
    } else if (typeof result.modelSettings?.model === "string") {
      this._model = result.modelSettings.model;
    }
    if ("modelSettings" in result) {
      this._modelSettings = result.modelSettings ?? null;
    }
    return result;
  }

  async recoverPendingApprovals(
    options: RecoverPendingApprovalsOptions = {},
  ): Promise<RecoverPendingApprovalsResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    return this.controller.recoverPendingApprovals(this.runtime, options);
  }

  async removeQueuedMessage(itemId: string): Promise<RemoveQueuedMessageResult> {
    if (typeof itemId !== "string" || itemId.trim().length === 0) {
      throw new Error("Invalid queue item id. Expected a non-empty string.");
    }
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }

    const response = await this.controller.request(
      "remove_queue_item",
      {
        runtime: this.runtime,
        item_id: itemId,
      },
      {
        predicate: (message) =>
          message.type === "remove_queue_item_response" &&
          message.item_id === itemId,
      },
    );
    if (typeof response.success !== "boolean") {
      throw new Error("Invalid remove_queue_item_response from runtime");
    }

    return {
      itemId:
        typeof response.item_id === "string" ? response.item_id : itemId,
      removed: response.success,
    };
  }

  async getDeviceStatus(
    options: GetDeviceStatusOptions = {},
  ): Promise<SessionDeviceStatus> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        "Invalid device status timeout. Expected a positive integer.",
      );
    }
    return this.refreshDeviceStatus(timeoutMs);
  }

  onDeviceStatus(listener: (status: SessionDeviceStatus) => void): () => void {
    if (typeof listener !== "function") {
      throw new Error("Invalid device status listener. Expected a function.");
    }
    this.deviceStatusListeners.add(listener);
    return () => {
      this.deviceStatusListeners.delete(listener);
    };
  }

  private refreshDeviceStatus(timeoutMs: number): Promise<SessionDeviceStatus> {
    const controller = this.controller;
    const runtime = this.runtime;
    if (!controller || !runtime) {
      return Promise.reject(new Error("Session is not initialized"));
    }
    return new Promise<SessionDeviceStatus>((resolve, reject) => {
      let status: SessionDeviceStatus | null = null;
      let syncAcknowledged = false;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        this.deviceStatusRefreshCancels.delete(cancel);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const resolveIfComplete = () => {
        if (settled || !syncAcknowledged || !status) return;
        settled = true;
        cleanup();
        resolve(status);
      };
      const cancel = (error: Error) => rejectOnce(error);
      const timer = setTimeout(() => {
        rejectOnce(
          new Error(`Timed out waiting for ${this.label} device status`),
        );
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const unsubscribe = this.onDeviceStatus((nextStatus) => {
        status = nextStatus;
        resolveIfComplete();
      });
      this.deviceStatusRefreshCancels.add(cancel);

      void controller.request(
        "sync",
        {
          runtime,
          recover_approvals: false,
          force_device_status: true,
        },
        {
          timeoutMs,
          predicate: (message) => message.type === "sync_response",
        },
      ).then(
        (response) => {
          if (response.success === false) {
            rejectOnce(
              new Error(
                typeof response.error === "string"
                  ? response.error
                  : `Failed to refresh ${this.label} device status`,
              ),
            );
            return;
          }
          syncAcknowledged = true;
          resolveIfComplete();
        },
        (error) => {
          rejectOnce(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
    });
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller) {
      throw new Error("Session is not initialized");
    }
    const conversationId = options.conversationId ?? this._conversationId;
    if (!conversationId) {
      throw new Error("No conversation id available for listMessages()");
    }
    return this.controller.listMessages(conversationId, options);
  }

  async bootstrapState(
    options: BootstrapStateOptions = {},
  ): Promise<BootstrapStateResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    const page = await this.listMessages({
      limit: options.limit,
      order: options.order,
    });

    const state: BootstrapStateResult = {
      agentId: this._agentId ?? "",
      conversationId: this._conversationId ?? "",
      model: this._model,
      messages: page.messages,
    };
    if (this.toolNames !== undefined) {
      state.tools = this.toolNames;
    }
    if (page.nextBefore !== undefined) {
      state.nextBefore = page.nextBefore;
    }
    if (page.hasMore !== undefined) {
      state.hasMore = page.hasMore;
    }
    return state;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.removeMessageHandler?.();
    this.removeMessageHandler = null;
    this.detachTransportDisconnect?.();
    this.detachTransportDisconnect = null;
    this.turns.close();
    for (const cancel of [...this.deviceStatusRefreshCancels]) {
      cancel(new Error(`Session closed while waiting for ${this.label} device status`));
    }
    this.deviceStatusRefreshCancels.clear();
    this.deviceStatusListeners.clear();
    this.controller?.close();
    this.controller = null;
    this.idleTransportDisconnected = false;
    this.onCoreClose();
  }

  get agentId(): string | null {
    return this._agentId;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
    await this.onCoreDisposed();
  }

  async changeDeviceState(
    updates: ChangeDeviceStateOptions,
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    const payload: Record<string, unknown> = {};
    if (updates.cwd !== undefined) payload.cwd = updates.cwd;
    if (updates.permissionMode !== undefined) {
      const mode = mapPermissionMode(updates.permissionMode);
      if (mode !== undefined) payload.mode = mode;
    }
    if (Object.keys(payload).length === 0) {
      throw new Error(
        "Invalid device state update. Expected cwd or permissionMode.",
      );
    }

    this.controller.send({
      type: "change_device_state",
      runtime: this.runtime,
      payload,
    });
  }

  async updateToolset(toolsetPreference: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.controller || !this.runtime) {
      throw new Error("Session is not initialized");
    }
    const response = await this.controller.request(
      "update_toolset",
      {
        runtime: this.runtime,
        toolset_preference: toolsetPreference,
      },
      { predicate: (message) => message.type === "update_toolset_response" },
    );
    ensureSuccess(response, "Failed to update toolset");
  }

  protected abstract initializeRuntimeController(): Promise<RuntimeSessionInit>;

  /**
   * Active turns fail because the input may have reached the listener. Cloud
   * sessions may recover an idle connection before the next turn is tracked.
   */
  protected watchTransportDisconnect(
    client: { onDisconnect(handler: () => void): () => void },
    options: { recoverWhenIdle?: boolean } = {},
  ): void {
    this.detachTransportDisconnect?.();
    this.detachTransportDisconnect = client.onDisconnect(() => {
      if (this.closed) return;
      this.transportDisconnectGeneration += 1;
      if (options.recoverWhenIdle && !this.turns.hasInFlightTurn()) {
        this.detachTransportDisconnect?.();
        this.detachTransportDisconnect = null;
        this.removeMessageHandler?.();
        this.removeMessageHandler = null;
        this.controller?.close();
        this.controller = null;
        const error = new Error(`${this.label} connection closed before send`);
        for (const cancel of [...this.deviceStatusRefreshCancels]) cancel(error);
        this.deviceStatusRefreshCancels.clear();
        this.onIdleTransportDisconnect();
        this.idleTransportDisconnected = true;
        return;
      }
      this.turns.closeWithError(
        `The ${this.label} connection closed unexpectedly; resume the conversation to continue.`,
      );
      this.close();
    });
  }

  private async recoverIdleTransportIfNeeded(): Promise<void> {
    if (!this.idleTransportDisconnected) return;
    if (this.transportRecoveryPromise) {
      await this.transportRecoveryPromise;
      return;
    }
    const runtime = this.runtime;
    if (!runtime) throw new Error("Session transport disconnected without a runtime");
    const generation = this.transportDisconnectGeneration;
    const recovery = this.recoverIdleTransport(runtime)
      .then(async (init) => {
        if (this.closed || generation !== this.transportDisconnectGeneration) {
          init.controller.close();
          this.onRecoveredTransportDiscarded();
          throw new Error(`${this.label} connection closed during recovery`);
        }
        if (
          init.runtime.agent_id !== runtime.agent_id ||
          init.runtime.conversation_id !== runtime.conversation_id
        ) {
          init.controller.close();
          this.onRecoveredTransportDiscarded();
          throw new Error(`${this.label} transport recovered a different runtime`);
        }
        this.controller = init.controller;
        this.runtime = init.runtime;
        this._modelSettings = init.modelSettings ?? this._modelSettings;
        if (typeof init.model === "string" && init.model) this._model = init.model;
        if (init.tools !== undefined) this.toolNames = init.tools;
        this.removeMessageHandler = this.controller.onMessage((message) => {
          if (this.runtime) this.turns.handleProtocolMessage(message, this.runtime);
        });
        this.idleTransportDisconnected = false;
        await this.afterRuntimeInitialized();
      })
      .finally(() => {
        if (this.transportRecoveryPromise === recovery) this.transportRecoveryPromise = null;
      });
    this.transportRecoveryPromise = recovery;
    await recovery;
  }

  protected async recoverIdleTransport(
    _runtime: RuntimeScope,
  ): Promise<RuntimeSessionInit> {
    throw new Error(`${this.label} sessions do not support idle transport recovery`);
  }

  protected onIdleTransportDisconnect(): void {
    // Optional hook for transport-specific handler cleanup before recovery.
  }

  protected onRecoveredTransportDiscarded(): void {
    // Optional hook when a recovery finishes after the session closed or dropped again.
  }

  protected async afterRuntimeInitialized(): Promise<void> {
    // Optional hook for subclasses to send transport-specific startup frames.
  }

  protected async beforeTurn(): Promise<void> {
    // Optional hook for subclasses to refresh transport-specific lifecycle state.
  }

  protected onCoreClose(): void {
    // Optional hook for subclass-owned resources outside the controller.
  }

  protected async onCoreDisposed(): Promise<void> {
    // Optional hook for awaiting asynchronous cleanup started by onCoreClose().
  }

  protected currentOptions(): LettaCodeClientSessionOptions | CreateAgentOptions {
    return this.mode.options;
  }

  protected shouldEnableMemfs(options: LettaCodeClientSessionOptions | CreateAgentOptions): boolean {
    void options;
    return false;
  }

  protected enableMemfsBody(): Record<string, unknown> {
    if (!this.runtime) return {};
    return { agent_id: this.runtime.agent_id };
  }

  protected setModel(model: string): void {
    this._model = model;
  }

  private async resolveUpdateModelPayload(
    input: NormalizedUpdateModelInput,
  ): Promise<UpdateModelPayload> {
    if (input.reasoningEffort === undefined) {
      return modelPayloadWithoutReasoning(input);
    }
    if (!this.controller) {
      throw new Error("Session is not initialized");
    }

    const catalog = await this.controller.listModels();
    const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    const aliases = catalog.byokProviderAliases;

    let baseEntry: LettaCodeModelEntry | undefined;
    let explicitHandle: string | undefined;
    let targetHandle: string | undefined;

    if (input.modelId !== undefined) {
      baseEntry = byId.get(input.modelId);
      explicitHandle = input.modelHandle;
      targetHandle = baseEntry?.handle ?? toBaseModelHandle(input.modelHandle, aliases);
    } else if (input.modelHandle !== undefined) {
      explicitHandle = input.modelHandle;
      targetHandle = toBaseModelHandle(input.modelHandle, aliases);
    } else if (input.model !== undefined) {
      baseEntry = byId.get(input.model);
      if (baseEntry) {
        targetHandle = baseEntry.handle;
      } else {
        explicitHandle = input.model;
        targetHandle = toBaseModelHandle(input.model, aliases);
      }
    } else {
      explicitHandle = this._model || undefined;
      targetHandle = toBaseModelHandle(this._model || undefined, aliases);
    }

    if (!targetHandle) {
      throw new Error("reasoningEffort requires a current model or explicit model/modelId/modelHandle.");
    }

    const candidates = catalog.entries.filter(
      (entry) => entry.handle === targetHandle || entry.handle === explicitHandle,
    );
    if (candidates.length === 0) {
      throw new Error(
        `reasoningEffort requires a model from listModels(); no catalog entry found for ${targetHandle}.`,
      );
    }

    const contextWindow =
      getContextWindow(baseEntry?.updateArgs) ?? getContextWindow(this._modelSettings);
    const scopedCandidates = sameContextCandidates(candidates, contextWindow);
    const matchingEntry =
      scopedCandidates.find((entry) => getReasoningEffort(entry) === input.reasoningEffort) ??
      candidates.find((entry) => getReasoningEffort(entry) === input.reasoningEffort);

    if (!matchingEntry) {
      throw new Error(
        `No ${input.reasoningEffort} reasoning tier found for model ${targetHandle}.`,
      );
    }

    const payload: UpdateModelPayload = { model_id: matchingEntry.id };
    if (explicitHandle !== undefined) {
      payload.model_handle = explicitHandle;
    }
    return payload;
  }

  protected async applyPostInitializeOptions(): Promise<void> {
    if (!this.controller || !this.runtime) return;

    const options = this.currentOptions();

    if (this.shouldEnableMemfs(options)) {
      const response = await this.controller.request(
        "enable_memfs",
        this.enableMemfsBody(),
        {
          predicate: (message) => message.type === "enable_memfs_response",
          // Enabling the memory filesystem on a cloud agent is a slow
          // multi-round-trip operation; the default request timeout is far
          // too tight for it.
          timeoutMs: 180_000,
        },
      );
      ensureSuccess(response, "Failed to enable memfs");
    }

    const dreamingSettings = resolveDreamingSettings(options.dreaming);
    const isStatelessSession =
      this.mode.kind === "session" && this.mode.options.stateless === true;
    if (dreamingSettings && !isStatelessSession) {
      const response = await this.controller.request(
        "set_reflection_settings",
        {
          runtime: this.runtime,
          settings: dreamingSettings,
          scope: "both",
        },
        { predicate: (message) => message.type === "set_reflection_settings_response" },
      );
      ensureSuccess(response, "Failed to update dreaming settings");
    }

    if (this.mode.kind !== "session") return;

    if (
      this.mode.options.model !== undefined ||
      this.mode.options.reasoningEffort !== undefined
    ) {
      await this.applyModelUpdate({
        ...(this.mode.options.model !== undefined ? { model: this.mode.options.model } : {}),
        ...(this.mode.options.reasoningEffort !== undefined
          ? { reasoningEffort: this.mode.options.reasoningEffort }
          : {}),
      });
    }

    // Initial cwd and permission mode are part of runtime_start for
    // websocket protocol sessions. Reserve change_device_state for explicit
    // post-init mutations via changeDeviceState().
  }

  private emitDeviceStatus(status: SessionDeviceStatus): void {
    for (const listener of [...this.deviceStatusListeners]) {
      try {
        listener(status);
      } catch {
        // Subscriber errors must not break the protocol message pump.
      }
    }
  }
}
