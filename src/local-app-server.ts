import { spawn, type ChildProcess } from "node:child_process";
import { findLettaCli } from "./cli-resolver.js";

export interface LocalAppServerHandle {
  url: string;
  close(): void;
}

export interface StartLocalAppServerOptions {
  listen?: string;
  startupTimeoutMs?: number;
  cliPath?: string;
  env?: Record<string, string | undefined>;
}

const DEFAULT_LISTEN_URL = "ws://127.0.0.1:0";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const LISTENING_RE = /^Listening on\s+(ws:\/\/\S+)\s*$/m;

function appendLine(buffer: string, chunk: unknown): string {
  return buffer + String(chunk);
}

function tryExtractListeningUrl(output: string): string | null {
  const match = output.match(LISTENING_RE);
  return match?.[1] ?? null;
}

function terminateProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 1_000).unref?.();
}

/**
 * Spawn an SDK-owned Letta Code app-server on an ephemeral loopback port.
 */
export function startLocalAppServer(
  options: StartLocalAppServerOptions = {},
): Promise<LocalAppServerHandle> {
  const cliPath = options.cliPath ?? findLettaCli();
  const args = [cliPath, "app-server", "--listen", options.listen ?? DEFAULT_LISTEN_URL];
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
    });

    let settled = false;
    let output = "";

    const cleanup = () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      clearTimeout(timeout);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateProcess(child);
      reject(error);
    };

    const succeed = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        url,
        close: () => terminateProcess(child),
      });
    };

    const onOutput = (chunk: unknown) => {
      output = appendLine(output, chunk);
      const url = tryExtractListeningUrl(output);
      if (url) succeed(url);
    };

    const onStdout = (chunk: unknown) => onOutput(chunk);
    const onStderr = (chunk: unknown) => {
      // Startup failures are printed to stderr by the CLI. Keep stderr in the
      // collected output so timeout/exit errors are actionable.
      output = appendLine(output, chunk);
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      fail(
        new Error(
          `Local Letta Code app-server exited before listening (code=${code ?? "null"}, signal=${signal ?? "null"}).${
            output ? ` Output:\n${output.trim()}` : ""
          }`,
        ),
      );
    };

    const timeout = setTimeout(() => {
      fail(
        new Error(
          `Timed out waiting for local Letta Code app-server to start.${
            output ? ` Output:\n${output.trim()}` : ""
          }`,
        ),
      );
    }, startupTimeoutMs);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
