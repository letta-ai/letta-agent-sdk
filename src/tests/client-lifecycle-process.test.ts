import { describe, expect, test } from "bun:test";

describe("LettaAgentClient process lifecycle", () => {
  test("async disposal exits without leaving the owned App Server alive", async () => {
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
    const stdoutPromise = new Response(child.stdout).text();
    let appServerPid: number | null = null;
    for (let attempt = 0; attempt < 100 && appServerPid === null; attempt += 1) {
      const lookup = Bun.spawn(["pgrep", "-P", String(child.pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await new Response(lookup.stdout).text();
      await lookup.exited;
      const pid = Number.parseInt(output.trim().split("\n")[0] ?? "", 10);
      if (Number.isInteger(pid)) appServerPid = pid;
      else await Bun.sleep(25);
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      stdoutPromise,
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);

    if (exitCode !== 0) {
      throw new Error(`Fixture exited with ${exitCode}. stderr:\n${stderr}`);
    }
    expect(appServerPid).not.toBeNull();
    expect(() => process.kill(appServerPid!, 0)).toThrow();
    expect(stdout).toContain("CALL_COMPLETE");
    expect(exitCode).toBe(0);
  }, 25_000);
});
