/**
 * Focus Group Session
 * 
 * Orchestrates the interaction between candidate, voters, and analyst.
 * 
 * Flow:
 * 1. Candidate presents a position
 * 2. Each voter responds
 * 3. Candidate asks a follow-up question
 * 4. Each voter responds to the follow-up
 * 5. Analyst provides summary and insights
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '../../src/index.js';
import {
  FocusGroupState,
  VoterPersona,
  FocusGroupRound,
} from './types.js';
import {
  createCandidateAgent,
  resumeCandidateAgent,
  createVoterAgent,
  resumeVoterAgent,
  createAnalystAgent,
  resumeAnalystAgent,
  SAMPLE_PERSONAS,
} from './agents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'state.json');

// ANSI colors for terminal output
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  candidate: '\x1b[36m',  // cyan
  voter1: '\x1b[33m',      // yellow
  voter2: '\x1b[35m',      // magenta
  analyst: '\x1b[32m',     // green
  header: '\x1b[1m',       // bold
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export async function loadState(): Promise<FocusGroupState> {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(await readFile(STATE_FILE, 'utf-8'));
  }
  return {
    candidateAgentId: null,
    voterAgentIds: {},
    analystAgentId: null,
    sessionCount: 0,
  };
}

export async function saveState(state: FocusGroupState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// AGENT COMMUNICATION
// ============================================================================

/**
 * Send a message to an agent and collect the full response
 */
async function chat(session: Session, message: string): Promise<string> {
  await session.send(message);
  
  let response = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
    }
  }
  return response.trim();
}

/**
 * Send a message and stream the response to console
 */
async function chatWithOutput(
  session: Session, 
  message: string,
  color: string,
  label: string
): Promise<string> {
  process.stdout.write(`\n${C.header}${label}:${C.reset} `);
  
  await session.send(message);
  
  let response = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
      process.stdout.write(`${color}${msg.content}${C.reset}`);
    }
  }
  console.log(); // newline
  return response.trim();
}

// ============================================================================
// FOCUS GROUP SESSION
// ============================================================================

export class FocusGroup {
  private state: FocusGroupState;
  private candidate: Session | null = null;
  private voters: Map<string, Session> = new Map();
  private analyst: Session | null = null;
  private personas: VoterPersona[];

  constructor(state: FocusGroupState, personas: VoterPersona[] = SAMPLE_PERSONAS) {
    this.state = state;
    this.personas = personas;
  }

  /**
   * Initialize all agents (create new or resume existing)
   */
  async initialize(): Promise<void> {
    console.log(`${C.dim}Initializing focus group...${C.reset}\n`);

    // Candidate
    if (this.state.candidateAgentId) {
      console.log(`${C.dim}Resuming candidate agent...${C.reset}`);
      this.candidate = await resumeCandidateAgent(this.state.candidateAgentId);
    } else {
      console.log(`${C.dim}Creating candidate agent...${C.reset}`);
      this.candidate = await createCandidateAgent();
    }

    // Voters
    for (const persona of this.personas) {
      const existingId = this.state.voterAgentIds[persona.name];
      if (existingId) {
        console.log(`${C.dim}Resuming voter: ${persona.name}...${C.reset}`);
        this.voters.set(persona.name, await resumeVoterAgent(existingId));
      } else {
        console.log(`${C.dim}Creating voter: ${persona.name}...${C.reset}`);
        this.voters.set(persona.name, await createVoterAgent(persona));
      }
    }

    // Analyst
    if (this.state.analystAgentId) {
      console.log(`${C.dim}Resuming analyst agent...${C.reset}`);
      this.analyst = await resumeAnalystAgent(this.state.analystAgentId);
    } else {
      console.log(`${C.dim}Creating analyst agent...${C.reset}`);
      this.analyst = await createAnalystAgent();
    }

    console.log(`${C.dim}All agents ready.${C.reset}\n`);
  }

  /**
   * Run a focus group round on a topic
   */
  async runRound(topic: string): Promise<FocusGroupRound> {
    const round: FocusGroupRound = {
      position: '',
      voterResponses: [],
    };

    // Step 1: Candidate presents position
    console.log(`${C.header}═══ CANDIDATE PRESENTS ═══${C.reset}`);
    round.position = await chatWithOutput(
      this.candidate!,
      `Present your position on: ${topic}\n\nBe specific about what you would do. Keep it to 2-3 sentences.`,
      C.candidate,
      'Candidate'
    );

    // Step 2: Voters respond
    console.log(`\n${C.header}═══ VOTER REACTIONS ═══${C.reset}`);
    const voterColors = [C.voter1, C.voter2];
    let i = 0;
    for (const [name, voter] of this.voters) {
      const reaction = await chatWithOutput(
        voter,
        `A political candidate just said:\n\n"${round.position}"\n\nHow does this make you feel? React as yourself.`,
        voterColors[i % voterColors.length],
        name
      );
      round.voterResponses.push({ voterName: name, reaction });
      i++;
    }

    // Step 3: Candidate asks follow-up
    console.log(`\n${C.header}═══ FOLLOW-UP QUESTION ═══${C.reset}`);
    const voterSummary = round.voterResponses
      .map(r => `${r.voterName}: "${r.reaction}"`)
      .join('\n\n');
    
    round.followUpQuestion = await chatWithOutput(
      this.candidate!,
      `Here's how the voters reacted to your position:\n\n${voterSummary}\n\nAsk ONE follow-up question to dig deeper into their concerns.`,
      C.candidate,
      'Candidate'
    );

    // Step 4: Voters respond to follow-up
    console.log(`\n${C.header}═══ FOLLOW-UP RESPONSES ═══${C.reset}`);
    round.followUpResponses = [];
    i = 0;
    for (const [name, voter] of this.voters) {
      const reaction = await chatWithOutput(
        voter,
        `The candidate asks: "${round.followUpQuestion}"\n\nAnswer honestly based on your perspective.`,
        voterColors[i % voterColors.length],
        name
      );
      round.followUpResponses.push({ voterName: name, reaction });
      i++;
    }

    // Step 5: Analyst provides insights
    console.log(`\n${C.header}═══ ANALYST INSIGHTS ═══${C.reset}`);
    const fullTranscript = `
TOPIC: ${topic}

CANDIDATE'S POSITION:
"${round.position}"

INITIAL REACTIONS:
${round.voterResponses.map(r => `${r.voterName}: "${r.reaction}"`).join('\n')}

FOLLOW-UP QUESTION:
"${round.followUpQuestion}"

FOLLOW-UP RESPONSES:
${round.followUpResponses.map(r => `${r.voterName}: "${r.reaction}"`).join('\n')}
`;

    round.analysis = await chatWithOutput(
      this.analyst!,
      `Analyze this focus group exchange:\n${fullTranscript}\n\nProvide insights on what worked, what didn't, and recommendations.`,
      C.analyst,
      'Analyst'
    );

    // Save agent IDs after first interaction
    await this.saveAgentIds();
    
    return round;
  }

  /**
   * Save agent IDs to state
   */
  private async saveAgentIds(): Promise<void> {
    let needsSave = false;

    if (!this.state.candidateAgentId && this.candidate?.agentId) {
      this.state.candidateAgentId = this.candidate.agentId;
      needsSave = true;
    }

    for (const [name, voter] of this.voters) {
      if (!this.state.voterAgentIds[name] && voter.agentId) {
        this.state.voterAgentIds[name] = voter.agentId;
        needsSave = true;
      }
    }

    if (!this.state.analystAgentId && this.analyst?.agentId) {
      this.state.analystAgentId = this.analyst.agentId;
      needsSave = true;
    }

    if (needsSave) {
      this.state.sessionCount++;
      await saveState(this.state);
      console.log(`\n${C.dim}[Agents saved - session #${this.state.sessionCount}]${C.reset}`);
    }
  }

  /**
   * Close all sessions
   */
  close(): void {
    this.candidate?.close();
    for (const voter of this.voters.values()) {
      voter.close();
    }
    this.analyst?.close();
  }
}

/**
 * Reset focus group state
 */
export async function resetFocusGroup(): Promise<void> {
  if (existsSync(STATE_FILE)) {
    const { unlink } = await import('node:fs/promises');
    await unlink(STATE_FILE);
  }
  console.log('Focus group reset. All agents forgotten.');
}

/**
 * Show current status
 */
export async function showStatus(): Promise<void> {
  const state = await loadState();
  console.log('\n📊 Focus Group Status\n');
  console.log(`Sessions: ${state.sessionCount}`);
  console.log(`Candidate: ${state.candidateAgentId || '(not created)'}`);
  console.log(`Analyst: ${state.analystAgentId || '(not created)'}`);
  console.log(`Voters:`);
  for (const [name, id] of Object.entries(state.voterAgentIds)) {
    console.log(`  - ${name}: ${id}`);
  }
  if (Object.keys(state.voterAgentIds).length === 0) {
    console.log('  (none created)');
  }
  console.log();
}
