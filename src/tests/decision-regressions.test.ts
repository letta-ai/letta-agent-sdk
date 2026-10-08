import { describe, expect, test } from "bun:test";
import { LettaAgentClient } from "../client-entry.js";

function jsonResponse(answers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    id: "synthetic-decision",
    model: "typesafe/jev-test",
    provider: "synthetic",
    answers,
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
  }), { headers: { "Content-Type": "application/json" } });
}

describe("Decisions review regressions", () => {
  test("preserves __proto__ as an own named answer", async () => {
    const name = "__proto__";
    const answer = { type: "noul", noul: 0.5 };
    await using client = new LettaAgentClient({
      backend: "cloud",
      apiKey: "synthetic-key",
      fetch: (async (_input: Parameters<typeof fetch>[0]) =>
        jsonResponse(Object.fromEntries([[name, answer]]))) as typeof fetch,
    });
    const result = await client.alpha.decisions.evaluate({
      state: "Synthetic evidence",
      questions: { [name]: { type: "noul", instructions: "Synthetic proposition" } },
    });
    expect(Object.hasOwn(result.answers, name)).toBe(true);
    expect(Object.keys(result.answers)).toEqual([name]);
    expect(JSON.parse(JSON.stringify(result.answers))[name]).toEqual(answer);
  });

  test("rejects sparse score criteria before network I/O", async () => {
    let requests = 0;
    await using client = new LettaAgentClient({
      backend: "cloud",
      apiKey: "synthetic-key",
      fetch: (async (_input: Parameters<typeof fetch>[0]) => {
        requests += 1;
        return jsonResponse({
          urgency: {
            type: "score", score: 0, legend: { "0": "normal" },
            probabilities: { "0": 1 }, confidence: 1,
          },
        });
      }) as typeof fetch,
    });
    const failure = await client.alpha.decisions.evaluate({
      state: "Synthetic evidence",
      questions: {
        urgency: { type: "score", instructions: "Rank urgency", criteria: new Array<string>(1) },
      },
    }).catch((error: unknown) => error);
    expect(requests).toBe(0);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Invalid decision request");
  });
});
