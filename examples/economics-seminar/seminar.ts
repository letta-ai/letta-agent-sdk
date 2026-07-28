/**
 * Seminar Orchestration
 * 
 * Runs the full economics seminar flow.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LettaCodeSession } from '../../src/index.js';
import type { 
  SeminarConfig, 
  SeminarState, 
  FacultyMember, 
  FacultyRole,
  TranscriptEntry 
} from './types.js';
import { FACULTY, DEFAULT_CONFIG } from './types.js';
import { createPresenter, pickTopicAndResearch, respondToQuestion } from './presenter.js';
import { createFacultyMember, askQuestion, reflectOnSeminar } from './faculty.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'seminar-state.json');
const TRANSCRIPTS_DIR = join(__dirname, 'transcripts');

// ANSI colors for live transcript
const COLORS = {
  presenter: '\x1b[36m',  // Cyan
  macro: '\x1b[33m',      // Yellow
  micro: '\x1b[32m',      // Green
  behavioral: '\x1b[35m', // Magenta
  historian: '\x1b[34m',  // Blue
  system: '\x1b[90m',     // Gray
  reset: '\x1b[0m',
};

/**
 * Load seminar state from disk
 */
export async function loadState(): Promise<SeminarState> {
  if (existsSync(STATE_FILE)) {
    const content = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(content);
  }
  
  return {
    presenterId: null,
    facultyIds: {
      macro: null,
      micro: null,
      behavioral: null,
      historian: null,
    },
    seminarsCompleted: 0,
  };
}

/**
 * Save seminar state to disk
 */
export async function saveState(state: SeminarState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Clean up content formatting - fix run-together sentences and separators
 */
function formatContent(content: string): string {
  return content
    // Fix sentences stuck together (period+Capital with no space, but not abbreviations like Dr. or U.S.)
    .replace(/\.([A-Z][a-z]{2,})/g, '.\n\n$1')
    // Fix --- stuck to text
    .replace(/([^\n])---/g, '$1\n\n---')
    // Normalize multiple newlines
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Save transcript to markdown file
 */
async function saveTranscript(
  transcript: TranscriptEntry[], 
  topic: string,
  seminarNumber: number
): Promise<string> {
  // Ensure transcripts directory exists
  if (!existsSync(TRANSCRIPTS_DIR)) {
    await mkdir(TRANSCRIPTS_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `seminar-${seminarNumber}-${timestamp}.md`;
  const filepath = join(TRANSCRIPTS_DIR, filename);
  
  // Format transcript as markdown
  const lines: string[] = [
    `# Economics Seminar #${seminarNumber}`,
    '',
    `**Topic**: ${topic}`,
    `**Date**: ${new Date().toLocaleString()}`,
    '',
    '---',
    '',
  ];
  
  for (const entry of transcript) {
    lines.push(`## ${entry.speaker}`);
    lines.push('');
    lines.push(formatContent(entry.content));
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  
  await writeFile(filepath, lines.join('\n'));
  return filepath;
}

/**
 * Print to transcript with speaker formatting
 */
function printTranscript(
  speaker: string, 
  role: 'presenter' | FacultyRole | 'system',
  content: string
) {
  const color = COLORS[role] || COLORS.system;
  const prefix = role === 'system' ? `[${speaker}]` : `**${speaker}**:`;
  console.log(`\n${color}${prefix}${COLORS.reset}`);
  console.log(content);
}

/**
 * Stream output with color
 */
function createStreamPrinter(role: 'presenter' | FacultyRole) {
  const color = COLORS[role] || COLORS.reset;
  let started = false;
  
  return (text: string) => {
    if (!started) {
      process.stdout.write(color);
      started = true;
    }
    process.stdout.write(text);
  };
}

/**
 * Run a full economics seminar
 */
export async function runSeminar(config: SeminarConfig = DEFAULT_CONFIG, userTopic?: string): Promise<void> {
  const state = await loadState();
  const transcript: TranscriptEntry[] = [];
  
  console.log('\n' + '═'.repeat(70));
  console.log('🎓 ECONOMICS SEMINAR');
  console.log('═'.repeat(70));
  console.log(`\nSeminar #${state.seminarsCompleted + 1}`);
  console.log(`Faculty panel: ${config.facultyCount} members`);
  console.log(`Q&A rounds: up to ${config.maxRoundsPerFaculty} per faculty member`);
  console.log('\n' + '─'.repeat(70));

  // Select faculty for this seminar
  const selectedFaculty = FACULTY.slice(0, config.facultyCount);
  
  // Initialize presenter
  console.log('\n📚 Initializing presenter...');
  const presenter = await createPresenter(state.presenterId, config);
  
  // Get presenter ID after first message
  let presenterId = state.presenterId;
  
  // Initialize faculty
  console.log('👥 Initializing faculty panel...');
  const facultySessions: Map<FacultyRole, LettaCodeSession> = new Map();
  
  for (const faculty of selectedFaculty) {
    const session = await createFacultyMember(
      faculty, 
      state.facultyIds[faculty.role], 
      config
    );
    facultySessions.set(faculty.role, session);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('📖 RESEARCH & PRESENTATION');
  console.log('═'.repeat(70));
  
  // Phase 1: Presenter picks topic and researches
  console.log(`\n${COLORS.presenter}**Presenter** is preparing...${COLORS.reset}\n`);
  
  const { topic, presentation } = await pickTopicAndResearch(
    presenter,
    createStreamPrinter('presenter'),
    userTopic
  );
  
  console.log(COLORS.reset); // Reset color
  
  // Save presenter ID now that we have it
  if (!presenterId && presenter.agentId) {
    presenterId = presenter.agentId;
    state.presenterId = presenterId;
    await saveState(state);
    console.log(`\n${COLORS.system}[Presenter agent: ${presenterId}]${COLORS.reset}`);
    console.log(`${COLORS.system}[→ https://app.letta.com/agents/${presenterId}]${COLORS.reset}`);
  }
  
  transcript.push({
    speaker: 'Presenter',
    role: 'presenter',
    content: presentation,
    timestamp: new Date(),
  });

  // Phase 2: Q&A
  console.log('\n' + '═'.repeat(70));
  console.log('❓ Q&A SESSION');
  console.log('═'.repeat(70));
  
  let presentationSummary = presentation;
  let allExchanges = '';
  
  for (const faculty of selectedFaculty) {
    const session = facultySessions.get(faculty.role)!;
    const isNewFaculty = !state.facultyIds[faculty.role];
    
    console.log(`\n${COLORS.system}─── ${faculty.name} (${faculty.title}) ───${COLORS.reset}\n`);
    
    // Initial question
    console.log(`${COLORS[faculty.role]}**${faculty.name}**:${COLORS.reset}`);
    const question = await askQuestion(
      session,
      faculty,
      presentationSummary,
      allExchanges,
      false,
      createStreamPrinter(faculty.role)
    );
    console.log(COLORS.reset);
    
    // Save faculty ID now that we have it (after first message)
    if (isNewFaculty && session.agentId) {
      state.facultyIds[faculty.role] = session.agentId;
      await saveState(state);
    }
    console.log(`${COLORS.system}[→ https://app.letta.com/agents/${session.agentId}]${COLORS.reset}`);
    
    transcript.push({
      speaker: faculty.name,
      role: 'faculty',
      content: question,
      timestamp: new Date(),
    });
    
    // Presenter response
    console.log(`\n${COLORS.presenter}**Presenter**:${COLORS.reset}`);
    const response = await respondToQuestion(
      presenter,
      faculty.name,
      faculty.title,
      question,
      createStreamPrinter('presenter')
    );
    console.log(COLORS.reset);
    
    transcript.push({
      speaker: 'Presenter',
      role: 'presenter',
      content: response,
      timestamp: new Date(),
    });
    
    allExchanges += `\n${faculty.name}: ${question}\nPresenter: ${response}\n`;
    
    // Follow-up rounds
    for (let round = 1; round < config.maxRoundsPerFaculty; round++) {
      console.log(`\n${COLORS[faculty.role]}**${faculty.name}** (follow-up):${COLORS.reset}`);
      const followUp = await askQuestion(
        session,
        faculty,
        presentationSummary,
        allExchanges,
        true,
        createStreamPrinter(faculty.role)
      );
      console.log(COLORS.reset);
      
      transcript.push({
        speaker: faculty.name,
        role: 'faculty',
        content: followUp,
        timestamp: new Date(),
      });
      
      console.log(`\n${COLORS.presenter}**Presenter**:${COLORS.reset}`);
      const followUpResponse = await respondToQuestion(
        presenter,
        faculty.name,
        faculty.title,
        followUp,
        createStreamPrinter('presenter')
      );
      console.log(COLORS.reset);
      
      transcript.push({
        speaker: 'Presenter',
        role: 'presenter',
        content: followUpResponse,
        timestamp: new Date(),
      });
      
      allExchanges += `\n${faculty.name}: ${followUp}\nPresenter: ${followUpResponse}\n`;
    }
  }

  // Phase 3: Faculty reflections
  console.log('\n' + '═'.repeat(70));
  console.log('💭 FACULTY REFLECTIONS');
  console.log('═'.repeat(70));
  
  const fullTranscript = transcript.map(t => `${t.speaker}: ${t.content}`).join('\n\n');
  
  for (const faculty of selectedFaculty) {
    const session = facultySessions.get(faculty.role)!;
    
    console.log(`\n${COLORS[faculty.role]}**${faculty.name}**:${COLORS.reset}`);
    await reflectOnSeminar(
      session,
      faculty,
      fullTranscript,
      createStreamPrinter(faculty.role)
    );
    console.log(COLORS.reset);
    
    session.close();
  }
  
  presenter.close();

  // Update state
  state.seminarsCompleted++;
  await saveState(state);

  // Save transcript to file
  const transcriptPath = await saveTranscript(transcript, topic, state.seminarsCompleted);

  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('✅ SEMINAR COMPLETE');
  console.log('═'.repeat(70));
  console.log(`\nSeminars completed: ${state.seminarsCompleted}`);
  console.log(`Topic: ${topic}`);
  console.log(`\n📄 Transcript saved: ${transcriptPath}`);
  console.log('\nAgent IDs (persistent across seminars):');
  console.log(`  Presenter: ${state.presenterId}`);
  for (const faculty of selectedFaculty) {
    console.log(`  ${faculty.name}: ${state.facultyIds[faculty.role]}`);
  }
  console.log('\n💡 Run another seminar to see agents apply what they learned!');
  console.log('');
}

/**
 * Get seminar status
 */
export async function getStatus(): Promise<void> {
  const state = await loadState();
  
  console.log('\n📊 Economics Seminar Status\n');
  console.log(`Seminars completed: ${state.seminarsCompleted}`);
  console.log(`\nPresenter: ${state.presenterId || '(not created yet)'}`);
  if (state.presenterId) {
    console.log(`  → https://app.letta.com/agents/${state.presenterId}`);
  }
  
  console.log('\nFaculty:');
  for (const faculty of FACULTY) {
    const id = state.facultyIds[faculty.role];
    console.log(`  ${faculty.name} (${faculty.role}): ${id || '(not created yet)'}`);
    if (id) {
      console.log(`    → https://app.letta.com/agents/${id}`);
    }
  }
  console.log('');
}

/**
 * Reset seminar state
 */
export async function resetSeminar(): Promise<void> {
  await saveState({
    presenterId: null,
    facultyIds: {
      macro: null,
      micro: null,
      behavioral: null,
      historian: null,
    },
    seminarsCompleted: 0,
  });
  console.log('✅ Seminar state reset. Fresh agents will be created on next run.');
}
