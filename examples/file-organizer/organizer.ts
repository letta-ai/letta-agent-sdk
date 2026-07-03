/**
 * File Organizer Agent
 * 
 * A persistent agent that helps organize files in directories.
 * Remembers your organizational preferences.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSession, resumeSession, type Session } from '../../src/index.js';
import { FileOrganizerState, DEFAULT_CONFIG } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'state.json');

// ANSI colors
const COLORS = {
  agent: '\x1b[33m',   // Yellow
  system: '\x1b[90m',  // Gray
  success: '\x1b[32m', // Green
  warn: '\x1b[33m',    // Yellow
  reset: '\x1b[0m',
};

const SYSTEM_PROMPT = `You are a file organizer. Your job is to help organize files in directories.

## Your Capabilities
- List and read files using Bash (ls, find) and Glob
- Move and rename files using Bash (mv)
- Create directories using Bash (mkdir)
- Read file contents to understand what they are

## Your Approach
1. **Scan the directory** - List all files and understand what's there
2. **Propose organization** - Suggest how to organize (by type, date, project, etc.)
3. **Get approval** - Always ask before making changes
4. **Execute carefully** - Move files, creating directories as needed
5. **Report results** - Show what was moved where

## Organization Strategies
- By file type (images/, documents/, code/, etc.)
- By date (2024/, 2025/, or by month)
- By project (project-a/, project-b/)
- By status (inbox/, processed/, archive/)

## Memory
You remember organizational preferences:
- How this user likes things organized
- Directory structures we've used before
- Naming conventions

## Safety
- Always preview changes before executing
- Never delete files (only move)
- Create backups of any renamed files
- Handle duplicates carefully`;

/**
 * Load state from disk
 */
export async function loadState(): Promise<FileOrganizerState> {
  if (existsSync(STATE_FILE)) {
    const data = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  }
  return {
    agentId: null,
    organizationCount: 0,
  };
}

/**
 * Save state to disk
 */
export async function saveState(state: FileOrganizerState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Get or create the file organizer agent
 */
export async function getOrCreateAgent(state: FileOrganizerState): Promise<Session> {
  if (state.agentId) {
    console.log(`${COLORS.system}Resuming file organizer agent...${COLORS.reset}`);
    return resumeSession(state.agentId, {
      model: DEFAULT_CONFIG.model,
      allowedTools: ['Bash', 'Read', 'Glob'],
      permissionMode: 'unrestricted',
    });
  }

  console.log(`${COLORS.system}Creating new file organizer agent...${COLORS.reset}`);
  const session = await createSession({
    model: DEFAULT_CONFIG.model,
    systemPrompt: SYSTEM_PROMPT,
    memory: [
      {
        label: 'organization-preferences',
        value: `# Organization Preferences

## Preferred Structure
(Will learn from user's choices)

## Naming Conventions
(Will learn from existing files)

## Past Organizations
(History of what we've organized)`,
        description: 'User preferences for file organization',
      },
    ],
    allowedTools: ['Bash', 'Read', 'Glob'],
    permissionMode: 'unrestricted',
  });

  return session;
}

/**
 * Stream output with color
 */
function createStreamPrinter(): (text: string) => void {
  return (text: string) => {
    process.stdout.write(`${COLORS.agent}${text}${COLORS.reset}`);
  };
}

/**
 * Send a message and get response
 */
export async function chat(
  session: Session,
  message: string,
  onOutput?: (text: string) => void
): Promise<string> {
  await session.send(message);
  
  let response = '';
  const printer = onOutput || createStreamPrinter();
  let lastToolName = '';
  
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
      printer(msg.content);
      lastToolName = '';
    } else if (msg.type === 'tool_call' && 'toolName' in msg) {
      if (msg.toolName !== lastToolName) {
        console.log(`\n${COLORS.system}[${msg.toolName}]${COLORS.reset}`);
        lastToolName = msg.toolName;
      }
    }
  }
  
  return response;
}

/**
 * Organize a directory
 */
export async function organizeDirectory(
  session: Session,
  state: FileOrganizerState,
  targetDir: string,
  strategy?: string,
  dryRun: boolean = false
): Promise<void> {
  console.log(`\n${COLORS.system}Analyzing directory: ${targetDir}...${COLORS.reset}\n`);
  
  let prompt = `Please help me organize the files in: ${targetDir}

Steps:
1. First, scan the directory and list what's there
2. Propose an organization strategy
3. Show me exactly what would be moved where`;

  if (strategy) {
    prompt += `\n\nPreferred strategy: ${strategy}`;
  }

  if (dryRun) {
    prompt += `\n\n⚠️ DRY RUN MODE: Only show what would be done, don't actually move anything.`;
  } else {
    prompt += `\n\nAfter showing the plan, ask me to confirm before moving anything.`;
  }

  await chat(session, prompt, createStreamPrinter());
  
  // Update count
  state.organizationCount++;
  await saveState(state);
  
  console.log(`\n\n${COLORS.success}Organization complete.${COLORS.reset}`);
  console.log(`${COLORS.system}Total organizations: ${state.organizationCount}${COLORS.reset}\n`);
}

/**
 * Interactive mode
 */
export async function interactiveMode(session: Session, state: FileOrganizerState): Promise<void> {
  const readline = await import('node:readline');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  const askQuestion = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer);
      });
    });
  };
  
  console.log(`${COLORS.system}Interactive mode. Ask me to organize directories.${COLORS.reset}\n`);
  
  while (true) {
    const input = await askQuestion(`${COLORS.agent}> ${COLORS.reset}`);
    
    if (input.toLowerCase() === 'quit' || input.toLowerCase() === 'exit') {
      break;
    }
    
    if (!input.trim()) continue;
    
    console.log('');
    await chat(session, input, createStreamPrinter());
    console.log('\n');
  }
  
  rl.close();
}

/**
 * Show status
 */
export async function showStatus(state: FileOrganizerState): Promise<void> {
  console.log('\n📁 File Organizer Status\n');
  console.log(`Agent: ${state.agentId || '(not created yet)'}`);
  if (state.agentId) {
    console.log(`  → https://app.letta.com/agents/${state.agentId}`);
  }
  console.log(`Organizations completed: ${state.organizationCount}`);
  console.log('');
}

/**
 * Reset state
 */
export async function reset(): Promise<void> {
  if (existsSync(STATE_FILE)) {
    const fs = await import('node:fs/promises');
    await fs.unlink(STATE_FILE);
  }
  console.log('\n🗑️  File organizer reset. Agent forgotten.\n');
}
