#!/usr/bin/env bun

/**
 * Teleport Example
 * 
 * Demonstrates Letta's "agent teleportation" - taking agents trained
 * in one context and using them in another.
 * 
 * Prerequisites:
 *   1. Run the research team demo first to create trained agents:
 *      bun cli.ts "some topic" --depth=quick
 *   
 *   2. Check that agents exist:
 *      bun cli.ts --status
 * 
 * Usage:
 *   bun teleport-example.ts
 */

import { resumeExampleSession, createExampleClient } from '../create-agent-session.js';
import { loadTeamState } from './tools/file-store.js';

const client = createExampleClient({ backend: 'local' });

async function main() {
  console.log('🚀 Agent Teleportation Demo\n');
  console.log('This example shows how to "teleport" agents trained in the CLI');
  console.log('into a completely different context (like an API, bot, or script).\n');
  console.log('═'.repeat(60) + '\n');

  // Load the team state (contains agent IDs from previous runs)
  const teamState = await loadTeamState();

  // Check if agents exist
  if (!teamState.agentIds.researcher) {
    console.error('❌ No researcher agent found!');
    console.error('   Run the demo first: bun cli.ts "quantum computing" --depth=quick');
    process.exit(1);
  }

  console.log('📋 Found trained agents:\n');
  
  for (const [role, agentId] of Object.entries(teamState.agentIds)) {
    if (agentId) {
      console.log(`   ${role}: ${agentId}`);
      console.log(`   → https://chat.letta.com/agents/${agentId}\n`);
    }
  }

  console.log(`📊 These agents have completed ${teamState.completedTasks} task(s)`);
  console.log('   and learned from the experience.\n');
  console.log('═'.repeat(60) + '\n');

  // Example 1: Teleport the researcher for a quick question
  console.log('📚 Example 1: Teleport Researcher\n');
  console.log('   The researcher remembers which sources are reliable');
  console.log('   and which search strategies work best.\n');

  const researcher = resumeExampleSession(teamState.agentIds.researcher!, {
    allowedTools: ['Read', 'Write'],
    permissionMode: 'unrestricted',
  }, client);

  console.log('   Asking: "What search strategies have you found effective?"\n');
  
  await researcher.send(
    'Based on your experience and memory, what search strategies have you found most effective? ' +
    'What types of sources tend to be most reliable? Just give me a brief summary from your memory.'
  );

  let researcherResponse = '';
  for await (const msg of researcher.stream()) {
    if (msg.type === 'assistant') {
      researcherResponse += msg.content;
      process.stdout.write('.');
    }
  }
  console.log('\n');
  console.log('   Researcher says:');
  console.log('   ' + researcherResponse.slice(0, 500).split('\n').join('\n   '));
  if (researcherResponse.length > 500) console.log('   ...\n');
  
  researcher.close();

  // Example 2: Teleport the analyst
  if (teamState.agentIds.analyst) {
    console.log('\n' + '═'.repeat(60) + '\n');
    console.log('🔍 Example 2: Teleport Analyst\n');
    console.log('   The analyst remembers effective analysis patterns');
    console.log('   and quality standards from previous work.\n');

    const analyst = resumeExampleSession(teamState.agentIds.analyst, {
      allowedTools: ['Read', 'Write'],
      permissionMode: 'unrestricted',
    }, client);

    console.log('   Asking: "What analysis frameworks have worked well?"\n');

    await analyst.send(
      'Based on your experience and memory, what analysis frameworks or approaches ' +
      'have you found most effective? Brief summary from your memory.'
    );

    let analystResponse = '';
    for await (const msg of analyst.stream()) {
      if (msg.type === 'assistant') {
        analystResponse += msg.content;
        process.stdout.write('.');
      }
    }
    console.log('\n');
    console.log('   Analyst says:');
    console.log('   ' + analystResponse.slice(0, 500).split('\n').join('\n   '));
    if (analystResponse.length > 500) console.log('   ...\n');

    analyst.close();
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('✅ TELEPORTATION COMPLETE');
  console.log('═'.repeat(60) + '\n');
  
  console.log('Key takeaways:\n');
  console.log('1. Agents trained via CLI were "teleported" into this script');
  console.log('2. They retained all their learned knowledge and memories');
  console.log('3. Same agents could be teleported into: API, Slack bot, GitHub Action, etc.\n');
  
  console.log('Try it yourself:\n');
  console.log('   // In your own code:');
  console.log('   import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";');
  console.log('   const client = new LettaAgentClient({ backend: "local" });');
  console.log(`   const agent = client.resumeSession("${teamState.agentIds.researcher}");`);
  console.log('   await agent.send("Your question here");');
  console.log('');
}

main().catch(console.error);
