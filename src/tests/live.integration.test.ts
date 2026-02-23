import { afterAll, describe, expect, test } from "bun:test";
import { createSession, resumeSession, type Session } from "../index.js";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKStreamEventMessage,
  ListMessagesResult,
} from "../types.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_KEY = process.env.LETTA_API_KEY;
const RUN_LIVE = process.env.LETTA_LIVE_INTEGRATION === "1" && !!API_KEY;
const RECORD_FIXTURES = process.env.LETTA_RECORD_FIXTURES === "1";
const BASE_URL = process.env.LETTA_BASE_URL ?? "https://api.letta.com";
const AGENT_ID_OVERRIDE = process.env.LETTA_AGENT_ID;
const CONVERSATION_ID_OVERRIDE = process.env.LETTA_CONVERSATION_ID;
const TEST_TIMEOUT_MS = Number(process.env.LETTA_LIVE_TEST_TIMEOUT_MS ?? "180000");

const describeLive = RUN_LIVE ? describe : describe.skip;

type AgentSummary = {
  id?: string;
  name?: string;
  tools?: Array<{ name?: string }>;
  tags?: string[];
};

let agentId = "";
let selectedAgentName = "";
let seededConversationId = "";
let ensureReadyPromise: Promise<void> | null = null;
const openedSessions: Session[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

function log(message: string, data?: unknown): void {
  if (data === undefined) {
    console.log(`[live-sdk:${nowIso()}] ${message}`);
    return;
  }
  console.log(`[live-sdk:${nowIso()}] ${message}`, data);
}

function hasTool(agent: AgentSummary, toolName: string): boolean {
  return !!agent.tools?.some((t) => t?.name === toolName);
}

function pickBestAgent(agents: AgentSummary[]): AgentSummary | null {
  if (agents.length === 0) return null;

  const byNameAndBash = agents.find(
    (a) => /big\s*chungus|lettabot/i.test(a.name ?? "") && hasTool(a, "Bash"),
  );
  if (byNameAndBash) return byNameAndBash;

  const byTagAndBash = agents.find(
    (a) => (a.tags ?? []).includes("origin:letta-code") && hasTool(a, "Bash"),
  );
  if (byTagAndBash) return byTagAndBash;

  const byBash = agents.find((a) => hasTool(a, "Bash"));
  if (byBash) return byBash;

  return agents.find((a) => typeof a.id === "string") ?? null;
}

async function discoverAgent(): Promise<{ id: string; name: string }> {
  if (AGENT_ID_OVERRIDE) return { id: AGENT_ID_OVERRIDE, name: "override" };
  if (!API_KEY) throw new Error("LETTA_API_KEY is required");

  const response = await fetch(`${BASE_URL}/v1/agents?limit=200`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to discover agent: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as AgentSummary[];
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("No agents found for LETTA_API_KEY");
  }

  const picked = pickBestAgent(payload);
  if (!picked?.id) throw new Error("Could not pick a valid agent from discovered agents");

  return { id: picked.id, name: picked.name ?? "unnamed" };
}

async function ensureAgentReady(): Promise<void> {
  if (agentId) return;
  if (!ensureReadyPromise) {
    ensureReadyPromise = (async () => {
      const discovered = await discoverAgent();
      agentId = discovered.id;
      selectedAgentName = discovered.name;
      log(`using agentId=${agentId} (${selectedAgentName})`);
    })();
  }
  await ensureReadyPromise;
}

function redactString(value: string): string {
  return value
    .replace(/sk-let-[A-Za-z0-9:=+/_-]+/g, "<redacted-api-key>")
    .replace(/\/Users\/[^\s"']+/g, "/Users/<redacted>");
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase().includes("token") || k.toLowerCase().includes("authorization")) {
        out[k] = "<redacted>";
      } else {
        out[k] = sanitizeValue(v);
      }
    }
    return out;
  }
  return value;
}

function summarizeMessage(message: SDKMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { type: message.type };

  if ("uuid" in message && typeof message.uuid === "string") {
    base.uuid = message.uuid;
  }

  switch (message.type) {
    case "assistant":
    case "reasoning":
      base.contentPreview = message.content.slice(0, 160);
      base.contentLength = message.content.length;
      break;
    case "tool_call":
      base.toolCallId = message.toolCallId;
      base.toolName = message.toolName;
      base.toolInput = sanitizeValue(message.toolInput);
      break;
    case "tool_result":
      base.toolCallId = message.toolCallId;
      base.isError = message.isError;
      base.contentPreview = message.content.slice(0, 160);
      base.contentLength = message.content.length;
      break;
    case "stream_event":
      base.event = sanitizeValue(message.event);
      break;
    case "result":
      base.success = message.success;
      base.error = message.error;
      base.stopReason = message.stopReason;
      base.durationMs = message.durationMs;
      base.conversationId = message.conversationId;
      break;
    case "error":
      base.message = message.message;
      base.stopReason = message.stopReason;
      base.runId = message.runId;
      base.apiError = sanitizeValue(message.apiError);
      break;
    case "retry":
      base.reason = message.reason;
      base.attempt = message.attempt;
      base.maxAttempts = message.maxAttempts;
      base.delayMs = message.delayMs;
      base.runId = message.runId;
      break;
    case "init":
      base.agentId = message.agentId;
      base.sessionId = message.sessionId;
      base.conversationId = message.conversationId;
      base.model = message.model;
      break;
  }

  return base;
}

async function writeFixture(name: string, body: unknown): Promise<void> {
  if (!RECORD_FIXTURES) return;

  const thisFile = fileURLToPath(import.meta.url);
  const fixtureDir = join(dirname(thisFile), "fixtures", "live");
  await mkdir(fixtureDir, { recursive: true });
  const target = join(fixtureDir, `${name}.json`);
  await writeFile(target, JSON.stringify(sanitizeValue(body), null, 2), "utf8");
  log(`wrote fixture ${target}`);
}

async function collectTurn(session: Session, prompt: string): Promise<SDKMessage[]> {
  await session.send(prompt);

  const messages: SDKMessage[] = [];
  const start = Date.now();

  for await (const message of session.stream()) {
    messages.push(message);
    if (Date.now() - start > TEST_TIMEOUT_MS) {
      throw new Error(`stream timed out after ${TEST_TIMEOUT_MS}ms`);
    }
  }

  return messages;
}

function expectTerminalResult(messages: SDKMessage[]): SDKResultMessage {
  const last = messages[messages.length - 1];
  expect(last).toBeDefined();
  expect(last?.type).toBe("result");
  return last as SDKResultMessage;
}

function hasRenderableContent(messages: SDKMessage[]): boolean {
  return messages.some((m) => m.type === "assistant" || m.type === "reasoning" || m.type === "stream_event");
}

function pickAnyMessageId(page: ListMessagesResult): string | null {
  for (const item of page.messages) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (typeof obj.id === "string") return obj.id;
    }
  }
  return null;
}

function assertRawMessageShape(page: ListMessagesResult): void {
  for (const item of page.messages) {
    expect(item && typeof item === "object").toBe(true);
    const obj = item as Record<string, unknown>;
    const discriminator = obj.message_type ?? obj.type;
    expect(typeof discriminator === "string").toBe(true);
  }
}

describeLive("live integration: letta-code-sdk", () => {
  afterAll(() => {
    for (const session of openedSessions) {
      session.close();
    }
    openedSessions.length = 0;
  });

  test(
    "createSession initialize returns stable init contract",
    async () => {
      await ensureAgentReady();

      const session = createSession(agentId, {
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
      });
      openedSessions.push(session);

      const init = await session.initialize();
      seededConversationId = init.conversationId;

      expect(init.type).toBe("init");
      expect(init.agentId).toBe(agentId);
      expect(init.sessionId.length).toBeGreaterThan(5);
      expect(init.conversationId.startsWith("conv-")).toBe(true);
      expect(Array.isArray(init.tools)).toBe(true);

      await writeFixture("init_contract", {
        selectedAgentName,
        init,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "resumeSession(conversationId) rehydrates existing conversation",
    async () => {
      await ensureAgentReady();

      const conversationId = CONVERSATION_ID_OVERRIDE || seededConversationId;
      expect(conversationId.startsWith("conv-")).toBe(true);

      const session = resumeSession(conversationId, {
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
      });
      openedSessions.push(session);

      const init = await session.initialize();
      expect(init.conversationId).toBe(conversationId);

      await writeFixture("resume_conversation_init", init);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "send + stream yields renderable messages and terminal result",
    async () => {
      await ensureAgentReady();

      const session = createSession(agentId, {
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
      });
      openedSessions.push(session);

      const init = await session.initialize();
      const nonce = Math.random().toString(36).slice(2, 8);
      const prompt = `Reply with exactly this text and nothing else: SDK_LIVE_OK_${nonce}`;

      const messages = await collectTurn(session, prompt);
      const result = expectTerminalResult(messages);

      expect(result.success).toBe(true);
      expect(result.conversationId).toBe(init.conversationId);
      expect(hasRenderableContent(messages)).toBe(true);

      await writeFixture("send_stream_basic", {
        init,
        prompt,
        messages: messages.map(summarizeMessage),
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "includePartialMessages=true contract: stream_event if available, otherwise assistant/reasoning fallback",
    async () => {
      await ensureAgentReady();

      const session = createSession(agentId, {
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
      });
      openedSessions.push(session);

      const init = await session.initialize();
      const prompt =
        "Produce 40 short bullet points about test observability. One bullet per line.";

      const messages = await collectTurn(session, prompt);
      const result = expectTerminalResult(messages);
      expect(result.success).toBe(true);

      const streamEvents = messages.filter((m): m is SDKStreamEventMessage => m.type === "stream_event");
      const deltaEvents = streamEvents.filter((m) => m.event.type === "content_block_delta");
      const fallbackRenderable = messages.filter((m) => m.type === "assistant" || m.type === "reasoning");

      expect(streamEvents.length + fallbackRenderable.length).toBeGreaterThan(0);
      if (deltaEvents.length === 0) {
        log("no stream_event delta observed on this turn; fallback render path still validated", {
          selectedAgentName,
          agentId,
        });
      }

      await writeFixture("stream_event_partials", {
        init,
        prompt,
        counts: {
          total: messages.length,
          streamEvents: streamEvents.length,
          deltaEvents: deltaEvents.length,
          assistantOrReasoning: fallbackRenderable.length,
        },
        messages: messages.map(summarizeMessage),
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "listMessages returns raw API messages and paginates",
    async () => {
      await ensureAgentReady();

      const session = createSession(agentId, {
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
      });
      openedSessions.push(session);

      const init = await session.initialize();

      await collectTurn(
        session,
        "Respond with two short lines proving this thread has content for backfill testing.",
      );

      const page1 = await session.listMessages({
        conversationId: init.conversationId,
        limit: 25,
        order: "desc",
      });

      expect(Array.isArray(page1.messages)).toBe(true);
      expect(page1.messages.length).toBeGreaterThan(0);
      expect(typeof page1.hasMore).toBe("boolean");
      assertRawMessageShape(page1);

      let page2: ListMessagesResult | null = null;
      if (page1.nextBefore) {
        page2 = await session.listMessages({
          conversationId: init.conversationId,
          before: page1.nextBefore,
          limit: 25,
          order: "desc",
        });
        expect(Array.isArray(page2.messages)).toBe(true);
        assertRawMessageShape(page2);
      }

      await writeFixture("list_messages_pagination", {
        init,
        page1Summary: {
          count: page1.messages.length,
          hasMore: page1.hasMore,
          nextBefore: page1.nextBefore,
          sampleId: pickAnyMessageId(page1),
          sampleDiscriminator:
            ((page1.messages[0] as Record<string, unknown> | undefined)?.message_type as string | undefined) ??
            ((page1.messages[0] as Record<string, unknown> | undefined)?.type as string | undefined) ??
            null,
        },
        page2Summary: page2
          ? {
              count: page2.messages.length,
              hasMore: page2.hasMore,
              nextBefore: page2.nextBefore,
              sampleId: pickAnyMessageId(page2),
            }
          : null,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "listMessages is safe while stream is active",
    async () => {
      await ensureAgentReady();

      const session = createSession(agentId, {
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
      });
      openedSessions.push(session);

      const init = await session.initialize();
      const prompt =
        "Write a medium-length response with at least 30 numbered lines describing integration test anti-patterns.";

      await session.send(prompt);

      const streamMessages: SDKMessage[] = [];
      const streamPromise = (async () => {
        for await (const m of session.stream()) {
          streamMessages.push(m);
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 250));
      const page = await session.listMessages({
        conversationId: init.conversationId,
        limit: 10,
        order: "desc",
      });

      expect(Array.isArray(page.messages)).toBe(true);
      expect(page.messages.length).toBeGreaterThan(0);

      await streamPromise;
      const result = expectTerminalResult(streamMessages);
      expect(result.success).toBe(true);

      await writeFixture("list_messages_during_stream", {
        init,
        pageSummary: {
          count: page.messages.length,
          hasMore: page.hasMore,
          nextBefore: page.nextBefore,
        },
        streamSummary: streamMessages.map(summarizeMessage),
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "tool lifecycle contract (best-effort): if tool_call appears, tool_result must correlate",
    async () => {
      await ensureAgentReady();

      const session = createSession(agentId, {
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
      });
      openedSessions.push(session);

      await session.initialize();

      const attempts: Array<{ prompt: string; messages: SDKMessage[] }> = [];
      const prompts = [
        "Use the Bash tool to run: echo LETTA_SDK_LIVE_TOOL_1. Then return only the command output.",
        "You must invoke Bash. Run exactly: echo LETTA_SDK_LIVE_TOOL_2 and report the output.",
        "Call Bash now: echo LETTA_SDK_LIVE_TOOL_3",
      ];

      let toolCalls: Array<Extract<SDKMessage, { type: "tool_call" }>> = [];
      let toolResults: Array<Extract<SDKMessage, { type: "tool_result" }>> = [];

      for (const prompt of prompts) {
        const messages = await collectTurn(session, prompt);
        attempts.push({ prompt, messages });
        toolCalls = messages.filter((m): m is Extract<SDKMessage, { type: "tool_call" }> => m.type === "tool_call");
        toolResults = messages.filter((m): m is Extract<SDKMessage, { type: "tool_result" }> => m.type === "tool_result");
        if (toolCalls.length > 0) break;
      }

      if (toolCalls.length === 0) {
        log("tool lifecycle best-effort test observed no tool_call on this agent/model; not failing", {
          selectedAgentName,
          agentId,
        });
      } else {
        expect(toolResults.length).toBeGreaterThan(0);
        const callIds = new Set(toolCalls.map((m) => m.toolCallId));
        for (const result of toolResults) {
          expect(callIds.has(result.toolCallId)).toBe(true);
        }
      }

      await writeFixture("tool_lifecycle", {
        selectedAgentName,
        attempts: attempts.map((a) => ({
          prompt: a.prompt,
          messages: a.messages.map(summarizeMessage),
        })),
      });
    },
    TEST_TIMEOUT_MS,
  );
});
