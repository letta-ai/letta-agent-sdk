import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { SubprocessTransport } from "./transport.js";

describe("CLI resolution", () => {
  test("resolves @letta-ai/letta-code via package main export", () => {
    // This is the resolution strategy used by findCli().
    // Previously we resolved "@letta-ai/letta-code/letta.js" which fails
    // with ERR_PACKAGE_PATH_NOT_EXPORTED because the subpath isn't in the
    // package.json exports field. The main export "." maps to "./letta.js".
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("@letta-ai/letta-code");
    expect(resolved).toBeDefined();
    expect(resolved.endsWith("letta.js")).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  test("subpath resolution fails without explicit export", () => {
    // This documents why we can't use the subpath directly.
    const require = createRequire(import.meta.url);
    expect(() => {
      require.resolve("@letta-ai/letta-code/letta.js");
    }).toThrow();
  });
});

describe("transport args", () => {
  function buildArgsFor(options: {
    permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
    allowedTools?: string[];
    disallowedTools?: string[];
  } = {}): string[] {
    const transport = new SubprocessTransport(options);
    // Access private helper for deterministic argument testing.
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    return (transport as any).buildArgs();
  }

  test("acceptEdits uses --permission-mode acceptEdits", () => {
    const args = buildArgsFor({ permissionMode: "acceptEdits" });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
    expect(args).not.toContain("--accept-edits");
  });

  test("plan mode uses --permission-mode plan", () => {
    const args = buildArgsFor({ permissionMode: "plan" });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
  });

  test("bypassPermissions still uses --yolo alias", () => {
    const args = buildArgsFor({ permissionMode: "bypassPermissions" });
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--permission-mode");
  });

  test("allowedTools and disallowedTools are forwarded to CLI flags", () => {
    const args = buildArgsFor({
      allowedTools: ["Read", "Bash"],
      disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
    });
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read,Bash");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("EnterPlanMode,ExitPlanMode");
  });
});
