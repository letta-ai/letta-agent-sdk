import {
  buildCreateAgentRequest,
  type CreateAgentMemoryBlock,
  type CreateAgentRequest,
} from "@letta-ai/letta-code/agent-presets";
import {
  resolveSkillItems,
  skillsHaveSupportFiles,
  type AgentSkill,
} from "./skill-loading.js";
import type { CreateAgentOptions } from "./types.js";

function isPresetSystemPrompt(value: string): boolean {
  return [
    "default",
    "letta-claude",
    "letta-codex",
    "letta-gemini",
    "claude",
    "codex",
    "gemini",
  ].includes(value);
}

function assertCreateAgentOptionsSupported(options: CreateAgentOptions): void {
  if (
    options.allowedTools !== undefined ||
    options.disallowedTools !== undefined
  ) {
    throw new Error(
      "App-server createAgent() does not yet support allowedTools/disallowedTools.",
    );
  }
  if (options.canUseTool !== undefined) {
    throw new Error(
      "App-server createAgent() does not yet support canUseTool callbacks.",
    );
  }
  if (options.systemInfoReminder !== undefined) {
    throw new Error(
      "App-server createAgent() does not yet support systemInfoReminder overrides.",
    );
  }
  if (options.dreaming?.behavior !== undefined) {
    throw new Error(
      "App-server createAgent() does not yet support dreaming.behavior overrides.",
    );
  }
}

/** Translate SDK convenience options into the canonical Letta Code request. */
export async function createAgentBody(
  options: CreateAgentOptions,
  resolvedSkills?: AgentSkill[],
): Promise<CreateAgentRequest> {
  assertCreateAgentOptionsSupported(options);

  // Skills seed as memory blocks: the platform maps a block labeled
  // `skills/{name}` to `skills/{name}/SKILL.md` in the agent's memory repo.
  // The block value must be the SKILL.md body (the server synthesizes the
  // frontmatter from the block description; embedding frontmatter in the
  // value would double it).
  const skills = resolvedSkills ?? (await resolveSkillItems(options.skills));
  if (skills.length > 0 && options.memfs === false) {
    throw new Error(
      "createAgent() skills require the memory filesystem; remove memfs: false.",
    );
  }
  // When the backend passes pre-resolved skills it also owns the support-file
  // push (Cloud). A backend that calls with options only cannot deliver
  // support files, so reject them rather than seeding a skill whose
  // instructions reference scripts that do not exist.
  if (resolvedSkills === undefined && skillsHaveSupportFiles(skills)) {
    throw new Error(
      "This backend does not yet support skill support files (scripts/, " +
        "references/). Use the Cloud backend, or pass a skill with only SKILL.md.",
    );
  }

  let system: string | undefined;
  if (options.systemPrompt !== undefined) {
    if (
      typeof options.systemPrompt !== "string" ||
      isPresetSystemPrompt(options.systemPrompt)
    ) {
      throw new Error(
        "createAgent() does not yet support system prompt presets for this backend.",
      );
    }
    system = options.systemPrompt;
  }

  const memoryBlocks: CreateAgentMemoryBlock[] = [];
  const blockIds: string[] = [];
  for (const item of options.memory ?? []) {
    if (typeof item === "string") {
      throw new Error(
        "App-server createAgent() does not yet support memory preset names.",
      );
    }
    if ("blockId" in item) {
      blockIds.push(item.blockId);
    } else {
      memoryBlocks.push({ ...item });
    }
  }
  if (options.persona !== undefined) {
    memoryBlocks.push({ label: "persona", value: options.persona });
  }
  if (options.human !== undefined) {
    memoryBlocks.push({ label: "human", value: options.human });
  }
  for (const skill of skills) {
    memoryBlocks.push({
      label: `skills/${skill.name}`,
      value: skill.instructions,
      description: skill.description,
    });
  }
  const hasMemoryConfiguration =
    options.memory !== undefined ||
    options.persona !== undefined ||
    options.human !== undefined ||
    skills.length > 0;

  return buildCreateAgentRequest({
    personalityId: options.personality,
    name: options.name,
    description: options.description,
    model: options.model,
    system,
    memoryBlocks: hasMemoryConfiguration ? memoryBlocks : undefined,
    blockIds,
    extraTags: options.tags,
    enableMemfs: options.memfs ?? true,
    baseTools: options.baseTools,
    embedding: options.embedding,
    hidden: options.hidden,
  });
}
