// End-to-end validation of the public dreaming SDK:
//
//   1. collect the five newest Claude Code and five newest Codex transcripts;
//   2. initialize a guarded dream agent from an explicit MemFS structure;
//   3. run the dream with a project-scoping reflection prompt;
//   4. render the immutable final output with dream-viz.

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
const TRANSCRIPTS_PER_HARNESS = 5;
const DEFAULT_LOOKBACK_DAYS = 30;
const REFLECTION_PROMPT =
  "Only create memories and skills relevant to the project in ~/repos/letta-code. Skip processing any trajectories that are not relevant. Do not make any commmits if no trajectories are relevant";

const LETTA_CODE_DIR = join(homedir(), "repos", "letta-code");
const AGENTS_MD_PATH = join(LETTA_CODE_DIR, "AGENTS.md");
const DREAM_VIZ_PATH = join(homedir(), "repos", "dream-viz", "dream-viz.ts");

function cutoff(): string {
  if (process.env.DREAM_AFTER) return process.env.DREAM_AFTER;
  return new Date(
    Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function assertFiveEach(transcripts: readonly Transcript[]): void {
  for (const harness of ["claude", "codex"] as const) {
    const count = transcripts.filter(
      (transcript) => transcript.session.harness === harness,
    ).length;
    if (count !== TRANSCRIPTS_PER_HARNESS) {
      throw new Error(
        `Expected ${TRANSCRIPTS_PER_HARNESS} recent ${harness} transcripts, found ${count}. ` +
          "Set DREAM_AFTER to an earlier ISO timestamp if necessary.",
      );
    }
  }
}

function describeSelection(transcripts: readonly Transcript[]): void {
  for (const harness of ["claude", "codex"] as const) {
    console.log(`${harness} transcripts:`);
    for (const { session } of transcripts.filter(
      (transcript) => transcript.session.harness === harness,
    )) {
      console.log(
        `  ${session.sessionId}  ~${session.estTokens} tokens  ${session.startTime} -> ${session.endTime}`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.LETTA_API_KEY) {
    throw new Error(
      "LETTA_API_KEY is not set. Load ~/repos/letta-code/.env before running this script.",
    );
  }

  const after = cutoff();
  const transcripts = await collectTranscripts({
    after,
    sources: [
      { type: "claude", limit: TRANSCRIPTS_PER_HARNESS },
      { type: "codex", limit: TRANSCRIPTS_PER_HARNESS },
    ],
  });
  assertFiveEach(transcripts);
  console.log(`model: ${MODEL}`);
  console.log(`transcript cutoff: ${after}`);
  describeSelection(transcripts);

  const agentsMd = await readFile(AGENTS_MD_PATH, "utf-8");
  // The harness's native MemFS hook requires Markdown description
  // frontmatter. Preserve the repository AGENTS.md byte-for-byte below it.
  const memfsAgentsMd = agentsMd.startsWith("---\n")
    ? agentsMd
    : `---\ndescription: Repository guidance for ~/repos/letta-code\n---\n\n${agentsMd}`;
  const client = new LettaAgentClient({
    backend: "local",
    appServer: { harnessBackend: "api" },
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const agent = await initDreamAgent(client, {
    name: `letta-code-10-transcript-dream-${stamp}`,
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

  const plan = await dream({
    client,
    agentId: agent.agentId,
    transcripts,
    instruction: REFLECTION_PROMPT,
    planOnly: true,
  });
  if (plan.kind !== "plan" || plan.transcripts.length !== 10) {
    throw new Error(
      `Expected a 10-transcript plan, got ${
        plan.kind === "plan" ? plan.transcripts.length : plan.kind
      }`,
    );
  }
  console.log(
    `plan: ${plan.transcripts.length} transcripts in ${plan.batches.length} batches`,
  );
  for (const batch of plan.batches) {
    console.log(
      `  batch ${batch.index}: ${batch.sessions.length} transcript(s), ~${batch.estTokens} tokens`,
    );
  }

  const result = await dream({
    client,
    agentId: agent.agentId,
    transcripts,
    instruction: REFLECTION_PROMPT,
    log: (line) =>
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
  });
  if (result.kind !== "completed") {
    throw new Error(`Unexpected dream result: ${result.kind}`);
  }

  const succeededBatches = result.batches.filter((batch) => batch.success).length;
  console.log(
    `result: ${result.success ? "completed" : "failed"}; ` +
      `${succeededBatches}/${result.batches.length} batches succeeded; ` +
      `${result.aggregation.commitCount} aggregation commit(s)`,
  );
  console.log(
    `DREAM_VALIDATION_RESULT=${JSON.stringify({
      agentId: agent.agentId,
      reflectorAgentId: result.reflectorAgentId,
      aggregatorAgentId: result.aggregatorAgentId,
      runRoot: result.runRoot,
      success: result.success,
      succeededBatches,
      totalBatches: result.batches.length,
      aggregationCommits: result.aggregation.commitCount,
      transcriptIds: transcripts.map(
        ({ session }) => `${session.harness}:${session.sessionId}`,
      ),
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
