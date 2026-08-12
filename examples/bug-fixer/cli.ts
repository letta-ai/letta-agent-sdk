#!/usr/bin/env bun

/**
 * Bug Fixer CLI
 * 
 * A persistent agent that finds and fixes bugs in code.
 * 
 * Usage:
 *   bun cli.ts "description of the bug"   # Fix a specific bug
 *   bun cli.ts                            # Interactive mode
 *   bun cli.ts --status                   # Show agent status
 *   bun cli.ts --reset                    # Reset agent
 */

import { parseArgs } from 'node:util';
import {
  loadState,
  saveState,
  getOrCreateAgent,
  fixBug,
  interactiveMode,
  showStatus,
  reset,
  sayHello,
  listFilesInSrc,
} from './fixer.js';

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      status: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      list: { type: 'boolean', default: false },
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

  if (values.list) {
    await listFilesInSrc();
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
    // Fix the specified bug
    const bugDescription = positionals.join(' ');
    await fixBug(agent, state, bugDescription);
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
🐛 Bug Fixer

A persistent agent that finds and fixes bugs. Remembers your codebase.

USAGE:
  bun cli.ts [bug description]     Fix a specific bug
  bun cli.ts                       Interactive mode
  bun cli.ts --status              Show agent status
  bun cli.ts --reset               Reset agent (forget everything)
  bun cli.ts --list                List files in src/
  bun cli.ts -h, --help            Show this help

EXAMPLES:
  bun cli.ts "the tests in auth.test.ts are failing"
  bun cli.ts "TypeError on line 42 of utils.ts"
  bun cli.ts "npm run build shows an error about missing module"

HOW IT WORKS:
  1. Describe the bug (error message, failing test, unexpected behavior)
  2. The agent explores your codebase to understand the context
  3. It identifies the root cause and makes a fix
  4. It runs tests or commands to verify

PERSISTENCE:
  The agent remembers your codebase across sessions. The more you use it,
  the better it knows where things are and what patterns to look for.
`);
}

main().catch(console.error);
