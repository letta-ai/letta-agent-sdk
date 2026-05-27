#!/usr/bin/env bun

/**
 * Send one ACK-only message to a Letta Code remote by stable device ID.
 *
 * Required:
 *   LETTA_API_KEY
 *   LETTA_AGENT_ID
 *   LETTA_REMOTE_DEVICE_ID
 *
 * Optional:
 *   LETTA_CONVERSATION_ID (defaults to the agent's default conversation)
 *   LETTA_BASE_URL        (defaults to https://api.letta.com)
 *
 * Run:
 *   bun examples/remote-environments/send-to-device.ts "Run tests and summarize failures."
 */

import { createRemoteAgent } from '../../src/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const input = process.argv.slice(2).join(' ') || 'Say hello from this remote environment.';

const remoteAgent = createRemoteAgent({
  apiKey: requiredEnv('LETTA_API_KEY'),
  baseUrl: process.env.LETTA_BASE_URL,
  agentId: requiredEnv('LETTA_AGENT_ID'),
  conversationId: process.env.LETTA_CONVERSATION_ID,
  target: { deviceId: requiredEnv('LETTA_REMOTE_DEVICE_ID') },
  fallback: 'fail_if_unavailable',
});

const dispatch = await remoteAgent.tell(input);

console.log('Message dispatched to remote environment.');
console.log(`connectionId: ${dispatch.connectionId}`);
console.log(`clientMessageId: ${dispatch.clientMessageId}`);
console.log(`ack: ${dispatch.message}`);
console.log('\nThis SDK helper is ACK-only today; watch the remote Letta Code session for the response.');
