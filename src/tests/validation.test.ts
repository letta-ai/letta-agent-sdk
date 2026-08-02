import { describe, expect, test } from "bun:test";
import { validateCreateAgentOptions, validateCreateSessionOptions } from "../validation.js";

describe("validation", () => {
  test("accepts valid session skill and dreaming options", () => {
    expect(() =>
      validateCreateSessionOptions({
        skillSources: ["project", "global"],
        dreaming: {
          trigger: "step-count",
          stepCount: 6,
        },
        reasoningEffort: "high",
        toolset: {
          base: "none",
          include: ["Read", "LS", "Glob", "Grep"],
        },
      }),
    ).not.toThrow();
  });

  test("validates keyed MCP server configurations", () => {
    expect(() =>
      validateCreateSessionOptions({
        mcpServers: {
          local: { command: "node", args: ["server.js"] },
          remote: { type: "http", url: "https://example.com/mcp" },
        },
      }),
    ).not.toThrow();

    expect(() =>
      validateCreateSessionOptions({
        mcpServers: [{ name: "old", command: "node" }],
      } as never),
    ).toThrow("Expected an object keyed by server name");
  });

  test("rejects invalid client toolset configuration", () => {
    expect(() =>
      validateCreateSessionOptions({
        toolset: { base: "invented" },
      } as never),
    ).toThrow("Invalid toolset.base");

    expect(() =>
      validateCreateSessionOptions({
        toolset: { include: ["Read", ""] },
      }),
    ).toThrow("Invalid toolset.include");
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

  test("rejects invalid session dreaming options", () => {
    expect(() =>
      validateCreateSessionOptions({
        dreaming: {
          // biome-ignore lint/suspicious/noExplicitAny: runtime validation test
          trigger: "sometimes" as any,
        },
      }),
    ).toThrow("Invalid dreaming.trigger");

    expect(() =>
      validateCreateSessionOptions({
        dreaming: {
          // biome-ignore lint/suspicious/noExplicitAny: runtime validation test
          behavior: "manual" as any,
        },
      } as never),
    ).toThrow("Invalid dreaming.behavior");

    expect(() =>
      validateCreateSessionOptions({
        dreaming: {
          stepCount: 0,
        },
      }),
    ).toThrow("Invalid dreaming.stepCount");
  });

  test("rejects removed memfsStartup option", () => {
    expect(() =>
      validateCreateSessionOptions({
        memfsStartup: "skip",
      } as Parameters<typeof validateCreateSessionOptions>[0] & { memfsStartup: string }),
    ).toThrow("memfsStartup is not supported");
  });

  test("rejects options that only the removed stdio session supported", () => {
    for (const options of [
      { systemPrompt: "letta-claude" },
      { disallowedTools: ["Bash"] },
      { systemInfoReminder: false },
      { includePartialMessages: true },
      { dreaming: { behavior: "auto-launch" } },
    ]) {
      expect(() => validateCreateSessionOptions(options as never)).toThrow(
        "is not supported",
      );
    }
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
