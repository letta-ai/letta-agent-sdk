# Letta Agent SDK

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-code-sdk.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-code-sdk) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

The SDK interface to [**Letta Code**](https://github.com/letta-ai/letta-code). Build agents with persistent memory that learn over time. 

## Installation

```bash
npm install @letta-ai/letta-code-sdk
```

## Quick start

### Client creation

```ts
import { LettaCodeClient } from "@letta-ai/letta-code-sdk";

// Local: SDK-owned Letta Code app-server over loopback websockets. The SDK
// spawns/manages the app-server process for you.
const localClient = new LettaCodeClient({ backend: "local" });

// Remote: connect to a user-managed Letta Code app-server over websockets.
const remoteClient = new LettaCodeClient({
  backend: "remote",
  url: "http://127.0.0.1:4500",
  // Required when the app-server is bound to a non-loopback interface with
  // --ws-auth capability-token.
  authToken: process.env.LETTA_APP_SERVER_TOKEN,
});

// Constellation: create or resume agents whose state lives in Letta's
// agent cloud, with an SDK-managed sandbox by default.
const client = new LettaCodeClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});
```

### Persistent agent with multi-turn conversations

```ts
import { LettaCodeClient } from "@letta-ai/letta-code-sdk";

const client = new LettaCodeClient({ backend: "local" });

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

On app-server-backed sessions you may also call `send()` while another turn is
streaming. The SDK sends the same `input` frame used by Letta Desktop and the
listener owns queueing; `stream()` may surface `queue_update` events before the
current turn's `result`.

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
`prompt`) remain available for local app-server sessions.

### User-managed app-server backend

Use `backend: "remote"` when you already have a Letta Code app-server running.
The app-server URL selects the execution environment; the SDK uses the
app-server websocket protocol for `runtime_start`, `input`, streaming deltas,
and SDK-defined external tools.

```ts
const client = new LettaCodeClient({
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
const client = new LettaCodeClient({
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
  permissionMode: "bypassPermissions",
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
session to use an existing remote runtime instead of an SDK-managed sandbox:

```ts
const client = new LettaCodeClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
  environment: { connectionId: "conn-default" },
});

await using session = client.resumeSession(agentId, {
  environment: { connectionId: "conn-123" },
});
```

`environment` and `sandbox` are mutually exclusive. Managed sandbox refresh and
termination operate on the latest active sandbox for an agent; set
`sandbox.terminateOnClose: false` when multiple SDK sessions may run
concurrently against the same agent and rely on TTL cleanup instead.

By default, websocket authentication uses `Authorization` headers. Set
`webSocketAuth: "query"` for browser-style websocket clients that cannot send
custom upgrade headers.

## Session configuration

Session options let you set runtime defaults before a session starts, including
`model`, `reasoningEffort`, `cwd`, `permissionMode`, and sleeptime triggers.
For remote and Constellation sessions, `cwd` must be a path inside the selected
runtime environment.

```ts
import { LettaCodeClient } from "@letta-ai/letta-code-sdk";

const client = new LettaCodeClient({ backend: "local" });

const session = client.resumeSession("agent-123", {
  model: "anthropic/claude-sonnet-4",
  reasoningEffort: "high",
  // For local sessions this may be a local path; for remote/Constellation
  // sessions, use a path inside the selected runtime environment.
  cwd: "/workspace/project",
  permissionMode: "bypassPermissions",
  sleeptime: {
    trigger: "step-count", // off | step-count | compaction-event
    stepCount: 8,
  },
});
```

You can also inspect and change models after startup on app-server-backed
sessions:

```ts
const catalog = await session.listModels();
await session.updateModel({ model: "sonnet", reasoningEffort: "medium" });
```

Call `await session.abort()` to interrupt the current turn without closing the
session.

For advanced protocol access, use `sendCommand()` with raw app-server commands:

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

## Links

- Docs: https://docs.letta.com/letta-code-sdk
- Examples: [`./examples`](./examples)

---

Made with 💜 in San Francisco
