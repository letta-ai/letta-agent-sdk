// End-to-end validation of the public dreaming SDK over 20 explicit
// trajectories. Select the ten newest Claude Code and ten newest Codex
// sessions, then replace the oldest selected Claude session with the known
// skill-formation candidate before handing the snapshots to dream().

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LettaAgentClient,
  collectTranscripts,
  dream,
  initDreamAgent,
  type Transcript,
} from "./src/index.js";

const MODEL = "anthropic/claude-opus-4-8";
const TRANSCRIPTS_PER_HARNESS = 10;
const SKILL_CANDIDATE_SESSION_ID = "9b6a52fc-44c7-45ce-a333-a2187e12e10e";
const REFLECTION_PROMPT =
  "Only create memories and skills relevant to the project in ~/repos/letta-code. " +
  "Skip processing any trajectories that are not relevant. " +
  "Do not make any commits if no trajectories are relevant.";

const LETTA_CODE_DIR = join(homedir(), "repos", "letta-code");
const SKILL_CANDIDATE_PATH = join(
  homedir(),
  ".claude",
  "projects",
  "-Users-sarahwooders-repos-letta-code",
  `${SKILL_CANDIDATE_SESSION_ID}.jsonl`,
);
const PATCHED_CLI_PATH = join(
  LETTA_CODE_DIR,
  ".claude",
  "worktrees",
  "dream-multi-harness",
  "letta.js",
);
const DREAM_VIZ_PATH = join(homedir(), "repos", "dream-viz", "dream-viz.ts");

function transcriptKey(transcript: Transcript): string {
  return `${transcript.session.harness}:${transcript.session.sessionId}`;
}

function assertHarnessCount(
  transcripts: readonly Transcript[],
  harness: "claude" | "codex",
  expected: number,
): void {
  const count = transcripts.filter(
    (transcript) => transcript.session.harness === harness,
  ).length;
  if (count !== expected) {
    throw new Error(
      `Expected ${expected} ${harness} transcripts, found ${count}`,
    );
  }
}

function describeSelection(transcripts: readonly Transcript[]): void {
  for (const harness of ["claude", "codex"] as const) {
    console.log(`${harness} transcripts:`);
    for (const transcript of transcripts.filter(
      (entry) => entry.session.harness === harness,
    )) {
      const { session } = transcript;
      const marker =
        session.sessionId === SKILL_CANDIDATE_SESSION_ID
          ? "  [skill candidate]"
          : "";
      console.log(
        `  ${session.sessionId}  ~${session.estTokens} tokens  ` +
          `${session.startTime} -> ${session.endTime}${marker}`,
      );
    }
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

  assertHarnessCount(recent, "claude", TRANSCRIPTS_PER_HARNESS);
  assertHarnessCount(recent, "codex", TRANSCRIPTS_PER_HARNESS);
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
      "The skill candidate is already in the newest-ten selection; no replacement is necessary.",
    );
  }

  const selectedClaude = recent.filter(
    (transcript) => transcript.session.harness === "claude",
  );
  // collectTranscripts() returns globally chronological snapshots, so this is
  // the oldest of the ten selected Claude sessions.
  const removed = selectedClaude[0];
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
      `Expected 20 explicit transcripts, found ${transcripts.length}`,
    );
  }
  assertHarnessCount(transcripts, "claude", TRANSCRIPTS_PER_HARNESS);
  assertHarnessCount(transcripts, "codex", TRANSCRIPTS_PER_HARNESS);
  if (
    transcripts.filter(
      (transcript) => transcriptKey(transcript) === transcriptKey(candidate),
    ).length !== 1
  ) {
    throw new Error(
      "The final selection must contain the skill candidate exactly once",
    );
  }

  return { transcripts, removed, candidate };
}

async function main(): Promise<void> {
  if (!process.env.LETTA_API_KEY) {
    throw new Error(
      "LETTA_API_KEY is not set. Load ~/repos/letta-code/.env before running this script.",
    );
  }

  const { transcripts, removed, candidate } = await selectTranscripts();
  console.log(`model: ${MODEL}`);
  console.log(
    `replacement: ${transcriptKey(removed)} -> ${transcriptKey(candidate)}`,
  );
  describeSelection(transcripts);

  // Keep runtimes isolated: without an external URL, each SDK session owns a
  // separate app-server process. Point all of those processes at the patched
  // harness build through the SDK's normal CLI resolver.
  process.env.LETTA_CLI_PATH = PATCHED_CLI_PATH;
  console.log(`app-server CLI: ${PATCHED_CLI_PATH}`);

  const client = new LettaAgentClient({
    backend: "local",
    appServer: { harnessBackend: "api" },
  });
  const agentsMd = await readFile(join(LETTA_CODE_DIR, "AGENTS.md"), "utf-8");
  const memfsAgentsMd = agentsMd.startsWith("---\n")
    ? agentsMd
    : `---\ndescription: Repository guidance for ~/repos/letta-code\n---\n\n${agentsMd}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const agent = await initDreamAgent(client, {
    name: `letta-code-20-transcript-dream-${stamp}`,
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
  console.log(`memory: ${agent.memoryDir}`);

  const sharedDreamOptions = {
    client,
    agentId: agent.agentId,
    transcripts,
    reflectionPrompt: REFLECTION_PROMPT,
    maxTranscriptsPerBatch: 10,
  } as const;
  const plan = await dream({ ...sharedDreamOptions, planOnly: true });
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
  for (const batch of plan.batches) {
    console.log(
      `  batch ${batch.index}: ${batch.sessions.length} transcript(s), ` +
        `~${batch.estTokens} tokens`,
    );
  }

  const result = await dream({
    ...sharedDreamOptions,
    log: (line) =>
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
  });
  if (result.kind !== "completed") {
    throw new Error(`Unexpected dream result: ${result.kind}`);
  }

  const succeededBatches = result.batches.filter(
    (batch) => batch.success,
  ).length;
  console.log(
    `result: ${result.success ? "completed" : "failed"}; ` +
      `${succeededBatches}/${result.batches.length} batches succeeded; ` +
      `${result.aggregation.commitCount} aggregation commit(s)`,
  );
  console.log(
    `DREAM_20_RESULT=${JSON.stringify({
      dreamAgentId: agent.agentId,
      reflectorAgentId: result.reflectorAgentId,
      aggregatorAgentId: result.aggregatorAgentId,
      runRoot: result.runRoot,
      success: result.success,
      succeededBatches,
      totalBatches: result.batches.length,
      aggregationCommits: result.aggregation.commitCount,
      replacement: {
        removed: transcriptKey(removed),
        added: transcriptKey(candidate),
      },
      transcriptIds: transcripts.map(transcriptKey),
    })}`,
  );

  if (!result.success || succeededBatches !== result.batches.length) {
    process.exitCode = 1;
    return;
  }
  execFileSync("bun", [DREAM_VIZ_PATH, result.runRoot, "--open"], {
    stdio: "inherit",
  });
}

await main();
