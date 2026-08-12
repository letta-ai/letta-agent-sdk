/**
 * Bug Fixer Agent
 * 
 * A persistent agent that finds and fixes bugs in code.
 * Remembers the codebase and past fixes across sessions.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type LettaCodeSession } from '../../src/index.js';
import { createAgentSession, createExampleClient, formatAgentLink, resumeExampleSession } from '../create-agent-session.js';
import { DEFAULT_CONFIG, type BugFixerState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'state.json');
const client = createExampleClient({ backend: 'local' });

// ANSI colors
const COLORS = {
  agent: '\x1b[36m',   // Cyan
  system: '\x1b[90m',  // Gray
  success: '\x1b[32m', // Green
  error: '\x1b[31m',   // Red
  reset: '\x1b[0m',
};

const SYSTEM_PROMPT = `You are a bug-fixing agent. Your job is to find and fix bugs in code.

## Your Capabilities
You have access to tools for exploring and modifying code:
- Read files to understand the codebase
- Search for patterns with Grep
- Find files with Glob
- Edit files to fix bugs
- Run commands with Bash (tests, linters, etc.)

## Your Approach
1. **Understand the bug** - Read the error message or failing test carefully
2. **Explore the codebase** - Find relevant files and understand the context
3. **Identify the root cause** - Don't just fix symptoms, find the actual issue
4. **Make minimal changes** - Fix the bug without unnecessary refactoring
5. **Verify the fix** - Run tests or the command that was failing

## Memory Files
Keep durable notes in reference/codebase-knowledge.md and
reference/fix-history.md. Use them to:
- Recall where things are in the codebase
- Remember patterns that caused bugs before
- Avoid repeating failed approaches

## Style
- Be concise but thorough
- Explain what you're doing and why
- If you're unsure, say so and explain your reasoning`;

/**
 * Load state from disk
 */
export async function loadState(): Promise<BugFixerState> {
  if (existsSync(STATE_FILE)) {
    const data = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  }
  return {
    agentId: null,
    fixCount: 0,
  };
}

/**
 * Save state to disk
 */
export async function saveState(state: BugFixerState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Get or create the bug fixer agent
 */
export async function getOrCreateAgent(state: BugFixerState): Promise<LettaCodeSession> {
  if (state.agentId) {
    console.log(`${COLORS.system}Resuming bug fixer agent...${COLORS.reset}`);
    return resumeExampleSession(state.agentId, {
      model: DEFAULT_CONFIG.model,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      permissionMode: 'unrestricted',
    }, client);
  }

  console.log(`${COLORS.system}Creating new bug fixer agent...${COLORS.reset}`);
  const session = await createAgentSession({
    model: DEFAULT_CONFIG.model,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    permissionMode: 'unrestricted',
  }, client);

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
  session: LettaCodeSession,
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
      lastToolName = ''; // Reset after assistant output
    } else if (msg.type === 'tool_call' && 'toolName' in msg) {
      // Only show tool name if different from last (reduces spam)
      if (msg.toolName !== lastToolName) {
        console.log(`\n${COLORS.system}[${msg.toolName}]${COLORS.reset}`);
        lastToolName = msg.toolName;
      }
    } else if (msg.type === 'tool_result') {
      // Don't print anything for tool results - cleaner output
    }
  }
  
  return response;
}

/**
 * Fix a bug
 */
export async function fixBug(
  session: LettaCodeSession,
  state: BugFixerState,
  description: string
): Promise<void> {
  console.log(`\n${COLORS.system}Starting bug fix...${COLORS.reset}\n`);
  
  const prompt = `Please fix this bug:

${description}

Steps:
1. First, explore the codebase to understand the context
2. Find the root cause of the bug
3. Make the minimal fix needed
4. Run any relevant tests to verify

Go ahead and fix it.`;

  await chat(session, prompt, createStreamPrinter());
  
  // Update fix count
  state.fixCount++;
  await saveState(state);
  
  console.log(`\n\n${COLORS.success}Bug fix attempt complete.${COLORS.reset}`);
  console.log(`${COLORS.system}Total fixes attempted: ${state.fixCount}${COLORS.reset}\n`);
}

/**
 * Interactive mode - keep fixing bugs
 */
export async function interactiveMode(session: LettaCodeSession, state: BugFixerState): Promise<void> {
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
  
  console.log(`${COLORS.system}Interactive mode. Describe bugs to fix, or type 'quit' to exit.${COLORS.reset}\n`);
  
  while (true) {
    const input = await askQuestion(`${COLORS.agent}Describe the bug > ${COLORS.reset}`);
    
    if (input.toLowerCase() === 'quit' || input.toLowerCase() === 'exit') {
      break;
    }
    
    if (!input.trim()) continue;
    
    await fixBug(session, state, input);
  }
  
  rl.close();
}

/**
 * Show status
 */
export async function showStatus(state: BugFixerState): Promise<void> {
  console.log('\n🐛 Bug Fixer Status\n');
  console.log(`Agent: ${state.agentId || '(not created yet)'}`);
  if (state.agentId) {
    console.log(`  → ${formatAgentLink(state.agentId, client)}`);
  }
  console.log(`Fixes attempted: ${state.fixCount}`);
  console.log('');
}

/**
 * Say hello
 */
export function sayHello(): void {
  console.log('Hello');
}

/**
 * List files in src/ directory
 */
export async function listFilesInSrc(): Promise<void> {
  const srcPath = '../../src';
  const fs = await import('node:fs/promises');
  
  try {
    const files = await fs.readdir(srcPath);
    console.log('\nFiles in src/:\n');
    files.forEach((file) => {
      console.log(`  ${file}`);
    });
    console.log('');
  } catch (error) {
    console.error('Error reading src directory:', error);
  }
}

/**
 * Reset state
 */
export async function reset(): Promise<void> {
  if (existsSync(STATE_FILE)) {
    const fs = await import('node:fs/promises');
    await fs.unlink(STATE_FILE);
  }
  console.log('\n🗑️  Bug fixer reset. Agent forgotten.\n');
}
