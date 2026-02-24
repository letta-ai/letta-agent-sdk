import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

function extractBidirectionalModeSegment(source: string): string {
  const start = source.indexOf("async function runBidirectionalMode(");
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("process.exit(0);", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe("headless skills reminder contract", () => {
  const require = createRequire(import.meta.url);
  const cliPath = require.resolve("@letta-ai/letta-code");
  const cliSource = readFileSync(cliPath, "utf-8");

  test("if bidirectional mode injects skills reminders, it must gate reinjection", () => {
    const segment = extractBidirectionalModeSegment(cliSource);

    const hasSkillsInjectionInBidir =
      segment.includes("formatSkillsAsSystemReminder") ||
      segment.includes("discoverSkills");

    // Older CLI versions do not inject skills in bidirectional mode.
    // In that case this specific regression cannot occur.
    if (!hasSkillsInjectionInBidir) {
      expect(hasSkillsInjectionInBidir).toBe(false);
      return;
    }

    // Newer CLIs that inject skills reminders must include gating primitives
    // to avoid prefixing on every follow-up SDK message.
    expect(cliSource.includes("prependSkillsReminderToContent")).toBe(true);
    expect(cliSource.includes("shouldReinjectSkillsAfterCompaction")).toBe(true);
    expect(segment).toContain("hasInjectedSkillsReminder");
    expect(segment).toContain("pendingSkillsReinject");
    expect(segment).toContain("cachedSkillsReminder");
  });

  test("logs installed CLI version for debugging", () => {
    const pkgPath = join(dirname(cliPath), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      name?: string;
      version?: string;
    };

    expect(pkg.name).toBe("@letta-ai/letta-code");
    expect(typeof pkg.version).toBe("string");
    expect((pkg.version ?? "").length).toBeGreaterThan(0);
  });
});
