# Custom External Tools

A minimal example showing how to define custom tools that execute locally in the SDK process while the agent runs in a cloud sandbox.

## How it works

1. You define tools as `AgentTool` objects — each with a `name`, `description`, JSON Schema `parameters`, and an `execute` function.
2. Tools are passed to `resumeSession()` via the `tools` option.
3. The SDK sends tool definitions to the agent as `external_tools` in the `runtime_start` command.
4. When the agent calls a tool, the app-server sends an `external_tool_call_request` over the websocket.
5. The SDK intercepts it, runs your `execute()` function locally, and sends the result back.
6. The agent incorporates the result and continues.

The agent runs in the cloud; your tool code runs on your machine. The SDK bridges the two over the websocket.

## Quick start

```bash
# Requires LETTA_API_KEY in the environment
bun run examples/custom-tools/main.ts
```

## What it demonstrates

- **`get_local_time`** — returns the SDK process's local time and timezone. Shows a tool with optional parameters.
- **`roll_dice`** — rolls dice with a configurable count and number of sides. Shows a tool with required parameters.

The example runs two turns: one for each tool. Each turn logs the tool call, tool result, and the agent's final response.

## Defining your own tools

```typescript
import { type AnyAgentTool } from "@letta-ai/letta-agent-sdk";

const myTool: AnyAgentTool = {
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does, shown to the agent.",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "The input to process" },
    },
    required: ["input"],
  },
  execute: async (toolCallId, args) => {
    const { input } = args as { input: string };
    return {
      content: [{ type: "text", text: `Result: ${input.toUpperCase()}` }],
    };
  },
};

// Pass to resumeSession
const session = client.resumeSession(agentId, {
  tools: [myTool],
});
```

## Key points

- Tools execute in the SDK process, not in the agent's sandbox. This means they have access to your local filesystem, environment, and network.
- The `execute` function receives `(toolCallId, args, signal?, onUpdate?)`. The `args` are the parsed JSON arguments from the agent's tool call.
- Return `AgentToolResult` with a `content` array of `{ type: "text" | "image", text?, data?, mimeType? }` parts.
- Tools are registered per-session via the `tools` option. They are not persisted on the agent.
