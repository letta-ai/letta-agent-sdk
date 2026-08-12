import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKResultMessage } from "../src/index.js";
import {
  authorizePilotTool,
  buildChildEnvironment,
  buildReport,
  commandArgv,
  executeCommandArgv,
  executeSelectedProfileOnce,
  parseProfile,
  renderMarkdown,
  resolveRepositoryPath,
  sanitizeText,
  type CommandAttempt,
  type ExecutorState,
} from "./grumble-repro-pilot.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "grumble-repro-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function attempt(overrides: Partial<CommandAttempt> = {}): CommandAttempt {
  return {
    argv: ["bun", "test"],
    exitCode: 0,
    timedOut: false,
    durationMs: 25,
    stdout: "pass",
    stderr: "",
    ...overrides,
  };
}

const successfulResult = {
  type: "result",
  success: true,
  durationMs: 10,
  conversationId: "conv-test",
} as SDKResultMessage;

describe("repository path confinement", () => {
  test("rejects lexical traversal", async () => {
    const root = await temporaryDirectory();
    await expect(resolveRepositoryPath(root, "../outside.txt")).rejects.toThrow("escapes repository root");
  });

  test("rejects symlinks that resolve outside the checkout", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "repo");
    const outside = join(parent, "outside.txt");
    await mkdir(root);
    await writeFile(outside, "private");
    await symlink(outside, join(root, "escape"));
    await expect(resolveRepositoryPath(root, "escape")).rejects.toThrow("resolves outside repository root");
  });

  test("accepts a real file inside the checkout", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "inside.txt");
    await writeFile(file, "ok");
    expect(await resolveRepositoryPath(root, "inside.txt")).toBe(await realpath(file));
  });
});

describe("fixed command profiles", () => {
  test("preserves the exact argv for every approved profile", () => {
    expect(commandArgv(parseProfile("unit"))).toEqual(["bun", "test"]);
    expect(commandArgv(parseProfile("check"))).toEqual(["bun", "run", "check"]);
    expect(commandArgv(parseProfile("build"))).toEqual(["bun", "run", "build"]);
    expect(commandArgv(parseProfile("local-app-server-test"))).toEqual([
      "bun",
      "test",
      "src/tests/local-app-server.test.ts",
    ]);
  });

  test("rejects an unknown profile", () => {
    expect(() => parseProfile("bun test; curl example.invalid")).toThrow("Unknown command profile");
  });

  test("runs only the workflow-selected profile and only once", async () => {
    const state: ExecutorState = { selectedProfile: "check", attempts: [], executed: false };
    let calls = 0;
    const execute = async () => {
      calls++;
      return attempt({ argv: ["bun", "run", "check"] });
    };
    await expect(executeSelectedProfileOnce(state, "unit", execute)).rejects.toThrow("does not match");
    expect(calls).toBe(0);
    await expect(executeSelectedProfileOnce(state, "check", execute)).resolves.toMatchObject({ exitCode: 0 });
    await expect(executeSelectedProfileOnce(state, "check", execute)).rejects.toThrow("only once");
    expect(calls).toBe(1);
    expect(state.attempts).toHaveLength(1);
  });
});

describe("tool policy", () => {
  test("allows only the three pilot tools and interrupts all other calls", () => {
    expect(authorizePilotTool("read_repository_file")).toEqual({ behavior: "allow" });
    expect(authorizePilotTool("search_repository")).toEqual({ behavior: "allow" });
    expect(authorizePilotTool("run_reproduction_command")).toEqual({ behavior: "allow" });
    expect(authorizePilotTool("Bash")).toEqual({
      behavior: "deny",
      message: "The repro pilot permits only its three repository tools.",
      interrupt: true,
    });
  });
});

describe("process boundary", () => {
  test("constructs a small child environment without provider or GitHub credentials", () => {
    const env = buildChildEnvironment({
      PATH: "/bin",
      LETTA_API_KEY: "letta-secret",
      GITHUB_TOKEN: "github-secret",
      GH_TOKEN: "gh-secret",
      OPENAI_API_KEY: "provider-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      LANG: "C.UTF-8",
    }, "/safe-home");
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/safe-home",
      XDG_CONFIG_HOME: "/safe-home/.config",
      CI: "true",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      LANG: "C.UTF-8",
    });
  });

  test("times out a child process and preserves its exact argv", async () => {
    const root = await temporaryDirectory();
    const argv = [process.execPath, "-e", "setTimeout(() => {}, 10_000)"];
    const result = await executeCommandArgv(argv, root, [], {
      timeoutMs: 25,
      safeHome: join(root, "home"),
    });
    expect(result.argv).toEqual(argv);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("sanitization and reports", () => {
  test("redacts explicit and common secret forms and truncates output", () => {
    const value = sanitizeText(
      "token=top-secret Authorization: Bearer abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstuvwxyz " +
        "xoxb-1234567890-abcdefghij https://hooks.slack.com/services/T000/B000/secret " +
        "x".repeat(100),
      ["top-secret"],
      80,
    );
    expect(value).not.toContain("top-secret");
    expect(value).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(value).not.toContain("hooks.slack.com");
    expect(value).not.toContain("xoxb-");
    expect(value).toContain("[REDACTED]");
    expect(value).toContain("truncated");
  });

  test("downgrades confidence without command evidence", () => {
    const report = buildReport({
      problemStatement: "failure",
      commandProfile: "unit",
      revision: "abc123",
      dirtyStatus: "",
      attempts: [],
      assessment: { outcome: "reproduced", summary: "claimed", confidence: "high" },
      policyViolation: false,
      unexpectedTools: [],
      terminalResult: successfulResult,
    });
    expect(report.outcome).toBe("inconclusive");
    expect(report.confidence).toBe("low");
  });

  test("uses executor evidence for report shape and exact argv", () => {
    const evidence = attempt({
      argv: ["bun", "test", "src/tests/local-app-server.test.ts"],
      exitCode: 1,
      stdout: "expected failure",
    });
    const report = buildReport({
      problemStatement: "controlled failure",
      sourceUrl: "controlled-pilot",
      commandProfile: "local-app-server-test",
      revision: "abc123",
      dirtyStatus: "?? generated.txt",
      attempts: [evidence],
      assessment: { outcome: "reproduced", summary: "The focused test failed.", confidence: "high" },
      policyViolation: false,
      unexpectedTools: [],
      terminalResult: successfulResult,
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      outcome: "reproduced",
      confidence: "high",
      repository: { revision: "abc123", dirtyStatus: "?? generated.txt" },
      input: { commandProfile: "local-app-server-test" },
      agentResult: { success: true },
    });
    expect(report.attempts[0]?.argv).toEqual(evidence.argv);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(renderMarkdown(report)).toContain("bun test src/tests/local-app-server.test.ts");
  });

  test("never classifies a failed SDK turn as reproduced", () => {
    const report = buildReport({
      problemStatement: "failure",
      commandProfile: "unit",
      revision: "abc123",
      dirtyStatus: "",
      attempts: [attempt({ exitCode: 1 })],
      assessment: { outcome: "reproduced", summary: "claimed", confidence: "high" },
      policyViolation: false,
      unexpectedTools: [],
      terminalResult: { ...successfulResult, success: false, errorCode: "error" },
    });
    expect(report.outcome).toBe("infrastructure_failure");
    expect(report.outcome).not.toBe("reproduced");
    expect(report.summary).toContain("error");
  });

  test("makes denied or unexpected tools inconclusive", () => {
    const report = buildReport({
      problemStatement: "failure",
      commandProfile: "unit",
      revision: "abc123",
      dirtyStatus: "",
      attempts: [attempt({ exitCode: 1 })],
      assessment: { outcome: "reproduced", summary: "claimed", confidence: "high" },
      policyViolation: true,
      unexpectedTools: ["Bash"],
      terminalResult: { ...successfulResult, success: false, errorCode: "interrupted" },
    });
    expect(report.outcome).toBe("inconclusive");
    expect(report.confidence).toBe("low");
    expect(report.unexpectedTools).toEqual(["Bash"]);
    expect(report.summary).toContain("unexpected tools: Bash");
  });
});
