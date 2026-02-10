# Political Focus Group Simulator

Simulate a political focus group with persistent AI personas to test candidate messaging.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      FOCUS GROUP                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐                                           │
│  │  CANDIDATE   │ ──────────► Presents position             │
│  │              │ ◄────────── Asks follow-up questions      │
│  └──────────────┘                                           │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │   VOTER 1    │  │   VOTER 2    │  ... (expandable)       │
│  │   (Maria)    │  │   (James)    │                         │
│  │  Independent │  │  Republican  │                         │
│  └──────────────┘  └──────────────┘                         │
│         │                  │                                 │
│         └────────┬─────────┘                                │
│                  ▼                                           │
│         ┌──────────────┐                                    │
│         │   ANALYST    │  Observes and provides insights    │
│         └──────────────┘                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
cd examples/focus-group

# Run on a specific topic
bun cli.ts "healthcare reform"

# Interactive mode (enter multiple topics)
bun cli.ts

# Check status
bun cli.ts --status

# Reset all agents
bun cli.ts --reset
```

## Flow

1. **Candidate presents** - Takes a topic and presents a specific position
2. **Voters react** - Each voter responds based on their persona
3. **Candidate follows up** - Asks a probing question based on reactions
4. **Voters respond** - Answer the follow-up question
5. **Analyst summarizes** - Provides insights and recommendations

## Default Personas

### Maria (Independent)
- 34 years old, Phoenix, AZ
- Nurse, mother of two
- Top issues: healthcare costs, education, immigration
- Weak party identification

### James (Republican)  
- 58 years old, rural Ohio
- Former auto worker, small business owner
- Top issues: economy, manufacturing jobs, government spending
- Moderate party identification, skeptical of both parties

## Customizing Personas

Edit `agents.ts` and modify `SAMPLE_PERSONAS`:

```typescript
export const SAMPLE_PERSONAS: VoterPersona[] = [
  {
    name: 'Sarah',
    age: 28,
    location: 'Austin, TX',
    party: 'Democrat',
    leaningStrength: 'moderate',
    topIssues: ['climate change', 'student debt', 'housing costs'],
    background: 'Software engineer, renting, worried about buying a home.',
  },
  // Add more personas...
];
```

## Key Letta Features Demonstrated

1. **Agent Persistence** - All agents remember previous sessions
2. **Multi-Agent Coordination** - Candidate, voters, and analyst interact
3. **Persona Memory** - Each voter maintains their identity in memory blocks
4. **Streaming Responses** - See responses as they're generated

## Expanding to More Voters

The architecture supports any number of voters. To add more:

1. Add personas to `SAMPLE_PERSONAS` in `agents.ts`
2. The `FocusGroup` class automatically creates agents for each persona
3. Each new voter gets their own persistent agent

## Example Session

```
$ bun cli.ts "raising the minimum wage"

═══ CANDIDATE PRESENTS ═══
Candidate: I support raising the minimum wage to $15/hour over three years. 
This gives businesses time to adjust while ensuring workers can afford basic 
necessities. No one working full-time should live in poverty.

═══ VOTER REACTIONS ═══
Maria: That really resonates with me. As a nurse, I see patients who can't 
afford medications because they're working two jobs just to pay rent. $15 
feels like a starting point for dignity.

James: I'm torn. My employees deserve better pay, but I'm already struggling 
with costs. Three years might help, but I worry about the businesses that 
can't absorb it. What happens to them?

═══ FOLLOW-UP QUESTION ═══
Candidate: James, if there were tax credits or support for small businesses 
during the transition, would that change how you feel about it?

═══ FOLLOW-UP RESPONSES ═══
Maria: That actually makes me more confident. If we're supporting workers 
AND small businesses, that's the kind of balanced approach I can get behind.

James: Tax credits would help. I'm still skeptical, but at least you're 
thinking about people like me. Most politicians forget we exist.

═══ ANALYST INSIGHTS ═══
Analyst: Key finding: the "three year transition" message softened James's 
opposition. Maria is already supportive but responds to fairness framing. 
James opened up when small business concerns were acknowledged directly - 
quote: "at least you're thinking about people like me."

Recommendation: Lead with the transition timeline and pair minimum wage 
with small business support. This creates permission for moderate 
Republicans to consider the position.
```
