/**
 * Release Notes Generator Agent
 * 
 * A persistent agent that generates release notes from git commits.
 * Remembers past releases and learns your formatting preferences.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type LettaCodeSession } from '../../src/index.js';
import { createAgentSession, createExampleClient, formatAgentLink, resumeExampleSession } from '../create-agent-session.js';
import { DEFAULT_CONFIG, type ReleaseNotesState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'state.json');
const client = createExampleClient({ backend: 'local' });

// ANSI colors
const COLORS = {
  agent: '\x1b[35m',   // Magenta
  system: '\x1b[90m',  // Gray
  success: '\x1b[32m', // Green
  reset: '\x1b[0m',
};

const SYSTEM_PROMPT = `You are a release notes generator. Your job is to create clear, useful release notes from git commits.

## Your Capabilities
- Run git commands to analyze commits
- Read files to understand changes
- Write release notes to files

## Your Approach
1. **Get commits** - Use git log to get commits in the specified range
2. **Categorize** - Group changes into:
   - 🚀 Features (new functionality)
   - 🐛 Bug Fixes
   - 💥 Breaking Changes
   - 📚 Documentation
   - 🔧 Maintenance/Chores
3. **Summarize** - Write human-readable descriptions, not raw commit messages
4. **Format** - Use clean markdown with consistent style

## Memory Files
Keep durable release context in reference/release-history.md. Use it to:
- Maintain consistent formatting
- Reference version numbers correctly
- Avoid duplicating content from past releases

## Output Format
\`\`\`markdown
# Release Notes - vX.Y.Z

## 🚀 Features
- Feature description

## 🐛 Bug Fixes
- Fix description

## 💥 Breaking Changes
- What changed and migration steps

## 📚 Documentation
- Doc updates

## 🔧 Maintenance
- Chores, refactors, deps
\`\`\`

Skip empty sections. Be concise but informative.`;

/**
 * Load state from disk
 */
export async function loadState(): Promise<ReleaseNotesState> {
  if (existsSync(STATE_FILE)) {
    const data = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  }
  return {
    agentId: null,
    releasesGenerated: 0,
  };
}

/**
 * Save state to disk
 */
export async function saveState(state: ReleaseNotesState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Get or create the release notes agent
 */
export async function getOrCreateAgent(state: ReleaseNotesState): Promise<LettaCodeSession> {
  if (state.agentId) {
    console.log(`${COLORS.system}Resuming release notes agent...${COLORS.reset}`);
    return resumeExampleSession(state.agentId, {
      model: DEFAULT_CONFIG.model,
      allowedTools: ['Bash', 'Read', 'Write', 'Glob'],
      permissionMode: 'unrestricted',
    }, client);
  }

  console.log(`${COLORS.system}Creating new release notes agent...${COLORS.reset}`);
  const session = await createAgentSession({
    model: DEFAULT_CONFIG.model,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ['Bash', 'Read', 'Write', 'Glob'],
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
 * Generate release notes
 */
export async function generateReleaseNotes(
  session: LettaCodeSession,
  state: ReleaseNotesState,
  fromRef: string,
  toRef: string = 'HEAD',
  outputFile?: string
): Promise<void> {
  console.log(`\n${COLORS.system}Generating release notes for ${fromRef}..${toRef}...${COLORS.reset}\n`);
  
  let prompt = `Generate release notes for the commits between ${fromRef} and ${toRef}.

Steps:
1. Run \`git log ${fromRef}..${toRef} --oneline\` to see the commits
2. If needed, read specific files to understand changes better
3. Categorize and summarize the changes
4. Output clean, formatted release notes`;

  if (outputFile) {
    prompt += `\n\nWrite the release notes to: ${outputFile}`;
  }

  await chat(session, prompt, createStreamPrinter());
  
  // Update count
  state.releasesGenerated++;
  await saveState(state);
  
  console.log(`\n\n${COLORS.success}Release notes generated.${COLORS.reset}`);
  console.log(`${COLORS.system}Total releases generated: ${state.releasesGenerated}${COLORS.reset}\n`);
}

/**
 * Show status
 */
export async function showStatus(state: ReleaseNotesState): Promise<void> {
  console.log('\n📝 Release Notes Generator Status\n');
  console.log(`Agent: ${state.agentId || '(not created yet)'}`);
  if (state.agentId) {
    console.log(`  → ${formatAgentLink(state.agentId, client)}`);
  }
  console.log(`Releases generated: ${state.releasesGenerated}`);
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
  console.log('\n🗑️  Release notes generator reset. Agent forgotten.\n');
}
