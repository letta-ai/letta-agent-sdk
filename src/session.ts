/**
 * Session
 *
 * Represents a conversation session with a Letta agent.
 * Implements the V2 API pattern: send() / receive()
 */

import { SubprocessTransport } from "./transport.js";
import type {
  InternalSessionOptions,
  SDKMessage,
  SDKInitMessage,
  SDKResultMessage,
  SDKErrorCode,
  MessageWire,
  WireMessage,
  ControlRequest,
  CanUseToolControlRequest,
  CanUseToolResponse,
  CanUseToolResponseAllow,
  CanUseToolResponseDeny,
  SendMessage,
  AnyAgentTool,
  ExecuteExternalToolRequest,
  ListMessagesOptions,
  ListMessagesResult,
  ListModelsResult,
  BootstrapStateOptions,
  BootstrapStateResult,
  ChangeDeviceStateOptions,
  GetDeviceStatusOptions,
  SessionDeviceStatus,
  SDKStreamEventPayload,
  RunTurnOptions,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  RemoveQueuedMessageResult,
  SDKProtocolCommand,
  SDKProtocolMessage,
  SendCommandOptions,
  UpdateModelOptions,
  UpdateModelResult,
} from "./types.js";
import {
  buildCanUseToolContext,
  isHeadlessAutoAllowTool,
  requiresRuntimeUserInput,
} from "./interactiveToolPolicy.js";
import { isUnrestrictedPermissionMode } from "./remote-client-session-core.js";


// All logging gated behind DEBUG_SDK env var
function sessionLog(tag: string, ...args: unknown[]) {
  if (process.env.DEBUG_SDK) console.error(`[SDK-Session] [${tag}]`, ...args);
}

const MAX_BUFFERED_STREAM_MESSAGES = 100;
const DEFAULT_MAX_APPROVAL_RECOVERY_ATTEMPTS = 1;
const DEFAULT_APPROVAL_RECOVERY_TIMEOUT_MS = 5_000;

const KNOWN_SDK_ERROR_CODES = new Set<SDKErrorCode>([
  "approval_conflict",
  "approval_conflict_terminal",
  "protocol_error",
  "error",
  "llm_api_error",
  "max_steps",
  "interrupted",
  "stream_closed",
]);

function isKnownSdkErrorCode(value: string): value is SDKErrorCode {
  return KNOWN_SDK_ERROR_CODES.has(value as SDKErrorCode);
}

function toSdkErrorCode(value: string | undefined): SDKErrorCode | undefined {
  if (!value || value.length === 0) return undefined;
  return isKnownSdkErrorCode(value) ? value : undefined;
}

function isUnknownControlSubtypeError(
  errorMessage: string | undefined,
  subtype: string,
): boolean {
  if (!errorMessage) return false;
  return errorMessage
    .toLowerCase()
    .includes(`unknown control request subtype: ${subtype}`.toLowerCase());
}

function extractApiErrorDetail(apiError: Record<string, unknown> | undefined): string | undefined {
  const detail = apiError?.detail;
  if (typeof detail !== "string") return undefined;
  const trimmed = detail.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isApprovalConflictSignal(params: {
  detail?: string;
  message?: string;
  stopReason?: string;
}): boolean {
  if (params.stopReason === "requires_approval") return true;
  // Stopgap heuristic until the server emits a first-class structured
  // approval-conflict code in wire payloads.
  const haystack = [params.detail, params.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
  if (!haystack) return false;
  return (
    haystack.includes("waiting for approval on a tool call") ||
    haystack.includes("cannot send a new message") ||
    haystack.includes("requires_approval")
  );
}

type BufferedStreamMessage = {
  message: SDKMessage;
  generation: number;
  runId?: string;
};

export class Session implements AsyncDisposable {
  private transport: SubprocessTransport;
  private _agentId: string | null = null;
  private _sessionId: string | null = null;
  private _conversationId: string | null = null;
  private initialized = false;
  private closed = false;
  private initializePromise: Promise<SDKInitMessage> | null = null;
  private externalTools: Map<string, AnyAgentTool> = new Map();
  private streamQueue: BufferedStreamMessage[] = [];
  private streamResolvers: Array<(msg: BufferedStreamMessage | null) => void> = [];
  private pumpPromise: Promise<void> | null = null;
  private pumpClosed = false;
  private droppedStreamMessages = 0;
  // Monotonic counter incremented after each send(). Messages enqueued by the
  // pump are tagged with the current generation; stream() filters out messages
  // from earlier generations to prevent N-1 desync (stale events from a
  // previous run leaking into the current run's stream).
  private sendGeneration = 0;
  // Run IDs that completed in the previous streamed turn. Used to drop
  // late-arriving stale events from the old run if they arrive after send().
  private lastCompletedRunIds = new Set<string>();
  // Waiters for SDK-initiated control requests (e.g., listMessages).
  // Keyed by request_id; pump resolves the matching waiter when it sees
  // a control_response with that request_id instead of queuing it as a stream msg.
  private controlResponseWaiters = new Map<
    string,
    (response: { subtype: string; response?: unknown; error?: string }) => void
  >();

  constructor(
    private options: InternalSessionOptions = {}
  ) {
    // Note: Validation happens in public API functions (createSession, createAgent, etc.)
    if (options.reasoningEffort !== undefined) {
      throw new Error(
        "reasoningEffort is not supported by this session. Create a Cloud, Remote, or local agent session before setting reasoning effort.",
      );
    }
    this.transport = new SubprocessTransport(options);

    // Store external tools in a map for quick lookup
    if (options.tools) {
      for (const tool of options.tools) {
        this.externalTools.set(tool.name, tool);
      }
    }
  }

  /**
   * Initialize the session (called automatically on first send).
   *
   * Single-flight: concurrent callers (including lazily-initializing entry
   * points such as send()) share one in-flight initialization instead of
   * each connecting the transport. A failed stdio attempt closes the session
   * because its subprocess transport is no longer safe to reuse.
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
        // A failed stdio initialization can leave its one subprocess
        // transport unusable. Closing this session cannot affect another
        // initialize attempt because all callers share this promise.
        this.cleanupFailedInitialize();
        throw error;
      })
      .finally(() => {
        if (this.initializePromise === memo) {
          this.initializePromise = null;
        }
      });
    this.initializePromise = memo;
    return memo;
  }

  private async performInitialize(): Promise<SDKInitMessage> {
    sessionLog("init", "connecting transport...");
    await this.transport.connect();
    sessionLog("init", "transport connected, sending initialize request");

    // Send initialize control request
    await this.transport.write({
      type: "control_request",
      request_id: "init_1",
      request: { subtype: "initialize" },
    });

    // Wait for init message
    sessionLog("init", "waiting for init message from CLI...");
    for await (const msg of this.transport.messages()) {
      sessionLog("init", `received wire message: type=${msg.type}`);

      if (msg.type === "control_request") {
        const handled = await this.handleControlRequest(msg as ControlRequest);
        if (!handled) {
          const wireMsgAny = msg as unknown as Record<string, unknown>;
          sessionLog("init", `DROPPED unsupported control_request: subtype=${(wireMsgAny.request as Record<string, unknown>)?.subtype || "N/A"}`);
        }
        continue;
      }

      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        const initMsg = msg as WireMessage & {
          agent_id: string;
          session_id: string;
          conversation_id: string;
          model: string;
          tools: string[];
          memfs_enabled?: boolean;
          skill_sources?: Array<"bundled" | "global" | "agent" | "project">;
          system_info_reminder_enabled?: boolean;
          reflection_trigger?: "off" | "step-count" | "compaction-event";
          reflection_behavior?: "reminder" | "auto-launch";
          reflection_step_count?: number;
        };
        this._agentId = initMsg.agent_id;
        this._sessionId = initMsg.session_id;
        this._conversationId = initMsg.conversation_id;

        // Register external tools with CLI
        if (this.externalTools.size > 0) {
          await this.registerExternalTools();
        }
        if (this.closed) {
          throw new Error("Session is closed");
        }

        this.initialized = true;
        this.startBackgroundPump();

        // Include external tool names in the tools list
        const allTools = [
          ...initMsg.tools,
          ...Array.from(this.externalTools.keys()),
        ];

        sessionLog("init", `initialized: agent=${initMsg.agent_id} conversation=${initMsg.conversation_id} model=${initMsg.model} tools=${allTools.length} (${this.externalTools.size} external)`);

        return {
          type: "init",
          agentId: initMsg.agent_id,
          sessionId: initMsg.session_id,
          conversationId: initMsg.conversation_id,
          model: initMsg.model,
          tools: allTools,
          memfsEnabled: initMsg.memfs_enabled,
          skillSources: initMsg.skill_sources,
          systemInfoReminderEnabled: initMsg.system_info_reminder_enabled,
          dreaming:
            initMsg.reflection_trigger &&
            initMsg.reflection_behavior &&
            typeof initMsg.reflection_step_count === "number"
              ? {
                  trigger: initMsg.reflection_trigger,
                  behavior: initMsg.reflection_behavior,
                  stepCount: initMsg.reflection_step_count,
                }
              : undefined,
        };
      }
    }

    const stderr = this.transport.getStderr();
    const detail = stderr ? `\nCLI stderr:\n${stderr}` : '';
    sessionLog("init", `ERROR: transport closed before init message received${detail}`);
    throw new Error(`Failed to initialize session - no init message received${detail}`);
  }

  private cleanupFailedInitialize(): void {
    this.transport.close();
    this.closed = true;
    this.initialized = false;
    this._agentId = null;
    this._sessionId = null;
    this._conversationId = null;
    this.pumpClosed = true;
    this.resolveAllStreamWaiters(null);
  }

  /**
   * Send a message to the agent
   * 
   * @param message - Text string or multimodal content array
   * 
   * @example
   * // Simple text
   * await session.send("Hello!");
   * 
   * @example
   * // With image
   * await session.send([
   *   { type: "text", text: "What's in this image?" },
   *   { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }
   * ]);
   */
  async send(message: SendMessage): Promise<void> {
    if (!this.initialized) {
      sessionLog("send", "auto-initializing (not yet initialized)");
      await this.initialize();
    }

    const preview = typeof message === "string"
      ? message.slice(0, 100)
      : Array.isArray(message) ? `[multimodal: ${message.length} parts]` : String(message).slice(0, 100);
    sessionLog("send", `sending message: ${preview}${typeof message === "string" && message.length > 100 ? "..." : ""}`);

    // Clear stale messages from previous turn to prevent desync
    if (this.streamQueue.length > 0) {
      sessionLog("send", `clearing ${this.streamQueue.length} stale messages from previous turn`);
      this.streamQueue.length = 0;
    }

    await this.transport.write({
      type: "user",
      message: { role: "user", content: message },
    });

    // Advance generation AFTER the write so any messages the pump enqueues
    // during the await (from the previous run's lingering events) are tagged
    // with the old generation and will be filtered by stream().
    this.sendGeneration++;
    sessionLog("send", `message written to transport (generation=${this.sendGeneration})`);
  }

  /**
   * Run a full turn (send + stream terminal result), with optional bounded
   * SDK-owned approval-conflict recovery.
   */
  async runTurn(
    message: SendMessage,
    options: RunTurnOptions = {},
  ): Promise<SDKResultMessage> {
    const maxApprovalRecoveryAttempts =
      this.resolveMaxApprovalRecoveryAttempts(options);
    const recoveryTimeoutMs = this.resolveApprovalRecoveryTimeoutMs(options);

    let recoveryAttempts = 0;
    let result = await this.runSingleTurn(message);

    while (
      !result.success &&
      result.approvalConflict === true &&
      recoveryAttempts < maxApprovalRecoveryAttempts
    ) {
      recoveryAttempts += 1;
      const recovery = await this.recoverPendingApprovals({
        timeoutMs: recoveryTimeoutMs,
      });

      if (!recovery.recovered) {
        return this.toTerminalApprovalConflictResult(result, {
          recoveryAttempts,
          detail: recovery.detail,
        });
      }

      result = await this.runSingleTurn(message);
    }

    if (!result.success && result.approvalConflict === true) {
      return this.toTerminalApprovalConflictResult(result, { recoveryAttempts });
    }

    if (recoveryAttempts > 0) {
      result.recoveryAttempts = recoveryAttempts;
    }

    return result;
  }

  /**
   * Ask the CLI to recover pending approvals for the current
   * agent/conversation context.
   */
  async recoverPendingApprovals(
    options: RecoverPendingApprovalsOptions = {},
  ): Promise<RecoverPendingApprovalsResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const timeoutMs =
      options.timeoutMs ??
      this.options.approvalRecoveryTimeoutMs ??
      DEFAULT_APPROVAL_RECOVERY_TIMEOUT_MS;

    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        "Invalid approval recovery timeout. Expected a positive integer.",
      );
    }

    const requestId = `recover-approvals-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    let resp: { subtype: string; response?: unknown; error?: string };
    try {
      resp = await this.requestControlResponse(
        requestId,
        {
          subtype: "recover_pending_approvals",
          ...(this._agentId ? { agent_id: this._agentId } : {}),
          ...(this._conversationId ? { conversation_id: this._conversationId } : {}),
        },
        { timeoutMs },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        recovered: false,
        unsupported: false,
        detail,
      };
    }

    if (resp.subtype === "error") {
      const detail = resp.error ?? "recover_pending_approvals failed";
      return {
        recovered: false,
        pendingApproval: true,
        unsupported: isUnknownControlSubtypeError(
          detail,
          "recover_pending_approvals",
        ),
        detail,
      };
    }

    return {
      recovered: true,
      pendingApproval: false,
      unsupported: false,
    };
  }

  private resolveMaxApprovalRecoveryAttempts(options: RunTurnOptions): number {
    const value =
      options.maxApprovalRecoveryAttempts ??
      this.options.maxApprovalRecoveryAttempts ??
      DEFAULT_MAX_APPROVAL_RECOVERY_ATTEMPTS;

    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        "Invalid maxApprovalRecoveryAttempts. Expected a non-negative integer.",
      );
    }

    return value;
  }

  private resolveApprovalRecoveryTimeoutMs(options: RunTurnOptions): number {
    const value =
      options.recoveryTimeoutMs ??
      this.options.approvalRecoveryTimeoutMs ??
      DEFAULT_APPROVAL_RECOVERY_TIMEOUT_MS;

    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        "Invalid approval recovery timeout. Expected a positive integer.",
      );
    }

    return value;
  }

  private toTerminalApprovalConflictResult(
    result: SDKResultMessage,
    options: { recoveryAttempts: number; detail?: string },
  ): SDKResultMessage {
    return {
      ...result,
      success: false,
      error: "approval_conflict_terminal",
      errorCode: "approval_conflict_terminal",
      approvalConflict: true,
      recoverable: false,
      recoveryAttempts: options.recoveryAttempts,
      errorDetail:
        options.detail ||
        result.errorDetail ||
        "Approval conflict remained unresolved after bounded SDK recovery.",
    };
  }

  private async runSingleTurn(message: SendMessage): Promise<SDKResultMessage> {
    await this.send(message);

    let latestApprovalConflictDetail: string | undefined;
    let latestNonConflictErrorDetail: string | undefined;

    for await (const msg of this.stream()) {
      if (msg.type === "error") {
        const detail = msg.errorDetail || msg.message;
        if (msg.approvalConflict) {
          latestApprovalConflictDetail = detail;
        } else {
          latestNonConflictErrorDetail = detail;
        }
        continue;
      }

      if (msg.type === "result") {
        if (!msg.success && !msg.errorDetail) {
          if (msg.approvalConflict && latestApprovalConflictDetail) {
            return {
              ...msg,
              errorDetail: latestApprovalConflictDetail,
            };
          }

          if (!msg.approvalConflict && latestNonConflictErrorDetail) {
            return {
              ...msg,
              errorDetail: latestNonConflictErrorDetail,
            };
          }
        }

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
      durationMs: 0,
      conversationId: this._conversationId,
    };
  }

  /**
   * Stream messages from the agent
   */
  async *stream(): AsyncGenerator<SDKMessage> {
    const streamStart = Date.now();
    const minGeneration = this.sendGeneration;
    let yieldCount = 0;
    let staleCount = 0;
    let staleRunIdCount = 0;
    let gotResult = false;
    const currentStreamRunIds = new Set<string>();
    const staleRunIds = new Set(this.lastCompletedRunIds);
    const approvalConflictDetailsByRunId = new Map<string, string>();
    let latestApprovalConflictDetail: string | undefined;

    this.startBackgroundPump();
    sessionLog("stream", `starting stream (agent=${this._agentId}, conversation=${this._conversationId}, generation=${minGeneration})`);

    while (true) {
      const bufferedMsg = await this.nextBufferedMessage();
      if (!bufferedMsg) {
        break;
      }

      // Filter stale messages from previous runs. Messages enqueued before
      // the current send() carry an older generation tag.
      if (bufferedMsg.generation < minGeneration) {
        staleCount++;
        sessionLog("stream", `discarding stale message: type=${bufferedMsg.message.type} generation=${bufferedMsg.generation} (current=${minGeneration})`);
        continue;
      }

      // Filter late old-run messages that arrive after send() has already
      // advanced generation and stream queue was cleared.
      if (bufferedMsg.runId && staleRunIds.has(bufferedMsg.runId)) {
        staleRunIdCount++;
        sessionLog("stream", `discarding stale message: type=${bufferedMsg.message.type} runId=${bufferedMsg.runId}`);
        continue;
      }

      if (bufferedMsg.runId) {
        currentStreamRunIds.add(bufferedMsg.runId);
      }

      const sdkMsg = bufferedMsg.message;

      if (sdkMsg.type === "error" && sdkMsg.approvalConflict) {
        const detail = sdkMsg.errorDetail || sdkMsg.message;
        if (detail) {
          latestApprovalConflictDetail = detail;
          if (sdkMsg.runId) {
            approvalConflictDetailsByRunId.set(sdkMsg.runId, detail);
          }
        }
      }

      let normalizedMsg: SDKMessage = sdkMsg;

      if (sdkMsg.type === "result" && !sdkMsg.success) {
        let detail = sdkMsg.errorDetail;
        if (!detail && Array.isArray(sdkMsg.runIds)) {
          for (const runId of sdkMsg.runIds) {
            const fromRun = approvalConflictDetailsByRunId.get(runId);
            if (fromRun) {
              detail = fromRun;
              break;
            }
          }
        }
        if (!detail) {
          detail = latestApprovalConflictDetail;
        }

        const approvalConflict =
          sdkMsg.approvalConflict === true
          || isApprovalConflictSignal({
            detail,
            message: sdkMsg.errorCode || sdkMsg.error,
            stopReason: sdkMsg.stopReason,
          });

        if (approvalConflict) {
          const normalizedErrorCode =
            !sdkMsg.errorCode || sdkMsg.errorCode === "error"
              ? "approval_conflict"
              : sdkMsg.errorCode;
          const normalizedError =
            !sdkMsg.error || sdkMsg.error === "error"
              ? normalizedErrorCode
              : sdkMsg.error;

          normalizedMsg = {
            ...sdkMsg,
            approvalConflict: true,
            recoverable: sdkMsg.recoverable ?? true,
            ...(detail ? { errorDetail: detail } : {}),
            errorCode: normalizedErrorCode,
            error: normalizedError,
          };
        } else if (!sdkMsg.errorCode && sdkMsg.error) {
          const errorCode = toSdkErrorCode(sdkMsg.error);
          if (errorCode) {
            normalizedMsg = {
              ...sdkMsg,
              errorCode,
            };
          }
        }
      }

      yieldCount++;
      sessionLog("stream", `yield #${yieldCount}: type=${normalizedMsg.type}${normalizedMsg.type === "result" ? ` success=${(normalizedMsg as SDKResultMessage).success} error=${(normalizedMsg as SDKResultMessage).error || "none"}` : ""}`);
      yield normalizedMsg;

      // Stop on result message
      if (normalizedMsg.type === "result") {
        gotResult = true;
        this.updateCompletedRunIds((normalizedMsg as SDKResultMessage).runIds, currentStreamRunIds);
        break;
      }
    }

    const elapsed = Date.now() - streamStart;
    sessionLog("stream", `stream ended: duration=${elapsed}ms yielded=${yieldCount} staleFiltered=${staleCount} staleRunIdFiltered=${staleRunIdCount} dropped=${this.droppedStreamMessages} gotResult=${gotResult}`);
    if (!gotResult) {
      sessionLog("stream", "WARNING: stream ended WITHOUT a result message -- transport may have closed unexpectedly");
    }
  }

  private startBackgroundPump(): void {
    if (this.pumpPromise) {
      return;
    }

    this.pumpClosed = false;
    this.pumpPromise = this.runBackgroundPump()
      .catch((err) => {
        sessionLog("pump", `ERROR: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.pumpClosed = true;
        this.resolveAllStreamWaiters(null);
      });
  }

  private async runBackgroundPump(): Promise<void> {
    sessionLog("pump", "background pump started");

    // Tool call chunks are emitted immediately (no buffering).
    // Consumers that need complete arguments should accumulate rawArguments
    // across chunks sharing the same toolCallId on their side.
    //
    // Index-to-ID mapping: The Letta API follows the OpenAI streaming format
    // for parallel tool calls -- only the first chunk per tool call includes
    // tool_call_id, subsequent chunks identify themselves via index only.
    // We maintain a lightweight index->id map so transformMessage() can
    // resolve the ID for every chunk without buffering.
    const indexToToolCallId = new Map<number, string>();

    for await (const wireMsg of this.transport.messages()) {
      const wireMsgAny = wireMsg as unknown as Record<string, unknown>;

      if (wireMsg.type === "control_request") {
        const handled = await this.handleControlRequest(wireMsg as ControlRequest);
        if (!handled) {
          sessionLog("pump", `DROPPED unsupported control_request: subtype=${(wireMsgAny.request as Record<string, unknown>)?.subtype || "N/A"}`);
        }
        continue;
      }

      // Route control_response to a registered waiter (e.g., from listMessages).
      // Unmatched control_responses are logged and dropped — they never reach the stream.
      if (wireMsg.type === "control_response") {
        const respMsg = wireMsg as unknown as {
          response: { subtype: string; request_id?: string; response?: unknown; error?: string };
        };
        const requestId = respMsg.response?.request_id;
        if (requestId && this.controlResponseWaiters.has(requestId)) {
          const resolve = this.controlResponseWaiters.get(requestId)!;
          this.controlResponseWaiters.delete(requestId);
          resolve(respMsg.response);
        } else {
          sessionLog("pump", `DROPPED unmatched control_response: request_id=${requestId ?? "N/A"}`);
        }
        continue;
      }

      // For tool_call_message chunks, resolve index-based IDs before transform.
      // The first chunk has both tool_call_id and index; subsequent chunks have
      // only index. Patch the wire message so transformMessage() always sees an ID.
      const messageType = wireMsgAny.message_type as string | undefined;
      if (wireMsg.type === "message" && (messageType === "tool_call_message" || messageType === "approval_request_message")) {
        const toolCalls = wireMsgAny.tool_calls as Array<Record<string, unknown>> | undefined;
        const toolCall = wireMsgAny.tool_call as Record<string, unknown> | undefined;
        const tc = toolCalls?.[0] || toolCall;
        if (tc) {
          const fnObj = tc.function as Record<string, unknown> | undefined;
          const tcId = (tc.tool_call_id as string | undefined) ?? (tc.id as string | undefined);
          const tcIndex = tc.index as number | undefined;

          if (tcId && tcIndex !== undefined) {
            indexToToolCallId.set(tcIndex, tcId);
          } else if (!tcId && tcIndex !== undefined) {
            const resolvedId = indexToToolCallId.get(tcIndex);
            if (resolvedId) {
              // Patch the resolved ID into the wire message for transformMessage
              if (fnObj) {
                tc.id = resolvedId;
              } else {
                tc.tool_call_id = resolvedId;
              }
            }
          }
        }
      }

      const sdkMsg = this.transformMessage(wireMsg);
      if (sdkMsg) {
        this.enqueueStreamMessage(sdkMsg);
      } else {
        sessionLog("pump", `DROPPED wire message: type=${wireMsg.type} message_type=${wireMsgAny.message_type || "N/A"} subtype=${wireMsgAny.subtype || "N/A"}`);
      }
    }

    sessionLog("pump", "background pump ended");
  }

  private async handleControlRequest(controlReq: ControlRequest): Promise<boolean> {
    // Widen to string to allow SDK-extension subtypes not in the protocol union
    const subtype: string = controlReq.request.subtype;
    sessionLog("pump", `control_request: subtype=${subtype} tool=${(controlReq.request as CanUseToolControlRequest).tool_name || "N/A"}`);

    if (subtype === "can_use_tool") {
      await this.handleCanUseTool(
        controlReq.request_id,
        controlReq.request as CanUseToolControlRequest
      );
      return true;
    }

    if (subtype === "execute_external_tool") {
      // SDK extension: not in protocol ControlRequestBody union, extract fields via Record
      const rawReq = controlReq.request as Record<string, unknown>;
      await this.handleExecuteExternalTool(
        controlReq.request_id,
        {
          subtype: "execute_external_tool",
          tool_call_id: rawReq.tool_call_id as string,
          tool_name: rawReq.tool_name as string,
          input: rawReq.input as Record<string, unknown>,
        }
      );
      return true;
    }

    return false;
  }

  private enqueueStreamMessage(msg: SDKMessage): void {
    const bufferedMsg: BufferedStreamMessage = {
      message: msg,
      generation: this.sendGeneration,
      runId: this.getMessageRunId(msg),
    };

    if (this.streamResolvers.length > 0) {
      const resolve = this.streamResolvers.shift()!;
      resolve(bufferedMsg);
      return;
    }

    if (this.streamQueue.length >= MAX_BUFFERED_STREAM_MESSAGES) {
      this.streamQueue.shift();
      this.droppedStreamMessages++;
      sessionLog("pump", `stream queue overflow: dropped oldest message (total_dropped=${this.droppedStreamMessages}, max=${MAX_BUFFERED_STREAM_MESSAGES})`);
    }

    this.streamQueue.push(bufferedMsg);
  }

  private async nextBufferedMessage(): Promise<BufferedStreamMessage | null> {
    if (this.streamQueue.length > 0) {
      return this.streamQueue.shift()!;
    }

    if (this.pumpClosed) {
      return null;
    }

    return new Promise((resolve) => {
      this.streamResolvers.push(resolve);
    });
  }

  private resolveAllStreamWaiters(msg: BufferedStreamMessage | null): void {
    for (const resolve of this.streamResolvers) {
      resolve(msg);
    }
    this.streamResolvers = [];
    // Also cancel any in-flight control request waiters (e.g., listMessages)
    for (const resolve of this.controlResponseWaiters.values()) {
      resolve({ subtype: "error", error: "session closed" });
    }
    this.controlResponseWaiters.clear();
  }

  private getMessageRunId(msg: SDKMessage): string | undefined {
    switch (msg.type) {
      case "assistant":
      case "tool_call":
      case "tool_result":
      case "reasoning":
      case "error":
      case "retry":
        return msg.runId;
      default:
        return undefined;
    }
  }

  private updateCompletedRunIds(
    resultRunIds: string[] | undefined,
    streamedRunIds: Set<string>,
  ): void {
    const nextRunIds = new Set<string>();

    if (Array.isArray(resultRunIds)) {
      for (const runId of resultRunIds) {
        if (runId) {
          nextRunIds.add(runId);
        }
      }
    }

    for (const runId of streamedRunIds) {
      if (runId) {
        nextRunIds.add(runId);
      }
    }

    this.lastCompletedRunIds = nextRunIds;
  }

  /**
   * Register external tools with the CLI
   */
  private async registerExternalTools(): Promise<void> {
    const toolDefs = Array.from(this.externalTools.values()).map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      // Convert TypeBox schema to plain JSON Schema
      parameters: this.schemaToJsonSchema(tool.parameters),
    }));

    sessionLog("registerTools", `registering ${toolDefs.length} external tools: ${toolDefs.map(t => t.name).join(", ")}`);

    await this.transport.write({
      type: "control_request",
      request_id: `register_tools_${Date.now()}`,
      request: {
        subtype: "register_external_tools",
        tools: toolDefs,
      },
    });
  }

  /**
   * Convert TypeBox schema to JSON Schema
   */
  private schemaToJsonSchema(schema: unknown): Record<string, unknown> {
    // TypeBox schemas are already JSON Schema compatible
    // Just need to extract the schema object
    if (schema && typeof schema === "object") {
      // TypeBox schemas have these JSON Schema properties
      const s = schema as Record<string, unknown>;
      return {
        type: s.type,
        properties: s.properties,
        required: s.required,
        additionalProperties: s.additionalProperties,
        description: s.description,
      };
    }
    return { type: "object" };
  }

  /**
   * Handle execute_external_tool control request from CLI
   */
  private async handleExecuteExternalTool(
    requestId: string,
    req: ExecuteExternalToolRequest
  ): Promise<void> {
    const tool = this.externalTools.get(req.tool_name);
    
    if (!tool) {
      // Tool not found - send error result
      sessionLog("executeExternalTool", `ERROR: unknown tool ${req.tool_name}`);
      await this.transport.write({
        type: "control_response",
        response: {
          subtype: "external_tool_result",
          request_id: requestId,
          tool_call_id: req.tool_call_id,
          content: [{ type: "text", text: `Unknown external tool: ${req.tool_name}` }],
          is_error: true,
        },
      });
      return;
    }

    try {
      sessionLog("executeExternalTool", `executing ${req.tool_name} (call_id=${req.tool_call_id})`);
      // Execute the tool
      const result = await tool.execute(req.tool_call_id, req.input);
      
      // Send success result
      await this.transport.write({
        type: "control_response",
        response: {
          subtype: "external_tool_result",
          request_id: requestId,
          tool_call_id: req.tool_call_id,
          content: result.content,
          is_error: false,
        },
      });
      sessionLog("executeExternalTool", `${req.tool_name} completed successfully`);
    } catch (err) {
      // Send error result
      const errorMessage = err instanceof Error ? err.message : String(err);
      sessionLog("executeExternalTool", `${req.tool_name} failed: ${errorMessage}`);
      await this.transport.write({
        type: "control_response",
        response: {
          subtype: "external_tool_result",
          request_id: requestId,
          tool_call_id: req.tool_call_id,
          content: [{ type: "text", text: `Tool execution error: ${errorMessage}` }],
          is_error: true,
        },
      });
    }
  }

  /**
   * Handle can_use_tool control request from CLI (Claude SDK compatible format)
   */
  private async handleCanUseTool(
    requestId: string,
    req: CanUseToolControlRequest
  ): Promise<void> {
    let response: CanUseToolResponse;
    const toolName = req.tool_name;
    const hasCallback = typeof this.options.canUseTool === "function";
    const toolNeedsRuntimeUserInput = requiresRuntimeUserInput(toolName);
    const autoAllowWithoutCallback =
      isHeadlessAutoAllowTool(toolName);

    sessionLog("canUseTool", `tool=${toolName} mode=${this.options.permissionMode || "standard"} requestId=${requestId}`);

    // Tools that require runtime user input cannot be auto-allowed without a callback.
    if (toolNeedsRuntimeUserInput && !hasCallback) {
      response = {
        behavior: "deny",
        message: "No canUseTool callback registered",
        interrupt: false,
      };
    } else if (
      isUnrestrictedPermissionMode(this.options.permissionMode) &&
      !toolNeedsRuntimeUserInput
    ) {
      // unrestricted auto-allows non-interactive tools.
      sessionLog("canUseTool", `AUTO-ALLOW ${toolName} (unrestricted)`);
      response = {
        behavior: "allow",
        updatedInput: null,
        updatedPermissions: [],
      } satisfies CanUseToolResponseAllow;
    } else if (hasCallback) {
      try {
        const result = await this.options.canUseTool!(
          toolName,
          req.input,
          buildCanUseToolContext(req as unknown as Record<string, unknown>, requestId),
        );
        if (result.behavior === "allow") {
          response = {
            behavior: "allow",
            updatedInput: result.updatedInput ?? null,
            updatedPermissions: [], // TODO: not implemented
          } satisfies CanUseToolResponseAllow;
        } else {
          response = {
            behavior: "deny",
            message: result.message ?? "Denied by canUseTool callback",
            interrupt: false, // TODO: not wired up yet
          } satisfies CanUseToolResponseDeny;
        }
      } catch (err) {
        response = {
          behavior: "deny",
          message: err instanceof Error ? err.message : "Callback error",
          interrupt: false,
        };
      }
    } else if (autoAllowWithoutCallback) {
      // Default headless behavior matches Claude: EnterPlanMode can proceed
      // without requiring a callback in bidirectional mode.
      sessionLog("canUseTool", `AUTO-ALLOW ${toolName} (default behavior)`);
      response = {
        behavior: "allow",
        updatedInput: null,
        updatedPermissions: [],
      } satisfies CanUseToolResponseAllow;
    } else {
      // No callback registered - deny by default
      response = {
        behavior: "deny",
        message: "No canUseTool callback registered",
        interrupt: false,
      };
    }

    // Send control_response (Claude SDK compatible format)
    const responseBehavior = "behavior" in response ? response.behavior : "unknown";
    sessionLog("canUseTool", `responding: requestId=${requestId} behavior=${responseBehavior}`);
    await this.transport.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    });
    sessionLog("canUseTool", `response sent for ${toolName}`);
  }

  /**
   * Abort the current operation (interrupt without closing the session)
   */
  async abort(): Promise<void> {
    if (!this.initialized || this.pumpClosed) return;
    sessionLog("abort", `aborting session (agent=${this._agentId})`);
    await this.transport.write({
      type: "control_request",
      request_id: `interrupt-${Date.now()}`,
      request: { subtype: "interrupt" },
    });
  }

  private async requestControlResponse(
    requestId: string,
    request: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<{ subtype: string; response?: unknown; error?: string }> {
    const responsePromise = new Promise<{
      subtype: string;
      response?: unknown;
      error?: string;
    }>((resolve) => {
      this.controlResponseWaiters.set(requestId, resolve);
    });

    try {
      await this.transport.write({
        type: "control_request",
        request_id: requestId,
        request: request as unknown as ControlRequest["request"],
      });
    } catch (error) {
      this.controlResponseWaiters.delete(requestId);
      throw error;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      if (typeof options.timeoutMs === "number") {
        return await Promise.race([
          responsePromise,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              this.controlResponseWaiters.delete(requestId);
              reject(
                new Error(
                  `Timed out waiting for control_response (${requestId})`,
                ),
              );
            }, options.timeoutMs);
          }),
        ]);
      }

      return await responsePromise;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Fetch a page of conversation messages via the CLI control protocol.
   *
   * The session must be initialized before calling this method.
   * Safe to call concurrently with an active stream() — the pump routes
   * matching control_response messages to this waiter without touching the
   * stream queue.
   */
  async listMessages(options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    if (!this.initialized) {
      throw new Error("Session must be initialized before calling listMessages()");
    }

    const requestId = `list-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const resp = await this.requestControlResponse(requestId, {
      subtype: "list_messages",
      ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
      ...(options.before ? { before: options.before } : {}),
      ...(options.after ? { after: options.after } : {}),
      ...(options.order ? { order: options.order } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });

    if (!resp) {
      throw new Error("Session closed before listMessages response arrived");
    }
    if (resp.subtype === "error") {
      throw new Error(resp.error ?? "listMessages failed");
    }

    const payload = resp.response as {
      messages?: unknown[];
      next_before?: string | null;
      has_more?: boolean;
    } | undefined;

    return {
      messages: payload?.messages ?? [],
      nextBefore: payload?.next_before ?? null,
      hasMore: payload?.has_more ?? false,
    };
  }

  async listModels(): Promise<ListModelsResult> {
    throw new Error(
      "listModels() is not supported by this session. Use a Cloud, Remote, or local agent session.",
    );
  }

  async sendCommand(command: SDKProtocolCommand): Promise<void>;
  async sendCommand<TResponse extends SDKProtocolMessage = SDKProtocolMessage>(
    command: SDKProtocolCommand,
    options: SendCommandOptions,
  ): Promise<TResponse>;
  async sendCommand(
    _command?: SDKProtocolCommand,
    _options?: SendCommandOptions,
  ): Promise<void> {
    throw new Error(
      "sendCommand() is not supported by this session. Use a Cloud, Remote, or local agent session.",
    );
  }

  async updateModel(_update: string | UpdateModelOptions): Promise<UpdateModelResult> {
    throw new Error(
      "updateModel() is not supported by this session. Use a Cloud, Remote, or local agent session.",
    );
  }

  async changeDeviceState(_updates: ChangeDeviceStateOptions): Promise<void> {
    throw new Error(
      "changeDeviceState() is not supported by the legacy stdio transport. Use a Cloud, Remote, or local app-server session.",
    );
  }

  async removeQueuedMessage(_itemId: string): Promise<RemoveQueuedMessageResult> {
    throw new Error(
      "removeQueuedMessage() is not supported by the legacy stdio transport. Use a Cloud, Remote, or local app-server session.",
    );
  }

  async getDeviceStatus(_options?: GetDeviceStatusOptions): Promise<SessionDeviceStatus> {
    throw new Error(
      "getDeviceStatus() is not supported by the legacy stdio transport. Use a Cloud, Remote, or local app-server session.",
    );
  }

  onDeviceStatus(_listener: (status: SessionDeviceStatus) => void): () => void {
    throw new Error(
      "onDeviceStatus() is not supported by the legacy stdio transport. Use a Cloud, Remote, or local app-server session.",
    );
  }

  /**
   * Fetch all data needed to render the initial conversation view in one round-trip.
   *
   * Returns resolved session metadata + initial history page + pending approval flag
   * + optional timing breakdown.  This is faster than separate initialize() + listMessages()
   * calls because the CLI collects and returns everything in a single control response.
   *
   * The session must be initialized before calling this method.
   */
  async bootstrapState(
    options: BootstrapStateOptions = {},
  ): Promise<BootstrapStateResult> {
    if (!this.initialized) {
      throw new Error(
        "Session must be initialized before calling bootstrapState()",
      );
    }

    const requestId = `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const resp = await this.requestControlResponse(requestId, {
      subtype: "bootstrap_session_state",
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.order ? { order: options.order } : {}),
    });

    if (!resp) {
      throw new Error("Session closed before bootstrapState response arrived");
    }
    if (resp.subtype === "error") {
      throw new Error(
        (resp as { error?: string }).error ?? "bootstrapState failed",
      );
    }

    const payload = resp.response as {
      agent_id?: string;
      conversation_id?: string;
      model?: string;
      tools?: string[];
      memfs_enabled?: boolean;
      messages?: unknown[];
      next_before?: string | null;
      has_more?: boolean;
      has_pending_approval?: boolean;
      timings?: {
        resolve_ms: number;
        list_messages_ms: number;
        total_ms: number;
      };
    } | undefined;

    const state: BootstrapStateResult = {
      agentId: payload?.agent_id ?? this._agentId ?? "",
      conversationId: payload?.conversation_id ?? this._conversationId ?? "",
      model: payload?.model,
      memfsEnabled: payload?.memfs_enabled ?? false,
      messages: payload?.messages ?? [],
      nextBefore: payload?.next_before ?? null,
      hasMore: payload?.has_more ?? false,
      hasPendingApproval: payload?.has_pending_approval ?? false,
    };
    if (payload?.tools !== undefined) state.tools = payload.tools;
    if (payload?.timings !== undefined) state.timings = payload.timings;
    return state;
  }

  async updateToolset(_toolsetPreference: string): Promise<void> {
    throw new Error("updateToolset() is not supported by this session. Use a Cloud, Remote, or local agent session.");
  }

  /**
   * Close the session
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    sessionLog("close", `closing session (agent=${this._agentId}, conversation=${this._conversationId})`);
    this.transport.close();
    this.pumpClosed = true;
    this.resolveAllStreamWaiters(null);
  }

  /**
   * Get the agent ID (available after initialization)
   */
  get agentId(): string | null {
    return this._agentId;
  }

  /**
   * Get the session ID (available after initialization)
   */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Get the conversation ID (available after initialization)
   */
  get conversationId(): string | null {
    return this._conversationId;
  }

  /**
   * AsyncDisposable implementation for `await using`
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  /**
   * Transform wire message to SDK message
   */
  private transformMessage(wireMsg: WireMessage | MessageWire): SDKMessage | null {
    // Init message
    if (wireMsg.type === "system" && "subtype" in wireMsg && wireMsg.subtype === "init") {
      const msg = wireMsg as WireMessage & {
        agent_id: string;
        session_id: string;
        conversation_id: string;
        model: string;
        tools: string[];
        memfs_enabled?: boolean;
        skill_sources?: Array<"bundled" | "global" | "agent" | "project">;
        system_info_reminder_enabled?: boolean;
        reflection_trigger?: "off" | "step-count" | "compaction-event";
        reflection_behavior?: "reminder" | "auto-launch";
        reflection_step_count?: number;
      };
      return {
        type: "init",
        agentId: msg.agent_id,
        sessionId: msg.session_id,
        conversationId: msg.conversation_id,
        model: msg.model,
        tools: msg.tools,
        memfsEnabled: msg.memfs_enabled,
        skillSources: msg.skill_sources,
        systemInfoReminderEnabled: msg.system_info_reminder_enabled,
        dreaming:
          msg.reflection_trigger &&
          msg.reflection_behavior &&
          typeof msg.reflection_step_count === "number"
            ? {
                trigger: msg.reflection_trigger,
                behavior: msg.reflection_behavior,
                stepCount: msg.reflection_step_count,
              }
            : undefined,
      };
    }

    // Handle message types (all have type: "message" with message_type field)
    if (wireMsg.type === "message" && "message_type" in wireMsg) {
      const msg = wireMsg as WireMessage & {
        message_type: string;
        uuid: string;
        run_id?: string;
        // assistant_message fields
        content?: string;
        // tool_call_message fields
        tool_call?: { name: string; arguments: string; tool_call_id: string };
        tool_calls?: Array<{ name: string; arguments: string; tool_call_id: string }>;
        // tool_return_message fields
        tool_call_id?: string;
        tool_return?: string;
        status?: "success" | "error";
        // reasoning_message fields
        reasoning?: string;
      };

      const runId = msg.run_id || undefined;

      // Assistant message
      if (msg.message_type === "assistant_message" && msg.content) {
        return {
          type: "assistant",
          content: msg.content,
          uuid: msg.uuid,
          runId,
        };
      }

      // Tool call message (tool_call_message = auto-executed, approval_request_message = needs approval)
      if (msg.message_type === "tool_call_message" || msg.message_type === "approval_request_message") {
        const toolCallRaw = (msg.tool_calls?.[0] || msg.tool_call) as Record<string, unknown> | undefined;
        if (toolCallRaw) {
          const fnObj = toolCallRaw.function as Record<string, unknown> | undefined;
          const toolCallId =
            (toolCallRaw.tool_call_id as string | undefined) ??
            (toolCallRaw.id as string | undefined);
          if (!toolCallId) {
            const detail = `Missing tool_call_id in ${msg.message_type} (uuid=${msg.uuid || "unknown"})`;
            sessionLog("transform", detail);
            return {
              type: "error",
              message: detail,
              errorCode: "protocol_error",
              stopReason: "protocol_error",
              runId,
              apiError: {
                error_type: "protocol_error",
                detail,
                message_type: msg.message_type,
              },
              recoverable: false,
              errorDetail: detail,
            };
          }

          const toolName =
            (toolCallRaw.name as string | undefined) ??
            (fnObj?.name as string | undefined) ??
            "?";
          const toolArgs =
            (toolCallRaw.arguments as string | undefined) ??
            (fnObj?.arguments as string | undefined) ??
            "";

          let toolInput: Record<string, unknown> = {};
          try {
            toolInput = JSON.parse(toolArgs);
          } catch {
            toolInput = { raw: toolArgs };
          }
          return {
            type: "tool_call",
            toolCallId,
            toolName,
            toolInput,
            rawArguments: toolArgs || undefined,
            uuid: msg.uuid,
            runId,
          };
        }
      }

      // Tool return message
      if (msg.message_type === "tool_return_message" && msg.tool_call_id) {
        return {
          type: "tool_result",
          toolCallId: msg.tool_call_id,
          content: msg.tool_return || "",
          isError: msg.status === "error",
          uuid: msg.uuid,
          runId,
        };
      }

      // Reasoning message
      if (msg.message_type === "reasoning_message" && msg.reasoning) {
        return {
          type: "reasoning",
          content: msg.reasoning,
          uuid: msg.uuid,
          runId,
        };
      }
    }

    // Stream event (partial message updates)
    if (wireMsg.type === "stream_event") {
      const msg = wireMsg as WireMessage & {
        event: unknown;
        uuid: string;
      };
      const eventPayload = (msg.event ?? {}) as SDKStreamEventPayload;
      return {
        type: "stream_event",
        event: eventPayload,
        uuid: msg.uuid,
      };
    }

    // Result message
    if (wireMsg.type === "result") {
      const msg = wireMsg as WireMessage & {
        subtype: string;
        result?: string;
        duration_ms: number;
        total_cost_usd?: number;
        conversation_id: string;
        stop_reason?: string;
        run_ids?: unknown[];
      };
      const runIds = Array.isArray(msg.run_ids)
        ? msg.run_ids.filter((id): id is string => typeof id === "string")
        : undefined;
      const approvalConflict = isApprovalConflictSignal({
        stopReason: msg.stop_reason,
      });
      const legacyError = msg.subtype !== "success"
        ? (approvalConflict && msg.subtype === "error" ? "approval_conflict" : msg.subtype)
        : undefined;
      const errorCode = toSdkErrorCode(legacyError);
      return {
        type: "result",
        success: msg.subtype === "success",
        result: msg.result,
        error: legacyError,
        errorCode,
        ...(approvalConflict
          ? {
              approvalConflict: true as const,
              recoverable: true as const,
            }
          : {}),
        stopReason: msg.stop_reason,
        durationMs: msg.duration_ms,
        totalCostUsd: msg.total_cost_usd,
        conversationId: msg.conversation_id,
        runIds,
      };
    }

    // Error message — carries the actual error detail from the CLI.
    // The subsequent type=result only has the opaque string "error";
    // this message has the human-readable description and API error.
    if (wireMsg.type === "error") {
      const msg = wireMsg as WireMessage & {
        message: string;
        stop_reason: string;
        run_id?: string;
        api_error?: Record<string, unknown>;
      };
      const errorDetail = extractApiErrorDetail(msg.api_error);
      const approvalConflict = isApprovalConflictSignal({
        detail: errorDetail,
        message: msg.message,
        stopReason: msg.stop_reason,
      });
      const errorCode = approvalConflict
        ? "approval_conflict"
        : toSdkErrorCode(msg.stop_reason);
      return {
        type: "error" as const,
        message: msg.message,
        ...(errorCode ? { errorCode } : {}),
        ...(approvalConflict
          ? {
              approvalConflict: true as const,
              recoverable: true as const,
            }
          : {}),
        ...(errorDetail ? { errorDetail } : {}),
        stopReason: msg.stop_reason,
        runId: msg.run_id,
        apiError: msg.api_error,
      };
    }

    // Retry message — the CLI is retrying after a transient failure.
    if (wireMsg.type === "retry") {
      const msg = wireMsg as WireMessage & {
        reason: string;
        attempt: number;
        max_attempts: number;
        delay_ms: number;
        run_id?: string;
      };
      return {
        type: "retry" as const,
        reason: msg.reason,
        attempt: msg.attempt,
        maxAttempts: msg.max_attempts,
        delayMs: msg.delay_ms,
        runId: msg.run_id,
      };
    }

    // Skip other message types (system_message, user_message, etc.)
    return null;
  }
}
