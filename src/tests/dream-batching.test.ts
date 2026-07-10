import { describe, expect, test } from "bun:test";
import { packDreamBatches } from "../dream/batching.js";
import type { DiscoveredSession } from "../dream/types.js";

function session(
  id: string,
  startTime: string,
  estTokens: number,
): DiscoveredSession {
  return {
    harness: "claude",
    sessionId: id,
    path: `/tmp/${id}.json`,
    startTime,
    endTime: startTime,
    estTokens,
    recordCount: 1,
    mtimeMs: 0,
  };
}

describe("packDreamBatches", () => {
  test("packs sessions in time order into budget-bounded batches", () => {
    const batches = packDreamBatches(
      [
        session("c", "2026-03-03T00:00:00Z", 400),
        session("a", "2026-03-01T00:00:00Z", 400),
        session("b", "2026-03-02T00:00:00Z", 400),
      ],
      900,
      10,
    );
    expect(batches.length).toBe(2);
    expect(batches[0]?.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(batches[1]?.sessions.map((s) => s.sessionId)).toEqual(["c"]);
    expect(batches[0]?.estTokens).toBe(800);
  });

  test("respects the session cap even under budget", () => {
    const batches = packDreamBatches(
      [
        session("a", "2026-03-01T00:00:00Z", 1),
        session("b", "2026-03-02T00:00:00Z", 1),
        session("c", "2026-03-03T00:00:00Z", 1),
      ],
      10_000,
      2,
    );
    expect(batches.map((b) => b.sessions.length)).toEqual([2, 1]);
  });

  test("an oversized session gets its own batch", () => {
    const batches = packDreamBatches(
      [
        session("big", "2026-03-01T00:00:00Z", 5000),
        session("small", "2026-03-02T00:00:00Z", 10),
      ],
      1000,
      10,
    );
    expect(batches.length).toBe(2);
    expect(batches[0]?.sessions.map((s) => s.sessionId)).toEqual(["big"]);
  });
});
