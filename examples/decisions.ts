import { LettaAgentClient } from "../src/index.js";

// Experimental Cloud API. No agent, conversation, or sandbox is created.
if (!process.env.LETTA_API_KEY) {
  throw new Error("Set LETTA_API_KEY before running this Cloud example.");
}

await using client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});

const result = await client.alpha.decisions.evaluate({
  state: "I was charged twice. I will cancel today unless it is refunded.",
  questions: {
    route: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Charges, refunds, and subscription payments",
        technical: "Product bugs and outages",
        other: "Neither billing nor technical",
      },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this request?",
      criteria: ["no rush", "normal", "today", "immediate"],
    },
    cancelThreat: {
      type: "noul",
      instructions: "The customer is threatening to cancel.",
    },
  },
});

console.log(JSON.stringify(result, null, 2));
