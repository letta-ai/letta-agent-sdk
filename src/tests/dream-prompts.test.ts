import { describe, expect, test } from "bun:test";
import {
  AGGREGATOR_PERSONA,
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
      "facts and documentation readily discoverable from the relevant repository",
    );
  });
});
