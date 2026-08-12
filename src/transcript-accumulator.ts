/**
 * Transcript accumulator
 *
 * Turns an `SDKMessage` stream into stable, render-ready rows so consumers stop
 * hand-rolling stream reconciliation. It owns the four reconciliation rules the
 * wire protocol requires:
 *
 * 1. Typed-by-family accumulation. Text slices are keyed on
 *    `message family + otid`, falling back to `uuid` *within the same family*.
 *    A bare `otid`/`uuid` key would collapse an assistant slice into a
 *    reasoning slice whenever a provider reuses an identifier across kinds.
 * 2. Per-`runId` `seqId` replay suppression. Each run keeps its own high-water
 *    mark, so a resumed stream that replays positions is dropped while a new
 *    run starts from a clean threshold.
 * 3. `toolCallId`-keyed merging. Tool argument fragments and the eventual tool
 *    result merge into one row keyed on the payload identity (`toolCallId`),
 *    while the envelope identities (the `uuid` of the `tool_call` message and
 *    of the `tool_result` message) stay separately visible.
 * 4. `rebase()` for mid-run backfill. A history page is merged in place with
 *    replace semantics, reordered ahead of live-only rows, and raises the
 *    replay thresholds it proves.
 *
 * The accumulator is pure and portable: no I/O, no timers, no Node built-ins,
 * so it is exported from both the package root and `/client`.
 */

import type { Message as LettaMessage } from "@letta-ai/letta-client/resources/agents/messages";
import {
  extractTextFromContent,
  firstToolCall,
  firstToolReturn,
} from "./remote-session-protocol.js";
import { extractStreamTextDelta } from "./stream-events.js";
import type { SDKMessage, SDKStreamEventMessage } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════

/** Message families the accumulator projects into rows. */
export type TranscriptRowKind = "user" | "assistant" | "reasoning" | "tool_call";

/** Text families. Rows in different families never share a key. */
export type TranscriptTextKind = "user" | "assistant" | "reasoning";

export interface TranscriptRowIdentity {
  /**
   * Stable render key. Namespaced by message family, so a provider that reuses
   * an `otid` or a message id across kinds still produces separate rows.
   */
  key: string;
  /** Envelope id of the message that opened this row, when known. */
  uuid?: string;
  /** Lineage key for this typed slice, when the stream supplied one. */
  otid?: string;
  /** Run that most recently contributed to this row. */
  runId?: string;
  /** Highest replay cursor observed for this row. */
  seqId?: number;
}

export interface TranscriptTextRow extends TranscriptRowIdentity {
  kind: TranscriptTextKind;
  /** Accumulated text for this slice. */
  text: string;
}

export interface TranscriptToolResult {
  content: string;
  isError: boolean;
  /**
   * Envelope id of the `tool_result` message. Deliberately distinct from the
   * row's `uuid`, which identifies the `tool_call` envelope.
   */
  uuid?: string;
}

/**
 * Lifecycle of a tool row.
 *
 * - `streaming`: argument fragments are still arriving and have not parsed.
 * - `ready`: arguments parsed; the result has not arrived.
 * - `complete`: a tool result merged into the row.
 */
export type TranscriptToolCallStatus = "streaming" | "ready" | "complete";

export interface TranscriptToolCallRow extends TranscriptRowIdentity {
  kind: "tool_call";
  /** Payload identity. This is what the row is keyed on. */
  toolCallId: string;
  toolName: string;
  /**
   * Best known parsed arguments. Never the transitional `{ raw }` wrapper the
   * protocol layer emits for an argument fragment that does not parse.
   */
  toolInput: Record<string, unknown>;
  /** Argument fragments concatenated in arrival order, when the wire sent any. */
  rawArguments?: string;
  /** Whether {@link toolInput} reflects fully parsed arguments. */
  argumentsComplete: boolean;
  result?: TranscriptToolResult;
  status: TranscriptToolCallStatus;
}

export type TranscriptRow = TranscriptTextRow | TranscriptToolCallRow;

/**
 * A history page accepted by {@link TranscriptAccumulator.rebase}. Covers
 * `session.listMessages()`, `session.bootstrapState()`, and a bare array of
 * Letta API messages.
 */
export type TranscriptHistoryPage =
  | { messages: readonly LettaMessage[] }
  | readonly LettaMessage[];

export interface TranscriptRebaseOptions {
  /**
   * Order of the supplied page. Omitted means auto-detect from `seq_id`/`date`;
   * `listMessages()` defaults to `"desc"` (newest first).
   */
  order?: "asc" | "desc";
}

export interface TranscriptAccumulator {
  /**
   * Fold one streamed message into the transcript and return the current rows.
   *
   * The returned array is referentially stable when the message changed
   * nothing (a replayed position, or a message family the accumulator ignores),
   * so it can be handed straight to a memoizing renderer.
   */
  apply(message: SDKMessage): readonly TranscriptRow[];
  /** Merge a history page into the transcript. Safe to call mid-run. */
  rebase(
    page: TranscriptHistoryPage,
    options?: TranscriptRebaseOptions,
  ): readonly TranscriptRow[];
  /** Current rows in transcript order. */
  rows(): readonly TranscriptRow[];
  /** Drop all rows and replay state. */
  reset(): void;
}

// ═══════════════════════════════════════════════════════════════
// INTERNALS
// ═══════════════════════════════════════════════════════════════

/**
 * Key segment separator. Every key carries a family segment and an identifier
 * kind segment ("otid"/"uuid"), so no wire identifier can produce a key that
 * collides with a key from another family or another identifier kind.
 */
const SEP = ":";

/** Bound on tracked replay thresholds so a long session cannot grow forever. */
const MAX_TRACKED_RUNS = 64;

/** Bucket used for streams that do not carry a `runId`. */
const ANONYMOUS_RUN = "";

interface TextSlice {
  kind: TranscriptTextKind;
  text: string;
  uuid?: string;
  otid?: string;
  runId?: string;
  seqId?: number;
}

function familyOtidAlias(kind: TranscriptTextKind, otid: string): string {
  return `${kind}${SEP}otid${SEP}${otid}`;
}

function familyUuidAlias(kind: TranscriptTextKind, uuid: string): string {
  return `${kind}${SEP}uuid${SEP}${uuid}`;
}

function toolRowKey(toolCallId: string): string {
  return `tool_call${SEP}id${SEP}${toolCallId}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse a JSON object, returning undefined for partial or non-object JSON. */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return asRecord(JSON.parse(trimmed) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Detect the protocol layer's transitional `{ raw }` wrapper.
 *
 * `toolInputFromArguments()` wraps an unparseable argument fragment as
 * `{ raw: "<fragment>" }`. That wrapper is a parse failure, not arguments, and
 * must never overwrite previously parsed input.
 */
function isRawArgumentsWrapper(
  input: Record<string, unknown> | undefined,
  rawArguments: string | undefined,
): boolean {
  if (!input) return false;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "raw") return false;
  const wrapped = input.raw;
  if (typeof wrapped !== "string") return false;
  return rawArguments === undefined || wrapped === rawArguments;
}

function toolStatus(row: {
  argumentsComplete: boolean;
  result?: TranscriptToolResult;
}): TranscriptToolCallStatus {
  if (row.result) return "complete";
  return row.argumentsComplete ? "ready" : "streaming";
}

interface ToolCallMerge {
  toolCallId: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  rawArguments?: string;
  uuid?: string;
  runId?: string;
  seqId?: number;
  /**
   * `fragment` appends streamed argument text; `whole` treats the arguments as
   * an authoritative complete value (history backfill).
   */
  mode: "fragment" | "whole";
}

interface ToolResultMerge {
  toolCallId: string;
  content: string;
  isError: boolean;
  uuid?: string;
  runId?: string;
  seqId?: number;
}

interface ToolArguments {
  rawArguments?: string;
  toolInput: Record<string, unknown>;
  argumentsComplete: boolean;
}

/**
 * Fold one argument delivery into the arguments known so far.
 *
 * The wire can deliver arguments three ways for the same call: streamed JSON
 * fragments, one complete JSON string, or an already-decoded object. Only a
 * successful parse is allowed to change `toolInput`.
 */
function mergeToolArguments(
  previous: ToolArguments,
  merge: ToolCallMerge,
): ToolArguments {
  let { rawArguments, toolInput, argumentsComplete } = previous;
  const fragment = merge.rawArguments;
  const wrapped = isRawArgumentsWrapper(merge.toolInput, fragment);

  if (fragment !== undefined && fragment.length > 0) {
    const whole = parseJsonObject(fragment);
    if (whole) {
      // A delivery that parses on its own is the complete argument value: a
      // final non-chunked `tool_call_message`, or a backfilled history row.
      // Replace rather than append so a repeated terminal message cannot
      // corrupt the accumulation.
      return { rawArguments: fragment, toolInput: whole, argumentsComplete: true };
    }
    if (argumentsComplete) {
      // Arguments already parsed; a trailing partial (a replayed fragment after
      // backfill) must not corrupt them.
      return previous;
    }
    if (merge.mode === "whole") {
      return { rawArguments: rawArguments ?? fragment, toolInput, argumentsComplete };
    }
    rawArguments = (rawArguments ?? "") + fragment;
    const parsed = parseJsonObject(rawArguments);
    if (parsed) {
      return { rawArguments, toolInput: parsed, argumentsComplete: true };
    }
    // Keep the previous parse. Never promote the `{ raw }` wrapper.
    return { rawArguments, toolInput, argumentsComplete: false };
  }

  if (!wrapped && merge.toolInput) {
    const keys = Object.keys(merge.toolInput);
    if (keys.length > 0) {
      return { rawArguments, toolInput: merge.toolInput, argumentsComplete: true };
    }
    if (rawArguments === undefined) {
      // Genuinely argument-free call: `{}` with no streamed fragments.
      return { rawArguments, toolInput, argumentsComplete: true };
    }
  }

  return previous;
}

class TranscriptAccumulatorImpl implements TranscriptAccumulator {
  /** Row key -> row. Map insertion order is the transcript order. */
  private byKey = new Map<string, TranscriptRow>();

  /** `family + otid` -> row key. */
  private aliasByOtid = new Map<string, string>();

  /** `family + uuid` -> row key. */
  private aliasByUuid = new Map<string, string>();

  /** `runId` -> highest accepted `seqId` for that run. */
  private seqThresholds = new Map<string, number>();

  private snapshot: readonly TranscriptRow[] | null = null;

  private anonymousCounter = 0;

  apply(message: SDKMessage): readonly TranscriptRow[] {
    switch (message.type) {
      case "assistant":
      case "reasoning":
        this.applyText({
          kind: message.type,
          text: message.content,
          uuid: message.uuid,
          otid: typeof message.otid === "string" ? message.otid : undefined,
          runId: message.runId,
          seqId: message.seqId,
        });
        break;
      case "tool_call":
        this.mergeToolCall({
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          toolInput: message.toolInput,
          rawArguments: message.rawArguments,
          uuid: message.uuid,
          runId: message.runId,
          mode: "fragment",
        });
        break;
      case "tool_result":
        this.mergeToolResult({
          toolCallId: message.toolCallId,
          content: message.content,
          isError: message.isError,
          uuid: message.uuid,
          runId: message.runId,
        });
        break;
      case "stream_event":
        this.applyStreamEvent(message);
        break;
      default:
        // init/result/error/retry/queue_update/loop_status are turn-level
        // signals rather than transcript content; consumers handle them
        // directly.
        break;
    }
    return this.rows();
  }

  rebase(
    page: TranscriptHistoryPage,
    options?: TranscriptRebaseOptions,
  ): readonly TranscriptRow[] {
    const messages = normalizeHistoryPage(page, options?.order);
    if (messages.length === 0) return this.rows();

    const historyKeys: string[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
      const key = this.applyHistoryMessage(message);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      historyKeys.push(key);
    }

    this.reorder(historyKeys);
    return this.rows();
  }

  rows(): readonly TranscriptRow[] {
    if (!this.snapshot) {
      this.snapshot = Array.from(this.byKey.values());
    }
    return this.snapshot;
  }

  reset(): void {
    this.byKey.clear();
    this.aliasByOtid.clear();
    this.aliasByUuid.clear();
    this.seqThresholds.clear();
    this.anonymousCounter = 0;
    this.snapshot = null;
  }

  // ── replay suppression ────────────────────────────────────────

  /**
   * Per-run replay guard.
   *
   * Thresholds are bucketed by `runId`, so a brand new run starts with no
   * threshold (a natural reset) while a resumed run keeps suppressing the
   * positions it already delivered. Messages without a `seqId` are never
   * suppressed here: their families are deduplicated by identity instead.
   */
  private isReplay(
    runId: string | undefined,
    seqId: number | undefined,
  ): boolean {
    if (seqId === undefined) return false;
    const bucket = runId ?? ANONYMOUS_RUN;
    const threshold = this.seqThresholds.get(bucket);
    if (threshold !== undefined && seqId <= threshold) return true;
    this.rememberSeq(bucket, seqId);
    return false;
  }

  private rememberSeq(bucket: string, seqId: number): void {
    const threshold = this.seqThresholds.get(bucket);
    if (threshold !== undefined && threshold >= seqId) return;
    this.seqThresholds.set(bucket, seqId);
    while (this.seqThresholds.size > MAX_TRACKED_RUNS) {
      const oldest = this.seqThresholds.keys().next();
      if (oldest.done) break;
      this.seqThresholds.delete(oldest.value);
    }
  }

  // ── text families ─────────────────────────────────────────────

  private applyText(slice: TextSlice): void {
    if (this.isReplay(slice.runId, slice.seqId)) return;
    this.writeText(slice, "append");
  }

  private writeText(slice: TextSlice, write: "append" | "replace"): string {
    const key = this.resolveTextKey(slice.kind, slice.uuid, slice.otid);
    const existing = this.byKey.get(key);
    const previous =
      existing && existing.kind === slice.kind ? existing : undefined;
    this.setRow(key, {
      kind: slice.kind,
      key,
      text: write === "append" ? (previous?.text ?? "") + slice.text : slice.text,
      uuid: previous?.uuid ?? slice.uuid,
      otid: slice.otid ?? previous?.otid,
      runId: slice.runId ?? previous?.runId,
      seqId: maxDefined(slice.seqId, previous?.seqId),
    });
    return key;
  }

  /**
   * Resolve the row key for a text slice.
   *
   * `otid` is the lineage key when present, but a stream can transition: early
   * fragments may carry only the message id and later fragments add an `otid`.
   * Both identifiers are aliased to one row so the transition does not split
   * it. When a message id is reused by a *second* slice carrying a different
   * `otid` (a provider emitting `[text, thinking, text]` under one message id),
   * the new `otid` opens its own row instead of appending to the previous one.
   */
  private resolveTextKey(
    kind: TranscriptTextKind,
    uuid: string | undefined,
    otid: string | undefined,
  ): string {
    const otidAlias = otid ? familyOtidAlias(kind, otid) : undefined;
    const uuidAlias = uuid ? familyUuidAlias(kind, uuid) : undefined;
    const fromOtid = otidAlias ? this.aliasByOtid.get(otidAlias) : undefined;
    const fromUuid = uuidAlias ? this.aliasByUuid.get(uuidAlias) : undefined;

    let key: string | undefined = fromOtid ?? fromUuid;

    if (key && !fromOtid && otid) {
      const existing = this.byKey.get(key);
      if (existing && existing.otid !== undefined && existing.otid !== otid) {
        // The envelope already committed to a different lineage: this is a new
        // slice sharing a message id, not a continuation of the old one.
        key = undefined;
      }
    }

    if (!key) {
      key =
        otidAlias ??
        uuidAlias ??
        `${kind}${SEP}auto${SEP}${++this.anonymousCounter}`;
    }

    if (otidAlias) this.aliasByOtid.set(otidAlias, key);
    // The newest slice owns the envelope, so later id-only fragments continue
    // it rather than the slice that closed before it.
    if (uuidAlias) this.aliasByUuid.set(uuidAlias, key);

    return key;
  }

  // ── tool families ─────────────────────────────────────────────

  private mergeToolCall(merge: ToolCallMerge): string {
    const key = toolRowKey(merge.toolCallId);
    const existing = this.byKey.get(key);
    const previous =
      existing && existing.kind === "tool_call" ? existing : undefined;

    const args = mergeToolArguments(
      {
        rawArguments: previous?.rawArguments,
        toolInput: previous?.toolInput ?? {},
        argumentsComplete: previous?.argumentsComplete ?? false,
      },
      merge,
    );

    const toolName =
      merge.toolName && merge.toolName !== "?"
        ? merge.toolName
        : (previous?.toolName ?? merge.toolName ?? "?");

    const next: TranscriptToolCallRow = {
      kind: "tool_call",
      key,
      toolCallId: merge.toolCallId,
      toolName,
      toolInput: args.toolInput,
      ...(args.rawArguments !== undefined
        ? { rawArguments: args.rawArguments }
        : {}),
      argumentsComplete: args.argumentsComplete,
      ...(previous?.result ? { result: previous.result } : {}),
      status: "streaming",
      // Envelope identity stays pinned to the `tool_call` message that opened
      // the row; the payload identity is `toolCallId`.
      uuid: previous?.uuid ?? merge.uuid,
      runId: merge.runId ?? previous?.runId,
      seqId: maxDefined(merge.seqId, previous?.seqId),
    };
    next.status = toolStatus(next);
    this.setRow(key, next);
    return key;
  }

  private mergeToolResult(merge: ToolResultMerge): string {
    const key = toolRowKey(merge.toolCallId);
    const existing = this.byKey.get(key);
    const previous =
      existing && existing.kind === "tool_call" ? existing : undefined;

    this.setRow(key, {
      kind: "tool_call",
      key,
      toolCallId: merge.toolCallId,
      toolName: previous?.toolName ?? "?",
      toolInput: previous?.toolInput ?? {},
      ...(previous?.rawArguments !== undefined
        ? { rawArguments: previous.rawArguments }
        : {}),
      argumentsComplete: previous?.argumentsComplete ?? false,
      result: {
        content: merge.content,
        isError: merge.isError,
        // The result envelope is a different message than the call envelope,
        // so it is recorded beside the row's `uuid`, not over it.
        ...(merge.uuid ? { uuid: merge.uuid } : {}),
      },
      status: "complete",
      uuid: previous?.uuid,
      runId: merge.runId ?? previous?.runId,
      seqId: maxDefined(merge.seqId, previous?.seqId),
    });
    return key;
  }

  // ── raw stream events ─────────────────────────────────────────

  /**
   * Compose with {@link extractStreamTextDelta} for payloads the session layer
   * passes through uncooked.
   *
   * Identity comes from the payload when it has any (`id`, `otid`, `seq_id`,
   * `run_id`). Content-block deltas carry none, so they fold into a single live
   * row per family — the most an anonymous delta stream can support.
   */
  private applyStreamEvent(message: SDKStreamEventMessage): void {
    const delta = extractStreamTextDelta(message.event);
    if (!delta) return;
    const payload = asRecord(message.event);
    const otid = payload ? readString(payload, "otid") : undefined;
    const payloadId = payload ? readString(payload, "id") : undefined;
    const identified = otid !== undefined || payloadId !== undefined;

    this.applyText({
      kind: delta.kind,
      text: delta.text,
      uuid: identified ? payloadId : `${delta.kind}${SEP}live`,
      otid,
      runId: payload ? readString(payload, "run_id") : undefined,
      seqId: payload ? readNumber(payload, "seq_id") : undefined,
    });
  }

  // ── history backfill ──────────────────────────────────────────

  private applyHistoryMessage(message: LettaMessage): string | undefined {
    const record = asRecord(message);
    if (!record) return undefined;
    const messageType = readString(record, "message_type");
    if (!messageType) return undefined;

    const uuid = readString(record, "id");
    const otid = readString(record, "otid");
    const runId = readString(record, "run_id");
    const seqId = readNumber(record, "seq_id");

    // A history page proves every position up to its own cursor for that run,
    // so replayed deltas at or below it are suppressed after the merge.
    if (seqId !== undefined) {
      this.rememberSeq(runId ?? ANONYMOUS_RUN, seqId);
    }

    switch (messageType) {
      case "user_message":
      case "assistant_message": {
        const text = extractTextFromContent(record.content);
        if (text === null) return undefined;
        return this.writeText(
          {
            kind: messageType === "user_message" ? "user" : "assistant",
            text,
            uuid,
            otid,
            runId,
            seqId,
          },
          "replace",
        );
      }
      case "reasoning_message": {
        const text =
          typeof record.reasoning === "string"
            ? record.reasoning
            : extractTextFromContent(record.content);
        if (text === null || text === undefined) return undefined;
        return this.writeText(
          { kind: "reasoning", text, uuid, otid, runId, seqId },
          "replace",
        );
      }
      case "tool_call_message":
      case "approval_request_message": {
        const toolCall = firstToolCall(record);
        if (!toolCall) return undefined;
        const fn = asRecord(toolCall.function);
        const toolCallId =
          (typeof toolCall.tool_call_id === "string"
            ? toolCall.tool_call_id
            : undefined) ??
          (typeof toolCall.id === "string" ? toolCall.id : undefined);
        if (!toolCallId) return undefined;
        const args = toolCall.arguments ?? fn?.arguments;
        return this.mergeToolCall({
          toolCallId,
          toolName:
            (typeof toolCall.name === "string" ? toolCall.name : undefined) ??
            (typeof fn?.name === "string" ? fn.name : undefined),
          toolInput: asRecord(args),
          rawArguments: typeof args === "string" ? args : undefined,
          uuid,
          runId,
          seqId,
          mode: "whole",
        });
      }
      case "tool_return_message": {
        const toolReturn = firstToolReturn(record) ?? record;
        const toolCallId =
          readString(record, "tool_call_id") ??
          (typeof toolReturn.tool_call_id === "string"
            ? toolReturn.tool_call_id
            : undefined);
        if (!toolCallId) return undefined;
        const content =
          extractTextFromContent(
            record.tool_return ?? toolReturn.tool_return ?? toolReturn.content,
          ) ?? "";
        const status =
          readString(record, "status") ??
          (typeof toolReturn.status === "string"
            ? toolReturn.status
            : undefined);
        return this.mergeToolResult({
          toolCallId,
          content,
          isError: status === "error",
          uuid,
          runId,
          seqId,
        });
      }
      default:
        // system/summary/event/hidden-reasoning/approval-response messages are
        // not transcript content this accumulator claims to own.
        return undefined;
    }
  }

  // ── row bookkeeping ───────────────────────────────────────────

  private setRow(key: string, row: TranscriptRow): void {
    this.byKey.set(key, row);
    this.snapshot = null;
  }

  /** Move backfilled rows ahead of rows that only exist in the live stream. */
  private reorder(historyKeys: readonly string[]): void {
    if (historyKeys.length === 0) return;
    const historySet = new Set(historyKeys);
    const reordered = new Map<string, TranscriptRow>();
    for (const key of historyKeys) {
      const row = this.byKey.get(key);
      if (row) reordered.set(key, row);
    }
    for (const [key, row] of this.byKey) {
      if (historySet.has(key)) continue;
      reordered.set(key, row);
    }
    this.byKey = reordered;
    this.snapshot = null;
  }
}

function maxDefined(
  next: number | undefined,
  previous: number | undefined,
): number | undefined {
  if (next === undefined) return previous;
  if (previous === undefined) return next;
  return Math.max(next, previous);
}

function normalizeHistoryPage(
  page: TranscriptHistoryPage,
  order: "asc" | "desc" | undefined,
): readonly LettaMessage[] {
  const messages = Array.isArray(page)
    ? (page as readonly LettaMessage[])
    : ((page as { messages?: readonly LettaMessage[] }).messages ?? []);
  if (messages.length < 2) return messages;
  const descending = order ? order === "desc" : detectDescending(messages);
  return descending ? [...messages].reverse() : messages;
}

/**
 * `listMessages()` defaults to newest-first. Detect that from the page itself
 * so callers do not have to restate the order they requested.
 */
function detectDescending(messages: readonly LettaMessage[]): boolean {
  const seqIds: number[] = [];
  const dates: number[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    const seqId = readNumber(record, "seq_id");
    if (seqId !== undefined) seqIds.push(seqId);
    const date = readString(record, "date");
    if (!date) continue;
    const parsed = Date.parse(date);
    if (!Number.isNaN(parsed)) dates.push(parsed);
  }
  const ordered = seqIds.length >= 2 ? seqIds : dates;
  if (ordered.length < 2) return false;
  const first = ordered[0] as number;
  const last = ordered[ordered.length - 1] as number;
  return last < first;
}

/**
 * Create a transcript accumulator.
 *
 * @example
 * ```typescript
 * const acc = createTranscriptAccumulator();
 * for await (const message of session.stream()) {
 *   render(acc.apply(message));
 * }
 *
 * // Safe mid-run: merges older history without duplicating live rows.
 * acc.rebase(await session.listMessages({ limit: 50 }));
 * ```
 */
export function createTranscriptAccumulator(): TranscriptAccumulator {
  return new TranscriptAccumulatorImpl();
}
