/**
 * Skill seeding for createAgent({ skills }) — portable core.
 *
 * A skill's canonical shape is a directory: `SKILL.md` plus optional support
 * files (scripts/, references/, ...). Callers pass either a path to such a
 * directory or an inline {@link AgentSkill} object.
 *
 * The platform stores `skills/{name}/SKILL.md` as a memory block labeled
 * `skills/{name}` (see letta-cloud `blockMarkdownPath.ts` /
 * `path_mapping.py`), so SKILL.md instructions ride the create-agent request
 * as a memory block. Support files have no block representation; they are
 * pushed to the agent's memory git repo after creation.
 *
 * This module is part of the portable client graph and must stay free of
 * Node imports. Directory loading and the git push live in `skill-node.ts`,
 * behind the package root, and are injected by the Node client.
 */

/**
 * A skill to seed into a new agent's memory filesystem at creation.
 *
 * The instructions become `skills/{name}/SKILL.md` in the agent's memory
 * repo (stored as the memory block labeled `skills/{name}`), so the agent
 * owns and can edit the skill like any other memory. Support `files` land
 * beside it (`skills/{name}/{path}`); they require the Cloud backend from
 * Node.
 */
export interface AgentSkill {
  /** Directory name: lowercase letters, digits, ".", "_", "-". */
  name: string;
  /**
   * Trigger text: when the agent should load this skill. Rendered as the
   * SKILL.md frontmatter description and always visible to the agent.
   */
  description: string;
  /** SKILL.md body (markdown, without frontmatter). */
  instructions: string;
  /**
   * Optional support files, keyed by path relative to the skill directory
   * (e.g. "scripts/convert.sh"). Cloud backend from Node only.
   */
  files?: Record<string, Uint8Array>;
}

/**
 * Skill item for createAgent(): a path to a skill directory containing
 * SKILL.md (Node runtimes only), or an inline {@link AgentSkill}.
 */
export type SkillItem = string | AgentSkill;

/** Loads a skill directory from disk. Node-only; see skill-node.ts. */
export type SkillDirectoryLoader = (dirPath: string) => Promise<AgentSkill>;

/** Pushes skill support files to an agent's memory git repo. Node-only. */
export type SkillFilesPusher = (
  target: { apiBaseUrl: string; apiKey: string; agentId: string },
  skills: AgentSkill[],
) => Promise<void>;

/** Node-only skill capabilities injected by the package-root client. */
export interface SkillNodeSupport {
  loadSkillDirectory: SkillDirectoryLoader;
  pushSkillSupportFiles: SkillFilesPusher;
}

/** Skill directory names: lowercase, digits, hyphens (letta-code convention). */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function assertValidSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}". Skill names are directory names: ` +
        `lowercase letters, digits, ".", "_", "-" (e.g. "generating-voice-memos").`,
    );
  }
}

/**
 * Minimal YAML frontmatter reader for SKILL.md: extracts `name` and
 * `description` (plain, quoted, or `>`/`>-` folded scalars) and returns the
 * body without the frontmatter fence. Anything unparsable is left in place.
 */
export function parseSkillMarkdown(content: string): {
  name?: string;
  description?: string;
  body: string;
} {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { body: content };
  }
  const fence = /\r?\n---[ \t]*(\r?\n|$)/.exec(content.slice(3));
  if (!fence) return { body: content };
  const yamlStart = content.startsWith("---\r\n") ? 5 : 4;
  const yamlEnd = 3 + fence.index;
  const yamlText = content.slice(yamlStart, yamlEnd);
  const body = content.slice(yamlEnd + fence[0].length);

  const fields: Record<string, string> = {};
  const lines = yamlText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      const folded: string[] = [];
      let next = lines[i + 1];
      while (next !== undefined && (/^\s/.test(next) || next === "")) {
        i++;
        folded.push(next.trim());
        next = lines[i + 1];
      }
      value = folded.filter((part) => part.length > 0).join(" ");
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  return { name: fields["name"], description: fields["description"], body };
}

/**
 * Resolve every skill item to an AgentSkill. Directory paths need the
 * injected Node loader; without one (portable clients) they are rejected.
 */
export async function resolveSkillItems(
  items: SkillItem[] | undefined,
  loadDirectory?: SkillDirectoryLoader,
): Promise<AgentSkill[]> {
  if (!items || items.length === 0) return [];
  const resolved: AgentSkill[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (!loadDirectory) {
        throw new Error(
          `Skill directory paths ("${item}") require a Node.js runtime. ` +
            "Pass an inline skill ({ name, description, instructions }) instead.",
        );
      }
      resolved.push(await loadDirectory(item));
    } else {
      assertValidSkillName(item.name);
      if (!item.instructions || item.instructions.trim().length === 0) {
        throw new Error(`Skill "${item.name}" has empty instructions.`);
      }
      if (!item.description || item.description.trim().length === 0) {
        throw new Error(
          `Skill "${item.name}" has no description. ` +
            `The description is the skill's trigger text; it is required.`,
        );
      }
      resolved.push(item);
    }
  }
  const seen = new Set<string>();
  for (const skill of resolved) {
    if (seen.has(skill.name)) {
      throw new Error(`Duplicate skill name: "${skill.name}".`);
    }
    seen.add(skill.name);
  }
  return resolved;
}

/** True when any resolved skill carries support files beyond SKILL.md. */
export function skillsHaveSupportFiles(skills: AgentSkill[]): boolean {
  return skills.some(
    (skill) => skill.files && Object.keys(skill.files).length > 0,
  );
}

/** Collect `skills/{name}/{relPath}` entries for every skill support file. */
export function skillSupportFileEntries(
  skills: AgentSkill[],
): Array<{ path: string; data: Uint8Array }> {
  const entries: Array<{ path: string; data: Uint8Array }> = [];
  for (const skill of skills) {
    for (const [relPath, data] of Object.entries(skill.files ?? {})) {
      if (relPath.split("/").some((part) => part === ".." || part === "")) {
        throw new Error(
          `Skill "${skill.name}" file path escapes the skill directory: ${relPath}`,
        );
      }
      entries.push({ path: `skills/${skill.name}/${relPath}`, data });
    }
  }
  return entries;
}
