import { describe, expect, test } from "bun:test";
import {
  AlphaClient as AlphaResource,
  DecisionsClient as DecisionsResource,
  LettaAgentClient as RootRuntimeClient,
} from "../index.js";
import { LettaAgentClient as PortableRuntimeClient } from "../client-entry.js";
import type {
  DecisionQuestion,
  DecisionResult,
  AlphaClient,
  DecisionsClient,
  LettaAgentClient,
} from "../index.js";
import type {
  DecisionsClient as PortableDecisionsClient,
  AlphaClient as PortableAlphaClient,
  LettaAgentClient as PortableClient,
} from "../client-entry.js";

type AssertTrue<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type _PortableExportsMatch = AssertTrue<Equal<DecisionsClient, PortableDecisionsClient>>;
type _PortableAlphaExportsMatch = AssertTrue<Equal<AlphaClient, PortableAlphaClient>>;

// Compile-time checks only. Do not run a classifier from the test suite.
async function checkPublicInference(client: LettaAgentClient) {
  const result = await client.alpha.decisions.evaluate({
    state: "Synthetic request",
    questions: {
      route: {
        type: "choice",
        instructions: "Route the request",
        criteria: { billing: "Charges", technical: "Bugs", other: "Neither" },
      },
      urgency: {
        type: "score",
        instructions: "Rank urgency",
        criteria: ["normal", "today"],
      },
      cancelThreat: {
        type: "noul",
        instructions: "The customer threatens cancellation.",
      },
    },
  });
  type _ChoiceLabels = AssertTrue<Equal<typeof result.answers.route.choice, "billing" | "technical" | "other">>;
  type _QuestionNames = AssertTrue<Equal<keyof typeof result.answers, "route" | "urgency" | "cancelThreat">>;
  const probability: number | undefined = result.answers.route.probabilities.billing;
  const score: number = result.answers.urgency.score;
  const likelihood: number = result.answers.cancelThreat.noul;
  const tokens: number = result.usage.inputTokens;
  // @ts-expect-error A label not supplied in criteria is not a possible result.
  const impossible: "legal" = result.answers.route.choice;
  // @ts-expect-error Unrequested questions are not present in the result.
  result.answers.missing;
  // @ts-expect-error Noul answers have no choice field.
  result.answers.cancelThreat.choice;
  // @ts-expect-error Scores remain numeric, not criterion strings.
  const wrongScore: string = result.answers.urgency.score;
  return { probability, score, likelihood, tokens };
}

async function checkPortableInference(client: PortableClient) {
  const questions = {
    route: {
      type: "choice",
      instructions: "Route it",
      criteria: { billing: "Payments", technical: "Bugs" },
    },
  } satisfies Record<string, DecisionQuestion>;
  const result: DecisionResult<typeof questions> = await client.alpha.decisions.evaluate({
    state: { text: "Synthetic message" },
    questions,
  }, { signal: new AbortController().signal, timeoutMs: 2_000 });
  const route: "billing" | "technical" = result.answers.route.choice;
  return route;
}

describe("public Decisions types", () => {
  test("exposes decisions only under the alpha namespace in both public clients", async () => {
    for (const Client of [RootRuntimeClient, PortableRuntimeClient]) {
      await using client = new Client({ backend: "cloud", apiKey: "synthetic-key" });
      expect(client.alpha).toBeInstanceOf(AlphaResource);
      expect(client.alpha.decisions).toBeInstanceOf(DecisionsResource);
      expect("decisions" in client).toBe(false);
    }
  });

  test("a retained alpha namespace rejects access after client close", async () => {
    const client = new RootRuntimeClient({ backend: "cloud", apiKey: "synthetic-key" });
    const alpha = client.alpha;
    await client.close();
    expect(() => alpha.decisions).toThrow("LettaAgentClient is closed");
  });

  test("the Node client's local backend rejects the alpha namespace", async () => {
    await using client = new RootRuntimeClient({ backend: "local" });
    expect(() => client.alpha).toThrow(/alpha.*cloud/i);
  });
});
