import { describe, expect, test } from "bun:test";
import {
  AGGREGATOR_PERSONA,
  buildAggregatorUserPrompt,
  buildReflectionUserPrompt,
  MEMORY_ROUTING_CONTRACT,
  REFLECTION_SYSTEM_PROMPT,
} from "../dream/prompts.js";

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

describe("dream prompt contracts", () => {
  test("reflection and aggregation use the same memory-routing contract", () => {
    expect(occurrences(REFLECTION_SYSTEM_PROMPT, MEMORY_ROUTING_CONTRACT)).toBe(1);
    expect(occurrences(AGGREGATOR_PERSONA, MEMORY_ROUTING_CONTRACT)).toBe(1);
    expect(REFLECTION_SYSTEM_PROMPT).not.toContain("{{memoryRoutingContract}}");
    expect(AGGREGATOR_PERSONA).not.toContain("{{memoryRoutingContract}}");
  });

  test("the shared skill policy defines routing, activation, and deduplication", () => {
    expect(MEMORY_ROUTING_CONTRACT).toContain(
      "definable activation condition → a skill",
    );
    expect(MEMORY_ROUTING_CONTRACT).toContain(
      "Treat the frontmatter `description` as the activation mechanism",
    );
    expect(MEMORY_ROUTING_CONTRACT).toContain(
      "Merge skills with the same or substantially similar activation conditions",
    );
    expect(MEMORY_ROUTING_CONTRACT).toContain(
      "information readily discoverable from the relevant repository",
    );
    expect(MEMORY_ROUTING_CONTRACT).toContain("explicit user feedback");
    expect(MEMORY_ROUTING_CONTRACT).toContain("experiential delta");
    expect(MEMORY_ROUTING_CONTRACT).toContain(
      "Do not persist file maps, implementation tours, API inventories",
    );
    expect(MEMORY_ROUTING_CONTRACT).toContain(
      "A corrected mistake at the start of a skill is not permission to attach an implementation guide",
    );
    expect(MEMORY_ROUTING_CONTRACT).toContain(
      "Do not add a skill catalog or index to `system/`",
    );
    expect(REFLECTION_SYSTEM_PROMPT).toContain("private user-signal ledger");
    expect(AGGREGATOR_PERSONA).toContain(
      "Does every retained paragraph pass the experiential-delta test on its own?",
    );
  });

  test("reflection prompts name the authoritative memory root", () => {
    const prompt = buildReflectionUserPrompt({
      batchIndex: 3,
      inputDir: "/tmp/dream/batches/3/input",
      sessionFileNames: ["claude-session.json"],
      memoryDir: "/tmp/dream/batches/3/output",
      timeRange: {
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-07-02T00:00:00.000Z",
      },
    });

    expect(prompt).toContain(
      "authoritative absolute memory root for this batch is:\n/tmp/dream/batches/3/output",
    );
    expect(prompt).toContain("never write to a sibling or parent agent's memory");
  });
});

describe("aggregationPrompt threading", () => {
  const base = {
    batchesDir: "/run/batches",
    batchCount: 2,
    memoryDir: "/agents/a1/memory",
  };

  test("aggregator user prompt includes the caller instruction when provided", () => {
    const prompt = buildAggregatorUserPrompt({
      ...base,
      instruction: "Maintain system/AGENTS.md in place; keep its frontmatter.",
    });
    expect(prompt).toContain(
      "Additional user-provided instruction for this pass:",
    );
    expect(prompt).toContain(
      "Maintain system/AGENTS.md in place; keep its frontmatter.",
    );
  });

  test("aggregator user prompt is unchanged when no instruction is provided", () => {
    const prompt = buildAggregatorUserPrompt(base);
    expect(prompt).not.toContain("Additional user-provided instruction");
    expect(prompt).not.toContain("{{instructionSection}}");
  });

  test("blank instruction is treated as absent", () => {
    const prompt = buildAggregatorUserPrompt({ ...base, instruction: "   " });
    expect(prompt).not.toContain("Additional user-provided instruction");
  });
});
