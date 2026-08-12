/**
 * Focus Group Agents
 * 
 * Creates and manages the three types of agents:
 * 1. Candidate - presents positions, asks follow-ups
 * 2. Voters - respond based on their persona
 * 3. Analyst - provides focus group analysis
 */

import { type LettaCodeSession } from '../../src/index.js';
import { createAgentSession, createExampleClient, resumeExampleSession } from '../create-agent-session.js';
import { CONFIG, type VoterPersona } from './types.js';

// File-editing demo: pin the local backend so agent state stays consistent.
const client = createExampleClient({ backend: 'local' });

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
- Keep questions focused and open-ended

Keep durable messaging lessons in reference/candidate-lessons.md.`;

export async function createCandidateAgent(): Promise<LettaCodeSession> {
  return createAgentSession({
    model: CONFIG.model,
    systemPrompt: CANDIDATE_PROMPT,
    permissionMode: 'unrestricted',
  }, client);
}

export async function resumeCandidateAgent(agentId: string): Promise<LettaCodeSession> {
  return resumeExampleSession(agentId, {
    model: CONFIG.model,
    permissionMode: 'unrestricted',
  }, client);
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
- Reference your personal situation when relevant

Keep durable changes to your preferences in reference/voter-profile.md.`;
}

export async function createVoterAgent(persona: VoterPersona): Promise<LettaCodeSession> {
  return createAgentSession({
    model: CONFIG.model,
    systemPrompt: buildVoterPrompt(persona),
    permissionMode: 'unrestricted',
  }, client);
}

export async function resumeVoterAgent(agentId: string): Promise<LettaCodeSession> {
  return resumeExampleSession(agentId, {
    model: CONFIG.model,
    permissionMode: 'unrestricted',
  }, client);
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
- End with 1-2 tactical recommendations

Keep durable response patterns in reference/focus-group-patterns.md.`;

export async function createAnalystAgent(): Promise<LettaCodeSession> {
  return createAgentSession({
    model: CONFIG.model,
    systemPrompt: ANALYST_PROMPT,
    permissionMode: 'unrestricted',
  }, client);
}

export async function resumeAnalystAgent(agentId: string): Promise<LettaCodeSession> {
  return resumeExampleSession(agentId, {
    model: CONFIG.model,
    permissionMode: 'unrestricted',
  }, client);
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
