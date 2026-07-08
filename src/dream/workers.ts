// Worker agents for the dream pipeline:
//
// - The REFLECTOR carries the reflection system prompt; every batch runs as
//   its own session on it (sessions are independent conversations, so any
//   number of batches run concurrently without contention).
// - The AGGREGATOR carries the default system prompt with the aggregator
//   persona block; the aggregation pass runs as a session on it.
//
// Callers may pass existing agent ids to reuse workers across runs (their
// conversation history then doubles as the dream run history); otherwise one
// of each is created per dream() call, tagged for later discovery.

import type { LettaAgentClient } from "../client.js";
import { AGGREGATOR_PERSONA, REFLECTION_SYSTEM_PROMPT } from "./prompts.js";

export interface DreamWorkers {
  reflectorAgentId: string;
  aggregatorAgentId: string;
}

export async function ensureDreamWorkers(
  client: LettaAgentClient,
  options: {
    reflectorAgentId?: string;
    aggregatorAgentId?: string;
    model?: string;
    log?: (line: string) => void;
  },
): Promise<DreamWorkers> {
  const log = options.log ?? (() => {});

  let reflectorAgentId = options.reflectorAgentId;
  if (!reflectorAgentId) {
    reflectorAgentId = await client.createAgent({
      systemPrompt: REFLECTION_SYSTEM_PROMPT,
      ...(options.model ? { model: options.model } : {}),
      tags: ["role:dream-reflector"],
      // Workers carry no memfs of their own: reflection edits per-batch
      // clones and aggregation edits the caller's target, and a shared memfs
      // would make concurrent sessions contend on its git state.
      memfs: false,
    });
    log(`[reflector] created ${reflectorAgentId}`);
  }

  let aggregatorAgentId = options.aggregatorAgentId;
  if (!aggregatorAgentId) {
    aggregatorAgentId = await client.createAgent({
      persona: AGGREGATOR_PERSONA,
      ...(options.model ? { model: options.model } : {}),
      tags: ["role:dream-aggregator"],
      memfs: false,
    });
    log(`[aggregator] created ${aggregatorAgentId}`);
  }

  return { reflectorAgentId, aggregatorAgentId };
}
