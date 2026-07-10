import { describe, expect, test } from "bun:test";
import {
  AGGREGATOR_PERSONA,
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
