import { LettaAgentClient } from "../../index.js";

await using client = new LettaAgentClient({
  backend: "local",
  appServer: {
    harnessBackend: "local",
    startupTimeoutMs: 15_000,
  },
});

const models = await client.models.list();
console.log(`MODELS=${models.entries.length}`);
console.log("CALL_COMPLETE");
