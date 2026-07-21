import { describe, expect, test } from "bun:test";
import { createAgentBody } from "../app-server-session.js";

describe("createAgentBody", () => {
  test("uses an empty prompt when systemPrompt is omitted", () => {
    const body = createAgentBody({ model: "openai/gpt-5.2" });

    expect(body.system).toBe("");
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
