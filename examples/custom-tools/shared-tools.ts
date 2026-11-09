/**
 * Shared Tools Example
 *
 * Registers client tools for several conversations over one connection with
 * client.registerTools(). Each conversation gets its own tool instance, so a
 * call from one conversation never touches another conversation's state.
 * Sessions on those conversations inherit the registered tools and
 * allowedTools. The same tools stay available to turns the agent starts on
 * its own, such as background task notifications, which stream() yields with
 * an `origin`.
 *
 * Runs on the local backend and creates one local agent.
 *
 * Run:
 *   bun run examples/custom-tools/shared-tools.ts
 */

import { LettaAgentClient, type AnyAgentTool } from "../../src/index.js";

/** A tally counter whose state belongs to one conversation. */
function tallyTool(label: string): AnyAgentTool {
  let total = 0;
  return {
    name: "add_to_tally",
    label: "Add to tally",
    description: "Add a number to this conversation's running tally and return the new total.",
    parameters: {
      type: "object",
      properties: { amount: { type: "number", description: "Number to add" } },
      required: ["amount"],
    },
    execute: async (_toolCallId, args) => {
      total += (args as { amount: number }).amount;
      return { content: [{ type: "text", text: `${label} tally: ${total}` }] };
    },
  };
}

const allowedTools = ["add_to_tally"];

await using client = new LettaAgentClient({ backend: "local" });
const agentId = await client.createAgent({
  systemPrompt: "You keep a running tally. Always use add_to_tally to change it.",
  memfs: false,
});

const northId = (await client.conversations.create({ agentId })).id;
const southId = (await client.conversations.create({ agentId })).id;

// One registration per tool set; both share the client's connection.
await using northTools = await client.registerTools({
  conversations: [northId],
  tools: [tallyTool("north")],
  allowedTools,
});
await using southTools = await client.registerTools({
  conversations: [southId],
  tools: [tallyTool("south")],
  allowedTools,
});

// Sessions inherit each registration's tools and allowedTools.
await using north = client.resumeSession(northId);
await using south = client.resumeSession(southId);

for (const [name, session, amount] of [["north", north, 3], ["south", south, 5]] as const) {
  await session.send(`Add ${amount} to the tally, then tell me the total.`);
  for await (const message of session.stream()) {
    if (message.type === "tool_result") console.log(`[${name}] ${message.content}`);
    if (message.type === "result" && message.origin) {
      console.log(`[${name}] ${message.origin} turn: ${message.result ?? ""}`);
    } else if (message.type === "result") {
      console.log(`[${name}] ${message.result ?? message.error}`);
    }
  }
}
