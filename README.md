# Letta Agent SDK

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-agent-sdk.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-agent-sdk) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

Build applications with stateful agents powered by the [Letta agent harness](https://www.letta.com/agent). The Agent SDK provides one TypeScript interface for managed, local, and self-hosted deployments.

## Installation

```bash
npm install @letta-ai/letta-agent-sdk
```

## Quick start

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});

const agentId = await client.createAgent({
  model: "anthropic/claude-opus-4-8",
  memory: [
    {
      label: "persona",
      value: "You are a proactive research assistant.",
    },
    {
      label: "human",
      value: "The user prefers concise summaries with sources and next steps.",
    },
  ],
});

await using session = client.createSession(agentId);

await session.send("Research the latest project changes and prepare a brief.");
for await (const message of session.stream()) {
  if (message.type === "assistant") {
    console.log(message.content);
  }
}
```

`createAgent()` uses the supplied memory as the agent's identity. Letta Code
personality presets are opt-in: pass `personality: "memo"` (or another preset)
only when you want that preset's name, description, and memory blocks.

An agent is the persistent entity with memory. A conversation is a thread on that agent. A session is the active connection used to send messages, stream events, execute tools, and handle approvals.

- `createSession(agentId)` starts a new conversation.
- `resumeSession(conversationId)` resumes a saved conversation.
- `resumeSession(agentId)` resumes the agent's default conversation.

Pass `stateless: true` when a session should use an existing agent without
loading or changing its MemFS:

```ts
await using session = client.createSession(agentId, { stateless: true });
```

The agent and conversation still persist. Stateless sessions preserve the
agent's model, prompt, tools, tags, and sampling settings, but skip MemFS sync,
agent-scoped skills and mods, memory transcript writes, and reflection for that
session. Options that mutate persisted configuration (`model`,
`reasoningEffort`, `dreaming`, and `resources`) are rejected, as is
`session.updateModel()`. The option works with local, remote App Server, and
Cloud backends.

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
// status.isProcessing, status.memoryDirectory,
// status.pendingControlRequests, status.raw

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

### Choose a computer

Cloud clients can list the computers registered with the current Letta account
and select one by name when opening a session:

```ts
const { computers } = await client.computers.list({ onlineOnly: true });
for (const computer of computers) {
  console.log(computer.name, computer.deviceId, computer.status);
}

await using session = client.resumeSession(agentId, {
  computer: "Work laptop",
});
await session.send("Run the test suite on this computer.");
```

Computer names must uniquely identify a registered computer. For persisted
selections, use the stable `deviceId`; a `connectionId` identifies only the
current online lease and can rotate after reconnects:

```ts
await using session = client.resumeSession(agentId, {
  computer: { deviceId: "device-..." },
});
```

`client.computers.get(deviceId)` retrieves one computer and
`client.computers.resolve(selector)` resolves a name or ID to its current online
connection. The previous client-level and session-level `environment` options
remain as deprecated compatibility aliases for `computer`.

### Local

```ts
const client = new LettaAgentClient({ backend: "local" });

await using session = client.createSession(agentId, {
  cwd: process.cwd(),
});
```

Local execution (embedded Letta Code harness / app server) requires Node.js 22.19 or newer.

### Built-in client toolsets

Use `toolset` to select a request-scoped harness preset and add bundled client
tools. `allowedTools` remains the final visibility boundary across bundled and
custom tools.

Both are scoped to locally executed client tools. Server-side tools (such as
`web_search`) are attached to the agent itself via `baseTools` at creation and
are unaffected by `allowedTools` — listing one there matches nothing.

```ts
await using session = client.createSession(agentId, {
  toolset: {
    base: "none",
    include: ["Read", "LS", "Glob", "Grep"],
  },
  allowedTools: ["Read", "LS", "Glob", "Grep"],
});
```

The override applies to this SDK session's turns without changing the agent's
persisted harness toolset preference.

### MCP tools

Pass MCP servers by name in session options. The SDK supports local stdio,
Streamable HTTP, and legacy SSE transports. It namespaces discovered tools as
`mcp__<server>__<tool>` and exposes them through Letta Code's external-tool
protocol.

```ts
await using session = client.createSession(agentId, {
  cwd: process.cwd(),
  mcpServers: {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    },
    exa: {
      type: "http",
      url: "https://mcp.exa.ai/mcp",
    },
    github: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    },
  },
  allowedTools: ["mcp__filesystem__*", "mcp__exa__*", "mcp__github__list_issues"],
});
```

Connections start concurrently during session initialization. A failed server
is skipped without dropping healthy servers. OAuth is host-managed, matching
the Claude Agent SDK: complete OAuth in your application and provide the access
token through `headers`. The SDK does not open an interactive browser flow.

MCP connections run in the Node SDK process and close with the session. This
includes MCP used by remote and Cloud sessions: stdio servers see the SDK host
filesystem, not a managed sandbox. MCP is unavailable from the portable
`@letta-ai/letta-agent-sdk/client` browser and React Native entry point.

### Managed Cloud sandbox repositories

Cloud sessions can clone up to 10 GitHub repositories into the managed
sandbox. Public repositories clone directly; private repositories require
access through the organization's GitHub integration.

```ts
await using session = client.createSession(agentId, {
  sandbox: {
    githubRepositories: [
      { owner: "letta-ai", repo: "letta-docs-md" },
      { owner: "letta-ai", repo: "letta-code" },
    ],
  },
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

The client exposes agent, conversation, model, computer, and Cloud repository management alongside active sessions:

```ts
const agents = await client.agents.list({ tags: ["support"] });
const conversations = await client.conversations.list({
  agentId: agents[0].id,
  orderBy: "lastMessageAt",
  order: "desc",
});

// No open session required — safe for model pickers and settings screens.
const { entries: models, availableHandles } = await client.models.list();

const repository = await client.repositories.create({ name: "inputs" });
await client.repositories.files.create(repository.id, {
  path: "brief.md",
  content: "# Project brief\n",
});

// Persistent agent knowledge: attach once during provisioning. This
// recompiles the agent's default conversation after the relationship is
// visible, and session.close() will not detach it.
await client.agents.repositories.attach(agents[0].id, repository.id, {
  permissions: "read",
});

// Remove persistent knowledge explicitly during deprovisioning.
await client.agents.repositories.detach(agents[0].id, repository.id);
await client.agents.delete(agents[0].id);
```

`client.repositories` and `client.agents.repositories` are available on the
`cloud` backend. Persistent agent relationships belong under
`client.agents.repositories`; use session `resources` only when the session
should own attachment and cleanup. Attach and detach recompile the agent's
default conversation by default; pass `{ recompile: false }` only when the
caller will handle prompt recompilation separately. Existing explicit
conversations are not silently recompiled. If recompilation fails after a
successful relationship mutation, the method rejects but the attachment state
remains changed; retrying is safe. See [Cloud repositories](https://docs.letta.com/letta-agent-sdk/repositories) for file operations, version history, and session resources.

## Documentation

- [Overview](https://docs.letta.com/letta-agent-sdk/overview)
- [Quickstart](https://docs.letta.com/letta-agent-sdk/quickstart)
- [Deployment](https://docs.letta.com/letta-agent-sdk/deployment)
- [SDK reference](https://docs.letta.com/letta-agent-sdk/reference)
- [React chat template](https://github.com/letta-ai/letta-agent-sdk-react-chat)
- [Examples](./examples)

---

Made with 💜 in San Francisco

<img
  referrerpolicy="no-referrer-when-downgrade"
  src="https://static.scarf.sh/a.png?x-pxid=29de91a5-e18c-4366-b192-33a909e184bc&page=README.md"
  alt=""
  aria-hidden="true"
/>
