Process reflection batch {{batchIndex}}: {{sessionCount}} recorded session(s) spanning {{startTime}} → {{endTime}}.

Normalized session transcripts to review, in {{inputDir}}:
{{sessionList}}

Each file is a JSON array whose optional leading record is `{"role": "meta", ...}` (source harness, cwd, git branch, model) followed by timestamped `user` / `reasoning` / `assistant` / `tool` records. These are recorded sessions from external coding harnesses — the "assistant" in them is that harness's agent, not you and not the primary agent.

The authoritative absolute memory root for this batch is:
{{memoryDir}}

`$MEMORY_DIR` should resolve to that same directory. Before any write or git command, verify the path. If the environment variable is empty or disagrees, use the explicit path above. Never infer another memory checkout from the parent agent id or nearby directories, and never write to a sibling or parent agent's memory.

This memory root is an isolated copy of the primary agent's memory filesystem at its current revision. Other reflection agents are processing other batches against their own copies in parallel; an aggregation pass will later synthesize everyone's changes into the real memory. Integrate this batch's durable learnings into the existing structure: update existing files where a topic already has a home, skip anything already captured, resolve contradictions at the source, and create new files only for genuinely new topics.

Review every session, then follow your phases, commit durable changes, and return your final report.{{instructionSection}}
