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

  // Creation parameters mirror letta-code's dream workers exactly: hidden
  // subagent-style agents with NO server-side base tools and no memfs of
  // their own — reflection edits per-batch clones (via $MEMORY_DIR),
  // aggregation edits the target, and a shared memfs would make concurrent
  // sessions contend on its git state.
  let reflectorAgentId = options.reflectorAgentId;
  if (!reflectorAgentId) {
    reflectorAgentId = await client.createAgent({
      name: "dream-reflector",
      description: "Dream pipeline reflector",
      systemPrompt: REFLECTION_SYSTEM_PROMPT,
      ...(options.model ? { model: options.model } : {}),
      tags: ["type:reflection", "role:dream-reflector"],
      hidden: true,
      baseTools: [],
      memfs: false,
    });
    log(`[reflector] created ${reflectorAgentId}`);
  }

  let aggregatorAgentId = options.aggregatorAgentId;
  if (!aggregatorAgentId) {
    aggregatorAgentId = await client.createAgent({
      name: "dream-aggregator",
      description: "Dream pipeline aggregator",
      memory: [
        {
          label: "persona",
          value: AGGREGATOR_PERSONA,
          description:
            "Who I am: a memory aggregator agent merging reflection outputs into one cohesive memory filesystem.",
        },
      ],
      ...(options.model ? { model: options.model } : {}),
      tags: ["type:aggregation", "role:dream-aggregator"],
      hidden: true,
      baseTools: [],
      memfs: false,
    });
    log(`[aggregator] created ${aggregatorAgentId}`);
  }

  return { reflectorAgentId, aggregatorAgentId };
}
