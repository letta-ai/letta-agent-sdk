# Letta Agent SDK

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-agent-sdk.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-agent-sdk) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

The SDK interface to [**Letta Code**](https://github.com/letta-ai/letta-code). Build agents with persistent memory that learn over time. 

## Installation

```bash
npm install @letta-ai/letta-agent-sdk
```

## Quick start

### Client creation

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

// Local: SDK-owned Letta Code app-server over loopback websockets. The SDK
// spawns/manages the app-server process for you.
const localClient = new LettaAgentClient({ backend: "local" });

// Remote: connect to a user-managed Letta Code app-server over websockets.
const remoteClient = new LettaAgentClient({
  backend: "remote",
  url: "http://127.0.0.1:4500",
  // Required when the app-server is bound to a non-loopback interface with
  // --ws-auth capability-token.
  authToken: process.env.LETTA_APP_SERVER_TOKEN,
});

// Constellation: create or resume agents whose state lives in Letta's
// agent cloud, with an SDK-managed sandbox by default.
const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});
```

### Persistent agent with multi-turn conversations

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({ backend: "local" });

const agentId = await client.createAgent({
  persona: "You are a helpful coding assistant for TypeScript projects.",
});

await using session = client.resumeSession(agentId);

await session.send("Find and fix the bug in auth.ts");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") console.log(msg.content);
}

await session.send("Add a unit test for the fix");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") console.log(msg.content);
}
```

Cloud, remote, and local agent sessions can accept another `send()` while a
turn is streaming. The SDK sends the same `input` frame used by Letta Desktop
and the listener owns queueing; `stream()` may surface `queue_update` events
before the current turn's `result`.

By default, `resumeSession(agentId)` continues the agent’s default conversation.
Use `createSession(agentId)` when you want to start a fresh thread.

For Constellation agents, omitting `environment` lets the SDK create and manage
a sandbox for the session. `environment` is still session-scoped and can
override the client default when you want to use a specific remote runtime:

```ts
await using session = client.resumeSession(agentId, {
  environment: { name: "LettaDevelopers" },
});
```

The top-level helpers (`createAgent`, `createSession`, `resumeSession`, and
`prompt`) remain available. Local helper calls use Letta Code's default agent
selection when you do not pass an agent ID.

### User-managed app-server backend

Use `backend: "remote"` when you already have a Letta Code app-server running.
The app-server URL selects the execution environment; the SDK uses the same
Letta Code websocket protocol for `runtime_start`, `input`, streaming deltas,
and SDK-defined external tools.

```ts
const client = new LettaAgentClient({
  backend: "remote",
  url: "http://127.0.0.1:4500",
  authToken: process.env.LETTA_APP_SERVER_TOKEN,
  requestTimeoutMs: 120_000,
});

const agentId = await client.createAgent({
  model: "anthropic/claude-sonnet-4",
  persona: "You are a helpful coding assistant.",
});

await using session = client.createSession(agentId);

await session.send("Summarize this repository.");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") console.log(msg.content);
}
```


### Constellation

Use `backend: "cloud"` to create or resume agents hosted on Constellation. If
no `environment` is provided, the SDK creates an agent-scoped sandbox, waits for
it to come online, refreshes it while the session is active, and cleans it up on
close.

```ts
const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
  sandbox: {
    // Optional: defaults to a 5-minute refresh TTL.
    ttlMinutes: 5,
    // Optional: defaults true. Set false for concurrent same-agent sessions.
    terminateOnClose: true,
  },
});

const agentId = await client.createAgent({
  model: "anthropic/claude-sonnet-4",
  persona: "You are a helpful coding assistant.",
});

await using session = client.resumeSession(agentId, {
  permissionMode: "unrestricted",
});

await session.send("Summarize this repository.");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") console.log(msg.content);
}
```

If you pass `cwd` for a Constellation session, use a path that exists inside the
selected remote environment or managed sandbox. Local paths such as
`process.cwd()` are not mapped into managed sandboxes automatically.

You can still set a default `environment` on the client or override it per
session to use an existing remote runtime instead of an SDK-managed sandbox. Use
the environment name from `letta remote --env-name <name>`:

```ts
const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
  environment: { name: "devbox" },
});

await using session = client.resumeSession(agentId, {
  environment: { name: "devbox" },
});
```

For advanced cases where you want to target a specific remote connection, pass
its `connectionId` instead. Connection IDs are assigned when the remote listener
registers and may change after reconnects:

```ts
await using session = client.resumeSession(agentId, {
  environment: { connectionId: "conn-123" },
});
```

`environment` also accepts `{ id: "env-..." }` for an environment record or
`{ deviceId: "device-..." }` for a stable device selector.

`environment` and `sandbox` are mutually exclusive. Managed sandbox refresh and
termination operate on the latest active sandbox for an agent; set
`sandbox.terminateOnClose: false` when multiple SDK sessions may run
concurrently against the same agent and rely on TTL cleanup instead.

By default, websocket authentication uses `Authorization` headers. Set
`webSocketAuth: "query"` for browser-style websocket clients that cannot send
custom upgrade headers.

## Cloud repositories

Cloud clients can create hosted repositories, manage text files inside them,
and attach repositories to a session as resources. Repository resources are
attached before the session starts and detached when the SDK session closes.

```ts
const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});

const repo = await client.repositories.create({ name: "inputs" });

await client.repositories.files.create(repo.id, {
  path: "data.csv",
  content: csvContent,
});

await using session = client.createSession(agentId, {
  resources: [
    { type: "repository", repositoryId: repo.id },
  ],
});

await session.send("Analyze the files in the attached repository.");
```

Repository file helpers are available under `client.repositories.files`, and
version history helpers are available under `client.repositories.versions`.

## Session configuration

Session options let you set runtime defaults before a session starts, including
`model`, `reasoningEffort`, `cwd`, `permissionMode`, and dreaming triggers. For
remote and Constellation sessions, `cwd` must be a path inside the selected
runtime environment.

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({ backend: "local" });

const session = client.resumeSession("agent-123", {
  model: "anthropic/claude-sonnet-4",
  reasoningEffort: "high",
  // For local sessions this may be a local path; for remote/Constellation
  // sessions, use a path inside the selected runtime environment.
  cwd: "/workspace/project",
  permissionMode: "unrestricted",
  dreaming: {
    trigger: "step-count", // off | step-count | compaction-event
    stepCount: 8,
  },
});
```

You can also inspect and change models after startup:

```ts
const catalog = await session.listModels();
await session.updateModel({ model: "sonnet", reasoningEffort: "medium" });
```

Call `await session.abort()` to interrupt the current turn without closing the
session.

For advanced protocol access, use `sendCommand()` with raw Letta Code websocket
protocol commands:

```ts
await session.sendCommand({
  type: "change_device_state",
  runtime: { agent_id: session.agentId!, conversation_id: session.conversationId! },
  payload: { cwd: "/workspace/project" },
});

const sync = await session.sendCommand(
  {
    type: "sync",
    runtime: { agent_id: session.agentId!, conversation_id: session.conversationId! },
  },
  { responseType: "sync_response" },
);
```

## Dreaming

Form long-term memory from recorded coding sessions — Claude Code, Codex, OpenHands, Letta conversations, or pre-normalized transcripts. Sessions are normalized to a shared format, packed into time-ordered batches, reflected on by concurrent agent sessions (each editing an isolated git clone of the target memory filesystem), and synthesized into the target by one aggregation pass that works from the batches' diffs.

```typescript
import { LettaAgentClient, dream } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({ backend: "cloud", apiKey: process.env.LETTA_API_KEY });

const result = await dream({
  client,
  sources: [
    { type: "claude" },                          // all local Claude Code sessions
    { type: "codex", locator: "<session-id>" },  // that Codex session onwards
  ],
  memoryDir: "/path/to/memory-repo",             // git repo the learnings land on
  runRoot: "/path/to/run-artifacts",
});

if (result.kind === "completed") {
  console.log(result.aggregation.report);
}
```

Source types: `claude`, `codex` (local stores; a locator acts as a time cursor), `openhands:<dir>`, `letta:<agent-id>/<conversation-id>` (recorded Letta conversation transcripts), `transcript:<file|dir>` (normalized files). Use `planOnly: true` to preview session selection and batch packing without running agents, and pass `reflectorAgentId`/`aggregatorAgentId` to reuse worker agents across runs. Every run records per-batch `input/`, the edited memory clone, `diff.patch`, `trajectory.json`, and `report.json` under `runRoot`. See `examples/dream.ts`.

## Links

- Docs: https://docs.letta.com/letta-agent-sdk
- Examples: [`./examples`](./examples)

---

Made with 💜 in San Francisco

<img
  referrerpolicy="no-referrer-when-downgrade"
  src="https://static.scarf.sh/a.png?x-pxid=29de91a5-e18c-4366-b192-33a909e184bc&page=README.md"
  alt=""
  aria-hidden="true"
/>
