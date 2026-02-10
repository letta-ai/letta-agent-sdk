/**
 * Focus Group Agents
 * 
 * Creates and manages the three types of agents:
 * 1. Candidate - presents positions, asks follow-ups
 * 2. Voters - respond based on their persona
 * 3. Analyst - provides focus group analysis
 */

import { createSession, resumeSession, type Session } from '../../src/index.js';
import { VoterPersona, CONFIG } from './types.js';

// ============================================================================
// CANDIDATE AGENT
// ============================================================================

const CANDIDATE_PROMPT = `You are a political candidate presenting your positions to a focus group.

Your role:
- Present clear, specific policy positions when asked
- Listen to voter feedback and ask thoughtful follow-up questions
- Stay focused on understanding voter concerns
- Be authentic but strategic

When presenting a position:
- Be specific about what you would do
- Explain the reasoning briefly
- Keep it to 2-3 sentences

When asking follow-ups:
- Probe deeper into concerns raised
- Ask about trade-offs they'd accept
- Keep questions focused and open-ended`;

export async function createCandidateAgent(): Promise<Session> {
  return createSession({
    model: CONFIG.model,
    systemPrompt: CANDIDATE_PROMPT,
    memory: [
      {
        label: 'positions',
        value: '# My Positions\n\n(Positions I\'ve presented)',
        description: 'Policy positions I have presented to focus groups',
      },
      {
        label: 'voter-insights',
        value: '# Voter Insights\n\n(What I\'ve learned about voter concerns)',
        description: 'Insights gathered from voter feedback',
      },
    ],
    permissionMode: 'bypassPermissions',
  });
}

export async function resumeCandidateAgent(agentId: string): Promise<Session> {
  return resumeSession(agentId, {
    model: CONFIG.model,
    permissionMode: 'bypassPermissions',
  });
}

// ============================================================================
// VOTER AGENT
// ============================================================================

function buildVoterPrompt(persona: VoterPersona): string {
  const partyDesc = persona.leaningStrength === 'strong' 
    ? `strongly identifies as ${persona.party}`
    : persona.leaningStrength === 'moderate'
    ? `leans ${persona.party}`
    : `weakly identifies as ${persona.party}`;

  return `You are ${persona.name}, a ${persona.age}-year-old voter from ${persona.location}.

YOUR IDENTITY:
- You ${partyDesc}
- Your top issues: ${persona.topIssues.join(', ')}
- Background: ${persona.background}

YOUR ROLE IN THIS FOCUS GROUP:
- React authentically to political positions based on your persona
- Share how positions make you FEEL, not just what you think
- Be specific about what resonates or concerns you
- You can be persuaded but stay true to your core values

RESPONSE STYLE:
- Speak naturally, as yourself (first person)
- Keep responses to 2-4 sentences
- Show emotional reactions when appropriate
- Reference your personal situation when relevant`;
}

export async function createVoterAgent(persona: VoterPersona): Promise<Session> {
  return createSession({
    model: CONFIG.model,
    systemPrompt: buildVoterPrompt(persona),
    memory: [
      {
        label: 'my-identity',
        value: `# Who I Am

Name: ${persona.name}
Age: ${persona.age}
Location: ${persona.location}
Party: ${persona.party} (${persona.leaningStrength})
Top Issues: ${persona.topIssues.join(', ')}
Background: ${persona.background}`,
        description: 'My demographic information and political identity',
      },
      {
        label: 'my-reactions',
        value: '# My Reactions\n\n(How I\'ve felt about positions presented)',
        description: 'My emotional reactions to political positions',
      },
    ],
    permissionMode: 'bypassPermissions',
  });
}

export async function resumeVoterAgent(agentId: string): Promise<Session> {
  return resumeSession(agentId, {
    model: CONFIG.model,
    permissionMode: 'bypassPermissions',
  });
}

// ============================================================================
// ANALYST AGENT
// ============================================================================

const ANALYST_PROMPT = `You are a focus group analyst observing voter reactions to political messaging.

Your role:
- Observe voter responses and identify patterns
- Note which messages resonate and which fall flat
- Identify persuadable voters and potential wedge issues
- Provide actionable insights for the candidate

Analysis style:
- Be specific and cite voter quotes
- Identify emotional triggers
- Note differences between voter segments
- Keep analysis concise but substantive (4-6 sentences)
- End with 1-2 tactical recommendations`;

export async function createAnalystAgent(): Promise<Session> {
  return createSession({
    model: CONFIG.model,
    systemPrompt: ANALYST_PROMPT,
    memory: [
      {
        label: 'session-notes',
        value: '# Focus Group Notes\n\n(Observations from sessions)',
        description: 'Running notes on voter reactions and patterns',
      },
      {
        label: 'recommendations',
        value: '# Strategic Recommendations\n\n(Messaging recommendations)',
        description: 'Tactical recommendations based on focus group insights',
      },
    ],
    permissionMode: 'bypassPermissions',
  });
}

export async function resumeAnalystAgent(agentId: string): Promise<Session> {
  return resumeSession(agentId, {
    model: CONFIG.model,
    permissionMode: 'bypassPermissions',
  });
}

// ============================================================================
// SAMPLE PERSONAS
// ============================================================================

export const SAMPLE_PERSONAS: VoterPersona[] = [
  {
    name: 'Maria',
    age: 34,
    location: 'Phoenix, AZ',
    party: 'Independent',
    leaningStrength: 'weak',
    topIssues: ['healthcare costs', 'education', 'immigration'],
    background: 'Nurse and mother of two. Worried about affording childcare and her kids\' future.',
  },
  {
    name: 'James',
    age: 58,
    location: 'Rural Ohio',
    party: 'Republican',
    leaningStrength: 'moderate',
    topIssues: ['economy', 'manufacturing jobs', 'government spending'],
    background: 'Former auto worker, now runs a small business. Skeptical of both parties.',
  },
];
