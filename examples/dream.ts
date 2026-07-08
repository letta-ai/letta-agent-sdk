// Dream over recorded coding sessions: reflect in parallel batches, then
// synthesize the learnings into a memory filesystem.
//
//   bun examples/dream.ts <memory-dir> [run-root]
//
// <memory-dir> is a git repository to land memory on (e.g. an agent's memfs
// checkout, or a fresh `git init` + commit for a standalone memory).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LettaAgentClient, dream } from "../src/index.js";

const [memoryDir, runRootArg] = process.argv.slice(2);
if (!memoryDir) {
  console.error("usage: bun examples/dream.ts <memory-dir> [run-root]");
  process.exit(64);
}
const runRoot = runRootArg ?? mkdtempSync(join(tmpdir(), "dream-run-"));

const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});

// Preview the plan first (no agents run).
const plan = await dream({
  client,
  sources: [{ type: "claude" }, { type: "codex" }],
  memoryDir,
  runRoot,
  planOnly: true,
});
if (plan.kind !== "plan") {
  console.log("no sessions found");
  process.exit(0);
}
console.log(
  `would reflect on ${plan.sessions.length} session(s) in ${plan.batches.length} batch(es)`,
);

// The real run: every batch reflects concurrently against its own clone of
// <memory-dir>; one aggregation pass synthesizes the diffs onto it.
const result = await dream({
  client,
  sources: [{ type: "claude" }, { type: "codex" }],
  memoryDir,
  runRoot,
  log: (line) => console.log(line),
});

if (result.kind === "completed") {
  console.log(
    `${result.success ? "done" : "failed"} — ${result.aggregation.commitCount} commit(s) on ${memoryDir}`,
  );
  console.log(`run artifacts: ${result.runRoot}`);
}
