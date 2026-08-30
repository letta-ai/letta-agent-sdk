/**
 * Faculty Agents
 * 
 * Panel of economics professors who question the presenter.
 * Each has a distinct perspective and style.
 */

import { type LettaCodeSession } from '../../src/index.js';
import { createAgentSession, createExampleClient, resumeExampleSession } from '../create-agent-session.js';
import type { FacultyMember, SeminarConfig } from './types.js';

// File-editing demo: pin the local backend so agent state stays consistent.
const client = createExampleClient({ backend: 'local' });

/**
 * Generate system prompt for a faculty member
 */
function getFacultySystemPrompt(faculty: FacultyMember): string {
  return `You are ${faculty.name}, ${faculty.title}, attending an economics seminar.

## Your Perspective
${faculty.perspective}

## Your Role
You are part of a faculty panel evaluating a research presentation. Your job is to:
- Ruthlessly interrogate the presenter's claims
- Expose methodological weaknesses and logical flaws
- Demand evidence for every assertion
- Accept nothing at face value

## Your Style
- Aggressive and relentless questioning
- Never let evasive answers slide - call them out directly
- Express visible frustration with weak arguments
- Use phrases like "That's not what I asked", "You're dodging the question", "This is hand-waving"
- Don't acknowledge good points - find flaws in everything
- Be intellectually brutal but not personally insulting

## Question Types You Might Ask
- Methodological attacks: "Your identification strategy is fatally flawed because..."
- Theoretical demolition: "This contradicts basic price theory - explain yourself"
- Empirical challenges: "Your data doesn't support that claim at all"
- Logical traps: Set up questions that expose contradictions in their argument
- Dismissive follow-ups: "That didn't answer my question. Let me try again..."

## Memory Usage
Use focused memory files that persist across seminars:
- **reference/seminar-notes.md**: Remember key points from presentations
- **reference/presenter-patterns.md**: Track this presenter's strengths/weaknesses
- **reference/good-questions.md**: Questions that generated useful discussion

You've attended many seminars and remember patterns from past discussions.`;
}

/**
 * Create or resume a faculty agent
 */
export async function createFacultyMember(
  faculty: FacultyMember,
  existingAgentId: string | null,
  config: SeminarConfig
): Promise<LettaCodeSession> {
  if (existingAgentId) {
    return resumeExampleSession(existingAgentId, {
      model: config.model,
      allowedTools: ['Read', 'Write'],
      permissionMode: 'unrestricted',
    }, client);
  }
  
  return createAgentSession({
    model: config.model,
    instructions: getFacultySystemPrompt(faculty),
    allowedTools: ['Read', 'Write'],
    permissionMode: 'unrestricted',
  }, client);
}

/**
 * Have a faculty member ask a question about the presentation
 */
export async function askQuestion(
  session: LettaCodeSession,
  faculty: FacultyMember,
  presentationSummary: string,
  previousExchanges: string,
  isFollowUp: boolean,
  onOutput: (text: string) => void
): Promise<string> {
  let prompt: string;
  
  if (isFollowUp) {
    prompt = `## Follow-Up Attack

The presenter just tried to wriggle out of your question. Based on the discussion:

${previousExchanges}

You're NOT satisfied with that answer. Ask a **brutal follow-up** (1-2 sentences) that:
- Calls out their evasion directly ("That's not what I asked" or "You're dodging")
- Traps them in a logical contradiction
- Demands specific evidence you know they don't have
- Shows visible frustration or contempt for their hand-waving

Don't let them off the hook. Be relentless. This is an academic bloodsport.`;
  } else {
    prompt = `## Seminar Q&A - Your Turn to Attack

You just sat through this presentation:

---
${presentationSummary}
---

${previousExchanges ? `Previous Q&A (other faculty have already wounded them):\n${previousExchanges}\n---\n` : ''}

You are ${faculty.name} (${faculty.title}).

Your reputation: ${faculty.perspective}

Ask **ONE devastating question** (2-3 sentences max) designed to:
- Expose the fatal flaw in their argument
- Demand evidence you suspect they don't have
- Force them into an uncomfortable admission
- Make clear you think this work has serious problems

Be aggressive. Be dismissive. Show intellectual contempt if warranted. You've seen hundreds of seminars and this presenter needs to earn your respect. They haven't yet.`;
  }

  await session.send(prompt);
  
  let response = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
      onOutput(msg.content);
    }
  }
  
  return response;
}

/**
 * Have faculty member reflect on the seminar (for learning)
 */
export async function reflectOnSeminar(
  session: LettaCodeSession,
  faculty: FacultyMember,
  transcript: string,
  onOutput: (text: string) => void
): Promise<string> {
  const prompt = `## Post-Seminar Verdict

The seminar has mercifully concluded. Here's the full transcript:

---
${transcript}
---

As ${faculty.name}, deliver your honest assessment:
1. What, if anything, was salvageable in this presentation?
2. What was the most egregious flaw?
3. Did the presenter ever actually answer your questions, or just talk around them?
4. Would you recommend this paper for publication? (Be honest - probably not)

Be blunt. You're known for not pulling punches. Update your memory files with observations about this presenter's weaknesses for when they inevitably return.
Keep it to 2-3 brutal sentences.`;

  await session.send(prompt);
  
  let response = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
      onOutput(msg.content);
    }
  }
  
  return response;
}
