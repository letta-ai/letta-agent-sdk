#!/usr/bin/env bun

/**
 * Lower-level RemoteEnvironmentClient example.
 *
 * Lists remote environments, chooses a target from environment variables, and
 * dispatches one ACK-only message.
 *
 * Required:
 *   LETTA_API_KEY
 *   LETTA_AGENT_ID
 *
 * Optional selectors, checked in this order:
 *   LETTA_REMOTE_DEVICE_ID
 *   LETTA_REMOTE_ENVIRONMENT_ID
 *   LETTA_REMOTE_CONNECTION_NAME
 *   LETTA_REMOTE_CONNECTION_ID
 *
 * If no selector is provided, the script uses the first online environment.
 *
 * Run:
 *   bun examples/remote-environments/list-and-send.ts --list-only
 *   bun examples/remote-environments/list-and-send.ts "Run pwd and summarize the repo."
 */

import {
  RemoteEnvironmentClient,
  type RemoteEnvironmentConnection,
  type RemoteEnvironmentTarget,
} from '../../src/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function targetFromEnv(onlineEnvironments: RemoteEnvironmentConnection[]): RemoteEnvironmentTarget {
  if (process.env.LETTA_REMOTE_DEVICE_ID) {
    return { deviceId: process.env.LETTA_REMOTE_DEVICE_ID };
  }
  if (process.env.LETTA_REMOTE_ENVIRONMENT_ID) {
    return { environmentId: process.env.LETTA_REMOTE_ENVIRONMENT_ID };
  }
  if (process.env.LETTA_REMOTE_CONNECTION_NAME) {
    return { connectionName: process.env.LETTA_REMOTE_CONNECTION_NAME };
  }
  if (process.env.LETTA_REMOTE_CONNECTION_ID) {
    return { connectionId: process.env.LETTA_REMOTE_CONNECTION_ID };
  }

  const firstOnline = onlineEnvironments.find((environment) => environment.connectionId);
  if (!firstOnline?.connectionId) {
    throw new Error('No online remote environments found. Start `letta server` first.');
  }

  return { connectionId: firstOnline.connectionId };
}

function describeTarget(target: RemoteEnvironmentTarget): string {
  if ('deviceId' in target) return `deviceId=${target.deviceId}`;
  if ('environmentId' in target) return `environmentId=${target.environmentId}`;
  if ('connectionName' in target) return `connectionName=${target.connectionName}`;
  if ('connectionId' in target) return `connectionId=${target.connectionId}`;
  return 'lastUsed=true';
}

const listOnly = process.argv.includes('--list-only');
const input = process.argv
  .slice(2)
  .filter((arg) => arg !== '--list-only')
  .join(' ') || 'Run pwd and summarize the current working directory.';

const client = new RemoteEnvironmentClient({
  apiKey: requiredEnv('LETTA_API_KEY'),
  baseUrl: process.env.LETTA_BASE_URL,
});

const { connections } = await client.listEnvironments();
const rows = connections.map((environment) => ({
  id: environment.id,
  deviceId: environment.deviceId,
  connectionName: environment.connectionName,
  connectionId: environment.connectionId ?? '(offline)',
  online: Boolean(environment.connectionId),
  lastSeenAt: new Date(environment.lastSeenAt).toISOString(),
}));

console.table(rows);

if (listOnly) {
  process.exit(0);
}

const target = targetFromEnv(connections);
console.log(`Dispatching to ${describeTarget(target)}...`);

const dispatch = await client.sendMessage({
  agentId: requiredEnv('LETTA_AGENT_ID'),
  conversationId: process.env.LETTA_CONVERSATION_ID,
  target,
  input,
});

console.log('\nMessage dispatched.');
console.log(`connectionId: ${dispatch.connectionId}`);
console.log(`clientMessageId: ${dispatch.clientMessageId}`);
console.log(`ack: ${dispatch.message}`);
