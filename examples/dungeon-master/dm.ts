/**
 * Dungeon Master Agent
 * 
 * A persistent DM that creates its own game system and runs campaigns.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type LettaCodeSession } from '../../src/index.js';
import { createAgentSession, createExampleClient, formatAgentLink, resumeExampleSession } from '../create-agent-session.js';
import { CAMPAIGN_FILES, DEFAULT_CONFIG, PATHS, type GameState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_FILE = join(__dirname, PATHS.stateFile);
const RULEBOOK_FILE = join(__dirname, PATHS.rulebook);
const CAMPAIGNS_DIR = join(__dirname, PATHS.campaignsDir);
const client = createExampleClient({ backend: 'local' });

// ANSI colors
const COLORS = {
  dm: '\x1b[35m',      // Magenta for DM
  player: '\x1b[36m',  // Cyan for player
  system: '\x1b[90m',  // Gray for system messages
  reset: '\x1b[0m',
};

/**
 * Load game state from disk
 */
export async function loadState(): Promise<GameState> {
  if (existsSync(STATE_FILE)) {
    const data = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  }
  return {
    dmAgentId: null,
    activeCampaign: null,
    campaigns: [],
  };
}

/**
 * Save game state to disk
 */
export async function saveState(state: GameState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Get campaign directory path
 */
function getCampaignDir(campaignName: string): string {
  return join(CAMPAIGNS_DIR, campaignName);
}

/**
 * Get campaign file path
 */
function getCampaignFile(campaignName: string, file: keyof typeof CAMPAIGN_FILES): string {
  return join(getCampaignDir(campaignName), CAMPAIGN_FILES[file]);
}

/**
 * Check if rulebook exists
 */
export function hasRulebook(): boolean {
  return existsSync(RULEBOOK_FILE);
}

/**
 * Read the rulebook
 */
export async function readRulebook(): Promise<string | null> {
  if (!hasRulebook()) return null;
  return readFile(RULEBOOK_FILE, 'utf-8');
}

/**
 * List all campaigns
 */
export async function listCampaigns(): Promise<string[]> {
  if (!existsSync(CAMPAIGNS_DIR)) return [];
  const entries = await readdir(CAMPAIGNS_DIR, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

/**
 * Create or resume the DM agent
 */
export async function createDM(state: GameState): Promise<LettaCodeSession> {
  if (state.dmAgentId) {
    // Resume existing DM
    return resumeExampleSession(state.dmAgentId, {
      model: DEFAULT_CONFIG.model,
      allowedTools: ['Read', 'Write'],
      permissionMode: 'unrestricted',
    }, client);
  }

  // Create new DM
  const session = await createAgentSession({
    model: DEFAULT_CONFIG.model,
    instructions: `You are a Dungeon Master - a creative storyteller and game designer who runs tabletop RPG campaigns.

## Your Role
- Design and run engaging tabletop RPG experiences
- Create your own game system with rules you write in rulebook.md
- Manage persistent campaign worlds that remember everything
- Collaborate with players on tone, style, and what kind of experience they want

## Your Style
- Adapt to what the player wants (serious, funny, dark, lighthearted)
- Be descriptive and immersive in narration
- Give players meaningful choices with real consequences
- Keep things moving - don't get bogged down in rules

## File Management
You have access to Read and Write tools. Use them to:
- Write and update your rulebook (rulebook.md)
- Manage campaign files in campaigns/{name}/:
  - world.md - Setting, locations, lore
  - player.md - Character sheet, backstory, inventory
  - npcs.md - NPCs met, relationships
  - quests.md - Active/completed quests
  - session-log.md - What happened each session
  - consequences.md - Pending events from past actions

## Memory Files
Keep cross-campaign player preferences in reference/player-preferences.md and
brief campaign pointers in reference/campaign-index.md. Keep full campaign
state in the campaign files above.

## Important
- Always update campaign files after significant events
- Reference your rulebook when resolving actions
- Make the world feel alive and reactive to player choices`,
    allowedTools: ['Read', 'Write'],
    permissionMode: 'unrestricted',
  }, client);

  return session;
}

/**
 * Stream output with color
 */
function createStreamPrinter(): (text: string) => void {
  return (text: string) => {
    process.stdout.write(`${COLORS.dm}${text}${COLORS.reset}`);
  };
}

/**
 * Send a message to the DM and get response
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
 * Initialize a new DM (create rulebook)
 */
export async function initializeDM(session: LettaCodeSession, state: GameState): Promise<void> {
  console.log(`\n${COLORS.system}The DM is creating its game system...${COLORS.reset}\n`);
  
  const prompt = `You're starting fresh as a Dungeon Master. Your first task is to create your game system.

Write a rulebook.md file that contains your custom tabletop RPG rules. Include:

1. **Core Mechanic** - How do players resolve actions? (dice, cards, narrative, etc.)
2. **Character Stats** - What defines a character mechanically?
3. **Combat** - How does fighting work?
4. **Skills/Abilities** - What can characters do?
5. **Progression** - How do characters grow?
6. **Health/Death** - How does damage and dying work?

Keep it simple but complete enough to run a game. You can always refine it later.

Use the Write tool to create rulebook.md now.`;

  await chat(session, prompt, createStreamPrinter());
  
  // Save the DM agent ID
  if (session.agentId) {
    state.dmAgentId = session.agentId;
    await saveState(state);
  }
  
  console.log(`\n\n${COLORS.system}Rulebook created! The DM is ready.${COLORS.reset}`);
  console.log(`${COLORS.system}[DM Agent: ${session.agentId}]${COLORS.reset}`);
  console.log(`${COLORS.system}[→ ${formatAgentLink(session.agentId, client)}]${COLORS.reset}\n`);
}

/**
 * Start a new campaign
 */
export async function startNewCampaign(
  session: LettaCodeSession,
  state: GameState,
  campaignName: string
): Promise<void> {
  // Create campaign directory
  const campaignDir = getCampaignDir(campaignName);
  await mkdir(campaignDir, { recursive: true });
  
  // Update state
  state.activeCampaign = campaignName;
  if (!state.campaigns.includes(campaignName)) {
    state.campaigns.push(campaignName);
  }
  await saveState(state);
  
  console.log(`\n${COLORS.system}Starting new campaign: ${campaignName}${COLORS.reset}\n`);
  
  const prompt = `We're starting a new campaign called "${campaignName}".

The campaign files are in: campaigns/${campaignName}/

First, let's create this world together. Ask me:
1. What kind of setting/world interests me?
2. What tone am I looking for? (serious, comedic, dark, heroic, etc.)
3. Any topics I'd like to avoid?

Then ask about my character concept - I'll describe who I want to play and you'll help fill in the mechanical details based on your rulebook.

Start by greeting me and asking these questions.`;

  await chat(session, prompt, createStreamPrinter());
  console.log('\n');
}

/**
 * Resume an existing campaign
 */
export async function resumeCampaign(
  session: LettaCodeSession,
  state: GameState,
  campaignName: string
): Promise<void> {
  state.activeCampaign = campaignName;
  await saveState(state);
  
  console.log(`\n${COLORS.system}Resuming campaign: ${campaignName}${COLORS.reset}\n`);
  
  const prompt = `We're resuming the campaign "${campaignName}".

Please:
1. Read the campaign files in campaigns/${campaignName}/ to refresh your memory
2. Read your rulebook.md if needed
3. Give me a brief recap of where we left off
4. Set the scene for our next moment of play

Use the Read tool to load the campaign state, then continue our adventure.`;

  await chat(session, prompt, createStreamPrinter());
  console.log('\n');
}

/**
 * Main gameplay loop
 */
export async function playSession(session: LettaCodeSession): Promise<void> {
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
  
  console.log(`${COLORS.system}(Type 'quit' to end session, 'save' to save progress)${COLORS.reset}\n`);
  
  while (true) {
    const input = await askQuestion(`${COLORS.player}> ${COLORS.reset}`);
    
    if (input.toLowerCase() === 'quit' || input.toLowerCase() === 'exit') {
      // Ask DM to save state
      console.log(`\n${COLORS.system}Ending session...${COLORS.reset}\n`);
      await chat(session, `The player is ending the session. Please:
1. Update the session-log.md with a summary of what happened this session
2. Update any other campaign files that need changes (player.md, npcs.md, quests.md, consequences.md)
3. Give a brief farewell that hints at what might come next

Use the Write tool to save everything.`, createStreamPrinter());
      console.log('\n');
      break;
    }
    
    if (input.toLowerCase() === 'save') {
      console.log(`\n${COLORS.system}Saving progress...${COLORS.reset}\n`);
      await chat(session, `Please save the current game state:
1. Update session-log.md with recent events
2. Update player.md with any changes to the character
3. Update any other files that need it

Use the Write tool to save.`, createStreamPrinter());
      console.log('\n');
      continue;
    }
    
    if (!input.trim()) continue;
    
    // Send player input to DM
    console.log('');
    await chat(session, input, createStreamPrinter());
    console.log('\n');
  }
  
  rl.close();
}

/**
 * Show game status
 */
export async function showStatus(state: GameState): Promise<void> {
  console.log('\n🎲 Dungeon Master Status\n');
  
  console.log(`DM Agent: ${state.dmAgentId || '(not created)'}`);
  if (state.dmAgentId) {
    console.log(`  → ${formatAgentLink(state.dmAgentId, client)}`);
  }
  
  console.log(`\nRulebook: ${hasRulebook() ? '✓ Created' : '✗ Not created'}`);
  
  console.log(`\nActive Campaign: ${state.activeCampaign || '(none)'}`);
  
  const campaigns = await listCampaigns();
  console.log(`\nCampaigns (${campaigns.length}):`);
  if (campaigns.length === 0) {
    console.log('  (no campaigns yet)');
  } else {
    for (const name of campaigns) {
      const marker = name === state.activeCampaign ? ' ← active' : '';
      console.log(`  - ${name}${marker}`);
    }
  }
  
  console.log('');
}

/**
 * Reset everything
 */
export async function resetAll(): Promise<void> {
  const fs = await import('node:fs/promises');
  
  if (existsSync(STATE_FILE)) {
    await fs.unlink(STATE_FILE);
  }
  if (existsSync(RULEBOOK_FILE)) {
    await fs.unlink(RULEBOOK_FILE);
  }
  if (existsSync(CAMPAIGNS_DIR)) {
    await fs.rm(CAMPAIGNS_DIR, { recursive: true });
    await mkdir(CAMPAIGNS_DIR);
  }
  
  console.log('\nLocal state and campaign files deleted. The agent still exists in the local backend.\n');
}
