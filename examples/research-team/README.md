# Research Team Demo

A multi-agent academic research system built on the Letta Agent SDK. Demonstrates persistent memory and collaborative agents that learn and improve over time.

## Overview

This demo showcases Letta's key differentiator: **agents with persistent memory that get better with use**.

The research team consists of four specialized agents:
- 📚 **Researcher** - Finds and evaluates academic sources
- 🔍 **Analyst** - Synthesizes findings, identifies patterns
- ✍️ **Writer** - Produces polished research reports
- 🎯 **Coordinator** - Orchestrates workflow, manages quality

Each agent maintains memory blocks that persist across sessions, allowing them to:
- Remember which sources are reliable
- Apply effective search and analysis strategies
- Adapt writing style based on user feedback
- Build a shared knowledge base over time

## Quick Start

```bash
# Set CLI path (required)
export LETTA_CLI_PATH=/path/to/letta-code-prod/letta.js

# Run a research task
cd examples/research-team
bun cli.ts "quantum error correction techniques" --depth=quick

# View team status
bun cli.ts --status

# Provide feedback (helps agents learn!)
bun cli.ts --feedback=task-1234567890-abc123
```

## Commands

### Research Query
```bash
bun cli.ts "your research query" [--depth=LEVEL]
```

**Depth Levels:**
| Level | Sources | Time | Report Length |
|-------|---------|------|---------------|
| quick | 3 | ~5 min | 500-800 words |
| standard | 6 | ~15 min | 1000-1500 words |
| comprehensive | 10 | ~30 min | 2000-3000 words |

### Team Management
```bash
# View agent IDs and task count
bun cli.ts --status

# Reset team (start fresh)
bun cli.ts --reset

# Provide feedback on a task
bun cli.ts --feedback=<taskId>
```

## How Learning Works

### 1. Quality Metrics (Automatic)
Each agent tracks quality metrics internally:
- Researcher: Source reliability scores, search strategy effectiveness
- Analyst: Synthesis coherence, citation accuracy
- Writer: Report completeness, structure effectiveness

### 2. User Feedback (Interactive)
After each task, you can provide a 1-5 star rating and optional comment:
```bash
bun cli.ts --feedback=task-1234567890-abc123
# Rate the research (1-5 stars): 4
# What could be better?: More focus on practical applications
```

### 3. Agent Reflections
When you provide feedback, each agent reflects on the task:
- What worked well?
- What could be improved?
- What lessons to apply next time?

These reflections are stored in memory and applied to future tasks.

### 4. Shared Knowledge Base
Agents share knowledge through memory blocks:
- High-quality sources added to shared source list
- Effective patterns documented for team reference
- Common pitfalls recorded to avoid repeated mistakes

## File Structure

```
research-team/
├── cli.ts                    # Main CLI entry point
├── teleport-example.ts       # Agent teleportation demo
├── types.ts                  # Shared type definitions
├── agents/
│   ├── coordinator.ts        # Workflow orchestration
│   ├── researcher.ts         # Source finding & evaluation
│   ├── analyst.ts            # Synthesis & pattern identification
│   └── writer.ts             # Report generation
├── tools/
│   ├── mock-sources.ts       # Simulated academic papers (fallback)
│   └── file-store.ts         # File I/O helpers
├── output/                   # Research artifacts
│   ├── team-state.json       # Persisted agent IDs
│   ├── *-findings.md         # Researcher output
│   ├── *-analysis.md         # Analyst output
│   └── *-report.md           # Final reports
└── README.md
```

## Example Session

### First Task
```bash
$ bun cli.ts "large language model reasoning" --depth=standard

═══════════════════════════════════════════════════════════════
🔬 RESEARCH TEAM
═══════════════════════════════════════════════════════════════

📋 Query: "large language model reasoning"
📊 Depth: standard (est. 15 min)
📚 Target Sources: 6

────────────────────────────────────────────────────────────────

[Init] Starting research task: task-1704585600000-abc123
[Research] Initializing researcher agent...
[Research] Created new researcher agent: agent-xxx-yyy
[Research] Searching for 6 sources...
[Research] Found 6 sources
[Analysis] Initializing analyst agent...
[Analysis] Created new analyst agent: agent-aaa-bbb
[Analysis] Synthesizing findings...
[Writing] Initializing writer agent...
[Writing] Created new writer agent: agent-ccc-ddd
[Writing] Writing final report...
[Complete] Research complete in 12m 34s

═══════════════════════════════════════════════════════════════
✅ RESEARCH COMPLETE
═══════════════════════════════════════════════════════════════

⏱️  Duration: 12m 34s
📄 Report: examples/research-team/output/task-xxx-report.md
🔖 Task ID: task-1704585600000-abc123

💬 To provide feedback and help the team learn:
   bun cli.ts --feedback=task-1704585600000-abc123
```

### Providing Feedback
```bash
$ bun cli.ts --feedback=task-1704585600000-abc123

📝 Feedback for Task: task-1704585600000-abc123
────────────────────────────────────────────────
Rate the research (1-5 stars): 4
What could be better?: Could use more recent sources

📤 Submitting feedback to team...

[Feedback] Processing feedback and triggering reflections...
[Feedback] Researcher reflecting...
[Researcher] I'll prioritize more recent publications in my search...
[Feedback] Analyst reflecting...
[Analyst] I'll pay more attention to temporal trends in my analysis...
[Feedback] Writer reflecting...
[Writer] I'll highlight publication dates more prominently...

✅ Feedback recorded! The team will apply these lessons to future tasks.
```

### Second Task (Improved!)
```bash
$ bun cli.ts "chain of thought prompting" --depth=standard

# Agents now use their learned strategies:
# - Researcher prioritizes recent sources
# - Analyst notes temporal trends
# - Writer highlights dates
```

## Agent Teleportation

This is Letta's killer feature: **agents are portable entities, not just code constructs**.

The research team agents you create here can be "teleported" into any context:
- 🖥️ **CLI** - Interactive debugging and testing
- 🌐 **Web App** - Embed in your product
- 🤖 **GitHub Action** - Automated PR reviews
- 💬 **Slack Bot** - Chat interface for your team
- 🔌 **API Endpoint** - Expose as a service

### How It Works

```typescript
import { resumeSession } from '@letta-ai/letta-agent-sdk';

// Get agent ID from team-state.json or --status
const researcherAgentId = 'agent-xxx-yyy-zzz';

// Teleport the trained researcher into your code
const researcher = resumeSession(researcherAgentId, {
  allowedTools: ['web_search', 'Read', 'Write'],
  permissionMode: 'unrestricted',
});

// The agent remembers everything it learned!
// - Which sources are reliable
// - Effective search strategies
// - Domain knowledge from past research
await researcher.send('Find recent papers on quantum error correction');
```

### Example: Research Team → API Endpoint

```typescript
// server.ts - Turn your research team into an API
import express from 'express';
import { resumeSession } from '@letta-ai/letta-agent-sdk';
import { loadTeamState } from './tools/file-store';

const app = express();
const teamState = await loadTeamState();

app.post('/research', async (req, res) => {
  const { query } = req.body;
  
  // Teleport the trained researcher
  const researcher = resumeSession(teamState.agentIds.researcher!, {
    permissionMode: 'unrestricted',
  });
  
  await researcher.send(`Research: ${query}`);
  
  let result = '';
  for await (const msg of researcher.stream()) {
    if (msg.type === 'assistant') result += msg.content;
  }
  
  researcher.close();
  res.json({ result });
});

// Your CLI-trained agents are now a production API!
```

### View Agents in the Browser

Every agent has a web UI in the Letta ADE (Agent Development Environment):

```
https://app.letta.com/agents/<agent-id>
```

After running the demo, check `--status` for agent IDs, then click the links to:
- Inspect memory blocks
- View conversation history
- Chat with agents directly
- Edit agent configuration

### Why This Matters

| Claude Agent SDK | Letta Agent SDK |
|------------------|----------------|
| Agents are ephemeral processes | Agents are persistent entities |
| Memory via local files | Memory on Letta server |
| Tied to one context | Teleport anywhere |
| Train in code only | Train anywhere (UI, CLI, API) |

**The story**: A PM trains the research team by chatting in the web UI. A developer teleports those same agents into a CI pipeline. The agents bring all their learned knowledge with them.

### Try It

After running the demo at least once, try the teleport example:

```bash
# First, create trained agents
bun cli.ts "large language models" --depth=quick

# Then teleport them into a different context
bun teleport-example.ts
```

This will:
1. Load the trained agent IDs from `team-state.json`
2. Teleport each agent into the script
3. Ask them what they've learned
4. Show how memories persist across contexts

---

## Notes

### Web Search
The Researcher agent uses the `web_search` tool to find real academic sources. No external API keys needed - it uses Letta's built-in search capability.

### Agent Persistence
Agent IDs are stored in `output/team-state.json`. Running `--reset` clears this file and creates fresh agents on the next run. This is useful for:
- Starting over with clean memory
- Testing the "first run" experience
- Debugging agent behavior

### Memory Block Contents
Each agent's memory blocks are stored on the Letta server. To inspect them:
1. Get the agent ID from `--status` or check the ADE links printed during execution
2. Visit `https://app.letta.com/agents/<agent-id>` to view memory contents

## Extending the Demo

### Add Real Web Search
Modify `researcher.ts` to call actual search APIs:
```typescript
// In researcher.ts
import { web_search } from 'some-search-api';

// Replace mock search with real search
const sources = await web_search(query, { limit: config.sourcesCount });
```

### Add More Domains
Extend `mock-sources.ts` with papers in new domains:
```typescript
// In tools/mock-sources.ts
export const MOCK_SOURCES: AcademicSource[] = [
  // ... existing papers ...
  {
    id: 'econ-003',
    title: 'Your New Paper',
    authors: ['Author, A.'],
    // ...
  }
];
```

### Customize Agent Prompts
Modify the system prompts in each agent file to change behavior:
- `researcher.ts`: Search strategy, quality criteria
- `analyst.ts`: Analysis framework, synthesis approach
- `writer.ts`: Writing style, report structure

## License

Apache-2.0 (same as letta-agent-sdk)
