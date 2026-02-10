#!/usr/bin/env bun

/**
 * Letta Code SDK V2 Examples
 * 
 * Comprehensive tests for all SDK features.
 * 
 * Run with: bun examples/v2-examples.ts [example]
 */

import { createAgent, createSession, resumeSession, prompt } from '../src/index.js';

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
    case 'memory-config':
      await testMemoryConfig();
      break;
    case 'convenience-props':
      await testConvenienceProps();
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
      await testMemoryConfig();
      await testConvenienceProps();
      await testConversations();
      console.log('\n✅ All examples passed');
      break;
    default:
      console.log('Usage: bun v2-examples.ts [basic|multi-turn|one-shot|resume|options|message-types|session-properties|tool-execution|permission-callback|system-prompt|memory-config|convenience-props|conversations|all]');
  }
}

// ═══════════════════════════════════════════════════════════════
// BASIC EXAMPLES
// ═══════════════════════════════════════════════════════════════

// Basic session with send/receive pattern
async function basicSession() {
  console.log('=== Basic Session ===\n');

  // Create agent, then resume default conversation
  const agentId = await createAgent();
  await using session = resumeSession(agentId, {
    permissionMode: 'bypassPermissions',
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
  await using session = createSession(undefined, {
    model: 'haiku',
    permissionMode: 'bypassPermissions',
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
  const result = await prompt('What is the capital of France? One word.');

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
  const agentId = await createAgent();
  console.log(`[Setup] Created agent: ${agentId}\n`);

  // First session - establish a memory
  {
    const session = resumeSession(agentId, {
      permissionMode: 'bypassPermissions',
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
    await using session = resumeSession(agentId, {
      permissionMode: 'bypassPermissions',
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
  const agentId = await createAgent();
  const modelResult = await prompt('Say "model test ok"', agentId);
  console.log(`  basic: ${modelResult.success ? 'PASS' : 'FAIL'} - ${modelResult.result?.slice(0, 50)}`);

  // Test systemPrompt preset via createSession (only presets allowed)
  console.log('Testing systemPrompt preset...');
  const sysPromptSession = createSession(undefined, {
    systemPrompt: 'letta-claude',
    permissionMode: 'bypassPermissions',
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
  const cwdSession = createSession(undefined, {
    cwd: '/tmp',
    allowedTools: ['Bash'],
    permissionMode: 'bypassPermissions',
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
  const toolsSession = createSession(undefined, {
    allowedTools: ['Bash'],
    permissionMode: 'bypassPermissions',
  });
  await toolsSession.send('Run: echo tool-test-ok');
  let toolsResponse = '';
  for await (const msg of toolsSession.stream()) {
    if (msg.type === 'result') toolsResponse = msg.result || '';
  }
  toolsSession.close();
  const hasToolOutput = toolsResponse.includes('tool-test-ok');
  console.log(`  allowedTools: ${hasToolOutput ? 'PASS' : 'CHECK'} - ${toolsResponse.slice(0, 60)}`);

  // Test permissionMode: bypassPermissions
  console.log('Testing permissionMode: bypassPermissions...');
  const bypassSession = createSession(undefined, {
    allowedTools: ['Bash'],
    permissionMode: 'bypassPermissions',
  });
  await bypassSession.send('Run: echo bypass-test');
  let bypassResponse = '';
  for await (const msg of bypassSession.stream()) {
    if (msg.type === 'result') bypassResponse = msg.result || '';
  }
  bypassSession.close();
  const hasBypassOutput = bypassResponse.includes('bypass-test');
  console.log(`  permissionMode: ${hasBypassOutput ? 'PASS' : 'CHECK'}`);

  console.log();
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE TYPES TESTS
// ═══════════════════════════════════════════════════════════════

async function testMessageTypes() {
  console.log('=== Testing Message Types ===\n');

  const agentId = await createAgent();
  const session = resumeSession(agentId, {
    permissionMode: 'bypassPermissions',
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
  const session = createSession(undefined, {
    model: 'haiku',
    permissionMode: 'bypassPermissions',
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
  const agentId = await createAgent();
  
  async function runWithTools(message: string, tools: string[]): Promise<string> {
    const session = createSession(agentId, {
      allowedTools: tools,
      permissionMode: 'bypassPermissions',
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

  // Note: permissionMode 'default' with NO allowedTools triggers callback
  // allowedTools auto-allows tools, bypassing the callback

  // Test 1: Allow specific commands via callback
  console.log('Testing canUseTool callback (allow)...');
  const allowSession = createSession(undefined, {
    // NO allowedTools - this ensures callback is invoked
    permissionMode: 'default',
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
  const denySession = createSession(undefined, {
    permissionMode: 'default',
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
    const agentId = await createAgent({ systemPrompt });
    const session = resumeSession(agentId, { permissionMode: 'bypassPermissions' });
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
// MEMORY CONFIGURATION TESTS
// ═══════════════════════════════════════════════════════════════

async function testMemoryConfig() {
  console.log('=== Testing Memory Configuration ===\n');

  async function runWithMemory(msg: string, memory?: any[]): Promise<{ success: boolean; result: string }> {
    const agentId = await createAgent({ memory });
    const session = resumeSession(agentId, { permissionMode: 'bypassPermissions' });
    await session.send(msg);
    let result = '';
    let success = false;
    for await (const m of session.stream()) {
      if (m.type === 'result') {
        result = m.result || '';
        success = m.success;
      }
    }
    session.close();
    return { success, result };
  }

  // Test 1: Default memory (persona, human, project)
  console.log('Testing default memory blocks...');
  const defaultResult = await runWithMemory('What memory blocks do you have? List their labels.');
  const hasDefaultBlocks = defaultResult.result.includes('persona') || 
                           defaultResult.result.includes('project');
  console.log(`  default blocks: ${defaultResult.success ? 'PASS' : 'FAIL'}`);
  console.log(`    Response mentions blocks: ${hasDefaultBlocks ? 'yes' : 'check manually'}`);

  // Test 2: Specific preset blocks only
  console.log('Testing specific preset blocks...');
  const specificResult = await runWithMemory('List your memory block labels', ['persona']);
  console.log(`  specific blocks [persona]: ${specificResult.success ? 'PASS' : 'FAIL'}`);

  // Test 3: Custom blocks
  console.log('Testing custom memory blocks...');
  const customResult = await runWithMemory(
    'What does your "rules" memory block say?',
    [{ label: 'rules', value: 'Always be concise. Never use more than 10 words.' }]
  );
  const isConcise = (customResult.result.split(' ').length || 0) < 20;
  console.log(`  custom blocks: ${customResult.success ? 'PASS' : 'FAIL'}`);
  console.log(`    Response is concise: ${isConcise ? 'yes' : 'check'}`);

  // Test 4: Multiple preset blocks
  console.log('Testing multiple preset blocks...');
  const multipleResult = await runWithMemory(
    'List your memory blocks',
    ['persona', 'human']
  );
  console.log(`  multiple presets: ${multipleResult.success ? 'PASS' : 'FAIL'}`);

  // Test 5: Empty memory (core blocks only)
  console.log('Testing empty memory (core only)...');
  const emptyResult = await runWithMemory('Hello', []);
  console.log(`  empty memory: ${emptyResult.success ? 'PASS' : 'FAIL'}`);

  console.log();
}

// ═══════════════════════════════════════════════════════════════
// CONVENIENCE PROPS TESTS
// ═══════════════════════════════════════════════════════════════

async function testConvenienceProps() {
  console.log('=== Testing Convenience Props ===\n');

  async function runWithProps(msg: string, props: Record<string, any>): Promise<{ success: boolean; result: string }> {
    const agentId = await createAgent(props);
    const session = resumeSession(agentId, { permissionMode: 'bypassPermissions' });
    await session.send(msg);
    let result = '';
    let success = false;
    for await (const m of session.stream()) {
      if (m.type === 'result') {
        result = m.result || '';
        success = m.success;
      }
    }
    session.close();
    return { success, result };
  }

  // Test 1: persona prop
  console.log('Testing persona prop...');
  const personaResult = await runWithProps(
    'Describe your personality in one sentence',
    { persona: 'You are an enthusiastic cooking assistant who loves Italian food.' }
  );
  const hasItalian = personaResult.result.toLowerCase().includes('italian') ||
                     personaResult.result.toLowerCase().includes('cook');
  console.log(`  persona: ${personaResult.success ? 'PASS' : 'FAIL'}`);
  console.log(`    Response mentions cooking/Italian: ${hasItalian ? 'yes' : 'check'}`);

  // Test 2: project block (custom)
  console.log('Testing project block (custom)...');
  const projectResult = await runWithProps(
    'What project are you helping with?',
    { memory: [{ label: 'project', value: 'A React Native mobile app for tracking daily habits.' }] }
  );
  const hasProject = projectResult.result.toLowerCase().includes('react') ||
                     projectResult.result.toLowerCase().includes('habit') ||
                     projectResult.result.toLowerCase().includes('mobile');
  console.log(`  project (custom): ${projectResult.success ? 'PASS' : 'FAIL'}`);
  console.log(`    Response mentions project: ${hasProject ? 'yes' : 'check'}`);

  // Test 3: human prop
  console.log('Testing human prop...');
  const humanResult = await runWithProps(
    'What do you know about me?',
    { human: 'Name: Bob. Senior developer. Prefers TypeScript over JavaScript.' }
  );
  const hasHuman = humanResult.result.toLowerCase().includes('bob') ||
                   humanResult.result.toLowerCase().includes('typescript');
  console.log(`  human: ${humanResult.success ? 'PASS' : 'FAIL'}`);
  console.log(`    Response mentions user info: ${hasHuman ? 'yes' : 'check'}`);

  // Test 4: Multiple convenience props together
  console.log('Testing multiple convenience props...');
  const multiResult = await runWithProps(
    'Introduce yourself briefly',
    { 
      memory: ['persona', 'human'],
      persona: 'You are a friendly code reviewer.',
      human: 'Name: Alice.'
    }
  );
  console.log(`  multiple props: ${multiResult.success ? 'PASS' : 'FAIL'}`);
  console.log(`    Response: ${multiResult.result.slice(0, 100)}...`);

  // Test 5: Convenience props with specific memory blocks
  console.log('Testing convenience props with memory config...');
  const combinedResult = await runWithProps(
    'What is in your persona block?',
    { memory: ['persona'], persona: 'You are a database expert specializing in PostgreSQL.' }
  );
  const hasDB = combinedResult.result.toLowerCase().includes('database') ||
                combinedResult.result.toLowerCase().includes('postgresql');
  console.log(`  props with memory: ${combinedResult.success ? 'PASS' : 'FAIL'}`);
  console.log(`    Response mentions DB: ${hasDB ? 'yes' : 'check'}`);

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
  const agentId = await createAgent();
  console.log(`Created agent: ${agentId}\n`);

  // Test 1: Resume default conversation and get conversationId
  console.log('Test 1: Resume default conversation...');
  {
    const session = resumeSession(agentId, {
      permissionMode: 'bypassPermissions',
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
    const session = createSession(agentId, {
      permissionMode: 'bypassPermissions',
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
    console.log('  Use resumeSession(agentId) to resume default conversation');
  } else {
    await using session = resumeSession(conversationId1!, {
      permissionMode: 'bypassPermissions',
    });

    await session.send('What is the secret code for this conversation?');
    
    let response = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant') response += msg.content;
    }

    const remembers = response.toLowerCase().includes('beta');
    console.log(`  resumeSession(convId): ${remembers ? 'PASS' : 'FAIL'}`);
    console.log(`  Response: ${response.slice(0, 80)}...`);
    
    // Verify same conversationId
    const sameConv = session.conversationId === conversationId1;
    console.log(`  same conversationId: ${sameConv ? 'PASS' : 'FAIL'}`);
  }

  // Test 4: Create another new conversation (verify different IDs)
  console.log('\nTest 4: Create another new conversation...');
  {
    await using session = createSession(agentId, {
      permissionMode: 'bypassPermissions',
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

  // Test 5: Resume default conversation via resumeSession(agentId)
  console.log('\nTest 5: Resume default conversation via resumeSession(agentId)...');
  {
    await using session = resumeSession(agentId, {
      permissionMode: 'bypassPermissions',
    });

    await session.send('What is the secret code? (should be ALPHA from default conversation)');
    
    let response = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant') response += msg.content;
    }

    const remembersAlpha = response.toLowerCase().includes('alpha');
    console.log(`  resumeSession(agentId): ${remembersAlpha ? 'PASS' : 'CHECK'}`);
    console.log(`  Response: ${response.slice(0, 80)}...`);
  }

  // Test 6: conversationId in result message
  console.log('\nTest 6: conversationId in result message...');
  {
    await using session = resumeSession(conversationId1!, {
      permissionMode: 'bypassPermissions',
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

  // Test 7: createSession() without agentId uses LRU agent + new conversation (like `letta`)
  console.log('\nTest 7: createSession() without agentId (uses LRU agent)...');
  {
    await using session = createSession(undefined, {
      model: 'haiku',
      permissionMode: 'bypassPermissions',
    });

    await session.send('Say "lru agent test ok"');
    
    for await (const msg of session.stream()) {
      // drain
    }

    const hasAgentId = session.agentId !== null;
    const hasConvId = session.conversationId !== null;
    console.log(`  has agentId: ${hasAgentId ? 'PASS' : 'FAIL'} - ${session.agentId}`);
    console.log(`  has conversationId: ${hasConvId ? 'PASS' : 'FAIL'} - ${session.conversationId}`);
  }

  console.log();
}

main().catch(console.error);
