/**
 * Custom External Tools Example
 *
 * Demonstrates how to define custom tools that execute locally in the SDK
 * process while the agent runs in a cloud sandbox. The agent sees the tool,
 * calls it, and the SDK runs your execute() function — the result is sent
 * back to the agent automatically over the websocket.
 *
 * Requires LETTA_API_KEY in the environment.
 *
 * Run:
 *   bun run examples/custom-tools/main.ts
 */

import { LettaCodeClient, type AnyAgentTool } from "../../src/index.js";

// ─── Custom tool definitions ─────────────────────────────────────────

/**
 * Returns the local time of the SDK process.
 * The agent can call this to answer "what time is it locally?"
 */
const getLocalTime: AnyAgentTool = {
  name: "get_local_time",
  label: "Get Local Time",
  description:
    "Get the current local time and timezone of the SDK process. " +
    "Use this when the user asks what time it is locally.",
  parameters: {
    type: "object",
    properties: {
      format: {
        type: "string",
        description: "Optional format: '12h' or '24h'. Defaults to '24h'.",
      },
    },
  },
  execute: async (_toolCallId, args) => {
    const input = args as { format?: string };
    const now = new Date();
    const use12h = input.format === "12h";
    const timeStr = now.toLocaleTimeString("en-US", {
      hour12: use12h,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      content: [
        {
          type: "text",
          text: `Local time: ${timeStr} (${tz})`,
        },
      ],
    };
  },
};

/**
 * Rolls dice and returns the result.
 * Demonstrates a tool with required parameters.
 */
const rollDice: AnyAgentTool = {
  name: "roll_dice",
  label: "Roll Dice",
  description:
    "Roll a number of dice and return the results. " +
    "Useful for games or random decisions.",
  parameters: {
    type: "object",
    properties: {
      count: {
        type: "number",
        description: "Number of dice to roll (1-10).",
        minimum: 1,
        maximum: 10,
      },
      sides: {
        type: "number",
        description: "Number of sides per die (default 6).",
        minimum: 2,
        maximum: 100,
      },
    },
    required: ["count"],
  },
  execute: async (_toolCallId, args) => {
    const input = args as { count: number; sides?: number };
    const sides = input.sides ?? 6;
    const rolls = Array.from(
      { length: input.count },
      () => Math.floor(Math.random() * sides) + 1,
    );
    const total = rolls.reduce((a, b) => a + b, 0);
    return {
      content: [
        {
          type: "text",
          text: `Rolled ${input.count}d${sides}: [${rolls.join(", ")}] = ${total}`,
        },
      ],
    };
  },
};

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const client = new LettaCodeClient({
    backend: "cloud",
    apiKey: process.env.LETTA_API_KEY,
  });

  const agentId = await client.createAgent({
    model: "letta/auto",
    persona: "You are a helpful assistant with access to custom tools.",
  });
  console.log("Created agent:", agentId);

  const session = client.resumeSession(agentId, {
    permissionMode: "bypassPermissions",
    tools: [getLocalTime, rollDice],
  });

  try {
    console.log("\n--- Turn 1: get_local_time ---");
    await session.send(
      "What time is it where the SDK is running? Use the get_local_time tool.",
    );

    for await (const msg of session.stream()) {
      if (msg.type === "assistant") process.stdout.write(msg.content);
      if (msg.type === "tool_call")
        console.log(`\n  [tool_call] ${msg.toolName}`, msg.toolInput);
      if (msg.type === "tool_result")
        console.log(`  [tool_result] ${msg.content}`);
      if (msg.type === "result") {
        console.log(`\n  (took ${msg.durationMs}ms)\n`);
      }
    }

    console.log("\n--- Turn 2: roll_dice ---");
    await session.send("Roll 3 dice for me. Use the roll_dice tool.");

    for await (const msg of session.stream()) {
      if (msg.type === "assistant") process.stdout.write(msg.content);
      if (msg.type === "tool_call")
        console.log(`\n  [tool_call] ${msg.toolName}`, msg.toolInput);
      if (msg.type === "tool_result")
        console.log(`  [tool_result] ${msg.content}`);
      if (msg.type === "result") {
        console.log(`\n  (took ${msg.durationMs}ms)\n`);
      }
    }
  } finally {
    session.close();
  }
}

main().catch(console.error);
