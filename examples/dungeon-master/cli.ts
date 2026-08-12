#!/usr/bin/env bun

/**
 * Dungeon Master CLI
 * 
 * A persistent DM that creates its own game system and remembers your campaigns.
 * 
 * Usage:
 *   bun cli.ts                    # Continue current campaign or start new
 *   bun cli.ts --new              # Start a new campaign
 *   bun cli.ts --campaign=NAME    # Switch to a specific campaign
 *   bun cli.ts --list             # List all campaigns
 *   bun cli.ts --status           # Show DM and campaign status
 *   bun cli.ts --rulebook         # Display the DM's rulebook
 *   bun cli.ts --reset            # Delete local campaign state and start fresh
 */

import { parseArgs } from 'node:util';
import * as readline from 'node:readline';
import {
  loadState,
  saveState,
  createDM,
  initializeDM,
  startNewCampaign,
  resumeCampaign,
  playSession,
  showStatus,
  resetAll,
  hasRulebook,
  readRulebook,
  listCampaigns,
} from './dm.js';

/**
 * Prompt user for input
 */
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

async function main() {
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
  });

  if (values.help) {
    printHelp();
    return;
  }

  if (values.reset) {
    const confirm = await prompt('⚠️  Delete DM and all campaigns? (yes/no): ');
    if (confirm.toLowerCase() === 'yes') {
      await resetAll();
    } else {
      console.log('Cancelled.\n');
    }
    return;
  }

  if (values.status) {
    const state = await loadState();
    await showStatus(state);
    return;
  }

  if (values.list) {
    const campaigns = await listCampaigns();
    console.log('\n📜 Campaigns:\n');
    if (campaigns.length === 0) {
      console.log('  (no campaigns yet)\n');
    } else {
      for (const name of campaigns) {
        console.log(`  - ${name}`);
      }
      console.log('');
    }
    return;
  }

  if (values.rulebook) {
    const rulebook = await readRulebook();
    if (rulebook) {
      console.log('\n📖 DM\'s Rulebook:\n');
      console.log(rulebook);
    } else {
      console.log('\n📖 No rulebook yet. Start a session to have the DM create one.\n');
    }
    return;
  }

  // Main game flow
  const state = await loadState();
  
  // Create or resume DM
  const dm = await createDM(state);
  
  // Save DM ID if new
  if (!state.dmAgentId && dm.agentId) {
    state.dmAgentId = dm.agentId;
    await saveState(state);
  }
  
  // If no rulebook, initialize the DM first
  if (!hasRulebook()) {
    await initializeDM(dm, state);
  }
  
  // Determine what to do
  if (values.new || values.campaign) {
    // Starting or switching campaigns
    const campaignName = values.campaign || await prompt('📜 Campaign name: ');
    if (!campaignName) {
      console.log('No campaign name provided.\n');
      dm.close();
      return;
    }
    
    const campaigns = await listCampaigns();
    if (campaigns.includes(campaignName)) {
      // Resume existing
      await resumeCampaign(dm, state, campaignName);
    } else {
      // Start new
      await startNewCampaign(dm, state, campaignName);
    }
  } else if (state.activeCampaign) {
    // Resume current campaign
    await resumeCampaign(dm, state, state.activeCampaign);
  } else {
    // No active campaign, start new
    console.log('\n🎲 Welcome to Dungeon Master!\n');
    console.log('No active campaign. Let\'s start one.\n');
    
    const campaignName = await prompt('📜 Campaign name: ');
    if (!campaignName) {
      console.log('No campaign name provided.\n');
      dm.close();
      return;
    }
    
    await startNewCampaign(dm, state, campaignName);
  }
  
  // Enter gameplay loop
  await playSession(dm);
  
  dm.close();
}

function printHelp() {
  console.log(`
🎲 Dungeon Master

A persistent DM that creates its own game system and remembers your campaigns.

USAGE:
  bun cli.ts [options]

OPTIONS:
  --new              Start a new campaign
  --campaign=NAME    Switch to or create a specific campaign
  --list             List all campaigns
  --status           Show DM and campaign status
  --rulebook         Display the DM's custom rulebook
  --reset            Delete local campaign state and start fresh
  -h, --help         Show this help

EXAMPLES:
  bun cli.ts                      # Continue current campaign
  bun cli.ts --new                # Start a new campaign
  bun cli.ts --campaign=dragons   # Play the "dragons" campaign
  bun cli.ts --rulebook           # See the DM's game system

FEATURES:
  📖 The DM writes its own rulebook - a custom game system it creates and refines
  🗺️  Persistent campaigns - come back days later and pick up where you left off
  👥 NPCs remember you - "You're the one who spared the goblin!"
  ⚡ Consequences matter - past actions shape future events
  🎭 Collaborative tone - the DM adapts to what you enjoy

GAMEPLAY:
  Type your actions, dialogue, or questions. The DM will respond.
  
  Special commands:
    save  - Save current progress
    quit  - End session (auto-saves)

Each campaign is stored in campaigns/{name}/ with files for world, character,
NPCs, quests, and session history. The DM reads and writes these files to keep
campaign context across sessions.
`);
}

main().catch(console.error);
