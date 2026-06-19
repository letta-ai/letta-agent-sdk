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

// Local: embedded Letta Code harness, stdio wire. This spawns/manages a
// subprocess; it is not the same as `remote` + a localhost URL.
const localClient = new LettaCodeClient({ backend: "local" });

// Remote/cloud are typed placeholders in this release. Construction succeeds,
// but using them will throw until the transports are implemented.
const remoteClient = new LettaCodeClient({
  backend: "remote",
  url: "wss://up698.railway.com/9123",
});

const client = new LettaCodeClient({
  backend: "cloud",
  environment: { name: "Cameron's MacMini" }, // optional default
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

By default, `resumeSession(agentId)` continues the agent’s default conversation. To start a fresh thread, use `createSession(agentId)` (see docs).

For cloud/remote backends, `environment` is session-scoped and can override the
client's default execution target once those backends are implemented:

```ts
await using session = client.resumeSession(agentId, {
  environment: { name: "LettaDevelopers" },
});
```

The legacy top-level helpers (`createAgent`, `createSession`, `resumeSession`,
and `prompt`) remain available and use the local subprocess backend.


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
