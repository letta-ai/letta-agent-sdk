/**
 * Unit tests for listMessages() types and control-response waiter routing.
 *
 * These tests verify:
 * 1. ListMessagesOptions / ListMessagesResult type shapes
 * 2. controlResponseWaiters routing via the pump (mock transport)
 *
 * Real end-to-end tests (live CLI + API) are in the manual smoke suite.
 */
import { describe, expect, test } from "bun:test";
import type { ListMessagesOptions, ListMessagesResult } from "../types.js";

// ─── type shape tests ────────────────────────────────────────────────────────

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
});

describe("ListMessagesResult type", () => {
  test("well-formed success result", () => {
    const result: ListMessagesResult = {
      messages: [{ id: "msg-1", message_type: "user_message" }],
      nextBefore: "msg-1",
      hasMore: false,
    };
    expect(result.messages).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });

  test("empty page result", () => {
    const result: ListMessagesResult = {
      messages: [],
      nextBefore: null,
      hasMore: false,
    };
    expect(result.messages).toHaveLength(0);
  });
});

// ─── control-response waiter routing ─────────────────────────────────────────

describe("controlResponseWaiters routing logic", () => {
  /**
   * Simulate the pump's routing logic in isolation.
   * The real pump in session.ts does the same Map lookup + delete + resolve.
   */
  function makePump() {
    const waiters = new Map<
      string,
      (resp: { subtype: string; response?: unknown; error?: string }) => void
    >();
    function route(wireMsg: { type: string; response?: { subtype: string; request_id?: string; response?: unknown; error?: string } }) {
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
    return { waiters, route };
  }

  test("routes matching control_response to waiter and removes it", async () => {
    const { waiters, route } = makePump();

    const promise = new Promise<{ subtype: string; response?: unknown }>((res) => {
      waiters.set("list_001", res);
    });

    const handled = route({
      type: "control_response",
      response: { subtype: "success", request_id: "list_001", response: { messages: [], has_more: false } },
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

  test("routes error response to waiter", async () => {
    const { waiters, route } = makePump();

    const promise = new Promise<{ subtype: string; error?: string }>((res) => {
      waiters.set("list_002", res);
    });

    route({
      type: "control_response",
      response: { subtype: "error", request_id: "list_002", error: "conversation not found" },
    });

    const resp = await promise;
    expect(resp.subtype).toBe("error");
    expect(resp.error).toContain("conversation not found");
  });

  test("concurrent waiters for different request_ids resolve independently", async () => {
    const { waiters, route } = makePump();

    const p1 = new Promise<{ subtype: string }>((res) => waiters.set("req_A", res));
    const p2 = new Promise<{ subtype: string }>((res) => waiters.set("req_B", res));

    route({ type: "control_response", response: { subtype: "success", request_id: "req_B", response: { messages: [1] } } });
    route({ type: "control_response", response: { subtype: "success", request_id: "req_A", response: { messages: [2] } } });

    const [rA, rB] = await Promise.all([p1, p2]);
    expect(rA.subtype).toBe("success");
    expect(rB.subtype).toBe("success");
    expect(waiters.size).toBe(0);
  });
});
