/**
 * Unit tests for the transcript accumulator.
 *
 * These cover the reconciliation rules a consumer would otherwise hand-roll:
 * typed-by-family otid merging, per-run seqId replay suppression, toolCallId
 * payload merging, the transitional `{ raw }` argument wrapper, and mid-run
 * history backfill.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { createTranscriptAccumulator } from "../transcript-accumulator.js";
import type {
  TranscriptRow,
  TranscriptTextRow,
  TranscriptToolCallRow,
} from "../transcript-accumulator.js";
import type { SDKMessage } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function assistant(
  content: string,
  identity: { uuid: string; otid?: string; seqId?: number; runId?: string },
): SDKMessage {
  return { type: "assistant", content, ...identity };
}

function reasoning(
  content: string,
  identity: { uuid: string; otid?: string; seqId?: number; runId?: string },
): SDKMessage {
  return { type: "reasoning", content, ...identity };
}

function toolCallFragment(
  toolCallId: string,
  rawArguments: string,
  extra: { uuid: string; toolName?: string; runId?: string },
): SDKMessage {
  return {
    type: "tool_call",
    toolCallId,
    toolName: extra.toolName ?? "Bash",
    // Mirrors `toolInputFromArguments()`: an unparseable fragment arrives
    // wrapped as `{ raw }`.
    toolInput: parsedOrWrapper(rawArguments),
    rawArguments,
    uuid: extra.uuid,
    ...(extra.runId ? { runId: extra.runId } : {}),
  };
}

function parsedOrWrapper(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { raw };
}

function historyMessage(record: Record<string, unknown>): Message {
  return record as unknown as Message;
}

function textRows(rows: readonly TranscriptRow[]): TranscriptTextRow[] {
  return rows.filter((row): row is TranscriptTextRow => row.kind !== "tool_call");
}

function toolRows(rows: readonly TranscriptRow[]): TranscriptToolCallRow[] {
  return rows.filter((row): row is TranscriptToolCallRow => row.kind === "tool_call");
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed-by-family accumulation
// ─────────────────────────────────────────────────────────────────────────────

describe("typed-by-family accumulation", () => {
  test("merges assistant fragments sharing an otid into one row", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("Hel", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }));
    const rows = acc.apply(
      assistant("lo", { uuid: "m1", otid: "o1", seqId: 2, runId: "r1" }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "assistant",
      text: "Hello",
      uuid: "m1",
      otid: "o1",
      runId: "r1",
      seqId: 2,
    });
  });

  test("keeps assistant and reasoning apart when a provider reuses one otid", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("answer", { uuid: "m1", otid: "shared", seqId: 1, runId: "r1" }));
    const rows = acc.apply(
      reasoning("thought", { uuid: "m2", otid: "shared", seqId: 2, runId: "r1" }),
    );

    expect(rows).toHaveLength(2);
    expect(textRows(rows).map((row) => [row.kind, row.text])).toEqual([
      ["assistant", "answer"],
      ["reasoning", "thought"],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  test("falls back to uuid only within a family", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("answer", { uuid: "shared", seqId: 1, runId: "r1" }));
    acc.apply(assistant(" more", { uuid: "shared", seqId: 2, runId: "r1" }));
    const rows = acc.apply(
      reasoning("thought", { uuid: "shared", seqId: 3, runId: "r1" }),
    );

    expect(textRows(rows).map((row) => [row.kind, row.text])).toEqual([
      ["assistant", "answer more"],
      ["reasoning", "thought"],
    ]);
  });

  test("keeps one row when a stream transitions from id-only to id+otid", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("Hel", { uuid: "m1", seqId: 1, runId: "r1" }));
    const rows = acc.apply(
      assistant("lo", { uuid: "m1", otid: "o1", seqId: 2, runId: "r1" }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "Hello", otid: "o1" });
  });

  test("opens a new row when a second otid reuses a committed message id", () => {
    const acc = createTranscriptAccumulator();
    // Anthropic-style [text, thinking, text] under one message id.
    acc.apply(assistant("first", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }));
    acc.apply(reasoning("thinking", { uuid: "m1", otid: "o2", seqId: 2, runId: "r1" }));
    const rows = acc.apply(
      assistant("second", { uuid: "m1", otid: "o3", seqId: 3, runId: "r1" }),
    );

    expect(textRows(rows).map((row) => [row.kind, row.text])).toEqual([
      ["assistant", "first"],
      ["reasoning", "thinking"],
      ["assistant", "second"],
    ]);
  });

  test("continues the newest slice for later id-only fragments", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("first", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }));
    acc.apply(assistant("second", { uuid: "m1", otid: "o2", seqId: 2, runId: "r1" }));
    const rows = acc.apply(assistant("-tail", { uuid: "m1", seqId: 3, runId: "r1" }));

    expect(textRows(rows).map((row) => row.text)).toEqual(["first", "second-tail"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Replay suppression
// ─────────────────────────────────────────────────────────────────────────────

describe("per-run seqId replay suppression", () => {
  test("drops replayed positions after a resume", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("a", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }));
    acc.apply(assistant("b", { uuid: "m1", otid: "o1", seqId: 2, runId: "r1" }));

    // Reconnect replays the whole run from the start.
    acc.apply(assistant("a", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }));
    acc.apply(assistant("b", { uuid: "m1", otid: "o1", seqId: 2, runId: "r1" }));
    const rows = acc.apply(
      assistant("c", { uuid: "m1", otid: "o1", seqId: 3, runId: "r1" }),
    );

    expect(rows).toHaveLength(1);
    expect((rows[0] as TranscriptTextRow).text).toBe("abc");
  });

  test("returns a referentially stable snapshot for suppressed replays", () => {
    const acc = createTranscriptAccumulator();
    const first = acc.apply(
      assistant("a", { uuid: "m1", otid: "o1", seqId: 7, runId: "r1" }),
    );
    const replayed = acc.apply(
      assistant("a", { uuid: "m1", otid: "o1", seqId: 7, runId: "r1" }),
    );

    expect(replayed).toBe(first);
  });

  test("resets the threshold for a new run", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("old", { uuid: "m1", otid: "o1", seqId: 42, runId: "r1" }));
    const rows = acc.apply(
      assistant("new", { uuid: "m2", otid: "o2", seqId: 1, runId: "r2" }),
    );

    expect(textRows(rows).map((row) => row.text)).toEqual(["old", "new"]);
  });

  test("keeps suppressing an older run after a newer run starts", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("old", { uuid: "m1", otid: "o1", seqId: 42, runId: "r1" }));
    acc.apply(assistant("new", { uuid: "m2", otid: "o2", seqId: 1, runId: "r2" }));
    const rows = acc.apply(
      assistant("old", { uuid: "m1", otid: "o1", seqId: 42, runId: "r1" }),
    );

    expect(textRows(rows).map((row) => row.text)).toEqual(["old", "new"]);
  });

  test("does not suppress across runs that reuse the same positions", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("one", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }));
    acc.apply(assistant("two", { uuid: "m2", otid: "o2", seqId: 1, runId: "r2" }));
    const rows = acc.apply(
      assistant("three", { uuid: "m3", otid: "o3", seqId: 1, runId: "r3" }),
    );

    expect(textRows(rows).map((row) => row.text)).toEqual(["one", "two", "three"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool merging
// ─────────────────────────────────────────────────────────────────────────────

describe("toolCallId-keyed merging", () => {
  test("merges argument fragments and the tool result into one row", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(toolCallFragment("call-1", '{"command"', { uuid: "env-1" }));
    let rows = acc.apply(toolCallFragment("call-1", ':"echo hi"', { uuid: "env-2" }));

    expect(toolRows(rows)[0]).toMatchObject({
      toolCallId: "call-1",
      argumentsComplete: false,
      status: "streaming",
      toolInput: {},
    });

    rows = acc.apply(toolCallFragment("call-1", "}", { uuid: "env-3" }));
    expect(toolRows(rows)[0]).toMatchObject({
      argumentsComplete: true,
      status: "ready",
      toolInput: { command: "echo hi" },
      rawArguments: '{"command":"echo hi"}',
    });

    rows = acc.apply({
      type: "tool_result",
      toolCallId: "call-1",
      content: "hi",
      isError: false,
      uuid: "env-result",
    });

    expect(rows).toHaveLength(1);
    expect(toolRows(rows)[0]).toMatchObject({
      status: "complete",
      toolInput: { command: "echo hi" },
      result: { content: "hi", isError: false, uuid: "env-result" },
    });
  });

  test("keeps envelope identity distinct from payload identity", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(toolCallFragment("call-1", '{"command":"ls"}', { uuid: "env-call" }));
    const rows = acc.apply({
      type: "tool_result",
      toolCallId: "call-1",
      content: "a\nb",
      isError: false,
      uuid: "env-result",
    });

    const row = toolRows(rows)[0]!;
    // The row is keyed on the payload id, while both envelopes stay readable.
    expect(row.key).toContain("call-1");
    expect(row.toolCallId).toBe("call-1");
    expect(row.uuid).toBe("env-call");
    expect(row.result?.uuid).toBe("env-result");
  });

  test("never lets the transitional { raw } wrapper overwrite parsed args", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(toolCallFragment("call-1", '{"command":"echo hi"}', { uuid: "env-1" }));
    // A replayed partial fragment arrives after the arguments already parsed.
    const rows = acc.apply(toolCallFragment("call-1", '{"comm', { uuid: "env-2" }));

    const row = toolRows(rows)[0]!;
    expect(row.toolInput).toEqual({ command: "echo hi" });
    expect(row.argumentsComplete).toBe(true);
    expect(row.toolInput.raw).toBeUndefined();
  });

  test("does not report unparsed fragments as complete arguments", () => {
    const acc = createTranscriptAccumulator();
    const rows = acc.apply(toolCallFragment("call-1", '{"command":"ec', { uuid: "e1" }));

    const row = toolRows(rows)[0]!;
    expect(row.argumentsComplete).toBe(false);
    expect(row.toolInput).toEqual({});
    expect(row.rawArguments).toBe('{"command":"ec');
  });

  test("treats an argument-free call as complete", () => {
    const acc = createTranscriptAccumulator();
    const rows = acc.apply({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "ListTools",
      toolInput: {},
      uuid: "env-1",
    });

    expect(toolRows(rows)[0]).toMatchObject({
      argumentsComplete: true,
      status: "ready",
    });
  });

  test("creates a row for a tool result that arrives without its call", () => {
    const acc = createTranscriptAccumulator();
    const rows = acc.apply({
      type: "tool_result",
      toolCallId: "call-orphan",
      content: "boom",
      isError: true,
      uuid: "env-result",
    });

    expect(toolRows(rows)[0]).toMatchObject({
      toolCallId: "call-orphan",
      toolName: "?",
      status: "complete",
      result: { content: "boom", isError: true },
    });
  });

  test("keeps a known tool name when a later fragment omits it", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(toolCallFragment("call-1", '{"command"', { uuid: "e1", toolName: "Bash" }));
    const rows = acc.apply(
      toolCallFragment("call-1", ':"ls"}', { uuid: "e2", toolName: "?" }),
    );

    expect(toolRows(rows)[0]?.toolName).toBe("Bash");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stream_event composition
// ─────────────────────────────────────────────────────────────────────────────

describe("stream_event composition", () => {
  test("folds identified stream events into the same rows as cooked messages", () => {
    const acc = createTranscriptAccumulator();
    acc.apply({
      type: "stream_event",
      uuid: "generated-1",
      event: {
        message_type: "assistant_message",
        id: "m1",
        otid: "o1",
        seq_id: 1,
        run_id: "r1",
        content: "Hel",
      },
    });
    const rows = acc.apply(
      assistant("lo", { uuid: "m1", otid: "o1", seqId: 2, runId: "r1" }),
    );

    expect(rows).toHaveLength(1);
    expect((rows[0] as TranscriptTextRow).text).toBe("Hello");
  });

  test("folds anonymous content_block deltas into one live row per family", () => {
    const acc = createTranscriptAccumulator();
    acc.apply({
      type: "stream_event",
      uuid: "generated-1",
      event: { type: "content_block_delta", delta: { text: "Hel" } },
    });
    acc.apply({
      type: "stream_event",
      uuid: "generated-2",
      event: { type: "content_block_delta", delta: { text: "lo" } },
    });
    const rows = acc.apply({
      type: "stream_event",
      uuid: "generated-3",
      event: { type: "content_block_delta", delta: { reasoning: "hmm" } },
    });

    expect(textRows(rows).map((row) => [row.kind, row.text])).toEqual([
      ["assistant", "Hello"],
      ["reasoning", "hmm"],
    ]);
  });

  test("ignores turn-level messages", () => {
    const acc = createTranscriptAccumulator();
    const rows = acc.apply({
      type: "result",
      success: true,
      durationMs: 12,
      conversationId: "conv-1",
    });

    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rebase()
// ─────────────────────────────────────────────────────────────────────────────

describe("rebase()", () => {
  test("merges a newest-first history page into ascending rows", () => {
    const acc = createTranscriptAccumulator();
    const rows = acc.rebase({
      messages: [
        historyMessage({
          id: "m2",
          message_type: "assistant_message",
          content: "hi there",
          otid: "o2",
          seq_id: 2,
          run_id: "r1",
          date: "2026-07-28T00:00:02Z",
        }),
        historyMessage({
          id: "m1",
          message_type: "user_message",
          content: "hello",
          otid: "o1",
          seq_id: 1,
          run_id: "r1",
          date: "2026-07-28T00:00:01Z",
        }),
      ],
    });

    expect(textRows(rows).map((row) => [row.kind, row.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi there"],
    ]);
  });

  test("honors an explicit order override", () => {
    const acc = createTranscriptAccumulator();
    const rows = acc.rebase(
      [
        historyMessage({ id: "m1", message_type: "user_message", content: "one" }),
        historyMessage({ id: "m2", message_type: "user_message", content: "two" }),
      ],
      { order: "asc" },
    );

    expect(textRows(rows).map((row) => row.text)).toEqual(["one", "two"]);
  });

  test("does not duplicate rows already built from the live stream", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("Hel", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }));
    const rows = acc.rebase([
      historyMessage({
        id: "m1",
        message_type: "assistant_message",
        content: "Hello",
        otid: "o1",
        seq_id: 1,
        run_id: "r1",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect((rows[0] as TranscriptTextRow).text).toBe("Hello");
  });

  test("backfills mid-stream and keeps accumulating the continued fragments", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("Hel", { uuid: "m1", otid: "o1", seqId: 10, runId: "r1" }));

    // "Load older messages" lands while the run is still streaming.
    acc.rebase({
      messages: [
        historyMessage({
          id: "m1",
          message_type: "assistant_message",
          content: "Hel",
          otid: "o1",
          seq_id: 10,
          run_id: "r1",
        }),
        historyMessage({
          id: "m0",
          message_type: "user_message",
          content: "hi",
          otid: "o0",
          seq_id: 9,
          run_id: "r1",
        }),
      ],
    });

    const rows = acc.apply(
      assistant("lo", { uuid: "m1", otid: "o1", seqId: 11, runId: "r1" }),
    );

    expect(textRows(rows).map((row) => [row.kind, row.text])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello"],
    ]);
  });

  test("suppresses stream positions the backfilled page already proved", () => {
    const acc = createTranscriptAccumulator();
    acc.rebase([
      historyMessage({
        id: "m1",
        message_type: "assistant_message",
        content: "Hello",
        otid: "o1",
        seq_id: 11,
        run_id: "r1",
      }),
    ]);

    // A reconnect replays the deltas that produced the persisted message.
    const rows = acc.apply(
      assistant("lo", { uuid: "m1", otid: "o1", seqId: 11, runId: "r1" }),
    );

    expect((rows[0] as TranscriptTextRow).text).toBe("Hello");
  });

  test("orders backfilled rows ahead of live-only rows", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("live", { uuid: "m9", otid: "o9", seqId: 90, runId: "r2" }));
    const rows = acc.rebase([
      historyMessage({
        id: "m1",
        message_type: "user_message",
        content: "older",
        otid: "o1",
        seq_id: 1,
        run_id: "r1",
      }),
    ]);

    expect(textRows(rows).map((row) => row.text)).toEqual(["older", "live"]);
  });

  test("merges history tool calls and returns onto the streamed tool row", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(toolCallFragment("call-1", '{"command":"ec', { uuid: "env-1" }));

    const rows = acc.rebase([
      historyMessage({
        id: "hist-call",
        message_type: "tool_call_message",
        seq_id: 3,
        run_id: "r1",
        tool_call: {
          tool_call_id: "call-1",
          name: "Bash",
          arguments: '{"command":"echo hi"}',
        },
      }),
      historyMessage({
        id: "hist-return",
        message_type: "tool_return_message",
        seq_id: 4,
        run_id: "r1",
        tool_call_id: "call-1",
        tool_return: "hi",
        status: "success",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(toolRows(rows)[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: { command: "echo hi" },
      argumentsComplete: true,
      status: "complete",
      result: { content: "hi", isError: false },
    });
  });

  test("maps approval requests onto the tool row", () => {
    const acc = createTranscriptAccumulator();
    const rows = acc.rebase([
      historyMessage({
        id: "hist-approval",
        message_type: "approval_request_message",
        tool_calls: [
          {
            tool_call_id: "call-2",
            name: "Write",
            arguments: '{"path":"a.txt"}',
          },
        ],
      }),
    ]);

    expect(toolRows(rows)[0]).toMatchObject({
      toolCallId: "call-2",
      toolName: "Write",
      toolInput: { path: "a.txt" },
      status: "ready",
    });
  });

  test("ignores history message types it does not own", () => {
    const acc = createTranscriptAccumulator();
    const rows = acc.rebase([
      historyMessage({ id: "s1", message_type: "system_message", content: "sys" }),
      historyMessage({
        id: "e1",
        message_type: "event_message",
        event_type: "compaction",
        event_data: {},
      }),
    ]);

    expect(rows).toHaveLength(0);
  });

  test("accepts an empty page without disturbing existing rows", () => {
    const acc = createTranscriptAccumulator();
    const before = acc.apply(
      assistant("live", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }),
    );
    const after = acc.rebase({ messages: [] });

    expect(after).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("snapshot behavior", () => {
  test("produces a new array whenever a row changes", () => {
    const acc = createTranscriptAccumulator();
    const first = acc.apply(
      assistant("a", { uuid: "m1", otid: "o1", seqId: 1, runId: "r1" }),
    );
    const second = acc.apply(
      assistant("b", { uuid: "m1", otid: "o1", seqId: 2, runId: "r1" }),
    );

    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });

  test("is exported from the package root", async () => {
    const root = await import("../index.js");
    expect(typeof root.createTranscriptAccumulator).toBe("function");
    expect(root.createTranscriptAccumulator().rows()).toHaveLength(0);
  });

  test("reset() clears rows and replay state", () => {
    const acc = createTranscriptAccumulator();
    acc.apply(assistant("a", { uuid: "m1", otid: "o1", seqId: 5, runId: "r1" }));
    acc.reset();

    expect(acc.rows()).toHaveLength(0);
    const rows = acc.apply(
      assistant("a", { uuid: "m1", otid: "o1", seqId: 5, runId: "r1" }),
    );
    expect(textRows(rows).map((row) => row.text)).toEqual(["a"]);
  });
});
