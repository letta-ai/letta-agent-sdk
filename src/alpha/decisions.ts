import type Letta from "@letta-ai/letta-client";
import type {
  DecisionAnswer,
  DecisionEvaluateParams,
  DecisionQuestion,
  DecisionRequestOptions,
  DecisionResult,
} from "./decision-types.js";

const DEFAULT_MODEL = "~typesafe/jev-latest";
const DEFAULT_TIMEOUT_MS = 40_000;
const MODEL_PATTERN = /^typesafe\/jev-[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(detail: string): never {
  throw new Error(`Invalid decision request: ${detail}.`);
}

function malformedResponse(detail: string): never {
  throw new Error(`Decisions API returned an invalid response: ${detail}.`);
}

function validateJsonValue(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidRequest("state contains a non-finite number");
    return;
  }
  if (typeof value !== "object") {
    invalidRequest("state contains a value that JSON would omit");
  }
  const object = value as object;
  if (ancestors.has(object)) invalidRequest("state contains a cycle");
  ancestors.add(object);
  if (Array.isArray(object)) {
    for (let index = 0; index < object.length; index++) {
      if (!Object.hasOwn(object, index) || object[index] === undefined) {
        invalidRequest("state contains an array value that JSON would replace");
      }
      validateJsonValue(object[index], ancestors);
    }
  } else {
    for (const key of Object.keys(object)) {
      const entry = (object as UnknownRecord)[key];
      if (entry === undefined) invalidRequest("state contains a value that JSON would omit");
      validateJsonValue(entry, ancestors);
    }
  }
  ancestors.delete(object);
}

function assertJsonSerializable(value: unknown): void {
  validateJsonValue(value, new Set());
  try {
    if (JSON.stringify(value) === undefined) {
      invalidRequest("state is not JSON-serializable");
    }
  } catch {
    invalidRequest("state is not JSON-serializable");
  }
}

function validateQuestion(name: string, question: unknown): asserts question is DecisionQuestion {
  if (!isRecord(question) || typeof question.instructions !== "string") {
    invalidRequest(`question "${name}" must have string instructions`);
  }
  if (question.type === "choice") {
    if (!isRecord(question.criteria)) {
      invalidRequest(`choice question "${name}" must have a criteria object`);
    }
    const criteria = Object.keys(question.criteria);
    if (criteria.length < 1 || criteria.length > 255) {
      invalidRequest(`choice question "${name}" must have 1 to 255 criteria`);
    }
    if (!Object.values(question.criteria).every((value) => typeof value === "string")) {
      invalidRequest(`choice question "${name}" criteria must be strings`);
    }
    return;
  }
  if (question.type === "score") {
    if (
      !Array.isArray(question.criteria) ||
      question.criteria.length < 1 ||
      !Array.from(question.criteria).every((value) => typeof value === "string")
    ) {
      invalidRequest(`score question "${name}" must have a non-empty string criteria array`);
    }
    return;
  }
  if (question.type !== "noul") {
    invalidRequest(`question "${name}" has an unsupported type`);
  }
  if (Object.hasOwn(question, "criteria")) {
    invalidRequest(`noul question "${name}" must not have criteria`);
  }
}

function validateParams<Q extends Record<string, DecisionQuestion>>(
  params: DecisionEvaluateParams<Q>,
  options: DecisionRequestOptions,
): void {
  if (!isRecord(params)) invalidRequest("params must be an object");
  if (!(typeof params.state === "string" || isRecord(params.state) || Array.isArray(params.state))) {
    invalidRequest("state must be a string, object, or array");
  }
  assertJsonSerializable(params.state);
  if (!isRecord(params.questions) || Object.keys(params.questions).length === 0) {
    invalidRequest("questions must be a non-empty object");
  }
  for (const [name, question] of Object.entries(params.questions)) {
    validateQuestion(name, question);
  }
  const model = params.model ?? DEFAULT_MODEL;
  if (model !== DEFAULT_MODEL && !MODEL_PATTERN.test(model)) {
    invalidRequest("model must be a supported typesafe/jev identifier");
  }
  if (
    params.sessionId !== undefined &&
    (typeof params.sessionId !== "string" || params.sessionId.length > 256)
  ) invalidRequest("sessionId must be a string of at most 256 characters");
  if (params.trace !== undefined) {
    if (!isRecord(params.trace)) invalidRequest("trace must be an object");
    assertJsonSerializable(params.trace);
  }
  if (params.user !== undefined && typeof params.user !== "string") {
    invalidRequest("user must be a string");
  }
  if (
    params.provider !== undefined &&
    (!isRecord(params.provider) ||
      (params.provider.allowFallbacks !== undefined &&
        typeof params.provider.allowFallbacks !== "boolean"))
  ) invalidRequest("provider.allowFallbacks must be a boolean");
  if (
    options.timeoutMs !== undefined &&
    (typeof options.timeoutMs !== "number" ||
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0)
  ) invalidRequest("timeoutMs must be a positive finite number");
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validateProbabilityMap(
  value: unknown,
  validKeys: ReadonlySet<string>,
  detail: string,
): asserts value is Record<string, number> {
  if (!isRecord(value)) malformedResponse(`${detail} must be an object`);
  for (const [key, probability] of Object.entries(value)) {
    if (!validKeys.has(key) || !isFiniteInRange(probability, 0, 1)) {
      malformedResponse(`${detail} contains an invalid entry`);
    }
  }
}

function scoreIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function validateAnswer(answer: unknown, question: DecisionQuestion): DecisionAnswer<DecisionQuestion> {
  if (!isRecord(answer) || answer.type !== question.type) {
    malformedResponse("an answer has the wrong variant");
  }
  if (question.type === "choice") {
    const choices = new Set(Object.keys(question.criteria));
    if (typeof answer.choice !== "string" || !choices.has(answer.choice)) {
      malformedResponse("a choice answer selected an unknown criterion");
    }
    validateProbabilityMap(answer.probabilities, choices, "choice probabilities");
    if (!isFiniteInRange(answer.confidence, 0, 1)) {
      malformedResponse("choice confidence must be between 0 and 1");
    }
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  if (question.type === "score") {
    const maximum = question.criteria.length - 1;
    if (!isFiniteInRange(answer.score, 0, maximum)) {
      malformedResponse("score is outside the requested scale");
    }
    if (!isRecord(answer.legend) || Object.keys(answer.legend).length === 0) {
      malformedResponse("score legend must be a non-empty object");
    }
    for (const [key, label] of Object.entries(answer.legend)) {
      if (!scoreIndex(key, question.criteria.length) || label !== question.criteria[Number(key)]) {
        malformedResponse("score legend contains an invalid scale entry");
      }
    }
    const validIndices = new Set(
      question.criteria.map((_, index) => String(index)),
    );
    validateProbabilityMap(answer.probabilities, validIndices, "score probabilities");
    if (!isFiniteInRange(answer.confidence, 0, 1)) {
      malformedResponse("score confidence must be between 0 and 1");
    }
    return {
      type: "score",
      score: answer.score,
      legend: answer.legend as Record<string, string>,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  if (!isFiniteInRange(answer.noul, 0, 1)) {
    malformedResponse("noul must be between 0 and 1");
  }
  return { type: "noul", noul: answer.noul };
}

function validateResponse<Q extends Record<string, DecisionQuestion>>(
  value: unknown,
  questions: Q,
): DecisionResult<Q> {
  if (!isRecord(value)) malformedResponse("body must be an object");
  if (
    typeof value.id !== "string" || value.id.length === 0 ||
    typeof value.model !== "string" || value.model.length === 0 ||
    typeof value.provider !== "string" || value.provider.length === 0
  ) malformedResponse("id, model, and provider must be non-empty strings");
  if (!isRecord(value.answers)) malformedResponse("answers must be an object");
  const responseAnswers = value.answers;
  const expectedKeys = Object.keys(questions);
  const actualKeys = Object.keys(responseAnswers);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(responseAnswers, key))
  ) malformedResponse("answer keys do not match the requested questions");
  const answers = Object.fromEntries(
    expectedKeys.map((key): [string, DecisionAnswer<DecisionQuestion>] => [
      key,
      validateAnswer(responseAnswers[key], questions[key] as DecisionQuestion),
    ]),
  );
  if (!isRecord(value.usage)) malformedResponse("usage must be an object");
  const { input_tokens: inputTokens, output_tokens: outputTokens, cost } = value.usage;
  if (
    !Number.isInteger(inputTokens) || (inputTokens as number) < 0 ||
    !Number.isInteger(outputTokens) || (outputTokens as number) < 0 ||
    typeof cost !== "number" || !Number.isFinite(cost) || cost < 0
  ) malformedResponse("usage is invalid");
  return {
    id: value.id,
    model: value.model,
    provider: value.provider,
    answers: answers as DecisionResult<Q>["answers"],
    usage: { inputTokens: inputTokens as number, outputTokens: outputTokens as number, cost },
  };
}

/** Experimental Cloud Decisions resource. This API has no stability guarantee. */
export class DecisionsClient {
  constructor(
    private readonly client: Letta,
    private readonly assertOpen: () => void,
  ) {}

  async evaluate<const Q extends Record<string, DecisionQuestion>>(
    params: DecisionEvaluateParams<Q>,
    options: DecisionRequestOptions = {},
  ): Promise<DecisionResult<Q>> {
    this.assertOpen();
    validateParams(params, options);
    const response = await this.client.post<unknown>("/v1/alpha/decisions", {
      body: {
        state: params.state,
        questions: params.questions,
        model: params.model ?? DEFAULT_MODEL,
        ...(params.sessionId !== undefined ? { session_id: params.sessionId } : {}),
        ...(params.trace !== undefined ? { trace: params.trace } : {}),
        ...(params.user !== undefined ? { user: params.user } : {}),
        ...(params.provider !== undefined
          ? { provider: { allow_fallbacks: params.provider.allowFallbacks } }
          : {}),
      },
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      maxRetries: 0,
    });
    return validateResponse(response, params.questions);
  }
}
