import { describe, expect, test } from "bun:test";
import {
  buildCreateAgentRequestForPersonality,
  buildSystemPrompt,
  LETTA_CODE_AGENT_TYPE,
} from "@letta-ai/letta-code/agent-presets";
import { createAgentBody } from "../app-server-session.js";

describe("createAgentBody", () => {
  test("builds a generic harness agent when personality is omitted", async () => {
    const body = await createAgentBody({ model: "openai/gpt-5.2" });

    expect(body).toMatchObject({
      agent_type: LETTA_CODE_AGENT_TYPE,
      model: "openai/gpt-5.2",
      system: buildSystemPrompt("default", "memfs"),
      tags: ["origin:letta-code", "git-memory-enabled"],
      initial_message_sequence: [],
      parallel_tool_calls: true,
      compaction_settings: { model: "letta/auto" },
    });
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("memory_blocks");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("include_base_tools");
    expect(body).not.toHaveProperty("include_base_tool_rules");
  });

  test("uses caller memory as the complete identity without a personality preset", async () => {
    const memory = [
      { label: "persona", value: "You are Ezra." },
      { label: "human", value: "The human reads the docs." },
      { label: "instructions", value: "Answer from official sources." },
    ];
    const body = await createAgentBody({
      name: "Ezra",
      description: "Letta documentation assistant.",
      memory,
    });

    expect(body.name).toBe("Ezra");
    expect(body.description).toBe("Letta documentation assistant.");
    expect(body.memory_blocks).toEqual(memory);
  });

  test("applies a personality only when explicitly requested", async () => {
    const body = await createAgentBody({
      personality: "memo",
      model: "openai/gpt-5.2",
    });
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
  });

  test("preserves custom prompts", async () => {
    expect(
      (await createAgentBody({
        model: "openai/gpt-5.2",
        systemPrompt: "You are a focused research assistant.",
      })).system,
    ).toBe("You are a focused research assistant.");
  });

  test("resolves managed prompt presets for Cloud and app-server creation", async () => {
    expect(
      (await createAgentBody({ systemPrompt: "default" })).system,
    ).toBe(buildSystemPrompt("default", "memfs"));
    expect(
      (
        await createAgentBody({
          memfs: false,
          systemPrompt: "letta-codex",
        })
      ).system,
    ).toBe(buildSystemPrompt("letta", "standard"));
  });

  test("appends caller instructions to a managed prompt without replacing it", async () => {
    const append = "Do not send progress updates in the embedded widget.";
    const body = await createAgentBody({
      systemPrompt: { type: "preset", preset: "default", append },
    });

    expect(body.system).toBe(
      `${buildSystemPrompt("default", "memfs")}\n\n${append}`,
    );
  });
});
