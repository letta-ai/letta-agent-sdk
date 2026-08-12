#!/usr/bin/env bun

/**
 * Web Chat Server
 * 
 * A simple web UI for chatting with a Letta agent.
 * 
 * Usage:
 *   bun server.ts              # Start server on port 3000
 *   bun server.ts --port=8080  # Custom port
 * 
 * Requirements:
 *   - LETTA_API_KEY for Cloud. Without it, the server uses the local backend.
 *   - Memory list/update uses Cloud REST and needs LETTA_API_KEY.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { type LettaCodeSession } from '../../src/index.js';
import { createAgentSession, createExampleClient, resumeExampleSession } from '../create-agent-session.js';
import Letta from '@letta-ai/letta-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'state.json');
const HTML_FILE = join(__dirname, 'index.html');

interface AppState {
  agentId: string | null;
}

let session: LettaCodeSession | null = null;
let state: AppState = { agentId: null };
const client = createExampleClient();
const isCloud = client.backend === 'cloud';

// Letta client for memory operations
const lettaClient = new Letta({
  baseURL: process.env.LETTA_BASE_URL || 'https://api.letta.com',
  apiKey: process.env.LETTA_API_KEY,
});

// Load state
async function loadState(): Promise<void> {
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
  }
}

// Save state
async function saveState(): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// Get or create session
async function getSession(): Promise<LettaCodeSession> {
  if (session) return session;

  if (state.agentId) {
    console.log(`Resuming agent: ${state.agentId}`);
    session = resumeExampleSession(state.agentId, {
      model: 'haiku',
      permissionMode: 'unrestricted',
    }, client);
  } else {
    console.log('Creating new agent...');
    session = await createAgentSession({
      model: 'haiku',
      systemPrompt: `You are a helpful assistant accessible through a web interface.

Be concise but friendly. You can help with:
- Answering questions
- Writing and reviewing code
- Brainstorming ideas
- General conversation

You have memory that persists across conversations. Use it to remember important context about the user and ongoing topics.`,
      memory: [
        {
          label: 'user-context',
          value: '# User Context\n\n(Nothing learned yet)',
          description: 'What I know about the user',
        },
        {
          label: 'conversation-notes', 
          value: '# Conversation Notes\n\n(No notes yet)',
          description: 'Important things from our conversations',
        },
      ],
      permissionMode: 'unrestricted',
    }, client);
  }

  return session;
}

// Parse args
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: 'string', default: '3000' },
  },
});

const PORT = parseInt(values.port!, 10);

// Load state on startup
await loadState();

console.log(`Starting web chat server on http://localhost:${PORT}`);

// Start server
Bun.serve({
  port: PORT,
  idleTimeout: 120, // 2 minutes for slow LLM responses
  
  async fetch(req) {
    const url = new URL(req.url);
    
    // Serve HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(HTML_FILE, 'utf-8');
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    
    // API: Get status
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return Response.json({
        agentId: state.agentId,
        connected: session !== null,
      });
    }
    
    // API: Chat (streaming)
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = (await req.json()) as { message?: unknown };
      const message = typeof body.message === 'string' ? body.message : '';
      
      if (!message) {
        return Response.json({ error: 'Message required' }, { status: 400 });
      }
      
      const sess = await getSession();
      
      // Save agent ID after first message
      if (!state.agentId && sess.agentId) {
        state.agentId = sess.agentId;
        await saveState();
        console.log(`Agent created: ${state.agentId}`);
      }
      
      // Stream response
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (data: object) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };
          
          try {
            await sess.send(message);
            
            for await (const msg of sess.stream()) {
              if (msg.type === 'assistant') {
                send({ type: 'text', content: msg.content });
              } else if (msg.type === 'tool_call' && 'toolName' in msg) {
                send({ type: 'tool', name: msg.toolName });
              } else if (msg.type === 'result') {
                // Update agent ID if we got it
                if (!state.agentId && sess.agentId) {
                  state.agentId = sess.agentId;
                  await saveState();
                }
              }
            }
            
            send({ type: 'done' });
            controller.close();
          } catch (err) {
            send({ type: 'error', message: String(err) });
            controller.close();
          }
        },
      });
      
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }
    
    // API: Get memory
    if (url.pathname === '/api/memory' && req.method === 'GET') {
      if (!state.agentId || !isCloud) {
        return Response.json({ blocks: [] });
      }
      
      try {
        const blocks = [];
        for await (const block of lettaClient.agents.blocks.list(state.agentId)) {
          blocks.push({
            label: block.label,
            value: block.value,
            description: block.description,
          });
        }
        return Response.json({ blocks });
      } catch (err) {
        console.error('Failed to read memory:', err);
        return Response.json({ blocks: [], error: String(err) });
      }
    }
    
    // API: Update memory
    if (url.pathname === '/api/memory' && req.method === 'POST') {
      if (!state.agentId || !isCloud) {
        return Response.json({ error: 'Memory edit requires a Cloud agent' }, { status: 400 });
      }
      
      const update = (await req.json()) as { label?: unknown; value?: unknown };
      const label = typeof update.label === 'string' ? update.label : '';
      const value = typeof update.value === 'string' ? update.value : undefined;
      if (!label || value === undefined) {
        return Response.json({ error: 'label and value required' }, { status: 400 });
      }
      
      try {
        await lettaClient.agents.blocks.update(label, {
          agent_id: state.agentId,
          value,
        });
        return Response.json({ ok: true });
      } catch (err) {
        console.error('Failed to update memory:', err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }
    
    // API: Reset
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (session) {
        session.close();
        session = null;
      }
      state = { agentId: null };
      await saveState();
      return Response.json({ ok: true });
    }
    
    return new Response('Not Found', { status: 404 });
  },
});
