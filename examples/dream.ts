// Concrete, zero-argument end-to-end dream over the letta-code project.
//
// This reproduces the validated 20-transcript workflow:
//   1. collect the 10 newest Claude Code and 10 newest Codex transcripts;
//   2. replace the oldest selected Claude transcript with a known session that
//      contains durable letta-code prompt-architecture learnings;
//   3. initialize MemFS with an empty skills/ directory and the repository's
//      AGENTS.md at system/letta-code/AGENTS.md;
//   4. allow new files and directories only under skills/;
//   5. run reflection with Opus 4.8 and render the resulting dream.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  LettaAgentClient,
  collectTranscripts,
  dream,
  initDreamAgent,
  type Transcript,
} from "../src/index.js";

const MODEL = "anthropic/claude-opus-4-8";
const TRANSCRIPTS_PER_HARNESS = 10;
const SKILL_CANDIDATE_SESSION_ID = "9b6a52fc-44c7-45ce-a333-a2187e12e10e";
const REFLECTION_PROMPT =
  "Only create memories and skills relevant to the project in ~/repos/letta-code. " +
  "Skip processing any trajectories that are not relevant. " +
  "Do not make any commits if no trajectories are relevant.";

const LETTA_CODE_DIR = join(homedir(), "repos", "letta-code");
const LETTA_CODE_ENV_PATH = join(LETTA_CODE_DIR, ".env");
const SKILL_CANDIDATE_PATH = join(
  homedir(),
  ".claude",
  "projects",
  "-Users-sarahwooders-repos-letta-code",
  `${SKILL_CANDIDATE_SESSION_ID}.jsonl`,
);
const DREAM_VIZ_PATH = join(homedir(), "repos", "dream-viz", "dream-viz.ts");

function transcriptKey(transcript: Transcript): string {
  return `${transcript.session.harness}:${transcript.session.sessionId}`;
}

function assertHarnessCount(
  transcripts: readonly Transcript[],
  harness: "claude" | "codex",
): void {
  const count = transcripts.filter(
    (transcript) => transcript.session.harness === harness,
  ).length;
  if (count !== TRANSCRIPTS_PER_HARNESS) {
    throw new Error(
      `Expected ${TRANSCRIPTS_PER_HARNESS} ${harness} transcripts, found ${count}`,
    );
  }
}

async function selectTranscripts(): Promise<{
  transcripts: Transcript[];
  removed: Transcript;
  candidate: Transcript;
}> {
  const [recent, candidateMatches] = await Promise.all([
    collectTranscripts({
      sources: [
        { type: "claude", limit: TRANSCRIPTS_PER_HARNESS },
        { type: "codex", limit: TRANSCRIPTS_PER_HARNESS },
      ],
    }),
    collectTranscripts({
      sources: [{ type: "claude", locator: SKILL_CANDIDATE_PATH }],
    }),
  ]);

  assertHarnessCount(recent, "claude");
  assertHarnessCount(recent, "codex");
  if (candidateMatches.length !== 1) {
    throw new Error(
      `Expected one skill candidate transcript, found ${candidateMatches.length}`,
    );
  }

  const candidate = candidateMatches[0];
  if (
    recent.some(
      (transcript) => transcriptKey(transcript) === transcriptKey(candidate),
    )
  ) {
    throw new Error(
      "The skill candidate is already in the newest-ten Claude selection.",
    );
  }

  // collectTranscripts() returns globally chronological snapshots, so the
  // first selected Claude transcript is the oldest of that source's ten.
  const removed = recent.find(
    (transcript) => transcript.session.harness === "claude",
  );
  if (!removed) throw new Error("No Claude transcript is available to replace");

  const transcripts = [
    ...recent.filter(
      (transcript) => transcriptKey(transcript) !== transcriptKey(removed),
    ),
    candidate,
  ].sort(
    (a, b) =>
      a.session.startTime.localeCompare(b.session.startTime) ||
      transcriptKey(a).localeCompare(transcriptKey(b)),
  );

  if (transcripts.length !== 20) {
    throw new Error(
      `Expected 20 final transcripts, found ${transcripts.length}`,
    );
  }
  assertHarnessCount(transcripts, "claude");
  assertHarnessCount(transcripts, "codex");
  return { transcripts, removed, candidate };
}

const fileEnv = parseEnv(await readFile(LETTA_CODE_ENV_PATH, "utf-8"));
for (const [key, value] of Object.entries(fileEnv)) {
  process.env[key] ??= value;
}
if (!process.env.LETTA_API_KEY) {
  throw new Error(`LETTA_API_KEY is missing from ${LETTA_CODE_ENV_PATH}`);
}

const { transcripts, removed, candidate } = await selectTranscripts();
console.log(
  `replacement: ${transcriptKey(removed)} -> ${transcriptKey(candidate)}`,
);

const client = new LettaAgentClient({
  backend: "local",
  appServer: { harnessBackend: "api" },
});
const agentsMd = await readFile(join(LETTA_CODE_DIR, "AGENTS.md"), "utf-8");
const memfsAgentsMd = agentsMd.startsWith("---\n")
  ? agentsMd
  : `---\ndescription: Repository guidance for ~/repos/letta-code\n---\n\n${agentsMd}`;

const agent = await initDreamAgent(client, {
  name: `letta-code-20-transcript-dream-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`,
  model: MODEL,
  memfs: {
    directories: ["skills"],
    files: {
      "system/letta-code/AGENTS.md": memfsAgentsMd,
    },
  },
  guard: {
    allowedNewFilePrefixes: ["skills"],
  },
});
console.log(`dream agent: ${agent.agentId}`);

const dreamOptions = {
  client,
  agentId: agent.agentId,
  transcripts,
  reflectionPrompt: REFLECTION_PROMPT,
  maxTranscriptsPerBatch: 10,
} as const;

const plan = await dream({ ...dreamOptions, planOnly: true });
if (plan.kind !== "plan" || plan.transcripts.length !== 20) {
  throw new Error(
    `Expected a 20-transcript plan, got ${
      plan.kind === "plan" ? plan.transcripts.length : plan.kind
    }`,
  );
}
console.log(
  `plan: ${plan.transcripts.length} transcripts in ${plan.batches.length} batches`,
);

const result = await dream({
  ...dreamOptions,
  log: (line) =>
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
});
if (result.kind !== "completed") {
  throw new Error(`Unexpected dream result: ${result.kind}`);
}

const succeededBatches = result.batches.filter((batch) => batch.success).length;
console.log(
  `${result.success ? "done" : "failed"}: ` +
    `${succeededBatches}/${result.batches.length} batches; ${result.runRoot}`,
);
console.log(`reflector agent: ${result.reflectorAgentId}`);

if (!result.success) process.exit(1);
execFileSync("bun", [DREAM_VIZ_PATH, result.runRoot, "--open"], {
  stdio: "inherit",
});
