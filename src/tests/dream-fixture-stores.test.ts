// End-to-end normalization over realistic on-disk fixture STORES, one per
// harness, mirroring the real stores' layouts and full line-type inventory
// (including the non-conversational noise each normalizer must skip:
// ai-title/mode/attachment/sidechain lines for Claude Code, turn_context /
// ghost_snapshot / encrypted reasoning for Codex, state-update events for
// OpenHands). The inline tests cover parsing details; these cover store
// discovery plus robustness against everything a real session file carries.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createClaudeCodeSource } from "../dream/sources/claude-code.js";
import { createCodexSource } from "../dream/sources/codex.js";
import { createOpenHandsSource } from "../dream/sources/openhands.js";

const FIXTURES = join(import.meta.dir, "fixtures", "dream");

describe("claude code fixture store", () => {
  const source = createClaudeCodeSource(join(FIXTURES, "claude-projects"));

  test("discovers the session with conversation-derived metadata", async () => {
    const sessions = await source.discover();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.sessionId).toBe(
      "1a2b3c4d-0000-4000-8000-000000000001",
    );
    expect(sessions[0]?.startTime).toBe("2026-07-01T10:00:01.000Z");
  });

  test("normalizes conversation and skips noise lines", async () => {
    const [session] = await source.discover();
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);
    const body = records.filter((r) => r.role !== "meta");

    expect(records[0]?.role).toBe("meta");
    expect(records[0]?.cwd).toBe("/tmp/demo-project");
    expect(records[0]?.model).toBe("claude-opus-4-6");
    // The text+tool_use assistant turn normalizes as two records: prose,
    // then the tool invocation.
    expect(body.map((r) => r.role)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
    const text = JSON.stringify(records);
    expect(text).not.toContain("sidechain chatter");
    expect(text).not.toContain("command-name");
    const toolCall = body.find((r) => r.tool_calls);
    expect(toolCall?.tool_calls?.[0]?.name).toBe("Bash");
  });
});

describe("codex fixture store", () => {
  const source = createCodexSource(join(FIXTURES, "codex-sessions"));

  test("discovers the rollout", async () => {
    const sessions = await source.discover();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.sessionId).toContain("019f0000");
  });

  test("normalizes conversation and skips wrappers, snapshots, injected context", async () => {
    const [session] = await source.discover();
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);
    const body = records.filter((r) => r.role !== "meta");

    expect(records[0]?.role).toBe("meta");
    expect(records[0]?.cwd).toBe("/tmp/demo-project");
    expect(body.map((r) => r.role)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "tool",
      "assistant",
    ]);
    const text = JSON.stringify(records);
    expect(text).not.toContain("environment_context");
    expect(text).not.toContain("ghost_commit");
    expect(text).not.toContain("encrypted");
    const toolCall = body.find((r) => r.tool_calls);
    expect(toolCall?.tool_calls?.[0]?.name).toBe("exec_command");
  });
});

describe("openhands fixture store", () => {
  const source = createOpenHandsSource();
  const convDir = join(FIXTURES, "openhands", "conv-demo");

  test("discovers and normalizes the conversation directory", async () => {
    const sessions = await source.discover(convDir);
    expect(sessions.length).toBe(1);
    const [session] = sessions;
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);
    const body = records.filter((r) => r.role !== "meta");

    expect(body.map((r) => r.role)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "tool",
      "assistant",
    ]);
    const text = JSON.stringify(records);
    expect(text).not.toContain("ConversationStateUpdateEvent");
    const toolResult = body.find((r) => r.role === "tool");
    expect(toolResult?.content).toContain("src/api.ts:40");
  });
});
