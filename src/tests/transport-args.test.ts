/**
 * Tests for buildCliArgs() — the real production function that builds
 * the CLI argument array passed to spawn().
 *
 * These tests exercise the actual transport code path, not a local replica.
 * SubprocessTransport.buildArgs() is a thin delegation to buildCliArgs(),
 * so testing buildCliArgs() directly covers the production spawn args.
 */
import { describe, expect, test } from "bun:test";
import { buildCliArgs } from "../transport.js";

// ─────────────────────────────────────────────────────────────────────────────
// Baseline: every invocation includes stream-json I/O and standard permissions.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliArgs — baseline args", () => {
  test("always includes --output-format stream-json and --input-format stream-json", () => {
    const args = buildCliArgs({});
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--input-format");
    const outIdx = args.indexOf("--output-format");
    expect(args[outIdx + 1]).toBe("stream-json");
    const inIdx = args.indexOf("--input-format");
    expect(args[inIdx + 1]).toBe("stream-json");
  });

  test("minimum invocation (empty options) produces exactly the baseline flags", () => {
    const args = buildCliArgs({});
    expect(args).toEqual([
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--permission-mode", "standard",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// includePartialMessages — the flag that started this investigation
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliArgs — includePartialMessages", () => {
  test("flag absent when includePartialMessages is undefined", () => {
    const args = buildCliArgs({ agentId: "agent-1" });
    expect(args).not.toContain("--include-partial-messages");
  });

  test("flag absent when includePartialMessages is false", () => {
    const args = buildCliArgs({ agentId: "agent-1", includePartialMessages: false });
    expect(args).not.toContain("--include-partial-messages");
  });

  test("flag present when includePartialMessages is true", () => {
    const args = buildCliArgs({ agentId: "agent-1", includePartialMessages: true });
    expect(args).toContain("--include-partial-messages");
  });

  test("flag appears after conversation/agent args, not before", () => {
    const args = buildCliArgs({
      agentId: "agent-1",
      conversationId: "conv-abc",
      includePartialMessages: true,
    });
    const convIdx = args.indexOf("--conversation");
    const flagIdx = args.indexOf("--include-partial-messages");
    expect(convIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(convIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation / agent routing
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliArgs — conversation and agent routing", () => {
  test("conversationId → --conversation flag (agent auto-derived from conv)", () => {
    const args = buildCliArgs({ conversationId: "conv-xyz" });
    const idx = args.indexOf("--conversation");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("conv-xyz");
    expect(args).not.toContain("--agent");
  });

  test("agentId only → --agent flag, no --new or --default", () => {
    const args = buildCliArgs({ agentId: "agent-1" });
    const idx = args.indexOf("--agent");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("agent-1");
    expect(args).not.toContain("--new");
    expect(args).not.toContain("--default");
  });

  test("agentId + newConversation → --agent + --new", () => {
    const args = buildCliArgs({ agentId: "agent-1", newConversation: true });
    expect(args).toContain("--agent");
    expect(args).toContain("--new");
    expect(args).not.toContain("--default");
  });

  test("agentId + defaultConversation → --agent + --conversation default", () => {
    const args = buildCliArgs({ agentId: "agent-1", defaultConversation: true });
    expect(args).toContain("--agent");
    const idx = args.indexOf("--conversation");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("default");
    expect(args).not.toContain("--new");
  });

  test("createOnly → --new-agent", () => {
    const args = buildCliArgs({ createOnly: true });
    expect(args).toContain("--new-agent");
  });

  test("newConversation without agentId → --new (LRU agent)", () => {
    const args = buildCliArgs({ newConversation: true });
    expect(args).toContain("--new");
    expect(args).not.toContain("--agent");
  });

  test("conversationId takes priority over agentId (conv wins)", () => {
    // When conversationId is set, --conversation is used and --agent is skipped
    const args = buildCliArgs({ conversationId: "conv-abc", agentId: "agent-1" });
    expect(args).toContain("--conversation");
    expect(args).not.toContain("--agent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model and embedding
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliArgs — model and embedding", () => {
  test("model option → -m flag", () => {
    const args = buildCliArgs({ model: "claude-sonnet-4" });
    const idx = args.indexOf("-m");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("claude-sonnet-4");
  });

  test("no model → no -m flag", () => {
    const args = buildCliArgs({});
    expect(args).not.toContain("-m");
  });

  test("embedding option → --embedding flag", () => {
    const args = buildCliArgs({ embedding: "text-embedding-3" });
    const idx = args.indexOf("--embedding");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("text-embedding-3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Permission mode
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliArgs — permission mode", () => {
  test("unrestricted → --permission-mode unrestricted", () => {
    const args = buildCliArgs({ permissionMode: "unrestricted" });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("unrestricted");
    expect(args).not.toContain("--yolo");
  });

  test("acceptEdits → --permission-mode acceptEdits", () => {
    const args = buildCliArgs({ permissionMode: "acceptEdits" });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("acceptEdits");
  });

  test("standard mode → --permission-mode standard", () => {
    const args = buildCliArgs({ permissionMode: "standard" });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("standard");
    expect(args).not.toContain("--yolo");
  });

  test("no permissionMode → standard permission mode", () => {
    const args = buildCliArgs({});
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("standard");
    expect(args).not.toContain("--yolo");
  });

  test("legacy bypassPermissions alias → unrestricted permission mode", () => {
    const args = buildCliArgs({ permissionMode: "bypassPermissions" as never });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("unrestricted");
    expect(args).not.toContain("--yolo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliArgs — system prompt", () => {
  test("preset string → --system <name>", () => {
    const args = buildCliArgs({ systemPrompt: "letta-claude" });
    const idx = args.indexOf("--system");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("letta-claude");
  });

  test("custom string → --system-custom <text>", () => {
    const args = buildCliArgs({ systemPrompt: "you are a helpful bot" });
    const idx = args.indexOf("--system-custom");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("you are a helpful bot");
    expect(args).not.toContain("--system");
  });

  test("preset object → --system <preset> + --system-append <text>", () => {
    const args = buildCliArgs({
      systemPrompt: { type: "preset", preset: "default", append: "extra context" },
    });
    expect(args).toContain("--system");
    expect(args).toContain("default");
    expect(args).toContain("--system-append");
    expect(args).toContain("extra context");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tools and tags
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliArgs — tools and tags", () => {
  test("allowedTools → --allowedTools joined with comma", () => {
    const args = buildCliArgs({ allowedTools: ["Read", "Write", "Bash"] });
    const idx = args.indexOf("--allowedTools");
    expect(args[idx + 1]).toBe("Read,Write,Bash");
  });

  test("disallowedTools → --disallowedTools joined with comma", () => {
    const args = buildCliArgs({ disallowedTools: ["EnterPlanMode"] });
    const idx = args.indexOf("--disallowedTools");
    expect(args[idx + 1]).toBe("EnterPlanMode");
  });

  test("createOnly leaves base tools to the CLI defaults when baseTools is omitted", () => {
    const args = buildCliArgs({ createOnly: true });
    expect(args).not.toContain("--base-tools");
  });

  test("createOnly passes --base-tools none for baseTools: []", () => {
    const args = buildCliArgs({ createOnly: true, baseTools: [] });
    const idx = args.indexOf("--base-tools");
    expect(args[idx + 1]).toBe("none");
  });

  test("createOnly passes explicit baseTools through", () => {
    const args = buildCliArgs({ createOnly: true, baseTools: ["web_search"] });
    const idx = args.indexOf("--base-tools");
    expect(args[idx + 1]).toBe("web_search");
  });

  test("existing-agent sessions never pass --base-tools", () => {
    const args = buildCliArgs({ agentId: "agent-1", baseTools: ["web_search"] });
    expect(args).not.toContain("--base-tools");
  });

  test("tags → --tags joined with comma", () => {
    const args = buildCliArgs({ tags: ["production", "v2"] });
    const idx = args.indexOf("--tags");
    expect(args[idx + 1]).toBe("production,v2");
  });

  test("createOnly adds SDK origin tag", () => {
    const args = buildCliArgs({ createOnly: true });
    const idx = args.indexOf("--tags");
    expect(args[idx + 1]).toBe("origin:letta-code");
  });

  test("createOnly preserves user tags and adds SDK origin tag", () => {
    const args = buildCliArgs({ createOnly: true, tags: ["production", "v2"] });
    const idx = args.indexOf("--tags");
    const tags = args[idx + 1]!.split(",");
    expect(tags).toEqual([
      "production",
      "v2",
      "origin:letta-code",
    ]);
  });

  test("createOnly does not duplicate SDK origin tag", () => {
    const args = buildCliArgs({
      createOnly: true,
      tags: ["origin:letta-code", "production", "origin:letta-code"],
    });
    const idx = args.indexOf("--tags");
    const tags = args[idx + 1]!.split(",");
    expect(tags).toEqual(["origin:letta-code", "production"]);
    expect(tags.filter((tag) => tag === "origin:letta-code")).toHaveLength(1);
  });

  test("empty tags array → no --tags flag", () => {
    const args = buildCliArgs({ tags: [] });
    expect(args).not.toContain("--tags");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory filesystem
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliArgs — memfs", () => {
  test("non-create sessions do not pass memfs flags", () => {
    const args = buildCliArgs({});
    expect(args).not.toContain("--memfs");
  });

  test("createOnly forces memfs enabled", () => {
    const args = buildCliArgs({ createOnly: true });
    expect(args).toContain("--memfs");
  });

  test("stale memfsStartup input is not forwarded", () => {
    const args = buildCliArgs({
      createOnly: true,
      memfsStartup: "skip",
    } as Parameters<typeof buildCliArgs>[0] & { memfsStartup: string });
    expect(args).toContain("--memfs");
    expect(args).not.toContain("--memfs-startup");
  });
});
