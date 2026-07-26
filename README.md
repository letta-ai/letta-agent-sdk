# Letta Agent SDK

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-agent-sdk.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-agent-sdk) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

Build applications with stateful agents powered by the [Letta agent harness](https://www.letta.com/agent). The Agent SDK provides one TypeScript interface for managed, local, and self-hosted deployments.

## Installation

```bash
npm install @letta-ai/letta-agent-sdk
```

Local execution requires Node.js 22.19 or newer.

## Quick start

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});

const agentId = await client.createAgent({
  model: "anthropic/claude-opus-4-8",
  persona: "You are a proactive research assistant.",
  human: "The user prefers concise summaries with sources and next steps.",
});

await using session = client.createSession(agentId);

await session.send("Research the latest project changes and prepare a brief.");
for await (const message of session.stream()) {
  if (message.type === "assistant") {
    console.log(message.content);
  }
}
```

An agent is the persistent entity with memory. A conversation is a thread on that agent. A session is the active connection used to send messages, stream events, execute tools, and handle approvals.

- `createSession(agentId)` starts a new conversation.
- `resumeSession(conversationId)` resumes a saved conversation.
- `resumeSession(agentId)` resumes the agent's default conversation.
- `prompt(message, agentId)` runs a one-shot prompt in a new conversation.

Portable sessions also expose the stateful controls needed by interactive
clients:

```ts
const state = await session.bootstrapState();
await session.changeDeviceState({
  cwd: "/workspace/project",
  permissionMode: "acceptEdits",
});

const removed = await session.removeQueuedMessage(queueItemId);
if (!removed.removed) {
  // Reconcile the authoritative queue before offering the action again.
}

await session.recoverPendingApprovals();
```

`removeQueuedMessage()` waits for an app-server acknowledgement.
`changeDeviceState()` currently confirms command transport only because the
underlying protocol does not acknowledge that mutation.

The read side of the device state is exposed as a one-shot getter and a
subscription — enough to restore permission-mode UI and re-surface pending
approvals when a mobile or web client returns to the foreground:

```ts
const status = await session.getDeviceStatus();
// status.permissionMode, status.workingDirectory, status.isOnline,
// status.isProcessing, status.pendingControlRequests, status.raw

const unsubscribe = session.onDeviceStatus((status) => {
  // Called for every device-status update pushed by the runtime.
});
unsubscribe();
```

`getDeviceStatus()` always sends a lightweight, request-correlated `sync`
(`recover_approvals: false`, `force_device_status: true`) and resolves only
after the runtime acknowledges it and replays a fresh status. This makes the
getter safe for foreground reconciliation instead of returning a snapshot
cached before the app was backgrounded. Pending approval request IDs are for
correlation; decisions continue through `recoverPendingApprovals()` and the
session's `canUseTool` callback.

## Deployment options

| Backend | Agent state | Tool execution |
| --- | --- | --- |
| `cloud` | Letta Cloud | Managed cloud sandbox or a selected computer |
| `local` | Current computer | Current computer through an SDK-managed App Server |
| `remote` | Configured by the App Server | A user-managed App Server computer |

### Local

```ts
const client = new LettaAgentClient({ backend: "local" });

await using session = client.createSession(agentId, {
  cwd: process.cwd(),
});
```

### Remote App Server

```ts
const client = new LettaAgentClient({
  backend: "remote",
  url: "http://127.0.0.1:4500",
  authToken: process.env.LETTA_APP_SERVER_TOKEN,
});
```

See the [deployment guide](https://docs.letta.com/letta-agent-sdk/deployment) for managed sandboxes, remote computers, App Server setup, and authentication.

## Browser and React Native

Use the portable `/client` entry point in browser, Expo, and React Native applications. It supports the `cloud` and `remote` backends without importing Node process-management modules.

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk/client";

const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: userProvidedApiKey,
  webSocketAuth: "query",
});
```

For authenticated Remote App Servers in React Native, pass the platform WebSocket through `createReactNativeWebSocketConstructor()` so capability-token headers use React Native's third constructor argument.

## Management APIs

The client exposes agent, conversation, and Cloud repository management alongside active sessions:

```ts
const agents = await client.agents.list({ tags: ["support"] });
const conversations = await client.conversations.list({
  agentId: agents[0].id,
  orderBy: "lastMessageAt",
  order: "desc",
});

const repository = await client.repositories.create({ name: "inputs" });
await client.repositories.files.create(repository.id, {
  path: "brief.md",
  content: "# Project brief\n",
});
```

`client.repositories` is available on the `cloud` backend. See [Cloud repositories](https://docs.letta.com/letta-agent-sdk/repositories) for file operations, version history, and session resources.

## Documentation

- [Overview](https://docs.letta.com/letta-agent-sdk/overview)
- [Quickstart](https://docs.letta.com/letta-agent-sdk/quickstart)
- [Deployment](https://docs.letta.com/letta-agent-sdk/deployment)
- [SDK reference](https://docs.letta.com/letta-agent-sdk/reference)
- [Examples](./examples)

---

Made with 💜 in San Francisco

<img
  referrerpolicy="no-referrer-when-downgrade"
  src="https://static.scarf.sh/a.png?x-pxid=29de91a5-e18c-4366-b192-33a909e184bc&page=README.md"
  alt=""
  aria-hidden="true"
/>
