#!/usr/bin/env bun

/**
 * Research Team CLI
 * 
 * A multi-agent academic research system with persistent memory.
 * 
 * Usage:
 *   bun examples/research-team/cli.ts "your research query" [options]
 * 
 * Options:
 *   --depth=quick|standard|comprehensive   Set research depth (default: standard)
 *   --status                               Show team status
 *   --reset                                Reset team (start fresh)
 *   --feedback=taskId                      Provide feedback for a task
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import type { Depth, UserFeedback } from './types.js';
import { DEPTH_CONFIGS, formatDuration } from './types.js';
import { 
  runResearchWorkflow, 
  processFeedback, 
  getTeamStatus, 
  resetTeam 
} from './agents/workflow.js';
import { readOutput, getOutputPath, outputExists, ARTIFACTS } from './tools/file-store.js';

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      depth: { type: 'string', default: 'standard' },
      status: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      feedback: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  // Help
  if (values.help) {
    printHelp();
    return;
  }

  // Status command
  if (values.status) {
    await showStatus();
    return;
  }

  // Reset command
  if (values.reset) {
    await resetTeam();
    console.log('✅ Team reset. All agents will be created fresh on next run.');
    return;
  }

  // Feedback command
  if (values.feedback) {
    await collectFeedback(values.feedback);
    return;
  }

  // Research query
  const query = positionals.join(' ');
  if (!query) {
    console.error('❌ Error: No research query provided');
    console.error('   Usage: bun cli.ts "your research query" [--depth=quick|standard|comprehensive]');
    process.exit(1);
  }

  // Validate depth
  const depth = values.depth as Depth;
  if (!['quick', 'standard', 'comprehensive'].includes(depth)) {
    console.error(`❌ Error: Invalid depth "${depth}"`);
    console.error('   Valid options: quick, standard, comprehensive');
    process.exit(1);
  }

  // Run research
  await runResearch(query, depth);
}

function printHelp() {
  console.log(`
🔬 Research Team CLI

A multi-agent academic research system with persistent memory.
TypeScript runs a researcher, analyst, and writer in sequence.

USAGE:
  bun examples/research-team/cli.ts "your research query" [options]

OPTIONS:
  --depth=LEVEL    Set research depth (default: standard)
                   - quick: ~5 min, 3 sources, brief report
                   - standard: ~15 min, 6 sources, thorough report
                   - comprehensive: ~30 min, 10 sources, extensive report
  
  --status         Show team status (agent IDs, completed tasks)
  --reset          Reset team state (creates fresh agents next run)
  --feedback=ID    Provide feedback for a completed task
  -h, --help       Show this help message

EXAMPLES:
  # Quick research on quantum computing
  bun cli.ts "quantum error correction techniques" --depth=quick

  # Standard research on AI
  bun cli.ts "chain of thought prompting in large language models"

  # Comprehensive climate research
  bun cli.ts "carbon capture and storage technologies" --depth=comprehensive

  # Check team status
  bun cli.ts --status

  # Provide feedback after a task
  bun cli.ts --feedback=task-1234567890-abc123

THE TEAM:
  📚 Researcher - Finds and evaluates academic sources
  🔍 Analyst - Synthesizes findings, identifies patterns
  ✍️  Writer - Produces polished research reports
  
  Each agent can reuse memory from earlier tasks and feedback.
`);
}

async function showStatus() {
  const status = await getTeamStatus();
  
  console.log('\n📊 Research Team Status\n');
  console.log(`Initialized: ${status.initialized ? '✅ Yes' : '❌ No'}`);
  console.log(`Completed Tasks: ${status.completedTasks}`);
  console.log('\nAgent IDs:');
  
  for (const [role, id] of Object.entries(status.agentIds)) {
    const emoji = id ? '✅' : '⬜';
    console.log(`  ${emoji} ${role}: ${id || '(not created yet)'}`);
  }
  
  if (status.completedTasks > 0) {
    console.log('\n💡 Tip: Run another query to observe what the agents retained.');
  }
  
  console.log('');
}

async function runResearch(query: string, depth: Depth) {
  const config = DEPTH_CONFIGS[depth];
  
  console.log('\n' + '═'.repeat(60));
  console.log('🔬 RESEARCH TEAM');
  console.log('═'.repeat(60));
  console.log(`\n📋 Query: "${query}"`);
  console.log(`📊 Depth: ${depth} (est. ${config.estimatedMinutes} min)`);
  console.log(`📚 Target Sources: ${config.sourcesCount}`);
  console.log('\n' + '─'.repeat(60) + '\n');

  const startTime = Date.now();
  
  try {
    const result = await runResearchWorkflow(query, depth);
    
    if (result.success) {
      console.log('\n' + '═'.repeat(60));
      console.log('✅ RESEARCH COMPLETE');
      console.log('═'.repeat(60));
      console.log(`\n⏱️  Duration: ${formatDuration(result.durationMs)}`);
      console.log(`📄 Report: ${getOutputPath(result.reportPath)}`);
      console.log(`🔖 Task ID: ${result.taskId}`);
      
      // Show report preview
      if (outputExists(result.reportPath)) {
        const report = await readOutput(result.reportPath);
        const preview = report.slice(0, 500);
        console.log('\n📝 Report Preview:');
        console.log('─'.repeat(40));
        console.log(preview + (report.length > 500 ? '...' : ''));
        console.log('─'.repeat(40));
      }
      
      console.log('\n💬 To ask each agent to reflect on this result:');
      console.log(`   bun cli.ts --feedback=${result.taskId}`);
      console.log('');
    } else {
      console.error('\n❌ Research failed. Check the logs above for details.');
    }
  } catch (error) {
    console.error('\n❌ Error during research:', error);
    process.exit(1);
  }
}

async function collectFeedback(taskId: string) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  const question = (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, resolve);
    });
  };
  
  console.log('\n📝 Feedback for Task: ' + taskId);
  console.log('─'.repeat(40));
  
  // Rating
  let rating = 0;
  while (rating < 1 || rating > 5) {
    const input = await question('Rate the research (1-5 stars): ');
    rating = parseInt(input, 10);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      console.log('Please enter a number between 1 and 5.');
      rating = 0;
    }
  }
  
  // Comment
  const comment = await question('What could be better? (optional, press Enter to skip): ');
  
  rl.close();
  
  const feedback: UserFeedback = {
    taskId,
    rating,
    comment: comment || undefined,
    timestamp: new Date(),
  };
  
  console.log('\n📤 Submitting feedback to team...\n');
  
  await processFeedback(taskId, feedback);
  
  console.log('\n✅ Feedback sent. Each agent was asked to store useful lessons.');
  console.log('');
}

// Run main
main().catch(console.error);
