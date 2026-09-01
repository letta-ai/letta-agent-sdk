import { describe, expect, test } from "bun:test";

describe("LettaAgentClient process lifecycle", () => {
  test("an async-disposed management-only client lets the process exit", async () => {
    const fixture = new URL(
      "./fixtures/client-management-exit.ts",
      import.meta.url,
    );
    const child = Bun.spawn([process.execPath, fixture.pathname], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 20_000);
    timeout.unref?.();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);

    if (exitCode !== 0) {
      throw new Error(`Fixture exited with ${exitCode}. stderr:\n${stderr}`);
    }
    expect(stdout).toContain("CALL_COMPLETE");
    expect(exitCode).toBe(0);
  }, 25_000);
});
