import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLettaCli } from "../cli-resolver.js";
import { SharedLocalAppServer } from "../shared-local-app-server.js";

const home = mkdtempSync(join(tmpdir(), "sdk-shared-servers-"));
const serverOptions = { backend: "api", env: { HOME: home, USERPROFILE: home } };
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function eventuallyStopped(isRunning: () => boolean): Promise<void> {
  for (let attempt = 0; isRunning() && attempt < 100; attempt++) await Bun.sleep(20);
  expect(isRunning()).toBe(false);
}

describe("shared local App Server (real processes)", () => {
  test("concurrent borrowers share startup and cannot stop siblings", async () => {
    const owner = new SharedLocalAppServer(serverOptions);
    try {
      const handles = await Promise.all(Array.from({ length: 16 }, () => owner.connect()));
      expect(new Set(handles.map((h) => h.url)).size).toBe(1);
      for (const handle of handles) handle.close();
      expect(handles[0]!.isRunning()).toBe(true);
      expect((await owner.connect()).url).toBe(handles[0]!.url);
      const closing = owner.close();
      expect(owner.close()).toBe(closing);
      await closing;
      await eventuallyStopped(handles[0]!.isRunning);
      await expect(owner.connect()).rejects.toThrow("closed");
    } finally { await owner.close(); }
  }, 30_000);

  test("failed startup can be retried after the executable becomes available", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-shared-retry-"));
    const cliPath = join(root, "letta.js");
    const owner = new SharedLocalAppServer({ ...serverOptions, cliPath });
    try {
      const failures = await Promise.allSettled([owner.connect(), owner.connect()]);
      expect(failures.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      symlinkSync(findLettaCli(), cliPath);
      const handle = await owner.connect();
      expect(handle.isRunning()).toBe(true);
      await owner.close();
      await eventuallyStopped(handle.isRunning);
    } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test("closing during startup rejects borrowers and does not resurrect the owner", async () => {
    const owner = new SharedLocalAppServer(serverOptions);
    const pending = owner.connect();
    const closing = owner.close();
    await expect(pending).rejects.toThrow("closed during startup");
    await closing;
    await expect(owner.connect()).rejects.toThrow("closed");
  }, 30_000);

  test.skipIf(process.platform !== "linux")("replaces an exited process on a later connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-shared-exit-"));
    const cliPath = join(root, "letta.js");
    symlinkSync(findLettaCli(), cliPath);
    const owner = new SharedLocalAppServer({ ...serverOptions, cliPath });
    try {
      const first = await owner.connect();
      const pids = readdirSync("/proc").filter((pid) => {
        if (!/^\d+$/.test(pid)) return false;
        try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(cliPath); }
        catch { return false; }
      });
      expect(pids).toHaveLength(1);
      process.kill(Number(pids[0]), "SIGKILL");
      await eventuallyStopped(first.isRunning);
      const second = await owner.connect();
      expect(second.isRunning()).toBe(true);
      expect(first.isRunning()).toBe(false);
      await owner.close();
      await eventuallyStopped(second.isRunning);
    } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test("real client multiplexes sessions, preserves isolation, and exits cleanly", async () => {
    const home = mkdtempSync(join(tmpdir(), "sdk-shared-client-"));
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/shared-app-server-client.ts")], {
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        LETTA_LOCAL_BACKEND_DIR: join(home, "local"),
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
        MEMORY_DIR: "", LETTA_MEMORY_DIR: "",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => proc.kill(), 25_000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect({ code, output: code === 0 ? "" : out + err }).toEqual({ code: 0, output: "" });
      expect(out).toContain("SHARED_CLIENT_OK");
    } finally { clearTimeout(deadline); proc.kill(); rmSync(home, { recursive: true, force: true }); }
  }, 30_000);
});
