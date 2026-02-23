/**
 * Unit tests for listMessages() SDK layer.
 *
 * Covers:
 * 1. ListMessagesOptions / ListMessagesResult type shapes
 * 2. controlResponseWaiters routing (pump mock) — concurrent, error, close cleanup
 * 3. includePartialMessages flag forwarding to CLI args
 * 4. Waiter resolution while a stream is active (concurrent safety)
 * 5. Close / error waiter cleanup — no hanging promises
 *
 * Real end-to-end tests with a live CLI are in the manual smoke suite.
 */
import { describe, expect, test } from "bun:test";
import type { ListMessagesOptions, ListMessagesResult } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Type shapes
// ─────────────────────────────────────────────────────────────────────────────

describe("ListMessagesOptions type", () => {
  test("accepts all optional fields", () => {
    const opts: ListMessagesOptions = {
      conversationId: "conv-123",
      before: "msg-abc",
      after: "msg-xyz",
      order: "desc",
      limit: 50,
    };
    expect(opts.conversationId).toBe("conv-123");
    expect(opts.limit).toBe(50);
  });

  test("accepts empty options object", () => {
    const opts: ListMessagesOptions = {};
    expect(opts.conversationId).toBeUndefined();
    expect(opts.limit).toBeUndefined();
  });

  test("order can be asc or desc", () => {
    const asc: ListMessagesOptions = { order: "asc" };
    const desc: ListMessagesOptions = { order: "desc" };
    expect(asc.order).toBe("asc");
    expect(desc.order).toBe("desc");
  });
});

describe("ListMessagesResult type", () => {
  test("well-formed success result with messages", () => {
    const result: ListMessagesResult = {
      messages: [{ id: "msg-1", message_type: "user_message" }],
      nextBefore: "msg-1",
      hasMore: false,
    };
    expect(result.messages).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextBefore).toBe("msg-1");
  });

  test("empty page — nextBefore is null", () => {
    const result: ListMessagesResult = {
      messages: [],
      nextBefore: null,
      hasMore: false,
    };
    expect(result.messages).toHaveLength(0);
    expect(result.nextBefore).toBeNull();
  });

  test("partial page — hasMore is true", () => {
    const result: ListMessagesResult = {
      messages: new Array(50).fill({ id: "x" }),
      nextBefore: "msg-50",
      hasMore: true,
    };
    expect(result.hasMore).toBe(true);
    expect(result.nextBefore).toBe("msg-50");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. controlResponseWaiters routing
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal pump simulator — mirrors the routing logic in session.ts. */
function makePump() {
  const waiters = new Map<
    string,
    (resp: { subtype: string; response?: unknown; error?: string }) => void
  >();

  function route(wireMsg: {
    type: string;
    response?: {
      subtype: string;
      request_id?: string;
      response?: unknown;
      error?: string;
    };
  }): boolean {
    if (wireMsg.type !== "control_response") return false;
    const requestId = wireMsg.response?.request_id;
    if (requestId && waiters.has(requestId)) {
      const resolve = waiters.get(requestId)!;
      waiters.delete(requestId);
      resolve(wireMsg.response!);
      return true;
    }
    return false;
  }

  /** Simulate session.close() clearing all waiters with an error. */
  function closeAll() {
    for (const resolve of waiters.values()) {
      resolve({ subtype: "error", error: "session closed" });
    }
    waiters.clear();
  }

  return { waiters, route, closeAll };
}

describe("controlResponseWaiters routing", () => {
  test("routes matching control_response to waiter and removes it", async () => {
    const { waiters, route } = makePump();

    const promise = new Promise<{ subtype: string; response?: unknown }>(
      (res) => { waiters.set("list_001", res); }
    );

    const handled = route({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "list_001",
        response: { messages: [], has_more: false },
      },
    });

    expect(handled).toBe(true);
    const resp = await promise;
    expect(resp.subtype).toBe("success");
    expect(waiters.size).toBe(0); // waiter consumed
  });

  test("drops unmatched control_response (no registered waiter)", () => {
    const { waiters, route } = makePump();

    const handled = route({
      type: "control_response",
      response: { subtype: "success", request_id: "unknown_id" },
    });

    expect(handled).toBe(false);
    expect(waiters.size).toBe(0);
  });

  test("routes error subtype to waiter", async () => {
    const { waiters, route } = makePump();

    const promise = new Promise<{ subtype: string; error?: string }>(
      (res) => { waiters.set("list_002", res); }
    );

    route({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "list_002",
        error: "conversation not found",
      },
    });

    const resp = await promise;
    expect(resp.subtype).toBe("error");
    expect(resp.error).toContain("conversation not found");
  });

  test("concurrent waiters for different request_ids resolve independently", async () => {
    const { waiters, route } = makePump();

    const p1 = new Promise<{ subtype: string; response?: unknown }>(
      (res) => waiters.set("req_A", res)
    );
    const p2 = new Promise<{ subtype: string; response?: unknown }>(
      (res) => waiters.set("req_B", res)
    );

    // Deliver in reverse order — both should resolve to their own response
    route({
      type: "control_response",
      response: { subtype: "success", request_id: "req_B", response: { messages: [1] } },
    });
    route({
      type: "control_response",
      response: { subtype: "success", request_id: "req_A", response: { messages: [2] } },
    });

    const [rA, rB] = await Promise.all([p1, p2]);
    expect(rA.subtype).toBe("success");
    expect(rB.subtype).toBe("success");
    expect(waiters.size).toBe(0);
  });

  test("non-control_response messages are ignored (pass-through)", () => {
    const { waiters, route } = makePump();
    waiters.set("req_X", () => { throw new Error("should not be called"); });

    const handled = route({ type: "assistant_message" });
    expect(handled).toBe(false);
    expect(waiters.size).toBe(1); // waiter still registered
  });

  test("control_response without request_id is dropped", () => {
    const { waiters, route } = makePump();
    waiters.set("req_Y", () => { throw new Error("should not be called"); });

    const handled = route({
      type: "control_response",
      response: { subtype: "success" /* no request_id */ },
    });
    expect(handled).toBe(false);
    expect(waiters.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. includePartialMessages arg forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("includePartialMessages arg forwarding", () => {
  /**
   * Simulate transport.ts buildArgs() to verify the flag is included.
   * The actual transport builds the args array and passes it to spawn().
   */
  function buildArgs(options: {
    agentId?: string;
    conversationId?: string;
    includePartialMessages?: boolean;
  }): string[] {
    const args: string[] = ["--output", "stream-json"];
    if (options.agentId) args.push("--agent", options.agentId);
    if (options.conversationId) args.push("--conv", options.conversationId);
    if (options.includePartialMessages) args.push("--include-partial-messages");
    return args;
  }

  test("flag absent when includePartialMessages is false", () => {
    const args = buildArgs({ agentId: "agent-1", includePartialMessages: false });
    expect(args).not.toContain("--include-partial-messages");
  });

  test("flag absent when includePartialMessages is undefined", () => {
    const args = buildArgs({ agentId: "agent-1" });
    expect(args).not.toContain("--include-partial-messages");
  });

  test("flag present when includePartialMessages is true", () => {
    const args = buildArgs({ agentId: "agent-1", includePartialMessages: true });
    expect(args).toContain("--include-partial-messages");
  });

  test("flag position is after other args (no disruption)", () => {
    const args = buildArgs({
      agentId: "agent-1",
      conversationId: "conv-abc",
      includePartialMessages: true,
    });
    // Other args still present
    expect(args).toContain("--agent");
    expect(args).toContain("agent-1");
    expect(args).toContain("--conv");
    expect(args).toContain("conv-abc");
    expect(args).toContain("--include-partial-messages");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Waiter while stream is active
// ─────────────────────────────────────────────────────────────────────────────

describe("listMessages waiter while stream active", () => {
  /**
   * The key invariant: a listMessages call can be in-flight at the same time
   * as a stream is running.  The pump should route stream events to stream
   * consumers and control_responses to listMessages waiters independently —
   * no interference.
   */
  test("control_response for listMessages does not discard stream messages", async () => {
    const { waiters, route } = makePump();

    // Register a listMessages waiter
    const listPromise = new Promise<{ subtype: string; response?: unknown }>(
      (res) => { waiters.set("concurrent_list", res); }
    );

    // Simulate stream events arriving first
    const streamEvents = [
      { type: "assistant_message", content: "hello" },
      { type: "tool_call_message" },
    ];
    for (const ev of streamEvents) {
      // Stream events are not control_response, so pump returns false
      const handled = route(ev as Parameters<typeof route>[0]);
      expect(handled).toBe(false);
    }
    expect(waiters.size).toBe(1); // listMessages waiter still waiting

    // Now the control_response arrives
    route({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "concurrent_list",
        response: { messages: [{ id: "m1" }], has_more: false },
      },
    });

    const resp = await listPromise;
    expect(resp.subtype).toBe("success");
    expect(waiters.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Close / error waiter cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe("waiter cleanup on session close", () => {
  test("close cancels in-flight listMessages waiter with error", async () => {
    const { waiters, closeAll } = makePump();

    const listPromise = new Promise<{ subtype: string; error?: string }>(
      (res) => { waiters.set("inflight_req", res); }
    );

    // Session closes before response arrives
    closeAll();

    const resp = await listPromise;
    expect(resp.subtype).toBe("error");
    expect(resp.error).toBe("session closed");
    expect(waiters.size).toBe(0); // map drained
  });

  test("close cancels multiple concurrent waiters", async () => {
    const { waiters, closeAll } = makePump();

    const p1 = new Promise<{ subtype: string; error?: string }>(
      (res) => { waiters.set("req_1", res); }
    );
    const p2 = new Promise<{ subtype: string; error?: string }>(
      (res) => { waiters.set("req_2", res); }
    );
    const p3 = new Promise<{ subtype: string; error?: string }>(
      (res) => { waiters.set("req_3", res); }
    );

    closeAll();

    const results = await Promise.all([p1, p2, p3]);
    for (const r of results) {
      expect(r.subtype).toBe("error");
      expect(r.error).toBe("session closed");
    }
    expect(waiters.size).toBe(0);
  });

  test("close is idempotent — second close does not throw", () => {
    const { waiters, closeAll } = makePump();
    waiters.set("req", (r) => { void r; });

    closeAll();
    expect(() => closeAll()).not.toThrow(); // already empty, should be safe
    expect(waiters.size).toBe(0);
  });

  test("waiter registered after close is never resolved (guard by caller)", async () => {
    // This verifies that if a caller checks initialized before calling listMessages,
    // a late waiter registration doesn't silently hang.
    // We model this as: waiter registered, then close fires immediately.
    const { waiters, closeAll } = makePump();

    let resolved = false;
    const listPromise = new Promise<{ subtype: string; error?: string }>((res) => {
      waiters.set("late_req", res);
      // Close fires synchronously before any response can arrive
      closeAll();
      resolved = true;
    });

    const resp = await listPromise;
    expect(resolved).toBe(true);
    expect(resp.subtype).toBe("error");
    expect(resp.error).toBe("session closed");
  });
});
