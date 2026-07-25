import { describe, expect, test } from "bun:test";
import { buildCreateAgentRequestForPersonality } from "@letta-ai/letta-code/agent-presets";
import { createAgentBody } from "../app-server-session.js";

describe("createAgentBody", () => {
  test("matches the centralized payload while leaving tool defaults to the harness", async () => {
    const body = await createAgentBody({ model: "openai/gpt-5.2" });
    const expected = {
      ...(await buildCreateAgentRequestForPersonality({
        personalityId: "memo",
        model: "openai/gpt-5.2",
      })),
    } as unknown as Record<string, unknown>;
    delete expected.tools;
    delete expected.include_base_tools;
    delete expected.include_base_tool_rules;

    expect(body).toEqual(expected);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("include_base_tools");
    expect(body).not.toHaveProperty("include_base_tool_rules");
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
