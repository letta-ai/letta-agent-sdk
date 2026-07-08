// Prompt loading + templating for the dream pipeline's agents. The reflector
// carries the reflection system prompt; every batch runs as a session on it
// with a path-bearing user prompt. The aggregator carries the default system
// prompt with AGGREGATOR_PERSONA as its persona block. Keep prompt TEXT in
// prompts/*.md — the .md files are the editing surface; this module only
// interpolates {{vars}}. render() throws on unresolved {{vars}} so a renamed
// placeholder fails at run start instead of leaking into a prompt.

import aggregatorPersonaMd from "./prompts/aggregator-persona.md";
import aggregatorUserMd from "./prompts/aggregator-user.md";
import reflectionSystemMd from "./prompts/reflection-system.md";
import reflectionUserMd from "./prompts/reflection-user.md";

export const REFLECTION_SYSTEM_PROMPT: string = reflectionSystemMd.trim();
export const AGGREGATOR_PERSONA: string = aggregatorPersonaMd.trim();

function render(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const value = vars[key];
      if (value === undefined) {
        throw new Error(`prompt template: missing variable ${match}`);
      }
      return String(value);
    })
    .trim();
}

function instructionSection(instruction: string | undefined): string {
  return instruction?.trim()
    ? `\n\nAdditional user-provided instruction for this pass:\n${instruction.trim()}`
    : "";
}

export function buildReflectionUserPrompt(input: {
  batchIndex: number;
  inputDir: string;
  sessionFileNames: string[];
  memoryDir: string;
  timeRange: { start: string; end: string };
  instruction?: string;
}): string {
  return render(reflectionUserMd, {
    batchIndex: input.batchIndex,
    sessionCount: input.sessionFileNames.length,
    startTime: input.timeRange.start,
    endTime: input.timeRange.end,
    inputDir: input.inputDir,
    sessionList: input.sessionFileNames.map((name) => `- ${name}`).join("\n"),
    memoryDir: input.memoryDir,
    instructionSection: instructionSection(input.instruction),
  });
}

export function buildAggregatorUserPrompt(input: {
  batchesDir: string;
  batchCount: number;
  memoryDir: string;
  instruction?: string;
}): string {
  return render(aggregatorUserMd, {
    count: input.batchCount,
    batchesDir: input.batchesDir,
    memoryDir: input.memoryDir,
    instructionSection: instructionSection(input.instruction),
  });
}
