# Stateless conversations

Use `query()` when you need one model turn but do not need an agent or memory.
Each call creates an ephemeral conversation, streams its messages, and closes
the runtime when iteration ends. Stateless means agent-free, not storage-free:
the conversation and its messages remain persisted and archived in Letta Cloud.

This example includes three patterns:

1. stream a direct answer;
2. collect and parse a structured result;
3. run several independent queries with the same client.

No example creates an agent.

## Run it

Set `LETTA_API_KEY`, then run:

```bash
bun examples/stateless-conversations/main.ts
```

The example uses a local App Server with the API backend. Conversation state is
stored by Letta Cloud, while the App Server executes on your machine.

## Minimal query

```typescript
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({
  backend: "local",
  appServer: { harnessBackend: "api" },
});

for await (const message of client.query({
  prompt: "What is the capital of France?",
  options: {
    model: "openai/gpt-5.6-luna",
    system: "Answer directly and concisely.",
  },
})) {
  if (message.type === "assistant") process.stdout.write(message.content);
}
```

With `backend: "remote"`, the connected App Server creates the ephemeral
conversation. With `backend: "cloud"`, pass an explicit `computer`; managed
sandboxes are agent-scoped and therefore are not used for stateless
conversations.
