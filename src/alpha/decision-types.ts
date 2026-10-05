/** Experimental Decisions types. These contracts may change without notice. */
/** Values accepted as evidence by the Decisions API. */
export type DecisionJsonValue =
  | string
  | number
  | boolean
  | null
  | DecisionJsonValue[]
  | { [key: string]: DecisionJsonValue };

export interface DecisionChoiceQuestion<
  Criteria extends Record<string, string> = Record<string, string>,
> {
  type: "choice";
  instructions: string;
  criteria: Criteria;
}

export interface DecisionScoreQuestion<
  Criteria extends readonly string[] = readonly string[],
> {
  type: "score";
  instructions: string;
  criteria: Criteria;
}

export interface DecisionNoulQuestion {
  type: "noul";
  instructions: string;
}

export type DecisionQuestion =
  | DecisionChoiceQuestion
  | DecisionScoreQuestion
  | DecisionNoulQuestion;

export interface DecisionChoiceAnswer<Choice extends string = string> {
  type: "choice";
  choice: Choice;
  probabilities: Partial<Record<Choice, number>>;
  confidence: number;
}

export interface DecisionScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Partial<Record<string, number>>;
  confidence: number;
}

export interface DecisionNoulAnswer {
  type: "noul";
  noul: number;
}

export type DecisionAnswer<Q extends DecisionQuestion> =
  Q extends DecisionChoiceQuestion<infer Criteria>
    ? DecisionChoiceAnswer<Extract<keyof Criteria, string>>
    : Q extends DecisionScoreQuestion
      ? DecisionScoreAnswer
      : Q extends DecisionNoulQuestion
        ? DecisionNoulAnswer
        : never;

export interface DecisionEvaluateParams<
  Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> {
  state: string | DecisionJsonValue[] | { [key: string]: DecisionJsonValue };
  questions: Q;
  model?: string;
  sessionId?: string;
  trace?: Record<string, DecisionJsonValue>;
  user?: string;
  provider?: {
    allowFallbacks?: boolean;
  };
}

export interface DecisionRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface DecisionResult<
  Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> {
  id: string;
  model: string;
  provider: string;
  answers: { [K in keyof Q]: DecisionAnswer<Q[K]> };
  usage: DecisionUsage;
}
