#!/usr/bin/env bun

/**
 * Send one ACK-only message to the last environment used by this
 * agent/conversation, with a fallback to any online environment.
 *
 * Required:
 *   LETTA_API_KEY
 *   LETTA_AGENT_ID
 *
 * Optional:
 *   LETTA_CONVERSATION_ID (defaults to the agent's default conversation)
 *   LETTA_BASE_URL        (defaults to https://api.letta.com)
 *
 * Run:
 *   bun examples/remote-environments/send-to-last-used.ts "Continue where we left off."
 */

import { createRemoteAgent } from '../../src/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const input = process.argv.slice(2).join(' ') || 'Continue the previous remote task and summarize current status.';

const remoteAgent = createRemoteAgent({
  apiKey: requiredEnv('LETTA_API_KEY'),
  baseUrl: process.env.LETTA_BASE_URL,
  agentId: requiredEnv('LETTA_AGENT_ID'),
  conversationId: process.env.LETTA_CONVERSATION_ID,
  target: { lastUsed: true },
  fallback: 'any_online',
});

const target = await remoteAgent.resolveTarget();
console.log('Resolved remote target:');
console.log(`connectionId: ${target.connectionId}`);
if (target.environment) {
  console.log(`deviceId: ${target.environment.deviceId}`);
  console.log(`connectionName: ${target.environment.connectionName}`);
}

const dispatch = await remoteAgent.tell(input);
console.log('\nMessage dispatched.');
console.log(`clientMessageId: ${dispatch.clientMessageId}`);
console.log(`ack: ${dispatch.message}`);
