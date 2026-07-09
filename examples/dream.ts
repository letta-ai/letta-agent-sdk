// Dream over recorded coding sessions: reflect in parallel batches, then
// synthesize the learnings into a dream agent's own memory filesystem.
//
//   bun examples/dream.ts init [target ...]     initialize a new dream agent
//   bun examples/dream.ts <agent-id>            dream against it
//
// A dream agent IS a memfs-enabled Letta agent — the identity is its agent
// id. Targets are bound at init: e.g. ./AGENTS.md (maintained at
// system/AGENTS.md) and ./skills/ (mirrored as the memfs skills/ tier).
// Aggregation runs on the agent itself, so learnings land in its memory.

import { LettaAgentClient, dream, initDreamAgent } from "../src/index.js";

const [command, ...rest] = process.argv.slice(2);
if (!command) {
  console.error("usage: bun examples/dream.ts init [target ...] | <agent-id>");
  process.exit(64);
}

// Dreaming edits local files (memory clones under the run dirs), so the
// harness must run on this machine; harnessBackend "api" keeps the agents on
// Letta Cloud. The "cloud" backend would run sessions in a managed remote
// sandbox that cannot see these directories.
const client = new LettaAgentClient({
  backend: "local",
  appServer: { harnessBackend: "api" },
});

if (command === "init") {
  const agent = await initDreamAgent(client, { targets: rest });
  console.log(`dream agent: ${agent.agentId}`);
  console.log(`memory:      ${agent.memoryDir}`);
  process.exit(0);
}

const agentId = command;
const sources = [{ type: "claude" }, { type: "codex" }];

// Preview the plan first (no agents run).
const plan = await dream({ client, agent: agentId, sources, planOnly: true });
if (plan.kind !== "plan") {
  console.log("nothing to dream");
  process.exit(0);
}
console.log(
  `would reflect on ${plan.sessions.length} session(s) in ${plan.batches.length} batch(es)`,
);

// The real run: every batch reflects concurrently against its own clone of
// the agent's memory; the agent itself synthesizes the diffs into its memfs,
// then the bound targets are exported back out.
const result = await dream({
  client,
  agent: agentId,
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
