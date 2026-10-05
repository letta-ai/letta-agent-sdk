import { describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import { LettaAgentClient } from "../client-entry.js";

type FetchInput = Parameters<typeof fetch>[0];

type RecordedRequest = {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
  signal?: AbortSignal | null;
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createFetchMock(
  requests: RecordedRequest[],
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: FetchInput | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : init?.body,
      signal: init?.signal,
    };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
}

const questions = {
  route: {
    type: "choice" as const,
    instructions: "Which team should handle this?",
    criteria: {
      billing: "Charges and refunds",
      technical: "Product failures",
      other: "Neither category",
    },
  },
  urgency: {
    type: "score" as const,
    instructions: "How urgent is this?",
    criteria: ["no rush", "normal", "today", "immediate"],
  },
  cancelThreat: {
    type: "noul" as const,
    instructions: "The customer is threatening to cancel.",
  },
};

const wireResponse = {
  id: "decision-1",
  model: "typesafe/jev-1.2",
  provider: "openrouter",
  answers: {
    route: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.61, other: 0.38 },
      confidence: 0.87,
    },
    urgency: {
      type: "score",
      score: 2.5,
      legend: { "0": "no rush", "3": "immediate" },
      probabilities: { "2": 0.504, "3": 0.495 },
      confidence: 0.91,
    },
    cancelThreat: { type: "noul", noul: 0.8 },
  },
  usage: { input_tokens: 31, output_tokens: 12, cost: 0.0042 },
};

function cloudClient(
  fetchMock: typeof fetch,
  extra: Record<string, unknown> = {},
): LettaAgentClient {
  return new LettaAgentClient({
    backend: "cloud",
    apiBaseUrl: "https://decisions.test/custom-base/",
    apiKey: "sk-test",
    fetch: fetchMock,
    ...extra,
  });
}

function basicParams(): { state: string; questions: typeof questions } {
  return { state: "I was charged twice and will cancel today.", questions };
}

describe("client.alpha.decisions.evaluate", () => {
  test("evaluates choice, score, and noul questions with the default model", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse(wireResponse)),
    );

    const result = await client.alpha.decisions.evaluate(basicParams());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.origin).toBe("https://decisions.test");
    expect(requests[0]?.url.pathname).toBe("/custom-base/v1/alpha/decisions");
    expect(requests[0]?.body).toEqual({
      model: "~typesafe/jev-latest",
      state: "I was charged twice and will cancel today.",
      questions,
    });
    expect(result as unknown).toEqual({
      ...wireResponse,
      usage: { inputTokens: 31, outputTokens: 12, cost: 0.0042 },
    });
    expect(result.answers.route.probabilities).toEqual({
      billing: 0.61,
      other: 0.38,
    });
    expect(result.answers.urgency.score).toBe(2.5);
    expect(result.answers.cancelThreat.noul).toBe(0.8);
  });

  test("maps explicit model and optional camel-case request fields", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse(wireResponse)),
      { headers: { "X-Account": "account-1", "X-Test": "custom" } },
    );

    await client.alpha.decisions.evaluate({
      ...basicParams(),
      state: { message: "refund", nested: [true, null, 3] },
      model: "typesafe/jev-1.2",
      sessionId: "session-correlation",
      trace: { ticket: "T-1" },
      user: "user-1",
      provider: { allowFallbacks: false },
    });

    expect(requests[0]?.body).toEqual({
      model: "typesafe/jev-1.2",
      state: { message: "refund", nested: [true, null, 3] },
      questions,
      session_id: "session-correlation",
      trace: { ticket: "T-1" },
      user: "user-1",
      provider: { allow_fallbacks: false },
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(requests[0]?.headers.get("x-account")).toBe("account-1");
    expect(requests[0]?.headers.get("x-test")).toBe("custom");
  });

  test("uses only the decisions HTTP endpoint even when a computer is configured", async () => {
    const requests: RecordedRequest[] = [];
    let socketConstructions = 0;
    class ForbiddenWebSocket {
      constructor() {
        socketConstructions += 1;
        throw new Error("WebSocket must not be constructed");
      }
    }
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse(wireResponse)),
      {
        computer: { deviceId: "configured-computer" },
        WebSocket: ForbiddenWebSocket,
      },
    );

    await client.alpha.decisions.evaluate(basicParams());

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/custom-base/v1/alpha/decisions",
    ]);
    expect(requests[0]?.url.pathname).not.toMatch(
      /agents|sessions|sandboxes|environments|computers|conversations/,
    );
    expect(socketConstructions).toBe(0);
  });

  test("is Cloud-only and rejects local or remote access before I/O", () => {
    let calls = 0;
    const fetchMock = createFetchMock([], () => {
      calls += 1;
      return jsonResponse(wireResponse);
    });
    const remote = new LettaAgentClient({
      backend: "remote",
      url: "ws://localhost:4500",
      fetch: fetchMock,
    } as never);

    expect(() => remote.alpha).toThrow(/alpha.*cloud/i);
    expect(
      () =>
        new LettaAgentClient({
          backend: "local",
          fetch: fetchMock,
        } as never),
    ).toThrow(/local.*portable|portable.*local/i);
    expect(calls).toBe(0);
  });

  test("a retained namespace rejects after close before I/O", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse(wireResponse)),
    );
    const decisions = client.alpha.decisions;

    await client.close();

    await expect(decisions.evaluate(basicParams())).rejects.toThrow(/closed/i);
    expect(requests).toHaveLength(0);
  });

  test("forwards a caller abort signal", async () => {
    const requests: RecordedRequest[] = [];
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock = createFetchMock(requests, (request) =>
      new Promise<Response>((_resolve, reject) => {
        markFetchStarted?.();
        request.signal?.addEventListener("abort", () =>
          reject(request.signal?.reason ?? new DOMException("Aborted", "AbortError")),
        );
      }),
    );
    const client = cloudClient(fetchMock);
    const controller = new AbortController();
    const pending = client.alpha.decisions.evaluate(basicParams(), {
      signal: controller.signal,
    });

    await fetchStarted;
    controller.abort(new DOMException("caller stopped", "AbortError"));

    await expect(pending).rejects.toThrow(/caller stopped|abort/i);
    expect(requests).toHaveLength(1);
  });
});

describe("decision request validation", () => {
  test("rejects malformed questions, criteria, model, and session IDs before I/O", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse(wireResponse)),
    );
    const tooManyChoices = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`choice-${index}`, "label"]),
    );
    const cases: Array<{ params: unknown; fragment: RegExp }> = [
      { params: { state: "x", questions: {} }, fragment: /questions/i },
      {
        params: {
          state: "x",
          questions: { q: { type: "unknown", instructions: "x" } },
        },
        fragment: /type|question/i,
      },
      {
        params: {
          state: "x",
          questions: { q: { type: "noul", instructions: 4 } },
        },
        fragment: /instructions/i,
      },
      {
        params: {
          state: "x",
          questions: {
            q: { type: "choice", instructions: "x", criteria: {} },
          },
        },
        fragment: /criteria|choice/i,
      },
      {
        params: {
          state: "x",
          questions: {
            q: { type: "choice", instructions: "x", criteria: tooManyChoices },
          },
        },
        fragment: /criteria|255|choice/i,
      },
      {
        params: {
          state: "x",
          questions: {
            q: { type: "score", instructions: "x", criteria: [] },
          },
        },
        fragment: /criteria|score/i,
      },
      { params: { ...basicParams(), model: "gpt-6" }, fragment: /model|jev/i },
      {
        params: { ...basicParams(), sessionId: "x".repeat(257) },
        fragment: /session/i,
      },
    ];

    for (const { params, fragment } of cases) {
      await expect(client.alpha.decisions.evaluate(params as never)).rejects.toThrow(
        fragment,
      );
    }
    expect(requests).toHaveLength(0);
  });

  test("rejects non-JSON state, cycles, and non-finite values before I/O", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse(wireResponse)),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidStates: unknown[] = [
      undefined,
      3,
      { missing: undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: 1n },
      cyclic,
    ];

    for (const state of invalidStates) {
      await expect(
        client.alpha.decisions.evaluate({ ...basicParams(), state } as never),
      ).rejects.toThrow(/state|JSON|serializ|finite|cycle/i);
    }
    expect(requests).toHaveLength(0);
  });

  test("requires a positive finite timeout before I/O", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () => jsonResponse(wireResponse)),
    );

    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        client.alpha.decisions.evaluate(basicParams(), { timeoutMs }),
      ).rejects.toThrow(/timeout/i);
    }
    expect(requests).toHaveLength(0);
  });
});

describe("decision response validation", () => {
  async function expectInvalidResponse(
    mutate: (response: typeof wireResponse) => unknown,
    fragment: RegExp,
  ): Promise<void> {
    const response = structuredClone(wireResponse);
    const client = cloudClient(
      createFetchMock([], () => jsonResponse(mutate(response))),
    );
    await expect(client.alpha.decisions.evaluate(basicParams())).rejects.toThrow(fragment);
  }

  test("requires every named answer and its requested variant", async () => {
    await expectInvalidResponse((response) => {
      delete (response.answers as Partial<typeof response.answers>).urgency;
      return response;
    }, /urgency|answer/i);
    await expectInvalidResponse((response) => {
      response.answers.route = response.answers.cancelThreat as never;
      return response;
    }, /route|choice|variant|type/i);
  });

  test("rejects labels outside the requested choices", async () => {
    await expectInvalidResponse((response) => {
      response.answers.route.choice = "sales";
      return response;
    }, /route|choice|label|sales/i);
  });

  test("rejects non-finite and out-of-range answer numbers", async () => {
    const mutations: Array<(response: typeof wireResponse) => unknown> = [
      (response) => {
        response.answers.route.probabilities.billing = -0.1;
        return response;
      },
      (response) => {
        response.answers.route.confidence = 1.1;
        return response;
      },
      (response) => {
        response.answers.cancelThreat.noul = Number.NaN;
        return response;
      },
      (response) => {
        response.answers.urgency.score = 4;
        return response;
      },
      (response) => {
        response.answers.urgency.probabilities["2"] = Number.POSITIVE_INFINITY;
        return response;
      },
    ];

    for (const mutate of mutations) {
      await expectInvalidResponse(mutate, /probab|confidence|noul|score|finite|range/i);
    }
  });

  test("rejects malformed response metadata and usage", async () => {
    const mutations: Array<(response: typeof wireResponse) => unknown> = [
      (response) => ({ ...response, id: 4 }),
      (response) => ({ ...response, model: null }),
      (response) => ({ ...response, provider: {} }),
      (response) => ({ ...response, usage: null }),
      (response) => ({
        ...response,
        usage: { ...response.usage, input_tokens: "31" },
      }),
      (response) => ({
        ...response,
        usage: { ...response.usage, output_tokens: Number.NaN },
      }),
      (response) => ({
        ...response,
        usage: { ...response.usage, cost: Number.POSITIVE_INFINITY },
      }),
    ];

    for (const mutate of mutations) {
      await expectInvalidResponse(mutate, /id|model|provider|usage|token|cost|finite/i);
    }
  });

  test("allows partial and independently rounded probabilities", async () => {
    const response = structuredClone(wireResponse);
    response.answers.route.probabilities = { billing: 0.34 } as Record<
      string,
      number
    > as typeof response.answers.route.probabilities;
    response.answers.route.confidence = 0.99;
    response.answers.urgency.probabilities = { "2": 0.333, "3": 0.666 };
    const client = cloudClient(
      createFetchMock([], () => jsonResponse(response)),
    );

    const result = await client.alpha.decisions.evaluate(basicParams());

    expect(result.answers.route.probabilities).toEqual({ billing: 0.34 });
    expect(result.answers.route.confidence).toBe(0.99);
    expect(result.answers.urgency.probabilities).toEqual({
      "2": 0.333,
      "3": 0.666,
    });
  });
});

describe("decision HTTP failures", () => {
  test("preserves the generated API error and never retries a 5xx", async () => {
    const requests: RecordedRequest[] = [];
    const client = cloudClient(
      createFetchMock(requests, () =>
        jsonResponse({ message: "decision service unavailable" }, { status: 503 }),
      ),
    );

    let caught: unknown;
    try {
      await client.alpha.decisions.evaluate(basicParams());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(APIError);
    expect(caught).toMatchObject({ status: 503 });
    expect((caught as Error).message).toContain("decision service unavailable");
    expect(requests).toHaveLength(1);
  });
});
