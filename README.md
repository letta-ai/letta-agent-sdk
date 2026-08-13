# Letta Agent SDK

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-agent-sdk.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-agent-sdk) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

The SDK for [stateful agents](https://docs.letta.com/concepts/stateful-agents): create an agent once, then resume it from anywhere. Each agent has its own identity and long-term memory, and keeps both across conversations, models, and the computers it runs on.

Read the [documentation](https://docs.letta.com/agent-sdk) for guides and the full API reference.

## Quick start

```bash
npm install @letta-ai/letta-agent-sdk
```

```typescript
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({ backend: "cloud" });

// Create the agent once. The preset keeps the default harness and MemFS guidance.
const agentId = await client.createAgent({ personality: "memo" });

// ...then resume it, from anywhere, for as long as it lives.
await using session = client.resumeSession(agentId);

await session.send("What changed since last week?");
for await (const message of session.stream()) {
  if (message.type === "assistant") process.stdout.write(message.content);
}
```

Set `LETTA_API_KEY` for the cloud backend. See the [quickstart](https://docs.letta.com/agent-sdk/quickstart) for the local and self-hosted paths.

## Where your agents run

One interface, three backends:

| Backend    | Agent state         | Tools execute                          |
| ---------- | ------------------- | -------------------------------------- |
| `"cloud"`  | Hosted by Letta     | A managed sandbox, or a computer you connect |
| `"local"`  | On this machine*    | On this machine*                       |
| `"remote"` | Your App Server     | On your App Server machine             |

\* *"this machine" refers to the machine that the SDK code itself is running on*

Browser, Expo, and React Native applications import from `@letta-ai/letta-agent-sdk/client`, which does not require Node and supports the cloud and remote backends. See [Deployment](https://docs.letta.com/agent-sdk/deployment).

## Examples

Runnable applications live in [`examples/`](./examples). Start with the [examples guide](./examples/README.md), which orders the demos by concept and lists their setup and side effects. See the [React chat template](https://github.com/letta-ai/letta-agent-sdk-react-chat) for a more complete custom UI.

## Contributing

Development conventions for this repository are in [AGENTS.md](./AGENTS.md).

---

Made with 💜 in San Francisco

<img
  referrerpolicy="no-referrer-when-downgrade"
  src="https://static.scarf.sh/a.png?x-pxid=29de91a5-e18c-4366-b192-33a909e184bc&page=README.md"
  alt=""
  aria-hidden="true"
/>
