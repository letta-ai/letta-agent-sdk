// Dream over recorded coding sessions: reflect in parallel batches, then
// synthesize the learnings into a dream agent's memory filesystem.
//
//   bun examples/dream.ts <agent-root> [target ...]
//
// <agent-root> is the dream agent's identity directory. On first use it is
// initialized (memory repo, runs/, agent.json) with the given targets bound —
// e.g. ./AGENTS.md (maintained at system/AGENTS.md) and ./skills/ (mirrored
// as the memfs skills/ tier). Later runs reuse the identity: its memory,
// worker agents, reflection cursors, and targets.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { LettaAgentClient, dream, initDreamAgent } from "../src/index.js";

const [agentRoot, ...targets] = process.argv.slice(2);
if (!agentRoot) {
  console.error("usage: bun examples/dream.ts <agent-root> [target ...]");
  console.error("  e.g. bun examples/dream.ts ./dream-agent ./AGENTS.md ./skills/");
  process.exit(64);
}

if (!existsSync(join(agentRoot, "agent.json"))) {
  const agent = await initDreamAgent({
    rootDir: agentRoot,
    targets,
    model: "anthropic/claude-opus-4-6",
  });
  console.log(
    `initialized dream agent at ${agent.rootDir} (${targets.length} target(s))`,
  );
} else if (targets.length > 0) {
  console.error("agent already initialized — targets are bound at init");
  process.exit(64);
}

// Dreaming edits local files (memory clones under the agent's run dirs), so
// the harness must run on this machine; harnessBackend "api" keeps the worker
// agents on Letta Cloud. The "cloud" backend would run sessions in a managed
// remote sandbox that cannot see these directories.
const client = new LettaAgentClient({
  backend: "local",
  appServer: { harnessBackend: "api" },
});

const sources = [{ type: "claude" }, { type: "codex" }];

// Preview the plan first (no agents run).
const plan = await dream({ client, agent: agentRoot, sources, planOnly: true });
if (plan.kind !== "plan") {
  console.log("nothing to dream");
  process.exit(0);
}
console.log(
  `would reflect on ${plan.sessions.length} session(s) in ${plan.batches.length} batch(es)`,
);

// The real run: every batch reflects concurrently against its own clone of
// the agent's memory; one aggregation pass synthesizes the diffs onto it,
// then the bound targets are exported back out.
const result = await dream({
  client,
  agent: agentRoot,
  sources,
  log: (line) => console.log(line),
});

if (result.kind === "completed") {
  console.log(
    `${result.success ? "done" : "failed"} — ${result.aggregation.commitCount} commit(s) on the agent's memory`,
  );
  console.log(`run artifacts: ${result.runRoot}`);
  if (result.target) {
    console.log(
      result.target.written
        ? `target doc updated: ${result.target.path}`
        : `target doc unchanged: ${result.target.path}`,
    );
  }
}
