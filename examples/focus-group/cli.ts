#!/usr/bin/env bun

/**
 * Focus Group CLI
 * 
 * Simulate a political focus group with AI personas.
 * 
 * Usage:
 *   bun cli.ts "healthcare"           # Run focus group on healthcare
 *   bun cli.ts                        # Interactive mode
 *   bun cli.ts --status               # Show agent status
 *   bun cli.ts --reset                # Reset all agents
 * 
 * The focus group includes:
 *   - A candidate who presents positions
 *   - Voters with distinct personas who react
 *   - An analyst who provides insights
 * 
 * Agents persist across sessions, so they remember previous discussions.
 */

import { parseArgs } from 'node:util';
import {
  FocusGroup,
  loadState,
  resetFocusGroup,
  showStatus,
} from './focus-group.js';

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
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
    await resetFocusGroup();
    return;
  }

  if (values.status) {
    await showStatus();
    return;
  }

  // Load state and create focus group
  const state = await loadState();
  const focusGroup = new FocusGroup(state);
  
  try {
    await focusGroup.initialize();

    if (positionals.length > 0) {
      // Run on specified topic
      const topic = positionals.join(' ');
      await focusGroup.runRound(topic);
    } else {
      // Interactive mode
      await interactiveMode(focusGroup);
    }
  } finally {
    focusGroup.close();
  }
}

async function interactiveMode(focusGroup: FocusGroup): Promise<void> {
  const readline = await import('node:readline');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  };

  console.log('\n📊 Focus Group - Interactive Mode');
  console.log('Enter topics to test, or "quit" to exit.\n');

  while (true) {
    const topic = await ask('\x1b[1mTopic:\x1b[0m ');
    
    if (topic.toLowerCase() === 'quit' || topic.toLowerCase() === 'exit') {
      break;
    }
    
    if (!topic.trim()) continue;

    await focusGroup.runRound(topic);
    console.log('\n' + '─'.repeat(60) + '\n');
  }

  rl.close();
}

function printHelp() {
  console.log(`
📊 Focus Group Simulator

Test political messaging against AI voter personas.

USAGE:
  bun cli.ts [topic]         Run focus group on a topic
  bun cli.ts                 Interactive mode
  bun cli.ts --status        Show agent status
  bun cli.ts --reset         Reset all agents
  bun cli.ts -h, --help      Show this help

EXAMPLES:
  bun cli.ts "healthcare reform"
  bun cli.ts "immigration policy"
  bun cli.ts "tax cuts vs government services"

HOW IT WORKS:
  1. Candidate presents a position on the topic
  2. Voters (Maria & James) react based on their personas
  3. Candidate asks a follow-up question
  4. Voters respond to the follow-up
  5. Analyst provides insights and recommendations

VOTER PERSONAS:
  Maria - 34yo Independent from Phoenix, AZ
          Nurse, mom of two. Cares about healthcare, education.
  
  James - 58yo moderate Republican from rural Ohio
          Former auto worker, small business owner. Skeptical.

PERSISTENCE:
  Agents remember previous sessions. Run multiple topics to see
  how insights accumulate over time.
`);
}

main().catch(console.error);
