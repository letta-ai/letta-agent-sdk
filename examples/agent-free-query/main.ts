#!/usr/bin/env bun

/**
 * Agent-free query examples
 *
 * Requires LETTA_API_KEY.
 * Run with: bun examples/agent-free-query/main.ts
 */

import {
  LettaAgentClient,
  type QueryParams,
  type SDKMessage,
  type SDKResultMessage,
} from "../../src/index.js";

if (!process.env.LETTA_API_KEY) {
  throw new Error("Set LETTA_API_KEY to run the agent-free query examples.");
}

const client = new LettaAgentClient({
  backend: "local",
  appServer: {
    harnessBackend: "api",
    requestTimeoutMs: 180_000,
  },
});

async function collectQuery(params: QueryParams): Promise<{
  messages: SDKMessage[];
  result: SDKResultMessage;
}> {
  const messages: SDKMessage[] = [];
  for await (const message of client.query(params)) {
    messages.push(message);
  }

  const result = messages.find(
    (message): message is SDKResultMessage => message.type === "result",
  );
  if (!result) throw new Error("Query ended without a result message.");
  if (!result.success) throw new Error(result.error ?? "Query failed.");
  return { messages, result };
}

async function streamDirectAnswer(): Promise<void> {
  console.log("\n1. Stream a direct answer\n");

  for await (const message of client.query({
    prompt: "Why does the sky look blue? Answer in two sentences.",
    options: {
      model: "openai/gpt-5.6-luna",
      system: "Explain scientific ideas accurately and without jargon.",
      allowedTools: [],
    },
  })) {
    if (message.type === "assistant") process.stdout.write(message.content);
    if (message.type === "result") {
      console.log(`\n\nCompleted in ${message.durationMs}ms`);
    }
  }
}

async function extractStructuredData(): Promise<void> {
  console.log("\n2. Collect a structured result\n");

  const { result } = await collectQuery({
    prompt:
      "Extract the customer request from: 'Please cancel order A-104 and refund it to my card.'",
    options: {
      model: "openai/gpt-5.6-luna",
      system:
        "Return only JSON with string fields action, orderId, and refundMethod.",
      allowedTools: [],
    },
  });

  if (typeof result.result !== "string") {
    throw new Error("Structured query returned no text result.");
  }
  const request = JSON.parse(result.result) as {
    action: string;
    orderId: string;
    refundMethod: string;
  };
  console.log(request);
}

async function runQueriesConcurrently(): Promise<void> {
  console.log("\n3. Run independent queries concurrently\n");

  const questions = [
    "Name the largest ocean on Earth.",
    "Name the smallest prime number.",
    "Name the chemical symbol for gold.",
  ];
  const answers = await Promise.all(
    questions.map(async (prompt) => {
      const { result } = await collectQuery({
        prompt,
        options: {
          model: "openai/gpt-5.6-luna",
          system: "Answer with only the requested name, number, or symbol.",
          allowedTools: [],
        },
      });
      return result.result;
    }),
  );

  for (const [index, question] of questions.entries()) {
    console.log(`${question} ${answers[index]}`);
  }
}

await streamDirectAnswer();
await extractStructuredData();
await runQueriesConcurrently();
