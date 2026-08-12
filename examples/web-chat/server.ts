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
 *   - The memory-file panel uses a Cloud repository and needs LETTA_API_KEY.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { type LettaCodeSession } from '../../src/index.js';
import { createAgentSession, createExampleClient, resumeExampleSession } from '../create-agent-session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'state.json');
const HTML_FILE = join(__dirname, 'index.html');

interface AppState {
  agentId: string | null;
  repositoryId: string | null;
  backend: 'cloud' | 'local' | null;
}

let session: LettaCodeSession | null = null;
let state: AppState = { agentId: null, repositoryId: null, backend: null };
const client = createExampleClient();
const isCloud = client.backend === 'cloud';
const backend = isCloud ? 'cloud' : 'local';

// Load state
async function loadState(): Promise<void> {
  if (existsSync(STATE_FILE)) {
    const stored = JSON.parse(await readFile(STATE_FILE, 'utf-8')) as Partial<AppState>;
    state = {
      agentId: stored.agentId ?? null,
      repositoryId: stored.repositoryId ?? null,
      backend: stored.backend
        ?? (stored.agentId?.startsWith('agent-local-') ? 'local' : stored.agentId ? 'cloud' : null),
    };
  }
}

// Save state
async function saveState(): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function ensureMemoryRepository(agentId: string): Promise<string | null> {
  if (!isCloud) return null;

  if (!state.repositoryId) {
    const repository = await client.repositories.create({
      name: `web-chat-${agentId}`,
    });
    state.repositoryId = repository.id;
    await saveState();
  }

  const seedFiles = [
    {
      path: 'user-context.md',
      content: '# User context\n\nNothing learned yet.\n',
    },
    {
      path: 'conversation-notes.md',
      content: '# Conversation notes\n\nNo notes yet.\n',
    },
  ];
  const listing = await client.repositories.files.list(state.repositoryId);
  for (const seed of seedFiles) {
    if (!listing.files.some((entry) => entry.path === seed.path)) {
      await client.repositories.files.create(state.repositoryId, seed);
    }
  }

  const repositories = await client.agents.repositories.list(agentId);
  const attached = repositories.find(
    (repository) => repository.id === state.repositoryId,
  );
  if (!attached || attached.permissions !== 'read_write') {
    await client.agents.repositories.attach(agentId, state.repositoryId, {
      permissions: 'read_write',
    });
  }
  await saveState();
  return state.repositoryId;
}

// Get or create session
async function getSession(): Promise<LettaCodeSession> {
  if (session) return session;

  if (state.agentId && state.backend && state.backend !== backend) {
    throw new Error(
      `Saved web-chat state uses the ${state.backend} backend. ` +
      `Start with the same backend or reset examples/web-chat/state.json.`,
    );
  }

  if (state.agentId) {
    console.log(`Resuming agent: ${state.agentId}`);
    await ensureMemoryRepository(state.agentId);
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

You have memory that persists across conversations. ${isCloud
        ? 'Keep user context in the attached user-context.md and conversation-notes.md repository files.'
        : 'Keep user context in focused files under reference/ in your memory checkout.'}`,
      memfs: true,
      permissionMode: 'unrestricted',
    }, client);
    if (session.agentId) {
      state.agentId = session.agentId;
      state.backend = backend;
      await saveState();
      await ensureMemoryRepository(session.agentId);
    }
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
    
    // API: Get attached memory-repository files
    if (url.pathname === '/api/memory' && req.method === 'GET') {
      if (!state.agentId || !state.repositoryId || !isCloud) {
        return Response.json({ files: [], available: false });
      }
      
      try {
        const listing = await client.repositories.files.list(state.repositoryId);
        const files = await Promise.all(
          listing.files
            .filter((entry) => entry.type === 'file')
            .map((entry) => client.repositories.files.read(state.repositoryId!, {
              path: entry.path,
            })),
        );
        return Response.json({ files, available: true });
      } catch (err) {
        console.error('Failed to read memory files:', err);
        return Response.json({ files: [], available: true, error: String(err) });
      }
    }
    
    // API: Create or update one attached memory-repository file
    if (url.pathname === '/api/memory' && req.method === 'POST') {
      if (!state.agentId || !state.repositoryId || !isCloud) {
        return Response.json({ error: 'Memory files require a Cloud agent' }, { status: 400 });
      }
      
      const update = (await req.json()) as { path?: unknown; content?: unknown };
      const path = typeof update.path === 'string' ? update.path : '';
      const content = typeof update.content === 'string' ? update.content : undefined;
      const validPath = path.endsWith('.md') && path.split('/').every(
        (part) => part.length > 0 && part !== '.' && part !== '..',
      );
      if (!validPath || content === undefined) {
        return Response.json({ error: 'A safe .md path and content are required' }, { status: 400 });
      }
      
      try {
        const listing = await client.repositories.files.list(state.repositoryId);
        if (listing.files.some((entry) => entry.type === 'file' && entry.path === path)) {
          const current = await client.repositories.files.read(state.repositoryId, { path });
          await client.repositories.files.update(state.repositoryId, {
            path,
            content,
            precondition: { contentSha256: current.contentSha256 },
          });
        } else {
          await client.repositories.files.create(state.repositoryId, { path, content });
        }
        return Response.json({ ok: true });
      } catch (err) {
        console.error('Failed to update memory file:', err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }
    
    // API: Reset
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (session) {
        session.close();
        session = null;
      }
      state = { agentId: null, repositoryId: null, backend: null };
      await saveState();
      return Response.json({ ok: true });
    }
    
    return new Response('Not Found', { status: 404 });
  },
});
