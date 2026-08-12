# Economics Seminar

A multi-agent academic seminar simulation built on the Letta Agent SDK.

An economist agent researches and presents findings, then defends their work against a faculty panel of specialists. Each agent has persistent memory and learns from each seminar.

## Quick Start

```bash
cd examples/economics-seminar
bun cli.ts
```

## What Happens

1. **📚 Research Phase**: The presenter agent picks a topic and uses `web_search` to research it
2. **📖 Presentation**: The presenter delivers their findings
3. **❓ Q&A Session**: Each faculty member asks questions, with back-and-forth follow-ups
4. **💭 Reflection**: Faculty members share final thoughts and update their memories

## The Cast

### Presenter (Economist)
- Picks compelling research topics
- Uses web search to find papers, data, evidence
- Presents findings and defends methodology
- Learns from faculty feedback over time

### Faculty Panel

| Role | Name | Perspective |
|------|------|-------------|
| **Macro** | Dr. Chen | Policy implications, aggregate effects, systemic impacts |
| **Micro** | Dr. Roberts | Incentives, equilibrium, theoretical rigor |
| **Behavioral** | Dr. Patel | Psychology, biases, how real humans behave |
| **Historian** | Dr. Morrison | Historical precedent, what's been tried before |

## Configuration

```bash
# Quick seminar (3 faculty, 1 question each)
bun cli.ts --faculty=3 --rounds=1

# Full panel, longer discussion
bun cli.ts --faculty=4 --rounds=3

# Check agent status
bun cli.ts --status

# Reset all agents
bun cli.ts --reset
```

## Live Transcript

The seminar streams a colored transcript as it runs:

```
═══════════════════════════════════════════════════════════════
🎓 ECONOMICS SEMINAR
═══════════════════════════════════════════════════════════════

Seminar #1
Faculty panel: 3 members
Q&A rounds: up to 2 per faculty member

───────────────────────────────────────────────────────────────

═══════════════════════════════════════════════════════════════
📖 RESEARCH & PRESENTATION
═══════════════════════════════════════════════════════════════

**Presenter** is preparing...

I'll research the topic of automation and labor market impacts...
[uses web_search]
...

═══════════════════════════════════════════════════════════════
❓ Q&A SESSION
═══════════════════════════════════════════════════════════════

─── Dr. Chen (Professor of Macroeconomics) ───

**Dr. Chen**:
Your analysis focuses on individual job displacement, but what about the
aggregate demand effects? If automation reduces wages broadly, who buys
the products these automated systems produce?

**Presenter**:
That's an excellent point about the demand-side effects...

**Dr. Chen** (follow-up):
But doesn't your model assume...

...
```

## Agent Persistence

Each agent maintains memory blocks that persist across seminars:

**Presenter memories:**
- `research-notes`: Findings and sources from research
- `past-seminars`: Feedback received from faculty
- `methodology`: Research approach refined over time

**Faculty memories:**
- `seminar-notes`: Key points from presentations attended
- `presenter-patterns`: Strengths/weaknesses observed
- `good-questions`: Questions that generated useful discussion

## Agent Teleportation

After running a seminar, the agents can be "teleported" into other contexts:

```typescript
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';

const client = new LettaAgentClient({ backend: 'local' });

// Get agent ID from --status
const drChen = client.resumeSession('agent-xxx', { permissionMode: 'unrestricted' });

// Dr. Chen remembers all past seminars!
await drChen.send('What patterns have you noticed in economics presentations?');
```

Agents created with `backend: 'cloud'` can be viewed in the hosted UI:
```
https://chat.letta.com/agents/<agent-id>
```
(Local-backend agents are not visible in hosted chat.)

## Learning Demonstration

Run multiple seminars to see agents learn:

```bash
# First seminar - agents are fresh
bun cli.ts

# Second seminar - agents reference past discussions
bun cli.ts

# Third seminar - patterns emerge
bun cli.ts
```

The presenter learns:
- Which arguments work against each faculty member
- How to anticipate common critiques
- Better research strategies

Faculty members learn:
- This presenter's strengths and weaknesses
- Effective questioning techniques
- Patterns across presentations

## File Structure

```
economics-seminar/
├── cli.ts           # CLI entry point
├── seminar.ts       # Orchestration logic
├── presenter.ts     # Presenter agent
├── faculty.ts       # Faculty panel agents
├── types.ts         # Shared types
├── seminar-state.json  # Persisted agent IDs
└── README.md
```

## Why This Demo?

This demonstrates Letta's unique capabilities:

1. **Multi-agent interaction**: Agents responding to each other
2. **Distinct personalities**: Each faculty member has a different perspective
3. **Persistent memory**: Agents learn and remember across sessions
4. **Live streaming**: Real-time transcript as agents "speak"
5. **Agent teleportation**: Same agents usable in any context

## License

Apache-2.0
