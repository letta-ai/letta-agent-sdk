/**
 * Shared Tools Example
 *
 * Registers one set of client tools for several conversations over one
 * connection with client.registerTools(). A single tool instance serves every
 * conversation: execute() receives a context naming the calling conversation,
 * so the tool keeps each conversation's state apart by `conversationId`.
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

/** One tally per conversation, kept apart by the calling conversation's id. */
const totals = new Map<string, number>();

const addToTally: AnyAgentTool = {
  name: "add_to_tally",
  label: "Add to tally",
  description: "Add a number to this conversation's running tally and return the new total.",
  parameters: {
    type: "object",
    properties: { amount: { type: "number", description: "Number to add" } },
    required: ["amount"],
  },
  execute: async (_toolCallId, args, _signal, _onUpdate, context) => {
    if (!context) throw new Error("add_to_tally needs the calling conversation");
    const total = (totals.get(context.conversationId) ?? 0) + (args as { amount: number }).amount;
    totals.set(context.conversationId, total);
    return { content: [{ type: "text", text: `tally: ${total}` }] };
  },
};

const allowedTools = ["add_to_tally"];

await using client = new LettaAgentClient({ backend: "local" });
const agentId = await client.createAgent({
  systemPrompt: "You keep a running tally. Always use add_to_tally to change it.",
  memfs: false,
});

const northId = (await client.conversations.create({ agentId })).id;
const southId = (await client.conversations.create({ agentId })).id;

// One registration covers both conversations on the client's connection.
await using tools = await client.registerTools({
  conversations: [northId, southId],
  tools: [addToTally],
  allowedTools,
});

// Sessions inherit the registration's tools and allowedTools.
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
