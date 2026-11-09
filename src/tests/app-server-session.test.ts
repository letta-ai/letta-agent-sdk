import { describe, expect, test } from "bun:test";
import {
  buildCreateAgentRequest,
  buildSystemPrompt,
  LETTA_CODE_AGENT_TYPE,
} from "@letta-ai/letta-code/agent-presets";
import { createAgentBody } from "../agent-creation.js";
import { createExternalToolCallHandler } from "../external-tools.js";
import type { AnyAgentTool } from "../types.js";

describe("createAgentBody", () => {
  test("builds a generic harness agent when personality is omitted", async () => {
    const body = await createAgentBody({ model: "openai/gpt-5.2" });

    expect(body).toMatchObject({
      agent_type: LETTA_CODE_AGENT_TYPE,
      model: "openai/gpt-5.2",
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
    // 0.33.x seeds the root index and refers to core memory files in the prompt.
    expect(body.memory_blocks).toEqual([
      { label: "MEMORY", value: "# Memory\n", description: "Root memory index." },
    ]);
    expect(body.system).toContain("core memory files");
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
    expect(body.memory_blocks).toEqual([
      { label: "MEMORY", value: "# Memory\n", description: "Root memory index." },
      ...memory,
    ]);
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

  test("translates convenience memory inputs before canonical creation", async () => {
    const body = await createAgentBody({
      personality: "memo",
      memory: [
        { label: "persona", value: "Memory persona" },
        { blockId: "block-shared" },
      ],
      persona: "Convenience persona",
      human: "Convenience human",
    });

    expect(body.memory_blocks).toEqual(
      expect.arrayContaining([
        { label: "persona", value: "Convenience persona" },
        { label: "human", value: "Convenience human" },
      ]),
    );
    expect(body.block_ids).toEqual(["block-shared"]);
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

describe("createExternalToolCallHandler", () => {
  test("executes a repeated request_id once and returns the same result", async () => {
    let executions = 0;
    const contexts: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = {
      name: "submit",
      label: "Submit",
      description: "Has a side effect",
      parameters: { type: "object", properties: {} },
      execute: async (_id: string, _args: unknown, _signal: unknown, _onUpdate: unknown, context: unknown) => {
        executions++;
        contexts.push(context);
        await gate;
        return { content: [{ type: "text" as const, text: `run ${executions}` }] };
      },
    } as unknown as AnyAgentTool;
    const handler = createExternalToolCallHandler(new Map([["submit", tool]]));
    const request = {
      type: "external_tool_call_request",
      request_id: "external-tool-1",
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      tool_call_id: "tool-call-1",
      tool_name: "submit",
      input: {},
    } as Parameters<typeof handler>[0];

    // Second delivery arrives while the first is still in flight.
    const first = handler(request);
    const second = handler({ ...request });
    release();
    const results = await Promise.all([first, second]);
    // A late redelivery after completion reuses the finished result.
    const third = await handler({ ...request });

    expect(executions).toBe(1);
    expect(contexts).toEqual([{ toolCallId: "tool-call-1", agentId: "agent-1", conversationId: "default" }]);
    expect(results[1]).toEqual(results[0]);
    expect(third).toEqual(results[0]);
  });
});
