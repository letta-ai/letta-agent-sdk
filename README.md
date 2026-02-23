# Letta Code SDK

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-code-sdk.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-code-sdk) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)


The SDK interface to [**Letta Code**](https://github.com/letta-ai/letta-code). Build agents with persistent memory that learn over time. 

> [!TIP]
> Check out [**LettaBot**](https://github.com/letta-ai/lettabot) and [**Letta Cowork**](https://github.com/letta-ai/letta-cowork), two open-source apps built on the SDK.

## Installation

```bash
npm install @letta-ai/letta-code-sdk
```

## Quick start

### One-shot prompt

```ts
import { prompt } from "@letta-ai/letta-code-sdk";

const result = await prompt("What is 2 + 2?");
console.log(result.result);
```

### Persistent agent with multi-turn conversations

```ts
import { createAgent, resumeSession } from "@letta-ai/letta-code-sdk";

const agentId = await createAgent({
  persona: "You are a helpful coding assistant for TypeScript projects.",
  memfs: true, // Enable git-backed memory filesystem for this new agent
});

await using session = resumeSession(agentId);

await session.send("Find and fix the bug in auth.ts");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") console.log(msg.content);
}

await session.send("Add a unit test for the fix");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") console.log(msg.content);
}
```

By default, `resumeSession(agentId)` continues the agent’s default conversation. To start a fresh thread, use `createSession(agentId)` (see docs).

## Session configuration

The SDK surfaces the same runtime controls as Letta Code CLI for skills, reminders, and sleeptime:

```ts
import { createSession } from "@letta-ai/letta-code-sdk";

const session = createSession("agent-123", {
  skillSources: ["project", "global"], // [] disables all skills (--no-skills)
  systemInfoReminder: false, // maps to --no-system-info-reminder
  sleeptime: {
    trigger: "step-count", // off | step-count | compaction-event
    behavior: "reminder", // reminder | auto-launch
    stepCount: 8,
  },
  memfs: true, // true -> --memfs, false -> --no-memfs
});
```

## Links

- Docs: https://docs.letta.com/letta-code-sdk
- Examples: [`./examples`](./examples)

---

Made with 💜 in San Francisco

## Live integration tests (opt-in)

The SDK includes live integration tests that hit real Letta Cloud endpoints and verify runtime contracts for:

- session init shape
- send/stream lifecycle (`assistant`, `reasoning`, `stream_event`, `result`)
- `listMessages()` backfill/pagination shape
- concurrent `listMessages()` during active stream
- tool lifecycle (`tool_call` -> `tool_result`)

These tests are opt-in and skipped by default.

```bash
# Required
export LETTA_API_KEY=sk-let-...

# Optional
export LETTA_AGENT_ID=agent-...            # force a specific agent
export LETTA_CONVERSATION_ID=conv-...      # force a specific conversation for init test
export LETTA_BASE_URL=https://api.letta.com
export LETTA_LIVE_TEST_TIMEOUT_MS=180000

# Run live tests
bun run test:live

# Run and record sanitized fixtures to src/tests/fixtures/live/
bun run test:live:record
```

Safety notes:

- live tests create/use real conversations on the target account
- fixture recording redacts obvious secrets/tokens and local home paths
- keep fixture recording disabled in CI unless you explicitly want refreshed snapshots
