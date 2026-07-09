// Re-run only the aggregation stage for an existing dream run, rebuilding
// reflection results from the immutable batch reports already on disk.
//
//   bun rerun-aggregate.ts <dream-agent-id> <run-root>

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LettaAgentClient, loadDreamAgent } from "./src/index.js";
import { runDreamAggregation } from "./src/dream/aggregate.js";
import { AGGREGATOR_PERSONA } from "./src/dream/prompts.js";
import type { BatchReflectionResult } from "./src/dream/reflect.js";

const [dreamAgentId, runRoot] = process.argv.slice(2);
if (!dreamAgentId || !runRoot) {
  throw new Error("usage: bun rerun-aggregate.ts <dream-agent-id> <run-root>");
}

const patchedCliPath = join(
  homedir(),
  "repos",
  "letta-code",
  ".claude",
  "worktrees",
  "dream-multi-harness",
  "letta.js",
);
process.env.LETTA_CLI_PATH = patchedCliPath;

const agent = await loadDreamAgent(dreamAgentId);
const batchesDir = join(runRoot, "batches");
const batchNames = (await readdir(batchesDir))
  .filter((name) => /^\d+$/.test(name))
  .sort((a, b) => Number(a) - Number(b));
const reflections: BatchReflectionResult[] = await Promise.all(
  batchNames.map(async (name) =>
    JSON.parse(await readFile(join(batchesDir, name, "report.json"), "utf-8")),
  ),
);

console.log(
  `re-aggregating ${reflections.length} batch report(s) for ${dreamAgentId}`,
);
const client = new LettaAgentClient({
  backend: "local",
  appServer: { harnessBackend: "api" },
});
const outcome = await runDreamAggregation({
  client,
  aggregatorAgentId: dreamAgentId,
  memoryDir: agent.memoryDir,
  runRoot,
  reflections,
  memfsPolicy: agent.config.memfs.policy,
  personaPreamble: AGGREGATOR_PERSONA,
  log: (line) =>
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
});

console.log(
  `AGGREGATION_RERUN_RESULT=${JSON.stringify({
    dreamAgentId,
    runRoot,
    success: outcome.success,
    commitCount: outcome.commitCount,
    conversationId: outcome.conversationId,
    error: outcome.error,
  })}`,
);
if (!outcome.success) process.exitCode = 1;
