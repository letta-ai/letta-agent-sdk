import { describe, expect, test } from "bun:test";
import {
  buildCreateAgentRequest,
  buildSystemPrompt,
  LETTA_CODE_AGENT_TYPE,
} from "@letta-ai/letta-code/agent-presets";
import { createAgentBody } from "../agent-creation.js";

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
      tools: ["web_search", "fetch_webpage"],
      include_base_tools: false,
      include_base_tool_rules: false,
    });
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("memory_blocks");
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
    expect(body).toEqual(
      await buildCreateAgentRequest({
        personalityId: "memo",
        model: "openai/gpt-5.2",
      }),
    );
  });

  test("keeps the default MemFS harness while translating creation memory", async () => {
    const body = await createAgentBody({
      memory: [
        { label: "project", value: "SDK initialization correction" },
        { label: "persona", value: "You are Nora, a research analyst." },
        { label: "human", value: "The human tracks competitors." },
        { blockId: "block-shared" },
      ],
    });

    expect(body.system).toBe(buildSystemPrompt("default", "memfs"));
    expect(body.memory_blocks).toEqual([
      { label: "project", value: "SDK initialization correction" },
      { label: "persona", value: "You are Nora, a research analyst." },
      { label: "human", value: "The human tracks competitors." },
    ]);
    expect(body.block_ids).toEqual(["block-shared"]);
  });

  test("keeps the default MemFS harness with persona and human shorthand", async () => {
    const body = await createAgentBody({
      persona: "You are Nora, a research analyst.",
      human: "The human tracks competitors.",
    });

    expect(body.system).toBe(buildSystemPrompt("default", "memfs"));
    expect(body.memory_blocks).toEqual([
      { label: "persona", value: "You are Nora, a research analyst." },
      { label: "human", value: "The human tracks competitors." },
    ]);
  });

  test("keeps MemFS mode and exact base tools in the canonical request", async () => {
    const body = await createAgentBody({ memfs: false, baseTools: [] });
    expect(body.system).toBe(buildSystemPrompt("default", "standard"));
    expect(body.tags).toEqual(["origin:letta-code"]);
    expect(body.tools).toEqual([]);
    expect(body.include_base_tools).toBe(false);
    expect(body.include_base_tool_rules).toBe(false);
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
