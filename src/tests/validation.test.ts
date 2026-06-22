import { describe, expect, test } from "bun:test";
import { validateCreateAgentOptions, validateCreateSessionOptions } from "../validation.js";

describe("validation", () => {
  test("accepts valid session skill/reminder/sleeptime options", () => {
    expect(() =>
      validateCreateSessionOptions({
        skillSources: ["project", "global"],
        systemInfoReminder: false,
        sleeptime: {
          trigger: "step-count",
          behavior: "reminder",
          stepCount: 6,
        },
        maxApprovalRecoveryAttempts: 2,
        approvalRecoveryTimeoutMs: 3000,
        reasoningEffort: "high",
      }),
    ).not.toThrow();
  });

  test("rejects invalid session reasoning effort", () => {
    expect(() =>
      validateCreateSessionOptions({
        // biome-ignore lint/suspicious/noExplicitAny: runtime validation test
        reasoningEffort: "maximum" as any,
      }),
    ).toThrow("Invalid reasoningEffort");
  });

  test("rejects invalid session skill source", () => {
    expect(() =>
      validateCreateSessionOptions({
        // biome-ignore lint/suspicious/noExplicitAny: runtime validation test
        skillSources: ["invalid-source"] as any,
      }),
    ).toThrow("Invalid skill source");
  });

  test("rejects invalid session sleeptime options", () => {
    expect(() =>
      validateCreateSessionOptions({
        sleeptime: {
          // biome-ignore lint/suspicious/noExplicitAny: runtime validation test
          trigger: "sometimes" as any,
        },
      }),
    ).toThrow("Invalid sleeptime.trigger");

    expect(() =>
      validateCreateSessionOptions({
        sleeptime: {
          // biome-ignore lint/suspicious/noExplicitAny: runtime validation test
          behavior: "manual" as any,
        },
      }),
    ).toThrow("Invalid sleeptime.behavior");

    expect(() =>
      validateCreateSessionOptions({
        sleeptime: {
          stepCount: 0,
        },
      }),
    ).toThrow("Invalid sleeptime.stepCount");
  });

  test("rejects invalid approval recovery options", () => {
    expect(() =>
      validateCreateSessionOptions({
        maxApprovalRecoveryAttempts: -1,
      }),
    ).toThrow("Invalid maxApprovalRecoveryAttempts");

    expect(() =>
      validateCreateSessionOptions({
        approvalRecoveryTimeoutMs: 0,
      }),
    ).toThrow("Invalid approvalRecoveryTimeoutMs");
  });

  test("rejects removed memfsStartup option", () => {
    expect(() =>
      validateCreateSessionOptions({
        memfsStartup: "skip",
      } as Parameters<typeof validateCreateSessionOptions>[0] & { memfsStartup: string }),
    ).toThrow("memfsStartup is not supported");
  });

  test("rejects invalid agent skill source", () => {
    expect(() =>
      validateCreateAgentOptions({
        // biome-ignore lint/suspicious/noExplicitAny: runtime validation test
        skillSources: ["bundled", "bad"] as any,
      }),
    ).toThrow("Invalid skill source");
  });
});
