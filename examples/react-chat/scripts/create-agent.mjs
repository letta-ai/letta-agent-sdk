import { appendFile } from "node:fs/promises";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk/client";

const apiKey = process.env.LETTA_API_KEY?.trim();
if (!apiKey) throw new Error("Add LETTA_API_KEY to .env.local first.");

// Avoid creating another agent when the setup script runs again.
const existingAgentId = process.env.LETTA_CHAT_AGENT_ID?.trim();
if (existingAgentId) {
  console.log(`Using existing agent: ${existingAgentId}`);
  process.exit(0);
}

// For local mode, import from the package root and use backend: "local".
// The complete changes are in "Use a local agent" below.
const client = new LettaAgentClient({
  backend: "cloud",
  apiKey,
});

const agentId = await client.createAgent({
  name: "React chat demo",
  model: "letta/auto", // Free model routing on Letta Cloud
  memfs: false, // This demo does not use git-backed memory
  persona:
    "You are a concise research assistant. Use web_search and fetch_webpage when a request needs current information.",
});

// Store the durable agent ID beside the API key for the server route.
await appendFile(
  new URL("../.env.local", import.meta.url),
  `\nLETTA_CHAT_AGENT_ID=${agentId}\n`,
);

console.log(`Created agent: ${agentId}`);
console.log("Saved LETTA_CHAT_AGENT_ID to .env.local");
