#!/usr/bin/env bun

/**
 * Letta Agent SDK V2 Examples
 * 
 * Comprehensive tests for all SDK features.
 * 
 * Run with: bun examples/v2-examples.ts [example]
 */

import { LettaAgentClient, prompt } from '../src/index.js';

const client = new LettaAgentClient({ backend: 'local' });

async function main() {
  const example = process.argv[2] || 'basic';

  switch (example) {
    case 'basic':
      await basicSession();
      break;
    case 'multi-turn':
      await multiTurn();
      break;
    case 'one-shot':
      await oneShot();
      break;
    case 'resume':
      await sessionResume();
      break;
    case 'options':
      await testOptions();
      break;
    case 'message-types':
      await testMessageTypes();
      break;
    case 'session-properties':
      await testSessionProperties();
      break;
    case 'tool-execution':
      await testToolExecution();
      break;
    case 'permission-callback':
      await testPermissionCallback();
      break;
    case 'system-prompt':
      await testSystemPrompt();
      break;
    case 'memfs':
      await testMemfs();
      break;
    case 'agent-options':
      await testAgentOptions();
      break;
    case 'conversations':
      await testConversations();
      break;
    case 'all':
      await basicSession();
      await multiTurn();
      await oneShot();
      await sessionResume();
      await testOptions();
      await testMessageTypes();
      await testSessionProperties();
      await testToolExecution();
      await testPermissionCallback();
      await testSystemPrompt();
      await testMemfs();
      await testAgentOptions();
      await testConversations();
      console.log('\n✅ All examples passed');
      break;
    default:
      console.log('Usage: bun v2-examples.ts [basic|multi-turn|one-shot|resume|options|message-types|session-properties|tool-execution|permission-callback|system-prompt|memfs|agent-options|conversations|all]');
  }
}

// ═══════════════════════════════════════════════════════════════
// BASIC EXAMPLES
// ═══════════════════════════════════════════════════════════════

// Basic session with send/receive pattern
async function basicSession() {
  console.log('=== Basic Session ===\n');

  // Create agent, then resume default conversation
  const agentId = await client.createAgent();
  await using session = client.resumeSession(agentId, {
    permissionMode: 'unrestricted',
  });
  
  await session.send('Hello! Introduce yourself in one sentence.');

  let response = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
    }
    if (msg.type === 'result') {
      console.log(`Letta: ${response.trim()}`);
      console.log(`[Result: ${msg.success ? 'success' : 'failed'}, ${msg.durationMs}ms]`);
    }
  }
  console.log();
}

// Multi-turn conversation
async function multiTurn() {
  console.log('=== Multi-Turn Conversation ===\n');

  // Create new agent + new conversation
  await using session = client.createSession(await client.createAgent(), {
    model: 'haiku',
    permissionMode: 'unrestricted',
  });

  // Turn 1
  await session.send('What is 5 + 3? Just the number.');
  let turn1Result = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') turn1Result += msg.content;
  }
  console.log(`Turn 1: ${turn1Result.trim()}`);

  // Turn 2 - agent remembers context
  await session.send('Multiply that by 2. Just the number.');
  let turn2Result = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') turn2Result += msg.content;
  }
  console.log(`Turn 2: ${turn2Result.trim()}`);
  console.log();
}

// One-shot convenience function
async function oneShot() {
  console.log('=== One-Shot Prompt ===\n');

  // One-shot creates new agent
  const agentId = await client.createAgent();
  const result = await prompt('What is the capital of France? One word.', agentId);

  if (result.success) {
    console.log(`Answer: ${result.result}`);
    console.log(`Duration: ${result.durationMs}ms`);
  } else {
    console.log(`Error: ${result.error}`);
  }
  console.log();
}

// Session resume - with PERSISTENT MEMORY
async function sessionResume() {
  console.log('=== Session Resume (Persistent Memory) ===\n');

  // Create agent first
  const agentId = await client.createAgent();
  console.log(`[Setup] Created agent: ${agentId}\n`);

  // First session - establish a memory
  {
    const session = client.resumeSession(agentId, {
      permissionMode: 'unrestricted',
    });
    
    console.log('[Session 1] Teaching agent a secret word...');
    await session.send('Remember this secret word: "pineapple". Store it in your memory.');

    let response = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant') response += msg.content;
      if (msg.type === 'result') {
        console.log(`[Session 1] Agent: ${response.trim()}`);
      }
    }
    
    console.log(`[Session 1] Agent ID: ${session.agentId}\n`);
    session.close();
  }

  console.log('--- Session closed. Agent persists on server. ---\n');

  // Resume and verify agent remembers
  {
    await using session = client.resumeSession(agentId, {
      permissionMode: 'unrestricted',
    });
    
    console.log('[Session 2] Asking agent for the secret word...');
    await session.send('What is the secret word I told you to remember?');

    let response = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant') response += msg.content;
      if (msg.type === 'result') {
        console.log(`[Session 2] Agent: ${response.trim()}`);
      }
    }
  }
  console.log();
}

// ═══════════════════════════════════════════════════════════════
// OPTIONS TESTS
// ═══════════════════════════════════════════════════════════════

async function testOptions() {
  console.log('=== Testing Options ===\n');

  // Test basic session
  console.log('Testing basic session...');
  const agentId = await client.createAgent();
  const modelResult = await prompt('Say "model test ok"', agentId);
  console.log(`  basic: ${modelResult.success ? 'PASS' : 'FAIL'} - ${modelResult.result?.slice(0, 50)}`);

  // Test systemPrompt preset via createSession (only presets allowed)
  console.log('Testing systemPrompt preset...');
  const systemPromptAgentId = await client.createAgent({ systemPrompt: 'letta-claude' });
  const sysPromptSession = client.createSession(systemPromptAgentId, {
    permissionMode: 'unrestricted',
  });
  await sysPromptSession.send('Hello, what kind of agent are you?');
  let sysPromptResponse = '';
  for await (const msg of sysPromptSession.stream()) {
    if (msg.type === 'result') sysPromptResponse = msg.result || '';
  }
  sysPromptSession.close();
  console.log(`  systemPrompt preset: ${sysPromptResponse ? 'PASS' : 'FAIL'} - ${sysPromptResponse.slice(0, 80)}`);

  // Test cwd option via createSession
  console.log('Testing cwd option...');
  const cwdSession = client.createSession(await client.createAgent(), {
    cwd: '/tmp',
    allowedTools: ['Bash'],
    permissionMode: 'unrestricted',
  });
  await cwdSession.send('Run pwd to show current directory');
  let cwdResponse = '';
  for await (const msg of cwdSession.stream()) {
    if (msg.type === 'result') cwdResponse = msg.result || '';
  }
  cwdSession.close();
  const hasTmp = cwdResponse.includes('/tmp');
  console.log(`  cwd: ${hasTmp ? 'PASS' : 'CHECK'} - ${cwdResponse.slice(0, 60)}`);

  // Test allowedTools option with tool execution
  console.log('Testing allowedTools option...');
  const toolsSession = client.createSession(await client.createAgent(), {
    allowedTools: ['Bash'],
    permissionMode: 'unrestricted',
  });
  await toolsSession.send('Run: echo tool-test-ok');
  let toolsResponse = '';
  for await (const msg of toolsSession.stream()) {
    if (msg.type === 'result') toolsResponse = msg.result || '';
  }
  toolsSession.close();
  const hasToolOutput = toolsResponse.includes('tool-test-ok');
  console.log(`  allowedTools: ${hasToolOutput ? 'PASS' : 'CHECK'} - ${toolsResponse.slice(0, 60)}`);

  // Test permissionMode: unrestricted
  console.log('Testing permissionMode: unrestricted...');
  const unrestrictedSession = client.createSession(await client.createAgent(), {
    allowedTools: ['Bash'],
    permissionMode: 'unrestricted',
  });
  await unrestrictedSession.send('Run: echo unrestricted-test');
  let unrestrictedResponse = '';
  for await (const msg of unrestrictedSession.stream()) {
    if (msg.type === 'result') unrestrictedResponse = msg.result || '';
  }
  unrestrictedSession.close();
  const hasUnrestrictedOutput = unrestrictedResponse.includes('unrestricted-test');
  console.log(`  permissionMode: ${hasUnrestrictedOutput ? 'PASS' : 'CHECK'}`);

  console.log();
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE TYPES TESTS
// ═══════════════════════════════════════════════════════════════

async function testMessageTypes() {
  console.log('=== Testing Message Types ===\n');

  const agentId = await client.createAgent();
  const session = client.resumeSession(agentId, {
    permissionMode: 'unrestricted',
  });

  await session.send('Say "hello" exactly');

  let sawAssistant = false;
  let sawResult = false;
  let assistantContent = '';

  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      sawAssistant = true;
      assistantContent += msg.content;
      // Verify assistant message has uuid
      if (!msg.uuid) {
        console.log('  assistant.uuid: FAIL - missing uuid');
      }
    }
    if (msg.type === 'result') {
      sawResult = true;
      // Verify result message structure
      const hasSuccess = typeof msg.success === 'boolean';
      const hasDuration = typeof msg.durationMs === 'number';
      console.log(`  result.success: ${hasSuccess ? 'PASS' : 'FAIL'}`);
      console.log(`  result.durationMs: ${hasDuration ? 'PASS' : 'FAIL'}`);
      console.log(`  result.result: ${msg.result ? 'PASS' : 'FAIL (empty)'}`);
    }
  }

  console.log(`  assistant message received: ${sawAssistant ? 'PASS' : 'FAIL'}`);
  console.log(`  result message received: ${sawResult ? 'PASS' : 'FAIL'}`);

  session.close();
  console.log();
}

// ═══════════════════════════════════════════════════════════════
// SESSION PROPERTIES TESTS
// ═══════════════════════════════════════════════════════════════

async function testSessionProperties() {
  console.log('=== Testing Session Properties ===\n');

  // Create new agent + new conversation
  const session = client.createSession(await client.createAgent(), {
    model: 'haiku',
    permissionMode: 'unrestricted',
  });

  // Before send - properties should be null
  console.log(`  agentId before send: ${session.agentId === null ? 'PASS (null)' : 'FAIL'}`);
  console.log(`  sessionId before send: ${session.sessionId === null ? 'PASS (null)' : 'FAIL'}`);

  await session.send('Hi');
  for await (const _ of session.stream()) {
    // drain
  }

  // After send - properties should be set
  const hasAgentId = session.agentId !== null && session.agentId.startsWith('agent-');
  const hasSessionId = session.sessionId !== null;
  console.log(`  agentId after send: ${hasAgentId ? 'PASS' : 'FAIL'} - ${session.agentId}`);
  console.log(`  sessionId after send: ${hasSessionId ? 'PASS' : 'FAIL'} - ${session.sessionId}`);

  // Test close()
  session.close();
  console.log(`  close(): PASS (no error)`);

  console.log();
}

// ═══════════════════════════════════════════════════════════════
// TOOL EXECUTION TESTS
// ═══════════════════════════════════════════════════════════════

async function testToolExecution() {
  console.log('=== Testing Tool Execution ===\n');

  // Create a shared agent for tool tests
  const agentId = await client.createAgent();
  
  async function runWithTools(message: string, tools: string[]): Promise<string> {
    const session = client.createSession(agentId, {
      allowedTools: tools,
      permissionMode: 'unrestricted',
    });
    await session.send(message);
    let result = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'result') result = msg.result || '';
    }
    session.close();
    return result;
  }

  // Test 1: Basic command execution
  console.log('Testing basic command execution...');
  const echoResult = await runWithTools('Run: echo hello-world', ['Bash']);
  const hasHello = echoResult.includes('hello-world');
  console.log(`  echo command: ${hasHello ? 'PASS' : 'FAIL'}`);

  // Test 2: Command with arguments
  console.log('Testing command with arguments...');
  const argsResult = await runWithTools('Run: echo "arg1 arg2 arg3"', ['Bash']);
  const hasArgs = argsResult.includes('arg1') && argsResult.includes('arg3');
  console.log(`  echo with args: ${hasArgs ? 'PASS' : 'FAIL'}`);

  // Test 3: File reading with Glob
  console.log('Testing Glob tool...');
  const globResult = await runWithTools('List all .ts files in the current directory using Glob', ['Glob']);
  console.log(`  Glob tool: ${globResult ? 'PASS' : 'FAIL'}`);

  // Test 4: Multi-step tool usage (agent decides which tools to use)
  console.log('Testing multi-step tool usage...');
  const multiResult = await runWithTools('First run "echo step1", then run "echo step2". Show me both outputs.', ['Bash']);
  const hasStep1 = multiResult.includes('step1');
  const hasStep2 = multiResult.includes('step2');
  console.log(`  multi-step: ${hasStep1 && hasStep2 ? 'PASS' : 'PARTIAL'} (step1: ${hasStep1}, step2: ${hasStep2})`);

  console.log();
}

// ═══════════════════════════════════════════════════════════════
// PERMISSION CALLBACK TESTS
// ═══════════════════════════════════════════════════════════════

async function testPermissionCallback() {
  console.log('=== Testing Permission Callback ===\n');

  // Note: permissionMode 'standard' with NO allowedTools triggers callback
  // allowedTools auto-allows tools, bypassing the callback

  // Test 1: Allow specific commands via callback
  console.log('Testing canUseTool callback (allow)...');
  const allowSession = client.createSession(await client.createAgent(), {
    // NO allowedTools - this ensures callback is invoked
    permissionMode: 'standard',
    canUseTool: async (toolName, toolInput) => {
      console.error('CALLBACK:', toolName, toolInput);
      const command = (toolInput as { command?: string }).command || '';
      if (command.includes('callback-allowed')) {
        return { behavior: 'allow', updatedInput: null };
      }
      return { behavior: 'deny', message: 'Command not whitelisted' };
    },
  });
  await allowSession.send('Run: echo callback-allowed');
  let allowResult = '';
  for await (const msg of allowSession.stream()) {
    if (msg.type === 'result') allowResult = msg.result || '';
  }
  allowSession.close();
  const hasAllowed = allowResult.includes('callback-allowed');
  console.log(`  allow via callback: ${hasAllowed ? 'PASS' : 'FAIL'}`);

  // Test 2: Deny specific commands via callback
  console.log('Testing canUseTool callback (deny)...');
  const denySession = client.createSession(await client.createAgent(), {
    permissionMode: 'standard',
    canUseTool: async (toolName, toolInput) => {
      const command = (toolInput as { command?: string }).command || '';
      if (command.includes('dangerous')) {
        return { behavior: 'deny', message: 'Dangerous command blocked' };
      }
      return { behavior: 'allow', updatedInput: null };
    },
  });
  await denySession.send('Run: echo dangerous-command');
  let denyResult = '';
  for await (const msg of denySession.stream()) {
    if (msg.type === 'result') denyResult = msg.result || '';
  }
  denySession.close();
  // Agent should report that it couldn't execute the command
  const wasDenied = !denyResult.includes('dangerous-command');
  console.log(`  deny via callback: ${wasDenied ? 'PASS' : 'CHECK'}`);

  console.log();
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM PROMPT TESTS
// ═══════════════════════════════════════════════════════════════

async function testSystemPrompt() {
  console.log('=== Testing System Prompt Configuration ===\n');

  async function runWithSystemPrompt(msg: string, systemPrompt: any): Promise<string> {
    const agentId = await client.createAgent({ systemPrompt });
    const session = client.resumeSession(agentId, { permissionMode: 'unrestricted' });
    await session.send(msg);
    let result = '';
    for await (const m of session.stream()) {
      if (m.type === 'result') result = m.result || '';
    }
    session.close();
    return result;
  }

  // Test 1: Preset system prompt
  console.log('Testing preset system prompt...');
  const presetResult = await runWithSystemPrompt(
    'What kind of agent are you? One sentence.',
    { type: 'preset', preset: 'letta-claude' }
  );
  console.log(`  preset (letta-claude): ${presetResult ? 'PASS' : 'FAIL'}`);
  console.log(`    Response: ${presetResult.slice(0, 80)}...`);

  // Test 2: Preset with append
  console.log('Testing preset with append...');
  const appendResult = await runWithSystemPrompt(
    'Say hello',
    { type: 'preset', preset: 'letta-claude', append: 'Always end your responses with "🎉"' }
  );
  const hasEmoji = appendResult.includes('🎉');
  console.log(`  preset with append: ${hasEmoji ? 'PASS' : 'CHECK'}`);
  console.log(`    Response: ${appendResult.slice(0, 80)}...`);

  // Test 3: Custom string system prompt
  console.log('Testing custom string system prompt...');
  const customResult = await runWithSystemPrompt(
    'What is your specialty?',
    'You are a pirate captain. Always speak like a pirate.'
  );
  const hasPirateSpeak = customResult.toLowerCase().includes('arr') || 
                         customResult.toLowerCase().includes('matey') ||
                         customResult.toLowerCase().includes('ship');
  console.log(`  custom string: ${customResult ? 'PASS' : 'FAIL'}`);
  console.log(`    Response: ${customResult.slice(0, 80)}...`);

  // Test 4: Basic preset (claude - no skills/memory)
  console.log('Testing basic preset (claude)...');
  const basicResult = await runWithSystemPrompt(
    'Hello, just say hi back',
    { type: 'preset', preset: 'claude' }
  );
  console.log(`  basic preset (claude): ${basicResult ? 'PASS' : 'FAIL'}`);

  console.log();
}

// ═══════════════════════════════════════════════════════════════
// MEMORY FILESYSTEM TEST
// ═══════════════════════════════════════════════════════════════

async function testMemfs() {
  console.log('=== Testing Memory Filesystem ===\n');

  const agentId = await client.createAgent({
    memfs: true,
    systemPrompt: `Use focused Markdown files under reference/ for durable
knowledge. Never store secrets in memory.`,
  });
  await using session = client.resumeSession(agentId, {
    permissionMode: 'unrestricted',
  });
  const status = await session.getDeviceStatus();

  console.log(`  memory checkout: ${status.memoryDirectory ?? 'unavailable'}`);
  console.log(`  memfs: ${status.memoryDirectory ? 'PASS' : 'FAIL'}`);
  console.log();
}

// ═══════════════════════════════════════════════════════════════
// AGENT CREATION OPTIONS
// ═══════════════════════════════════════════════════════════════

async function testAgentOptions() {
  console.log('=== Testing Agent Creation Options ===\n');

  const agentId = await client.createAgent({
    personality: 'blank',
    memfs: true,
    name: 'SDK Example Agent',
    description: 'Demonstrates current agent creation options.',
    tags: ['example:v2'],
  });

  console.log(`  created agent: ${agentId}`);
  console.log();
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION TESTS
// ═══════════════════════════════════════════════════════════════

async function testConversations() {
  console.log('=== Testing Conversation Support ===\n');

  let conversationId1: string | null = null;
  let conversationId2: string | null = null;

  // Create agent first
  const agentId = await client.createAgent();
  console.log(`Created agent: ${agentId}\n`);

  // Test 1: Resume default conversation and get conversationId
  console.log('Test 1: Resume default conversation...');
  {
    const session = client.resumeSession(agentId, {
      permissionMode: 'unrestricted',
    });

    await session.send('Remember: the secret code is ALPHA. Store this in memory.');
    for await (const msg of session.stream()) {
      // drain
    }

    conversationId1 = session.conversationId;
    
    const hasConvId = conversationId1 !== null;
    
    console.log(`  agentId: ${session.agentId}`);
    console.log(`  conversationId: ${hasConvId ? 'PASS' : 'FAIL'} - ${conversationId1}`);
    
    session.close();
  }

  // Test 2: Create NEW conversation using createSession
  console.log('\nTest 2: Create new conversation (createSession)...');
  {
    const session = client.createSession(agentId, {
      permissionMode: 'unrestricted',
    });

    await session.send('Remember: the secret code for THIS conversation is BETA.');
    for await (const msg of session.stream()) {
      // drain
    }

    conversationId1 = session.conversationId;
    
    const isRealConvId = conversationId1 !== null && conversationId1 !== 'default';
    console.log(`  newConversation created: ${isRealConvId ? 'PASS' : 'FAIL'}`);
    console.log(`  conversationId: ${conversationId1}`);
    
    session.close();
  }

  // Test 3: Resume conversation by conversationId (auto-detects conv-xxx)
  console.log('\nTest 3: Resume conversation by conversationId...');
  if (conversationId1 === 'default') {
    console.log('  SKIP - "default" is not a real conversation ID');
    console.log('  Use client.resumeSession(agentId) to resume default conversation');
  } else {
    await using session = client.resumeSession(conversationId1!, {
      permissionMode: 'unrestricted',
    });

    await session.send('What is the secret code for this conversation?');
    
    let response = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant') response += msg.content;
    }

    const remembers = response.toLowerCase().includes('beta');
    console.log(`  client.resumeSession(convId): ${remembers ? 'PASS' : 'FAIL'}`);
    console.log(`  Response: ${response.slice(0, 80)}...`);
    
    // Verify same conversationId
    const sameConv = session.conversationId === conversationId1;
    console.log(`  same conversationId: ${sameConv ? 'PASS' : 'FAIL'}`);
  }

  // Test 4: Create another new conversation (verify different IDs)
  console.log('\nTest 4: Create another new conversation...');
  {
    await using session = client.createSession(agentId, {
      permissionMode: 'unrestricted',
    });

    await session.send('Say "third conversation"');
    
    let response = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant') response += msg.content;
    }

    conversationId2 = session.conversationId;
    
    // New conversation should have different ID
    const differentConv = conversationId2 !== conversationId1;
    console.log(`  different from conversationId1: ${differentConv ? 'PASS' : 'FAIL'}`);
    console.log(`  conversationId1: ${conversationId1}`);
    console.log(`  conversationId2: ${conversationId2}`);
  }

  // Test 5: Resume default conversation via client.resumeSession(agentId)
  console.log('\nTest 5: Resume default conversation via client.resumeSession(agentId)...');
  {
    await using session = client.resumeSession(agentId, {
      permissionMode: 'unrestricted',
    });

    await session.send('What is the secret code? (should be ALPHA from default conversation)');
    
    let response = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant') response += msg.content;
    }

    const remembersAlpha = response.toLowerCase().includes('alpha');
    console.log(`  client.resumeSession(agentId): ${remembersAlpha ? 'PASS' : 'CHECK'}`);
    console.log(`  Response: ${response.slice(0, 80)}...`);
  }

  // Test 6: conversationId in result message
  console.log('\nTest 6: conversationId in result message...');
  {
    await using session = client.resumeSession(conversationId1!, {
      permissionMode: 'unrestricted',
    });

    await session.send('Hi');
    
    let resultConvId: string | null = null;
    for await (const msg of session.stream()) {
      if (msg.type === 'result') {
        resultConvId = msg.conversationId;
      }
    }

    const hasResultConvId = resultConvId !== null;
    const matchesSession = resultConvId === session.conversationId;
    console.log(`  result.conversationId: ${hasResultConvId ? 'PASS' : 'FAIL'}`);
    console.log(`  matches session.conversationId: ${matchesSession ? 'PASS' : 'FAIL'}`);
  }


  console.log();
}

main().catch(console.error);
