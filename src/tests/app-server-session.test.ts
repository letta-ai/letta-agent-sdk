import { describe, expect, test } from "bun:test";
import { buildCreateAgentRequestForPersonality } from "@letta-ai/letta-code/agent-presets";
import { createAgentBody } from "../app-server-session.js";

describe("createAgentBody", () => {
  test("is byte-for-byte identical to the centralized Letta Code payload by default", async () => {
    const body = await createAgentBody({ model: "openai/gpt-5.2" });
    const expected = await buildCreateAgentRequestForPersonality({
      personalityId: "memo",
      model: "openai/gpt-5.2",
    });

    expect(body).toEqual(expected as unknown as Record<string, unknown>);
  });

  test("preserves custom prompts", async () => {
    expect(
      (await createAgentBody({
        model: "openai/gpt-5.2",
        systemPrompt: "You are a focused research assistant.",
      })).system,
    ).toBe("You are a focused research assistant.");
  });
});
