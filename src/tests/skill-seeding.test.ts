import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentBody } from "../agent-creation.js";
import {
  parseSkillMarkdown,
  resolveSkillItems,
  skillSupportFileEntries,
  skillsHaveSupportFiles,
  type AgentSkill,
} from "../skill-loading.js";
import { loadSkillDirectory } from "../skill-node.js";

const SKILL_MD = `---
name: voice-memos
description: >-
  Generate and send voice memos. Load when the user asks for
  audio output.
---

# Voice memos

Call the TTS endpoint, convert to AAC, send.
`;

async function writeSkillDir(withScript: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-test-"));
  const skillDir = join(dir, "voice-memos");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), SKILL_MD);
  if (withScript) {
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(join(skillDir, "scripts", "convert.sh"), "#!/bin/sh\n");
  }
  return skillDir;
}

describe("parseSkillMarkdown", () => {
  test("extracts name, folded description, and body", () => {
    const parsed = parseSkillMarkdown(SKILL_MD);
    expect(parsed.name).toBe("voice-memos");
    expect(parsed.description).toBe(
      "Generate and send voice memos. Load when the user asks for audio output.",
    );
    expect(parsed.body).toContain("# Voice memos");
    expect(parsed.body).not.toContain("---");
  });

  test("returns content unchanged without frontmatter", () => {
    const parsed = parseSkillMarkdown("# Just a body\n");
    expect(parsed.name).toBeUndefined();
    expect(parsed.body).toBe("# Just a body\n");
  });
});

describe("resolveSkillItems", () => {
  test("loads a skill directory with support files", async () => {
    const skillDir = await writeSkillDir(true);
    try {
      const skills = await resolveSkillItems([skillDir], loadSkillDirectory);
      const skill = skills[0]!;
      expect(skill.name).toBe("voice-memos");
      expect(skill.instructions).toContain("# Voice memos");
      expect(Object.keys(skill.files ?? {})).toEqual(["scripts/convert.sh"]);
      expect(skillsHaveSupportFiles([skill])).toBe(true);
    } finally {
      await rm(skillDir, { recursive: true, force: true });
    }
  });

  test("accepts inline skills and rejects duplicates", async () => {
    const inline: AgentSkill = {
      name: "probe",
      description: "Probe things.",
      instructions: "# Probe\n",
    };
    const skills = await resolveSkillItems([inline]);
    expect(skills[0]!.name).toBe("probe");
    await expect(resolveSkillItems([inline, inline])).rejects.toThrow(
      /Duplicate skill name/,
    );
  });

  test("rejects directory paths without a Node loader", async () => {
    await expect(resolveSkillItems(["/some/skill-dir"])).rejects.toThrow(
      /require a Node\.js runtime/,
    );
  });

  test("rejects invalid names and missing descriptions", async () => {
    await expect(
      resolveSkillItems([
        { name: "Bad Name", description: "d", instructions: "i" },
      ]),
    ).rejects.toThrow(/Invalid skill name/);
    await expect(
      resolveSkillItems([{ name: "ok", description: "", instructions: "i" }]),
    ).rejects.toThrow(/no description/);
  });
});

describe("createAgentBody with skills", () => {
  test("skills become memory blocks labeled skills/{name}", async () => {
    const body = await createAgentBody({
      model: "openai/gpt-5.2",
      skills: [
        { name: "probe", description: "Probe things.", instructions: "# Probe\n" },
      ],
    });
    const block = body.memory_blocks?.find((b) => b.label === "skills/probe");
    expect(block).toBeDefined();
    expect(block?.value).toBe("# Probe\n");
    expect(block?.description).toBe("Probe things.");
  });

  test("skills combine with explicit memory blocks", async () => {
    const body = await createAgentBody({
      model: "openai/gpt-5.2",
      memory: [{ label: "persona", value: "p" }],
      skills: [
        { name: "probe", description: "Probe things.", instructions: "i" },
      ],
    });
    const labels = (body.memory_blocks ?? []).map((b) => b.label);
    expect(labels).toContain("persona");
    expect(labels).toContain("skills/probe");
  });

  test("rejects skills with memfs disabled", async () => {
    await expect(
      createAgentBody({
        memfs: false,
        skills: [
          { name: "probe", description: "Probe things.", instructions: "i" },
        ],
      }),
    ).rejects.toThrow(/require the memory filesystem/);
  });

  test("rejects support files when the backend cannot push them", async () => {
    await expect(
      createAgentBody({
        skills: [
          {
            name: "probe",
            description: "Probe things.",
            instructions: "i",
            files: { "scripts/x.sh": new Uint8Array([35]) },
          },
        ],
      }),
    ).rejects.toThrow(/does not yet support skill support files/);
  });
});

describe("skillSupportFileEntries", () => {
  test("prefixes paths with skills/{name} and rejects traversal", () => {
    const skill: AgentSkill = {
      name: "probe",
      description: "d",
      instructions: "i",
      files: { "scripts/x.sh": new Uint8Array([35]) },
    };
    expect(skillSupportFileEntries([skill])[0]!.path).toBe(
      "skills/probe/scripts/x.sh",
    );
    expect(() =>
      skillSupportFileEntries([
        { ...skill, files: { "../escape.sh": new Uint8Array([35]) } },
      ]),
    ).toThrow(/escapes the skill directory/);
  });
});
