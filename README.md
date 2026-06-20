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

### Client creation

```ts
import { LettaCodeClient } from "@letta-ai/letta-code-sdk";

// Local: SDK-owned Letta Code app-server over loopback websockets. The SDK
// spawns/manages the app-server process for you.
const localClient = new LettaCodeClient({ backend: "local" });

// Legacy local stdio transport remains available as an explicit fallback.
const legacyLocalClient = new LettaCodeClient({
  backend: "local",
  transport: "stdio",
});

// Remote: connect to a user-managed Letta Code app-server over websockets.
const remoteClient = new LettaCodeClient({
  backend: "remote",
  url: "http://127.0.0.1:4500",
  // Required when the app-server is bound to a non-loopback interface with
  // --ws-auth capability-token.
  authToken: process.env.LETTA_APP_SERVER_TOKEN,
});

// Cloud: create a Letta Cloud agent sandbox and control it over the
// Remote Client websocket protocol.
const client = new LettaCodeClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
  sandbox: { lifecycle: "ephemeral" },
});
```

### Persistent agent with multi-turn conversations

```ts
import { LettaCodeClient } from "@letta-ai/letta-code-sdk";

const client = new LettaCodeClient({ backend: "local" });

const agentId = await client.createAgent({
  persona: "You are a helpful coding assistant for TypeScript projects.",
});

// SDK-created agents have MemFS enabled by default and include the
// origin:letta-code tag. Set memfs: false to explicitly opt out.
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

By default, `resumeSession(agentId)` continues the agent’s default conversation. To start a fresh thread, use `createSession(agentId)` (see docs). App-server sessions require an explicit agent id; default/LRU local-agent selection (`createSession()` with no agent id) remains available through the legacy local stdio fallback.

For cloud backends, `environment` is session-scoped and can override the
client default. Remote app-server URLs already select their runtime:

```ts
await using session = client.resumeSession(agentId, {
  environment: { name: "LettaDevelopers" },
});
```

The top-level helpers (`createAgent`, `createSession`, `resumeSession`, and
`prompt`) remain available. They use the local app-server path when an agent id
is present; `createSession()`/`prompt()` without an agent id keep the historical
default/LRU-agent behavior through the legacy local stdio fallback.

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

await using session = client.createSession(agentId, { cwd: process.cwd() });
const result = await session.runTurn("Summarize this repository.");
console.log(result.result);
```


### Letta Cloud backend

Use `backend: "cloud"` to create or resume Cloud-hosted agents while running
turns in a Letta Cloud agent sandbox. The SDK manages the sandbox lifecycle via
Cloud REST endpoints, then uses the Remote Client websocket protocol for
`sync`, `input/create_message`, streaming deltas, approval responses, model
updates, cwd/mode device-state updates, and heartbeats.

```ts
const client = new LettaCodeClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
  // Default when no environment is supplied: create a sandbox and terminate it
  // when the session closes.
  sandbox: { lifecycle: "ephemeral" },
});

const agentId = await client.createAgent({
  model: "anthropic/claude-sonnet-4",
  persona: "You are a helpful coding assistant.",
});

await using session = client.resumeSession(agentId, {
  cwd: process.cwd(),
  permissionMode: "bypassPermissions",
});

const result = await session.runTurn("Summarize this repository.");
console.log(result.result);
```

Sandbox lifecycle options:

- `ephemeral` (default without `environment`): create a Cloud sandbox and
  terminate it on `session.close()`.
- `keep-warm`: create a Cloud sandbox and leave it running after the SDK session
  closes.
- `external` (default when `environment` is supplied): attach to an existing
  Remote Client connection without creating or terminating a sandbox.

```ts
const client = new LettaCodeClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
  sandbox: { lifecycle: "keep-warm" },
});

// Attach to an existing remote environment instead of creating a sandbox.
await using session = client.resumeSession(agentId, {
  environment: { connectionId: "conn-123" },
});
```

By default, websocket authentication uses `Authorization` headers. Set
`webSocketAuth: "query"` for browser-style websocket clients that cannot send
custom upgrade headers.


### Remote environments (ACK-only dispatch)

The SDK can also address a Letta Code remote environment through the Cloud
remote-environment API. Treat the agent and conversation as the stable actor;
treat the remote as an execution target that may be online or offline.

```ts
import { createRemoteAgent } from "@letta-ai/letta-code-sdk";

const agent = createRemoteAgent({
  apiKey: process.env.LETTA_API_KEY,
  agentId: "agent-123",
  conversationId: "conv-456",
  target: { deviceId: "work-laptop" },
  fallback: "fail_if_unavailable",
});

const dispatch = await agent.tell("Pull main, run tests, and summarize failures.");
console.log(dispatch.connectionId, dispatch.clientMessageId);
```

Remote dispatch currently acknowledges that the message reached the selected
Letta Code environment. It does **not** yet stream the final answer through this
SDK surface. The API is intentionally shaped around stable targets (`deviceId`,
`environmentId`, `lastUsed`) instead of making application code depend on the
current ephemeral `connectionId`.

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
