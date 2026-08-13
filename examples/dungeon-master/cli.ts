#!/usr/bin/env bun

/**
 * Persistent Dungeon Master example.
 *
 * Run this file from the repository root:
 *   bun examples/dungeon-master/cli.ts --help
 */

import * as readline from 'node:readline';
import { parseArgs } from 'node:util';

import type { LettaCodeSession } from '../../src/index.js';
import {
  createDM,
  hasRulebook,
  initializeDM,
  listCampaigns,
  loadState,
  normalizeCampaignName,
  playSession,
  readRulebook,
  recoverPendingCampaign,
  resetAll,
  resumeCampaign,
  showStatus,
  startNewCampaign,
} from './dm.js';
import type { GameState } from './types.js';

const COMMAND = 'bun examples/dungeon-master/cli.ts';
const CAMPAIGN_NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: 'accent',
  usage: 'search',
});

interface CliOptions {
  new: boolean;
  campaign?: string;
  list: boolean;
  status: boolean;
  rulebook: boolean;
  reset: boolean;
  help: boolean;
}

function parseOptions(): CliOptions {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      new: { type: 'boolean', default: false },
      campaign: { type: 'string' },
      list: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      rulebook: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  return values;
}

function validateMode(options: CliOptions): void {
  const selectedModes = [
    options.new ? '--new' : null,
    options.campaign !== undefined ? '--campaign' : null,
    options.list ? '--list' : null,
    options.status ? '--status' : null,
    options.rulebook ? '--rulebook' : null,
    options.reset ? '--reset' : null,
  ].filter((mode): mode is string => mode !== null);

  if (selectedModes.length > 1) {
    throw new Error(`Choose one mode option. Received: ${selectedModes.join(', ')}.`);
  }
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askForCampaignName(): Promise<string> {
  return normalizeCampaignName(await prompt('Campaign name: '));
}

interface CampaignSelection {
  name: string;
  exists: boolean;
}

async function selectCampaign(
  options: CliOptions,
  state: GameState,
): Promise<CampaignSelection> {
  let campaignName: string;

  if (options.new) {
    campaignName = await askForCampaignName();
  } else if (options.campaign !== undefined) {
    campaignName = normalizeCampaignName(options.campaign);
  } else if (state.activeCampaign) {
    campaignName = state.activeCampaign;
  } else {
    console.log('\nNo active campaign exists. Create one to start playing.\n');
    campaignName = await askForCampaignName();
  }

  const matchingNames = (await listCampaigns()).filter(
    (name) => CAMPAIGN_NAME_COLLATOR.compare(name.normalize('NFC'), campaignName) === 0,
  );
  if (matchingNames.length > 1) {
    throw new Error(
      `Campaign name is ambiguous: ${matchingNames.map((name) => JSON.stringify(name)).join(', ')}.`,
    );
  }
  const existingName = matchingNames[0];
  if (options.new && existingName) {
    throw new Error(
      `Campaign ${JSON.stringify(existingName)} already exists. Use --campaign=${JSON.stringify(existingName)} to resume it.`,
    );
  }

  return {
    name: existingName ?? campaignName,
    exists: existingName !== undefined,
  };
}

async function openCampaign(
  session: LettaCodeSession,
  state: GameState,
  selection: CampaignSelection,
): Promise<void> {
  if (selection.exists) {
    await resumeCampaign(session, state, selection.name);
  } else {
    await startNewCampaign(session, state, selection.name);
  }
}

async function runGame(options: CliOptions, state: GameState): Promise<void> {
  // Resolve local input before creating or resuming an agent. Invalid input
  // must not create backend state as a side effect.
  const campaign = await selectCampaign(options, state);
  const session = await createDM(state);

  // A session owns a local app-server connection. Close it after normal play
  // and after failures so that this short-lived CLI does not leak the process.
  try {
    if (!hasRulebook()) {
      await initializeDM(session, state);
    }

    await openCampaign(session, state, campaign);
    await playSession(session, campaign.name);
  } finally {
    session.close();
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  validateMode(options);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.reset) {
    const confirmation = await prompt(
      'Delete local campaign files and forget the saved agent ID? The backend agent will remain. Type yes to continue: ',
    );
    if (confirmation.toLowerCase() === 'yes') {
      await resetAll();
    } else {
      console.log('Reset cancelled.');
    }
    return;
  }

  if (options.rulebook) {
    const rulebook = await readRulebook();
    if (rulebook) {
      console.log('\nDungeon Master rulebook:\n');
      console.log(rulebook);
    } else {
      console.log(`\nNo rulebook exists. Run ${COMMAND} to create one.\n`);
    }
    return;
  }

  const state = await loadState();
  await recoverPendingCampaign(state);

  if (options.status) {
    await showStatus(state);
    return;
  }

  if (options.list) {
    const campaigns = await listCampaigns();
    console.log('\nCampaigns:\n');
    if (campaigns.length === 0) {
      console.log('  (none)\n');
      return;
    }
    for (const name of campaigns) {
      console.log(`  - ${name}`);
    }
    console.log('');
    return;
  }

  await runGame(options, state);
}

function printHelp(): void {
  console.log(`
Dungeon Master example

Runs one persistent local agent as a tabletop role-playing game Dungeon Master.
The agent writes the game rules and campaign state to files you can inspect.

Usage:
  ${COMMAND} [mode]

Modes (choose one):
  --new              Prompt for a new campaign name
  --campaign=NAME    Resume NAME, or create it when it does not exist
  --list             List campaign directories
  --status           Show the saved agent ID and active campaign
  --rulebook         Print the generated rulebook
  --reset            Delete generated files and forget the saved agent ID
  -h, --help         Show this help

Examples:
  ${COMMAND}
  ${COMMAND} --new
  ${COMMAND} --campaign=dragons
  ${COMMAND} --status

During play:
  save                Ask the agent to update the campaign files
  quit or exit        Save the campaign files and end the session

Generated files:
  examples/dungeon-master/state.json
      Stores the agent ID, active campaign, and any setup in progress.
  examples/dungeon-master/rulebook.md
      Stores the game system that the agent creates.
  examples/dungeon-master/campaigns/<name>/
      Stores the world, character, quests, NPCs, consequences, and session log.

Persistence:
  The local backend stores the agent and its default conversation. The files
  above store game state in a form that you can read and edit. --reset removes
  the files and saved ID, but it does not delete the backend agent.

Safety:
  The session gives the agent Read and Write tools in unrestricted permission
  mode. This example sets their working directory to examples/dungeon-master,
  but it does not sandbox file access.
`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
