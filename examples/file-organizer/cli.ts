#!/usr/bin/env bun

/**
 * File Organizer CLI
 * 
 * Organize files in directories with AI assistance.
 * 
 * Usage:
 *   bun cli.ts ~/Downloads           # Organize Downloads folder
 *   bun cli.ts . --strategy=type     # Organize by file type
 *   bun cli.ts . --dry-run           # Preview without changes
 *   bun cli.ts                       # Interactive mode
 *   bun cli.ts --status              # Show agent status
 *   bun cli.ts --reset               # Reset agent
 */

import { parseArgs } from 'node:util';
import {
  loadState,
  saveState,
  getOrCreateAgent,
  organizeDirectory,
  interactiveMode,
  showStatus,
  reset,
} from './organizer.js';

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      strategy: { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  if (values.reset) {
    await reset();
    return;
  }

  const state = await loadState();

  if (values.status) {
    await showStatus(state);
    return;
  }

  // Get or create the agent
  const agent = await getOrCreateAgent(state);

  if (positionals.length > 0) {
    // Organize the specified directory
    const targetDir = positionals[0];
    await organizeDirectory(agent, state, targetDir, values.strategy, values['dry-run']);
  } else {
    // Interactive mode
    await interactiveMode(agent, state);
  }

  // Save agent ID after first interaction (when it becomes available)
  if (!state.agentId && agent.agentId) {
    state.agentId = agent.agentId;
    await saveState(state);
    console.log(`\x1b[90m[Agent saved: ${agent.agentId}]\x1b[0m`);
    console.log(`\x1b[90m[→ https://chat.letta.com/agents/${agent.agentId}]\x1b[0m\n`);
  }

  agent.close();
}

function printHelp() {
  console.log(`
📁 File Organizer

Organize files in directories with AI assistance. Remembers your preferences.

USAGE:
  bun cli.ts [directory]           Organize a directory
  bun cli.ts                       Interactive mode
  bun cli.ts --status              Show agent status
  bun cli.ts --reset               Reset agent (forget preferences)
  bun cli.ts -h, --help            Show this help

OPTIONS:
  -s, --strategy TYPE    Organization strategy (type, date, project)
  --dry-run              Preview changes without moving files

EXAMPLES:
  bun cli.ts ~/Downloads                  # Organize Downloads
  bun cli.ts ~/Documents --strategy=date  # Organize by date
  bun cli.ts ./messy-folder --dry-run     # Preview only
  bun cli.ts .                            # Organize current directory

STRATEGIES:
  type      Group by file extension (images/, documents/, code/)
  date      Group by date (2024/, 2025/ or by month)
  project   Group by project (inferred from content)
  (none)    AI decides best approach

SAFETY:
  - Always previews changes before executing
  - Never deletes files (only moves)
  - Creates directories as needed

PERSISTENCE:
  The agent learns your organizational preferences over time.
`);
}

main().catch(console.error);
