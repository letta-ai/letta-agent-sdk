#!/usr/bin/env bun

/**
 * Economics Seminar CLI
 * 
 * A multi-agent academic seminar simulation.
 * An economist presents research, faculty panel asks questions.
 * 
 * Usage:
 *   bun cli.ts              # Run a seminar
 *   bun cli.ts --status     # Show agent status
 *   bun cli.ts --reset      # Reset all agents
 *   bun cli.ts --faculty=4  # Use 4 faculty members (default: 3)
 *   bun cli.ts --rounds=3   # Up to 3 Q&A rounds per faculty (default: 2)
 */

import { parseArgs } from 'node:util';
import * as readline from 'node:readline';
import { runSeminar, getStatus, resetSeminar } from './seminar.js';
import { DEFAULT_CONFIG } from './types.js';

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
      status: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      faculty: { type: 'string', default: '3' },
      rounds: { type: 'string', default: '2' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  if (values.status) {
    await getStatus();
    return;
  }

  if (values.reset) {
    await resetSeminar();
    return;
  }

  const config = {
    ...DEFAULT_CONFIG,
    facultyCount: Math.min(4, Math.max(1, parseInt(values.faculty, 10) || 3)),
    maxRoundsPerFaculty: Math.min(5, Math.max(1, parseInt(values.rounds, 10) || 2)),
  };

  // Prompt for topic
  console.log('\n🎓 Economics Seminar\n');
  console.log('Example topics:');
  console.log('  - Impact of AI on labor markets');
  console.log('  - Cryptocurrency regulation');
  console.log('  - Universal basic income');
  console.log('  - Housing affordability crisis');
  console.log('  - Central bank digital currencies');
  console.log('');
  
  const topic = await prompt('📋 Enter a research topic (or press Enter for random): ');
  
  await runSeminar(config, topic || undefined);
}

function printHelp() {
  console.log(`
🎓 Economics Seminar

A multi-agent academic seminar simulation demonstrating:
- Agent collaboration and debate
- Persistent memory across sessions
- Distinct agent personalities

USAGE:
  bun cli.ts [options]

OPTIONS:
  --status       Show current agent status and IDs
  --reset        Clear the saved agent IDs
  --faculty=N    Number of faculty members (1-4, default: 3)
  --rounds=N     Max Q&A rounds per faculty (1-5, default: 2)
  -h, --help     Show this help

EXAMPLES:
  bun cli.ts                  # Run with defaults (3 faculty, 2 rounds)
  bun cli.ts --faculty=4      # Full panel of 4 faculty
  bun cli.ts --rounds=1       # Quick seminar (1 question each)
  bun cli.ts --status         # See agent IDs and seminar count

THE SEMINAR:
  1. 📋 You pick a topic (or let the presenter choose)
  2. 📚 Presenter researches the topic using web search
  3. 📖 Presenter gives their presentation
  4. ❓ Hostile faculty panel attacks (back and forth)
  5. 💭 Faculty delivers their brutal verdict

FACULTY PANEL:
  👩‍🏫 Dr. Chen (Macro) - Policy implications, systemic effects
  👨‍🏫 Dr. Roberts (Micro) - Incentives, equilibrium, theory
  👩‍🏫 Dr. Patel (Behavioral) - Psychology, biases, real behavior
  👴 Dr. Morrison (Historian) - Historical context, precedent

Each agent can store notes that persist between seminars. Run another seminar
and inspect the transcript to see what context the agents retained.
`);
}

main().catch(console.error);
