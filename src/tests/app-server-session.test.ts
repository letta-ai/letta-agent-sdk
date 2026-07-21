import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "@letta-ai/letta-code/agent-presets";
import { createAgentBody } from "../app-server-session.js";

describe("createAgentBody", () => {
  test("uses the Letta Code MemFS prompt when systemPrompt is omitted", () => {
    const body = createAgentBody({ model: "openai/gpt-5.2" });

    expect(body.system).toBe(buildSystemPrompt("default", "memfs"));
  });

  test("uses the Letta Code non-MemFS prompt for worker agents", () => {
    const body = createAgentBody({
      model: "openai/gpt-5.2",
      memfs: false,
    });

    expect(body.system).toBe(buildSystemPrompt("default", "standard"));
  });

  test("preserves custom prompts", () => {
    expect(
      createAgentBody({
        model: "openai/gpt-5.2",
        systemPrompt: "You are a focused research assistant.",
      }).system,
    ).toBe("You are a focused research assistant.");
  });
});
