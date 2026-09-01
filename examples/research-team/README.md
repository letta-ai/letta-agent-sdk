# Persistent Research Team

This example uses TypeScript to run three persistent agents in sequence:

- **Researcher** finds and evaluates sources.
- **Analyst** reads the findings and synthesizes them.
- **Writer** reads the analysis and produces a report.

TypeScript orchestrates the workflow in `agents/workflow.ts`. The agents exchange artifacts through `output/` and keep separate git-backed memory files across sessions.

## Run it

From the repository root:

```bash
cd examples/research-team
bun cli.ts "quantum error correction techniques" --depth=quick
```

Available depth levels:

| Level | Target sources | Estimated time | Report length |
| --- | ---: | ---: | ---: |
| `quick` | 3 | ~5 min | 500-800 words |
| `standard` | 6 | ~15 min | 1000-1500 words |
| `comprehensive` | 10 | ~30 min | 2000-3000 words |

Run a query with a selected depth:

```bash
bun cli.ts "your research query" --depth=standard
```

Check the saved agent IDs and completed task count:

```bash
bun cli.ts --status
```

Reset the saved IDs and create fresh agents on the next run:

```bash
bun cli.ts --reset
```

## How the workflow works

For each query, the TypeScript orchestrator:

1. Resumes or creates the researcher and writes `output/<taskId>-findings.md`.
2. Resumes or creates the analyst and writes `output/<taskId>-analysis.md`.
3. Resumes or creates the writer and writes `output/<taskId>-report.md`.
4. Saves the three agent IDs and completed task count in `output/team-state.json`.

The agents use focused files under `reference/` in their own memory checkouts. Output artifacts pass task-specific work between agents; memory files hold durable notes that may be useful in later tasks.

### Tool note

`web_search` is a server-side tool attached when the researcher agent is created. The `allowedTools` array in `researcher.ts` controls client-side tools such as `Read` and `Write`, so `web_search` does not belong in that array.

## Observe persistence

Run a task and keep its printed task ID. Then send a rating and optional comment:

```bash
bun cli.ts --feedback=task-1234567890-abc123
```

The command resumes each agent and asks it to reflect on the feedback and store useful lessons in memory. Run another query, then inspect the new report and agent output to see what was retained. Persistence is observable; better results are not automatic.

The full loop is:

```bash
bun cli.ts "large language models" --depth=quick
bun cli.ts --feedback=<taskId>
bun cli.ts --status
bun cli.ts "chain of thought prompting" --depth=quick
```

## Resume the agents elsewhere

After running at least one task, the teleport example loads the saved IDs, resumes each agent in a separate session, and asks what it remembers:

```bash
bun cli.ts "large language models" --depth=quick
bun teleport-example.ts
```

The underlying SDK operation is an ordinary resume:

```typescript
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';

await using client = new LettaAgentClient({ backend: 'local' });
await using researcher = client.resumeSession('agent-xxx', {
  allowedTools: ['Read', 'Write'],
  permissionMode: 'unrestricted',
});

await researcher.send('Find recent papers on quantum error correction');
```

This demo pins the local backend, so its agents are not available in the hosted chat UI.

## Files

```text
research-team/
├── cli.ts
├── teleport-example.ts
├── types.ts
├── agents/
│   ├── workflow.ts      # TypeScript workflow orchestration
│   ├── researcher.ts
│   ├── analyst.ts
│   └── writer.ts
├── tools/
│   └── file-store.ts
└── output/              # Generated state and artifacts
```

To change agent behavior, edit the role prompts in `agents/researcher.ts`, `agents/analyst.ts`, and `agents/writer.ts`.
