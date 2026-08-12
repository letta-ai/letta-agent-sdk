import type {
  SDKErrorCode,
  SDKLoopStatusMessage,
  SDKMessage,
  SDKQueueUpdateMessage,
  SDKResultMessage,
  SDKStreamEventPayload,
  SessionDeviceStatus,
} from "./types.js";
import {
  deviceStatusRecord,
  extractTextFromContent,
  firstToolCall,
  firstToolReturn,
  isApprovalConflictSignal,
  isFailureStopReason,
  loopStatusRunIds,
  loopStatusValue,
  normalizeCallerOtid,
  queueItems,
  sameRuntime,
  streamDeltaMessageType,
  streamDeltaOtid,
  streamDeltaRecord,
  streamDeltaRunId,
  streamDeltaSeqId,
  streamDeltaStopReason,
  toSdkErrorCode,
  toSessionDeviceStatus,
  toolInputFromArguments,
  turnFinishedRecord,
  type ProtocolMessage,
  type RuntimeScope,
  type RuntimeTurnResult,
  type TurnTracker,
} from "./remote-session-protocol.js";

type RemoteTurnCoordinatorConfig = {
  label: string;
  requestTimeoutMs?: number;
  autoHandlesToolApprovals?: boolean;
  onDeviceStatus(status: SessionDeviceStatus): void;
};

const MAX_RECENTLY_SETTLED_RUN_IDS = 256;

/**
 * Owns the portable session's turn correlation and stream queue.
 *
 * Transport setup and public SDK methods stay in RemoteClientSessionCore.
 * This class only translates protocol events into SDK messages and correlates
 * those events with active or queued turns.
 */
export class RemoteTurnCoordinator {
  private readonly label: string;
  private readonly requestTimeoutMs: number | undefined;
  private readonly autoHandlesToolApprovals: boolean;
  private readonly onDeviceStatus: (status: SessionDeviceStatus) => void;
  private streamQueue: SDKMessage[] = [];
  private streamResolvers: Array<(message: SDKMessage | null) => void> = [];
  private activeTurn: TurnTracker | null = null;
  private pendingTurns: TurnTracker[] = [];
  private settledRunIds = new Set<string>();
  private nextTurnId = 0;
  private messageCounter = 0;
  private clientMessageCounter = 0;
  private closed = false;
  private _activeTurnStartedAt = 0;

  constructor(config: RemoteTurnCoordinatorConfig) {
    this.label = config.label;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.autoHandlesToolApprovals = config.autoHandlesToolApprovals === true;
    this.onDeviceStatus = config.onDeviceStatus;
  }

  get activeTurnStartedAt(): number {
    return this._activeTurnStartedAt;
  }

  hasInFlightTurn(): boolean {
    return this.activeTurn !== null || this.pendingTurns.length > 0;
  }

  /**
   * Start tracking a turn. A caller-supplied OTID doubles as the turn's
   * `clientMessageId` so queue updates carry the same correlation id the
   * persisted message will; otherwise the SDK mints one.
   */
  trackSentTurn(runtime: RuntimeScope, callerOtid?: string): TurnTracker {
    const otid = normalizeCallerOtid(callerOtid);
    const turn: TurnTracker = {
      id: ++this.nextTurnId,
      runtime,
      ...(otid !== undefined ? { otid } : {}),
      clientMessageId:
        otid ?? `sdk-message-${Date.now()}-${++this.clientMessageCounter}`,
      queuedAt: Date.now(),
      startedAt: 0,
      assistantText: "",
      runIds: new Set<string>(),
      observedTurnEvidence: false,
      observedRequiresApprovalStop: false,
      abortRequested: false,
      timeout: null,
    };

    if (this.activeTurn) {
      this.pendingTurns.push(turn);
    } else {
      this.activateTurn(turn);
    }
    return turn;
  }

  removeTrackedTurn(turn: TurnTracker): void {
    if (turn.timeout) clearTimeout(turn.timeout);
    if (this.activeTurn === turn) {
      this.activeTurn = null;
      return;
    }
    const index = this.pendingTurns.indexOf(turn);
    if (index !== -1) this.pendingTurns.splice(index, 1);
  }

  markAbortRequested(): void {
    if (this.activeTurn) this.activeTurn.abortRequested = true;
  }

  handleProtocolMessage(message: ProtocolMessage, runtime: RuntimeScope): void {
    if (!sameRuntime(message, runtime)) return;

    const statusRecord = deviceStatusRecord(message);
    if (statusRecord) {
      const status = toSessionDeviceStatus(statusRecord);
      if (status) this.onDeviceStatus(status);
      return;
    }

    if (message.type === "update_queue") {
      const sdkMessage: SDKQueueUpdateMessage = {
        type: "queue_update",
        queue: queueItems(message),
      };
      this.enqueue(sdkMessage);
      return;
    }

    if (message.type === "update_loop_status") {
      this.handleLoopStatusMessage(message);
      return;
    }

    const finished = turnFinishedRecord(message);
    if (finished) {
      this.handleTurnFinished(finished);
      return;
    }

    const delta = streamDeltaRecord(message);
    if (!delta) return;
    const active = this.activateNextTurnFromProtocol();
    if (active) {
      active.observedTurnEvidence = true;
      const runId = streamDeltaRunId(delta);
      if (runId) active.runIds.add(runId);
    }

    const sdkMessage = this.transformStreamDelta(delta);
    if (sdkMessage) this.enqueue(sdkMessage);
    this.handleTurnTerminalDelta(delta, sdkMessage);
  }

  nextMessage(): Promise<SDKMessage | null> {
    const next = this.streamQueue.shift();
    if (next) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.streamResolvers.push(resolve);
    });
  }

  /**
   * Close after the transport dropped, surfacing the failure to stream
   * consumers first.
   *
   * A plain close() resolves waiting consumers with `null`, which is
   * indistinguishable from a conversation ending normally. A dead socket
   * cannot deliver a turn-scoped failure of its own, so the error is
   * synthesized here before the queue drains.
   */
  closeWithError(detail: string): void {
    if (this.closed) return;
    const active = this.activeTurn;
    if (active) {
      this.failTurn(active, detail, {
        errorCode: "stream_closed",
        recoverable: true,
      });
    } else {
      this.enqueue({
        type: "error",
        message: detail,
        errorCode: "stream_closed",
        stopReason: "stream_closed",
        errorDetail: detail,
        recoverable: true,
      });
    }
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.activeTurn?.timeout) clearTimeout(this.activeTurn.timeout);
    for (const turn of this.pendingTurns) {
      if (turn.timeout) clearTimeout(turn.timeout);
    }
    this.activeTurn = null;
    this.pendingTurns.length = 0;
    this.resolveAll(null);
  }

  private activateTurn(turn: TurnTracker): void {
    this.activeTurn = turn;
    turn.startedAt = Date.now();
    this._activeTurnStartedAt = turn.startedAt;
    if (this.requestTimeoutMs !== undefined) {
      turn.timeout = setTimeout(() => {
        this.failTurn(turn, `Timed out waiting for ${this.label} turn`);
      }, this.requestTimeoutMs);
      (turn.timeout as { unref?: () => void }).unref?.();
    }
  }

  private activateNextTurnFromProtocol(): TurnTracker | null {
    if (this.activeTurn) return this.activeTurn;
    const next = this.pendingTurns.shift();
    if (!next) return null;
    this.activateTurn(next);
    return next;
  }

  private failTurn(
    turn: TurnTracker,
    detail: string,
    options: { errorCode?: SDKErrorCode; recoverable?: boolean } = {},
  ): void {
    if (this.activeTurn !== turn) return;
    const errorCode = options.errorCode ?? "error";
    this.enqueue({
      type: "error",
      message: detail,
      errorCode,
      stopReason: errorCode,
      errorDetail: detail,
      recoverable: options.recoverable ?? false,
    });
    this.completeActiveTurn({
      runtime: turn.runtime,
      stopReason: errorCode,
      runIds: [...turn.runIds],
      success: false,
      detail,
      errorCode,
      recoverable: options.recoverable,
    });
  }

  private completeActiveTurn(turn: RuntimeTurnResult): void {
    const active = this.activeTurn;
    if (!active) return;
    if (active.timeout) {
      clearTimeout(active.timeout);
      active.timeout = null;
    }
    this.rememberSettledRunIds(active.runIds);
    this.enqueue(this.resultFromTurn(turn, active));
    this.activeTurn = null;
  }

  private rememberSettledRunIds(runIds: Iterable<string>): void {
    for (const runId of runIds) {
      if (!runId || this.settledRunIds.has(runId)) continue;
      this.settledRunIds.add(runId);
      if (this.settledRunIds.size > MAX_RECENTLY_SETTLED_RUN_IDS) {
        const expired = this.settledRunIds.values().next().value;
        if (expired) this.settledRunIds.delete(expired);
      }
    }
  }

  private handleLoopStatusMessage(message: ProtocolMessage): void {
    const status = loopStatusValue(message);
    if (!status) return;
    const activeRunIds = loopStatusRunIds(message);
    const sdkMessage: SDKLoopStatusMessage = {
      type: "loop_status",
      status,
      activeRunIds,
    };
    this.enqueue(sdkMessage);

    const active = this.activeTurn;
    if (!active) return;
    for (const runId of activeRunIds) active.runIds.add(runId);

    const hadTurnEvidence =
      active.observedTurnEvidence || active.observedRequiresApprovalStop;
    if (!hadTurnEvidence) return;
    if (status === "WAITING_ON_APPROVAL") {
      // Loop status and approval requests arrive on different sockets. Keep a
      // callback-backed turn open until its control request continues the turn.
      if (this.autoHandlesToolApprovals) return;
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason: "requires_approval",
        runIds: [...active.runIds],
      });
      return;
    }
    if (status === "WAITING_ON_INPUT" && active.abortRequested) {
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason: "interrupted",
        runIds: [...active.runIds],
        success: false,
        detail: "Interrupted",
        errorCode: "interrupted",
      });
      return;
    }
    if (status === "WAITING_ON_INPUT" && active.observedTurnEvidence) {
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason: null,
        runIds: [...active.runIds],
      });
    }
  }

  private handleTurnFinished(finished: {
    runId?: string;
    stopReason: string;
    error?: string;
  }): void {
    const active = this.activeTurn;
    if (!active || !finished.runId) return;
    if (this.settledRunIds.has(finished.runId)) return;
    if (
      active.runIds.size > 0 &&
      !active.runIds.has(finished.runId)
    ) {
      return;
    }
    active.runIds.add(finished.runId);
    if (finished.stopReason === "requires_approval") {
      active.observedRequiresApprovalStop = true;
      if (!this.autoHandlesToolApprovals) {
        this.completeActiveTurn({
          runtime: active.runtime,
          stopReason: finished.stopReason,
          runIds: [...active.runIds],
        });
      }
      return;
    }
    const errorCode = toSdkErrorCode(finished.stopReason);
    const success = !isFailureStopReason(finished.stopReason);
    this.completeActiveTurn({
      runtime: active.runtime,
      stopReason: finished.stopReason,
      runIds: [...active.runIds],
      success,
      ...(success ? {} : { errorCode: errorCode ?? "error" }),
      ...(finished.error ? { detail: finished.error } : {}),
    });
  }

  private handleTurnTerminalDelta(
    delta: Record<string, unknown>,
    sdkMessage: SDKMessage | null,
  ): void {
    const active = this.activeTurn;
    if (!active) return;
    const messageType = streamDeltaMessageType(delta);
    if (messageType === "stop_reason") {
      const stopReason = streamDeltaStopReason(delta) ?? null;
      if (stopReason === "requires_approval") {
        active.observedRequiresApprovalStop = true;
        return;
      }
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason,
        runIds: [...active.runIds],
      });
      return;
    }

    if (sdkMessage?.type === "error") {
      this.completeActiveTurn({
        runtime: active.runtime,
        stopReason: sdkMessage.stopReason,
        runIds: [...active.runIds],
        success: false,
        detail: sdkMessage.errorDetail ?? sdkMessage.message,
        errorCode: sdkMessage.errorCode,
      });
    }
  }

  private transformStreamDelta(
    delta: Record<string, unknown>,
  ): SDKMessage | null {
    const messageType =
      typeof delta.message_type === "string" ? delta.message_type : undefined;
    const runId = typeof delta.run_id === "string" ? delta.run_id : undefined;
    const otid = streamDeltaOtid(delta);
    const seqId = streamDeltaSeqId(delta);
    const uuid =
      typeof delta.id === "string"
        ? delta.id
        : `${this.label}-${++this.messageCounter}`;

    if (messageType === "assistant_message") {
      const content = extractTextFromContent(delta.content);
      if (!content) return null;
      if (this.activeTurn) this.activeTurn.assistantText += content;
      return {
        type: "assistant",
        content,
        uuid,
        ...(otid !== undefined ? { otid } : {}),
        ...(seqId !== undefined ? { seqId } : {}),
        runId,
      };
    }

    if (messageType === "reasoning_message") {
      const content =
        typeof delta.reasoning === "string"
          ? delta.reasoning
          : extractTextFromContent(delta.content);
      if (!content) return null;
      return {
        type: "reasoning",
        content,
        uuid,
        ...(otid !== undefined ? { otid } : {}),
        ...(seqId !== undefined ? { seqId } : {}),
        runId,
      };
    }

    if (
      messageType === "tool_call_message" ||
      messageType === "approval_request_message"
    ) {
      const toolCall = firstToolCall(delta);
      if (!toolCall) return null;
      const fn =
        toolCall.function && typeof toolCall.function === "object"
          ? (toolCall.function as Record<string, unknown>)
          : undefined;
      const toolCallId =
        (typeof toolCall.tool_call_id === "string"
          ? toolCall.tool_call_id
          : undefined) ??
        (typeof toolCall.id === "string" ? toolCall.id : undefined);
      if (!toolCallId) {
        const detail = `Missing tool_call_id in ${messageType} (uuid=${uuid})`;
        return {
          type: "error",
          message: detail,
          errorCode: "protocol_error",
          stopReason: "protocol_error",
          runId,
          recoverable: false,
          errorDetail: detail,
        };
      }
      const toolName =
        (typeof toolCall.name === "string" ? toolCall.name : undefined) ??
        (typeof fn?.name === "string" ? fn.name : undefined) ??
        "?";
      const { input, raw } = toolInputFromArguments(
        toolCall.arguments ?? fn?.arguments,
      );
      return {
        type: "tool_call",
        toolCallId,
        toolName,
        toolInput: input,
        rawArguments: raw,
        uuid,
        runId,
      };
    }

    if (messageType === "tool_return_message") {
      const toolReturn = firstToolReturn(delta) ?? delta;
      const toolCallId =
        (typeof delta.tool_call_id === "string"
          ? delta.tool_call_id
          : undefined) ??
        (typeof toolReturn.tool_call_id === "string"
          ? toolReturn.tool_call_id
          : undefined);
      if (!toolCallId) return null;
      const content =
        extractTextFromContent(
          delta.tool_return ?? toolReturn.tool_return ?? toolReturn.content,
        ) ?? "";
      const status =
        typeof delta.status === "string" ? delta.status : toolReturn.status;
      return {
        type: "tool_result",
        toolCallId,
        content,
        isError: status === "error",
        uuid,
        runId,
      };
    }

    if (messageType === "error_message" || messageType === "loop_error") {
      const detail =
        (typeof delta.detail === "string" ? delta.detail : undefined) ??
        (typeof delta.message === "string" ? delta.message : undefined) ??
        `${this.label} turn failed`;
      const stopReason =
        (typeof delta.stop_reason === "string"
          ? delta.stop_reason
          : undefined) ??
        (typeof delta.error_type === "string"
          ? delta.error_type
          : undefined) ??
        "error";
      const approvalConflict = isApprovalConflictSignal({
        detail,
        message:
          typeof delta.message === "string" ? delta.message : undefined,
        stopReason,
      });
      return {
        type: "error",
        message: detail,
        errorCode: approvalConflict
          ? "approval_conflict"
          : toSdkErrorCode(stopReason),
        approvalConflict: approvalConflict || undefined,
        recoverable: approvalConflict ? true : false,
        errorDetail: detail,
        stopReason,
        runId,
      };
    }

    if (messageType === "retry") {
      return {
        type: "retry",
        reason: typeof delta.reason === "string" ? delta.reason : "error",
        attempt: typeof delta.attempt === "number" ? delta.attempt : 0,
        maxAttempts:
          typeof delta.max_attempts === "number" ? delta.max_attempts : 0,
        delayMs: typeof delta.delay_ms === "number" ? delta.delay_ms : 0,
        runId,
      };
    }

    if (messageType === "stop_reason" || messageType === "ping") {
      return null;
    }

    return {
      type: "stream_event",
      event: delta as SDKStreamEventPayload,
      uuid,
    };
  }

  private resultFromTurn(
    turn: RuntimeTurnResult,
    tracker?: TurnTracker,
  ): SDKResultMessage {
    const stopReason =
      turn.stopReason ?? (turn.success === false ? "error" : undefined);
    const approvalConflict = isApprovalConflictSignal({
      detail: turn.detail,
      stopReason,
    });
    const success =
      turn.success !== undefined
        ? turn.success &&
          !approvalConflict &&
          !isFailureStopReason(stopReason)
        : !approvalConflict && !isFailureStopReason(stopReason);
    const errorCode = approvalConflict
      ? "approval_conflict"
      : (turn.errorCode ?? toSdkErrorCode(stopReason));

    return {
      type: "result",
      success,
      result: success ? tracker?.assistantText || undefined : undefined,
      error: success ? undefined : (errorCode ?? stopReason ?? "error"),
      errorCode: success ? undefined : (errorCode ?? "error"),
      approvalConflict: approvalConflict || undefined,
      recoverable: approvalConflict
        ? true
        : success
          ? undefined
          : (turn.recoverable ?? false),
      errorDetail: success ? undefined : turn.detail,
      stopReason,
      durationMs:
        Date.now() - (tracker?.startedAt || this._activeTurnStartedAt),
      conversationId: turn.runtime.conversation_id,
      runIds: turn.runIds.length > 0 ? turn.runIds : undefined,
    };
  }

  private enqueue(message: SDKMessage): void {
    const resolver = this.streamResolvers.shift();
    if (resolver) {
      resolver(message);
      return;
    }
    this.streamQueue.push(message);
  }

  private resolveAll(value: SDKMessage | null): void {
    for (const resolve of this.streamResolvers.splice(0)) {
      resolve(value);
    }
  }
}
