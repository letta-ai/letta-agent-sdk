/** A persistent Dungeon Master with file-backed campaign state. */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type LettaCodeClientSessionOptions,
  type LettaCodeSession,
} from '../../src/index.js';
import {
  createExampleAgent,
  createExampleClient,
  formatAgentLink,
  resumeExampleSession,
} from '../create-agent-session.js';
import { CAMPAIGN_FILES, PATHS, type GameState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_FILE = join(__dirname, PATHS.stateFile);
const STATE_TEMP_FILE = `${STATE_FILE}.tmp`;
const RULEBOOK_FILE = join(__dirname, PATHS.rulebook);
const CAMPAIGNS_DIR = join(__dirname, PATHS.campaignsDir);
const client = createExampleClient({ backend: 'local' });
const INVALID_CAMPAIGN_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F]/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

// Setting cwd makes the agent's relative Read and Write paths match the files
// that this CLI inspects. The allowlist keeps unrelated client tools disabled.
const DM_SESSION_OPTIONS = {
  allowedTools: ['Read', 'Write'],
  permissionMode: 'unrestricted',
  cwd: __dirname,
  skillSources: [],
} satisfies LettaCodeClientSessionOptions;

const CAMPAIGN_FILE_GUIDE = [
  `${CAMPAIGN_FILES.world} - Setting, locations, and lore`,
  `${CAMPAIGN_FILES.player} - Character sheet, backstory, and inventory`,
  `${CAMPAIGN_FILES.npcs} - Non-player characters and relationships`,
  `${CAMPAIGN_FILES.quests} - Active and completed quests`,
  `${CAMPAIGN_FILES.sessionLog} - Session summaries`,
  `${CAMPAIGN_FILES.consequences} - Pending results of earlier choices`,
].map((line) => `  - ${line}`).join('\n');

// ANSI colors
const COLORS = {
  dm: '\x1b[35m',      // Magenta for DM
  player: '\x1b[36m',  // Cyan for player
  system: '\x1b[90m',  // Gray for system messages
  reset: '\x1b[0m',
};

function parseState(value: unknown): GameState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${PATHS.stateFile} must contain a JSON object.`);
  }

  const state = value as Record<string, unknown>;
  const dmAgentId = state.dmAgentId;
  const activeCampaign = state.activeCampaign;
  const pendingCampaign = state.pendingCampaign ?? null;
  if (dmAgentId !== null && typeof dmAgentId !== 'string') {
    throw new Error(`${PATHS.stateFile} has an invalid dmAgentId.`);
  }
  if (activeCampaign !== null && typeof activeCampaign !== 'string') {
    throw new Error(`${PATHS.stateFile} has an invalid activeCampaign.`);
  }
  if (pendingCampaign !== null && typeof pendingCampaign !== 'string') {
    throw new Error(`${PATHS.stateFile} has an invalid pendingCampaign.`);
  }
  if (activeCampaign) validateCampaignName(activeCampaign);
  if (pendingCampaign) validateCampaignName(pendingCampaign);

  return { dmAgentId, activeCampaign, pendingCampaign };
}

export async function loadState(): Promise<GameState> {
  if (!existsSync(STATE_FILE)) {
    return { dmAgentId: null, activeCampaign: null, pendingCampaign: null };
  }

  try {
    return parseState(JSON.parse(await readFile(STATE_FILE, 'utf-8')));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load ${PATHS.stateFile}: ${detail}`);
  }
}

export async function saveState(state: GameState): Promise<void> {
  await writeFile(STATE_TEMP_FILE, `${JSON.stringify(state, null, 2)}\n`);
  await rename(STATE_TEMP_FILE, STATE_FILE);
}

function validateCampaignName(campaignName: string): void {
  const valid =
    campaignName.length > 0 &&
    campaignName.length <= 64 &&
    campaignName === campaignName.trim() &&
    campaignName !== '.' &&
    campaignName !== '..' &&
    !campaignName.endsWith('.') &&
    !INVALID_CAMPAIGN_NAME_CHARACTERS.test(campaignName) &&
    !WINDOWS_RESERVED_NAME.test(campaignName);
  if (!valid) {
    throw new Error(
      'Campaign name must be 1-64 characters and valid as a directory name on macOS, Linux, and Windows.',
    );
  }
}

export function normalizeCampaignName(value: string): string {
  const campaignName = value.trim().normalize('NFC');
  validateCampaignName(campaignName);
  return campaignName;
}

function getCampaignDir(campaignName: string): string {
  validateCampaignName(campaignName);
  const campaignDir = resolve(CAMPAIGNS_DIR, campaignName);
  if (!campaignDir.startsWith(`${CAMPAIGNS_DIR}${sep}`)) {
    throw new Error('Campaign path must stay inside the campaigns directory.');
  }
  return campaignDir;
}

function getCampaignRelativePath(campaignName: string): string {
  validateCampaignName(campaignName);
  return `${PATHS.campaignsDir}/${campaignName}`;
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
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/** Remove a campaign whose setup did not reach the state-file commit. */
export async function recoverPendingCampaign(state: GameState): Promise<void> {
  if (!state.pendingCampaign) return;

  const pendingCampaign = state.pendingCampaign;
  await rm(getCampaignDir(pendingCampaign), { force: true, recursive: true });
  state.pendingCampaign = null;
  await saveState(state);
  console.log(
    `${COLORS.system}Removed incomplete campaign setup: ${pendingCampaign}${COLORS.reset}`,
  );
}

/** Resume the saved agent's default conversation, or create it once. */
export async function createDM(state: GameState): Promise<LettaCodeSession> {
  if (state.dmAgentId) {
    return resumeExampleSession(state.dmAgentId, DM_SESSION_OPTIONS, client);
  }

  // The SDK selects its current default model when `model` is omitted. Saving
  // the agent ID before the first turn lets a failed setup resume on retry.
  const agentId = await createExampleAgent({
    name: 'Dungeon Master',
    description: 'Runs file-backed tabletop role-playing campaigns.',
    baseTools: [],
    instructions: `You are a Dungeon Master who designs and runs tabletop role-playing campaigns.

## Role
- Create a small game system in ${PATHS.rulebook}.
- Run campaigns whose state later sessions can read from files.
- Ask the player about tone, boundaries, and character goals.

## Style
- Match the tone that the player requests.
- Describe scenes with enough detail to support a choice.
- Give choices consequences that follow from the saved campaign state.
- Prefer a clear ruling over a long rules discussion.

## Files
The working directory is this example directory. Use relative paths only.
Write the shared rules to ${PATHS.rulebook}. Store each campaign under
${PATHS.campaignsDir}/{name}/ with these files:
${CAMPAIGN_FILE_GUIDE}

Keep full campaign state in those campaign files. Store only durable,
cross-campaign player preferences in the agent's memory files. Do not store
secrets in campaign or memory files.

Read ${PATHS.rulebook} before you resolve an uncertain action. Update the active
campaign files after events that change the world, character, quests, or future
consequences. Never write one campaign's state into another campaign.`,
  }, client);

  state.dmAgentId = agentId;
  await saveState(state);
  return resumeExampleSession(agentId, DM_SESSION_OPTIONS, client);
}

function createStreamPrinter(): (text: string) => void {
  return (text: string) => {
    process.stdout.write(`${COLORS.dm}${text}${COLORS.reset}`);
  };
}

/** Send one turn, print assistant fragments, and require a terminal result. */
export async function chat(
  session: LettaCodeSession,
  message: string,
  onOutput?: (text: string) => void,
): Promise<string> {
  await session.send(message);

  let streamedResponse = '';
  let streamedError: string | undefined;
  const printedToolCalls = new Set<string>();
  const printer = onOutput ?? createStreamPrinter();

  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      streamedResponse += msg.content;
      printer(msg.content);
      continue;
    }

    if (msg.type === 'tool_call' && !printedToolCalls.has(msg.toolCallId)) {
      printedToolCalls.add(msg.toolCallId);
      console.log(`\n${COLORS.system}[${msg.toolName}]${COLORS.reset}`);
      continue;
    }

    if (msg.type === 'error') {
      streamedError = msg.errorDetail ?? msg.message;
      continue;
    }

    if (msg.type === 'result') {
      if (!msg.success) {
        throw new Error(
          streamedError ?? msg.errorDetail ?? msg.error ?? msg.errorCode ?? 'Dungeon Master turn failed.',
        );
      }

      const completeResponse = msg.result ?? streamedResponse;
      // Some transports provide only the complete text on the result message.
      if (!streamedResponse && completeResponse) printer(completeResponse);
      return completeResponse;
    }
  }

  throw new Error('Dungeon Master stream ended before a terminal result.');
}

/** Ask a new agent to create the rulebook that the CLI will inspect. */
export async function initializeDM(
  session: LettaCodeSession,
  state: GameState,
): Promise<void> {
  console.log(`\n${COLORS.system}The DM is creating its game system...${COLORS.reset}\n`);

  const prompt = `Create ${PATHS.rulebook} in the current working directory. Define a small tabletop role-playing game with:

1. A core action-resolution mechanic.
2. Character statistics.
3. Combat rules.
4. Skills or abilities.
5. Character progression.
6. Damage, recovery, and death rules.

Keep the rules short enough to use during play. Use the Write tool now.`;

  await chat(session, prompt, createStreamPrinter());
  if (!hasRulebook()) {
    throw new Error(`The turn completed without creating ${PATHS.rulebook}.`);
  }

  const agentId = session.agentId ?? state.dmAgentId;
  if (!agentId) throw new Error('The session did not report a Dungeon Master agent ID.');

  console.log(`\n\n${COLORS.system}Rulebook created. The DM is ready.${COLORS.reset}`);
  console.log(`${COLORS.system}[DM Agent: ${agentId}]${COLORS.reset}`);
  console.log(`${COLORS.system}[→ ${formatAgentLink(agentId, client)}]${COLORS.reset}\n`);
}

/** Create the campaign directory and begin play in the saved conversation. */
export async function startNewCampaign(
  session: LettaCodeSession,
  state: GameState,
  campaignName: string,
): Promise<void> {
  const normalizedName = normalizeCampaignName(campaignName);
  const campaignDir = getCampaignDir(normalizedName);
  const campaignPath = getCampaignRelativePath(normalizedName);
  if (existsSync(campaignDir)) {
    throw new Error(`Campaign ${JSON.stringify(normalizedName)} already exists.`);
  }

  state.pendingCampaign = normalizedName;
  await saveState(state);
  console.log(`\n${COLORS.system}Starting new campaign: ${normalizedName}${COLORS.reset}\n`);

  const prompt = `Start the new campaign ${JSON.stringify(normalizedName)}. Store its files only under ${campaignPath}/.

Ask the player the following questions:
1. What setting interests them?
2. What tone do they want?
3. What topics do they want to exclude?
4. What character do they want to play?

Use ${PATHS.rulebook} to help with the character's mechanical details. Begin with a short greeting and the questions.`;

  try {
    await mkdir(campaignDir, { recursive: true });
    await chat(session, prompt, createStreamPrinter());
    state.activeCampaign = normalizedName;
    state.pendingCampaign = null;
    await saveState(state);
  } catch (error) {
    await rm(campaignDir, { force: true, recursive: true });
    state.pendingCampaign = null;
    await saveState(state);
    throw error;
  }
  console.log('\n');
}

/** Resume a campaign after the agent reloads its file-backed state. */
export async function resumeCampaign(
  session: LettaCodeSession,
  state: GameState,
  campaignName: string,
): Promise<void> {
  validateCampaignName(campaignName);
  const campaignDir = getCampaignDir(campaignName);
  const campaignPath = getCampaignRelativePath(campaignName);
  if (!existsSync(campaignDir)) {
    throw new Error(`Campaign ${JSON.stringify(campaignName)} does not exist.`);
  }

  state.activeCampaign = campaignName;
  await saveState(state);

  console.log(`\n${COLORS.system}Resuming campaign: ${campaignName}${COLORS.reset}\n`);

  const prompt = `Resume the campaign ${JSON.stringify(campaignName)}.

1. Read the available files under ${campaignPath}/.
2. Read ${PATHS.rulebook} if you need to resolve an action.
3. Give the player a short recap based only on saved campaign state.
4. Set the next scene.

Keep all updates for this campaign under ${campaignPath}/.`;

  await chat(session, prompt, createStreamPrinter());
  console.log('\n');
}

/** Run the interactive player loop for one campaign. */
export async function playSession(
  session: LettaCodeSession,
  campaignName: string,
): Promise<void> {
  const readline = await import('node:readline');
  const campaignPath = getCampaignRelativePath(campaignName);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const inputLines = rl[Symbol.asyncIterator]();
  console.log(`${COLORS.system}(Type 'quit' to end session, 'save' to save progress)${COLORS.reset}\n`);

  try {
    while (true) {
      process.stdout.write(`${COLORS.player}> ${COLORS.reset}`);
      const nextInput = await inputLines.next();
      if (nextInput.done) break;
      const input = nextInput.value;
      const command = input.trim().toLowerCase();

      if (command === 'quit' || command === 'exit') {
        console.log(`\n${COLORS.system}Ending session...${COLORS.reset}\n`);
        await chat(session, `The player is ending the session.

1. Summarize this session in ${campaignPath}/${CAMPAIGN_FILES.sessionLog}.
2. Update any changed files under ${campaignPath}/.
3. Give the player a short farewell with one possible next development.

Use the Write tool for the file updates.`, createStreamPrinter());
        console.log('\n');
        break;
      }

      if (command === 'save') {
        console.log(`\n${COLORS.system}Saving progress...${COLORS.reset}\n`);
        await chat(session, `Save the current campaign state under ${campaignPath}/.

Update ${CAMPAIGN_FILES.sessionLog} and each other campaign file whose state changed. Do not write campaign state outside ${campaignPath}/.`, createStreamPrinter());
        console.log('\n');
        continue;
      }

      if (!input.trim()) continue;

      console.log('');
      await chat(session, input, createStreamPrinter());
      console.log('\n');
    }
  } finally {
    rl.close();
  }
}

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

/** Delete generated files without deleting the persisted backend agent. */
export async function resetAll(): Promise<void> {
  await rm(STATE_FILE, { force: true });
  await rm(STATE_TEMP_FILE, { force: true });
  await rm(RULEBOOK_FILE, { force: true });
  await rm(CAMPAIGNS_DIR, { force: true, recursive: true });

  console.log('\nLocal state and campaign files deleted. The agent still exists in the local backend.\n');
}
