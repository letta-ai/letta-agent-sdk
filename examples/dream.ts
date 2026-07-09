// Minimal end-to-end use of the three-part dreaming API.

import {
  LettaAgentClient,
  collectTranscripts,
  dream,
  initDreamAgent,
} from "../src/index.js";

const after =
  process.env.DREAM_AFTER ??
  new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const client = new LettaAgentClient({
  backend: "local",
  appServer: { harnessBackend: "api" },
});

// 1. Discover and normalize a bounded set of recent transcripts.
const transcripts = await collectTranscripts({
  after,
  sources: [
    { type: "claude", limit: 5 },
    { type: "codex", limit: 5 },
  ],
});

// 2. Create the dream agent from an explicit, guarded MemFS structure.
const agent = await initDreamAgent(client, {
  model: "anthropic/claude-opus-4-8",
  memfs: {
    directories: ["skills"],
    files: {
      "system/project/AGENTS.md":
        "---\ndescription: Project guidance\n---\n\n# Project guidance\n",
    },
  },
  guard: { allowedNewFilePrefixes: ["skills"] },
});

// 3. Reflect on exactly those transcript snapshots.
const result = await dream({
  client,
  agentId: agent.agentId,
  transcripts,
  reflectionPrompt: "Only retain durable learnings relevant to this project.",
  log: console.log,
});

if (result.kind === "completed") {
  console.log(`${result.success ? "done" : "failed"}: ${result.runRoot}`);
} else {
  console.log(result.kind);
}
