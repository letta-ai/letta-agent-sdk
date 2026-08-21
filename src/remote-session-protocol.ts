import type {
  CreateAgentOptions,
  LettaCodeClientSessionOptions,
  LettaCodeModelEntry,
  ListMessagesOptions,
  ListMessagesResult,
  ListModelsResult,
  MessageContentItem,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  ReasoningEffort,
  SDKErrorCode,
  SDKQueueItem,
  SendMessage,
  SessionDeviceStatus,
  SessionDiffHunk,
  SessionDiffPreview,
  SessionPendingControlRequest,
  SessionPermissionSuggestion,
  SkillSource,
  UpdateModelOptions,
  UpdateModelResult,
} from "./types.js";

export type RuntimeScope = {
  agent_id: string;
  conversation_id: string;
};

export type ProtocolMessage = Record<string, unknown> & {
  type: string;
  request_id?: string;
  runtime?: RuntimeScope;
};

export type RuntimeSessionMode =
  | { kind: "create-agent"; options: CreateAgentOptions }
  | {
      kind: "session";
      agentId?: string;
      conversationId?: string;
      newConversation?: boolean;
      defaultConversation?: boolean;
      options: LettaCodeClientSessionOptions;
    };

export type RuntimeTurnResult = {
  runtime: RuntimeScope;
  stopReason: string | null;
  runIds: string[];
  success?: boolean;
  detail?: string;
  errorCode?: SDKErrorCode;
  recoverable?: boolean;
};

export type RuntimeSendTurnOptions = {
  clientMessageId: string;
  /** Caller-supplied OTID for the user message, when one was provided. */
  otid?: string;
};

export type RuntimeRequestOptions = {
  timeoutMs?: number;
  predicate?: (message: ProtocolMessage) => boolean;
};

export interface RemoteClientRuntimeController {
  onMessage(handler: (message: ProtocolMessage, channel?: string) => void): () => void;
  send(command: Record<string, unknown>): void;
  sendTurnMessage(
    runtime: RuntimeScope,
    message: SendMessage,
    options: RuntimeSendTurnOptions,
  ): void;
  abort(runtime: RuntimeScope): Promise<void>;
  request<TResponse extends ProtocolMessage = ProtocolMessage>(
    type: string,
    body: Record<string, unknown>,
    options?: RuntimeRequestOptions,
  ): Promise<TResponse>;
  recoverPendingApprovals(
    runtime: RuntimeScope,
    options?: RecoverPendingApprovalsOptions,
  ): Promise<RecoverPendingApprovalsResult>;
  listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Promise<ListMessagesResult>;
  listModels(): Promise<ListModelsResult>;
  updateModel(
    runtime: RuntimeScope,
    payload: { model_id?: string; model_handle?: string },
  ): Promise<UpdateModelResult>;
  close(): void;
}

export type RuntimeSessionInit = {
  controller: RemoteClientRuntimeController;
  runtime: RuntimeScope;
  model?: string | null;
  modelSettings?: Record<string, unknown> | null;
  tools?: string[];
  /** Effective runtime skill source override, when explicitly requested. */
  skillSources?: SkillSource[];
};

export type RemoteClientSessionCoreConfig = {
  label: string;
  requestTimeoutMs?: number;
};

type ReflectionSettings = {
  trigger: "off" | "step-count" | "compaction-event";
  step_count: number;
};

export type UpdateModelPayload = {
  model_id?: string;
  model_handle?: string;
};

export type NormalizedUpdateModelInput = {
  model?: string;
  modelId?: string;
  modelHandle?: string;
  reasoningEffort?: ReasoningEffort;
};

export type TurnTracker = {
  id: number;
  runtime: RuntimeScope;
  clientMessageId: string;
  /** Caller-supplied OTID for this turn's user message, when one was provided. */
  otid?: string;
  queuedAt: number;
  startedAt: number;
  assistantText: string;
  runIds: Set<string>;
  observedTurnEvidence: boolean;
  observedRequiresApprovalStop: boolean;
  pendingTerminal: RuntimeTurnResult | null;
  abortRequested: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
};

const SUCCESS_STOP_REASONS = new Set([
  "end_turn",
  "tool_rule",
  "requires_approval",
]);
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
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

type LegacyPermissionMode = "default" | "bypassPermissions" | "fullAccess";

export function normalizePermissionMode(
  mode:
    | LettaCodeClientSessionOptions["permissionMode"]
    | LegacyPermissionMode
    | undefined,
): LettaCodeClientSessionOptions["permissionMode"] | undefined {
  if (mode === undefined || mode === "default") {
    return "standard";
  }
  if (mode === "bypassPermissions" || mode === "fullAccess") {
    return "unrestricted";
  }
  if (
    mode === "standard" ||
    mode === "acceptEdits" ||
    mode === "unrestricted" ||
    mode === "strict"
  ) {
    return mode;
  }
  return undefined;
}

export function mapPermissionMode(
  mode:
    | LettaCodeClientSessionOptions["permissionMode"]
    | LegacyPermissionMode
    | undefined,
): string | undefined {
  return normalizePermissionMode(mode);
}

export function isUnrestrictedPermissionMode(
  mode:
    | LettaCodeClientSessionOptions["permissionMode"]
    | LegacyPermissionMode
    | undefined,
): boolean {
  return normalizePermissionMode(mode) === "unrestricted";
}

export function ensureSuccess(message: Record<string, unknown>, fallback: string): void {
  if (message.success === false) {
    throw new Error(typeof message.error === "string" ? message.error : fallback);
  }
}

export function toSdkErrorCode(value: string | null | undefined): SDKErrorCode | undefined {
  if (!value || value.length === 0) return undefined;
  return KNOWN_SDK_ERROR_CODES.has(value as SDKErrorCode)
    ? (value as SDKErrorCode)
    : undefined;
}

export function isFailureStopReason(value: string | null | undefined): boolean {
  return value != null && !SUCCESS_STOP_REASONS.has(value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.has(value as ReasoningEffort);
}

function nonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}. Expected a non-empty string.`);
  }
  return value;
}

export function normalizeUpdateModelInput(update: string | UpdateModelOptions): NormalizedUpdateModelInput {
  if (typeof update === "string") {
    if (update.length === 0) {
      throw new Error("Invalid model. Expected a non-empty string.");
    }
    return { model: update };
  }
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new Error("Invalid updateModel options. Expected a model string or options object.");
  }

  const model = nonEmptyString(update.model, "model");
  const modelId = nonEmptyString(update.modelId, "modelId");
  const modelHandle = nonEmptyString(update.modelHandle, "modelHandle");
  const reasoningEffort = update.reasoningEffort;
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
    throw new Error(
      `Invalid reasoningEffort '${String(reasoningEffort)}'. Valid values: ${[...REASONING_EFFORTS].join(", ")}`,
    );
  }
  if (model !== undefined && (modelId !== undefined || modelHandle !== undefined)) {
    throw new Error("Invalid updateModel options. Use either model or explicit modelId/modelHandle, not both.");
  }
  if (
    model === undefined &&
    modelId === undefined &&
    modelHandle === undefined &&
    reasoningEffort === undefined
  ) {
    throw new Error("Invalid updateModel options. Provide model, modelId, modelHandle, or reasoningEffort.");
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(modelHandle !== undefined ? { modelHandle } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

export function modelPayloadWithoutReasoning(input: NormalizedUpdateModelInput): UpdateModelPayload {
  const payload: UpdateModelPayload = {};
  if (input.modelId !== undefined) payload.model_id = input.modelId;
  if (input.modelHandle !== undefined) payload.model_handle = input.modelHandle;
  if (input.model !== undefined) {
    if (input.model.includes("/")) payload.model_handle = input.model;
    else payload.model_id = input.model;
  }
  return payload;
}

export function toBaseModelHandle(
  handle: string | undefined,
  byokProviderAliases: Record<string, string> | undefined,
): string | undefined {
  if (!handle) return undefined;
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return handle;
  const provider = handle.slice(0, slashIndex);
  const model = handle.slice(slashIndex + 1);
  const baseProvider = byokProviderAliases?.[provider];
  return baseProvider ? `${baseProvider}/${model}` : handle;
}

export function getContextWindow(value: Record<string, unknown> | null | undefined): number | undefined {
  const contextWindow = value?.context_window;
  return typeof contextWindow === "number" ? contextWindow : undefined;
}

export function getReasoningEffort(entry: LettaCodeModelEntry): string | undefined {
  const effort = entry.updateArgs?.reasoning_effort;
  return typeof effort === "string" ? effort : undefined;
}

export function sameContextCandidates(
  candidates: LettaCodeModelEntry[],
  contextWindow: number | undefined,
): LettaCodeModelEntry[] {
  if (contextWindow === undefined) return candidates;
  const matches = candidates.filter(
    (entry) => getContextWindow(entry.updateArgs) === contextWindow,
  );
  return matches.length > 0 ? matches : candidates;
}

export function isApprovalConflictSignal(params: {
  detail?: string;
  message?: string;
  stopReason?: string | null;
}): boolean {
  if (params.stopReason === "requires_approval") return true;
  const haystack = [params.detail, params.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
  return (
    haystack.includes("waiting for approval on a tool call") ||
    haystack.includes("cannot send a new message") ||
    haystack.includes("requires_approval")
  );
}

export function resolveDreamingSettings(
  dreaming: LettaCodeClientSessionOptions["dreaming"],
): ReflectionSettings | null {
  if (!dreaming) return null;
  return {
    trigger: dreaming.trigger ?? "step-count",
    step_count: dreaming.stepCount ?? 5,
  };
}

export function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        pieces.push(part);
        continue;
      }
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") {
          pieces.push(record.text);
        }
      }
    }
    const joined = pieces.join("");
    return joined.length > 0 ? joined : null;
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }
  return null;
}

export function toolInputFromArguments(args: unknown): { input: Record<string, unknown>; raw?: string } {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return { input: args as Record<string, unknown> };
  }
  const raw = typeof args === "string" ? args : "";
  if (!raw) return { input: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown>, raw };
    }
  } catch {
    // Fall through to raw wrapper.
  }
  return { input: { raw }, raw };
}

export function firstToolCall(delta: Record<string, unknown>): Record<string, unknown> | undefined {
  const toolCalls = delta.tool_calls;
  if (Array.isArray(toolCalls)) {
    const first = toolCalls[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }
  if (toolCalls && typeof toolCalls === "object") {
    return toolCalls as Record<string, unknown>;
  }
  const toolCall = delta.tool_call;
  return toolCall && typeof toolCall === "object" ? (toolCall as Record<string, unknown>) : undefined;
}

export function firstToolReturn(delta: Record<string, unknown>): Record<string, unknown> | undefined {
  const toolReturns = delta.tool_returns;
  if (Array.isArray(toolReturns)) {
    const first = toolReturns[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }
  return undefined;
}

export function sameRuntime(message: ProtocolMessage, runtime: RuntimeScope): boolean {
  const msgRuntime = message.runtime;
  if (msgRuntime) {
    return (
      msgRuntime.agent_id === runtime.agent_id &&
      msgRuntime.conversation_id === runtime.conversation_id
    );
  }
  const messageAgentId =
    typeof message.agent_id === "string"
      ? message.agent_id
      : typeof message.agentId === "string"
        ? message.agentId
        : undefined;
  const messageConversationId =
    typeof message.conversation_id === "string"
      ? message.conversation_id
      : typeof message.conversationId === "string"
        ? message.conversationId
        : undefined;

  if (messageAgentId && messageAgentId !== runtime.agent_id) return false;
  if (messageConversationId && messageConversationId !== runtime.conversation_id) return false;
  return true;
}

export function streamDeltaRecord(message: ProtocolMessage): Record<string, unknown> | null {
  if (message.type !== "stream_delta") return null;
  const delta = message.delta;
  return delta && typeof delta === "object" && !Array.isArray(delta)
    ? (delta as Record<string, unknown>)
    : null;
}

export function streamDeltaMessageType(delta: Record<string, unknown>): string | undefined {
  return typeof delta.message_type === "string" ? delta.message_type : undefined;
}

export function streamDeltaRunId(delta: Record<string, unknown>): string | undefined {
  return typeof delta.run_id === "string" ? delta.run_id : undefined;
}

export function streamDeltaOtid(
  delta: Record<string, unknown>,
): string | null | undefined {
  return typeof delta.otid === "string" || delta.otid === null
    ? delta.otid
    : undefined;
}

export function streamDeltaSeqId(
  delta: Record<string, unknown>,
): number | undefined {
  return typeof delta.seq_id === "number" ? delta.seq_id : undefined;
}

export function streamDeltaStopReason(delta: Record<string, unknown>): string | null | undefined {
  return typeof delta.stop_reason === "string" ? delta.stop_reason : undefined;
}

function loopStatusRecord(message: ProtocolMessage): Record<string, unknown> | null {
  if (message.type !== "update_loop_status") return null;
  const loopStatus = message.loop_status;
  return loopStatus && typeof loopStatus === "object" && !Array.isArray(loopStatus)
    ? (loopStatus as Record<string, unknown>)
    : null;
}

export function loopStatusValue(message: ProtocolMessage): string | undefined {
  const loopStatus = loopStatusRecord(message);
  return typeof loopStatus?.status === "string" ? loopStatus.status : undefined;
}

export function loopStatusRunIds(message: ProtocolMessage): string[] {
  const activeRunIds = loopStatusRecord(message)?.active_run_ids;
  return Array.isArray(activeRunIds)
    ? activeRunIds.filter((runId): runId is string => typeof runId === "string")
    : [];
}

export function turnFinishedRecord(message: ProtocolMessage): {
  runId?: string;
  stopReason: string;
  error?: string;
} | null {
  if (message.type !== "turn_finished" || typeof message.stop_reason !== "string") {
    return null;
  }
  return {
    ...(typeof message.run_id === "string" ? { runId: message.run_id } : {}),
    stopReason: message.stop_reason,
    ...(typeof message.error === "string" ? { error: message.error } : {}),
  };
}

export function queueItems(message: ProtocolMessage): SDKQueueItem[] {
  const queue = message.queue;
  if (!Array.isArray(queue)) return [];
  return queue.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") return [];
    return [
      {
        id: record.id,
        clientMessageId:
          typeof record.client_message_id === "string" ? record.client_message_id : "",
        kind: typeof record.kind === "string" ? record.kind : "message",
        source: typeof record.source === "string" ? record.source : "user",
        content: record.content,
        enqueuedAt: typeof record.enqueued_at === "string" ? record.enqueued_at : "",
      },
    ];
  });
}

export function deviceStatusRecord(message: ProtocolMessage): Record<string, unknown> | null {
  if (message.type !== "update_device_status") return null;
  const status = message.device_status;
  return status && typeof status === "object" && !Array.isArray(status)
    ? (status as Record<string, unknown>)
    : null;
}

function pendingControlRequests(
  status: Record<string, unknown>,
): SessionPendingControlRequest[] {
  const pending = status.pending_control_requests;
  if (!Array.isArray(pending)) return [];
  return pending.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.request_id !== "string") return [];
    const request =
      record.request && typeof record.request === "object" && !Array.isArray(record.request)
        ? (record.request as Record<string, unknown>)
        : null;
    if (!request || typeof request.tool_name !== "string") return [];
    const entry: SessionPendingControlRequest = {
      requestId: record.request_id,
      toolName: request.tool_name,
      permissionSuggestions: permissionSuggestions(
        request.permission_suggestions,
      ),
      blockedPath:
        typeof request.blocked_path === "string" ||
        request.blocked_path === null
          ? request.blocked_path
          : null,
    };
    if (typeof request.tool_call_id === "string") entry.toolCallId = request.tool_call_id;
    if (request.input && typeof request.input === "object" && !Array.isArray(request.input)) {
      entry.toolInput = request.input as Record<string, unknown>;
    }
    const previews = diffPreviews(request.diffs);
    if (previews !== undefined) entry.diffs = previews;
    return [entry];
  });
}

function permissionSuggestions(
  value: unknown,
): SessionPermissionSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.text === "string"
      ? [{ id: record.id, text: record.text }]
      : [];
  });
}

function diffPreviews(value: unknown): SessionDiffPreview[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap<SessionDiffPreview>((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      record.mode === "advanced" &&
      typeof record.fileName === "string" &&
      Array.isArray(record.hunks)
    ) {
      return [{
        mode: "advanced" as const,
        fileName: record.fileName,
        hunks: diffHunks(record.hunks),
      }];
    }
    if (
      (record.mode === "fallback" || record.mode === "unpreviewable") &&
      typeof record.fileName === "string" &&
      typeof record.reason === "string"
    ) {
      return [{
        mode: record.mode,
        fileName: record.fileName,
        reason: record.reason,
      }];
    }
    return [];
  });
}

function diffHunks(value: unknown[]): SessionDiffHunk[] {
  return value.flatMap<SessionDiffHunk>((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.oldStart !== "number" ||
      typeof record.oldLines !== "number" ||
      typeof record.newStart !== "number" ||
      typeof record.newLines !== "number" ||
      !Array.isArray(record.lines)
    ) {
      return [];
    }
    const lines: SessionDiffHunk["lines"] = [];
    for (const line of record.lines) {
      if (!line || typeof line !== "object" || Array.isArray(line)) continue;
      const lineRecord = line as Record<string, unknown>;
      const type = lineRecord.type;
      if (
        (
          type !== "context" &&
          type !== "add" &&
          type !== "remove"
        ) ||
        typeof lineRecord.content !== "string"
      ) {
        continue;
      }
      lines.push({
        type,
        content: lineRecord.content,
      });
    }
    return [{
      oldStart: record.oldStart,
      oldLines: record.oldLines,
      newStart: record.newStart,
      newLines: record.newLines,
      lines,
    }];
  });
}

export function toSessionDeviceStatus(
  status: Record<string, unknown>,
): SessionDeviceStatus | null {
  const permissionMode = normalizePermissionMode(
    status.current_permission_mode as
      | LettaCodeClientSessionOptions["permissionMode"]
      | undefined,
  );
  if (
    typeof status.is_online !== "boolean" ||
    typeof status.is_processing !== "boolean" ||
    permissionMode === undefined ||
    !(
      typeof status.current_working_directory === "string" ||
      status.current_working_directory === null
    )
  ) {
    return null;
  }
  return {
    isOnline: status.is_online,
    isProcessing: status.is_processing,
    permissionMode,
    workingDirectory: status.current_working_directory,
    memoryDirectory:
      typeof status.memory_directory === "string"
        ? status.memory_directory
        : null,
    pendingControlRequests: pendingControlRequests(status),
    raw: { ...status },
  };
}

export function normalizeSendMessage(message: SendMessage): string | MessageContentItem[] {
  return message;
}

/**
 * Validate a caller-supplied OTID. Empty/whitespace-only values would silently
 * defeat correlation, so they are rejected instead of being dropped.
 */
export function normalizeCallerOtid(otid: string | undefined): string | undefined {
  if (otid === undefined) return undefined;
  if (typeof otid !== "string" || otid.trim() === "") {
    throw new Error("send() otid must be a non-empty string");
  }
  return otid;
}

/** Wire correlation options for a tracked turn. */
export function turnSendOptions(turn: TurnTracker): RuntimeSendTurnOptions {
  return {
    clientMessageId: turn.clientMessageId,
    ...(turn.otid !== undefined ? { otid: turn.otid } : {}),
  };
}
