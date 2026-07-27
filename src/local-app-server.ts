import { spawn, type ChildProcess } from "node:child_process";
import {
  createMemoryConfinementLauncher,
  type MemoryConfinementLauncherInput,
  type MemoryConfinementLauncherResult,
} from "@letta-ai/letta-code/memory-confinement";
import { findLettaCli } from "./cli-resolver.js";

export interface LocalAppServerHandle {
  url: string;
  close(): void;
}

export interface StartLocalAppServerOptions {
  listen?: string;
  backend?: string;
  startupTimeoutMs?: number;
  cliPath?: string;
  env?: Record<string, string | undefined>;
  filesystemConfinement?: "memory";
}

interface LocalAppServerProcess {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

type MemoryConfinementLauncher = (
  input: MemoryConfinementLauncherInput,
) => MemoryConfinementLauncherResult;

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

export function buildLocalAppServerArgs(
  cliPath: string,
  options: Pick<StartLocalAppServerOptions, "backend" | "listen"> = {},
): string[] {
  return [
    cliPath,
    ...(options.backend !== undefined ? ["--backend", options.backend] : []),
    "app-server",
    "--listen",
    options.listen ?? DEFAULT_LISTEN_URL,
  ];
}

export function buildLocalAppServerProcess(
  cliPath: string,
  options: StartLocalAppServerOptions = {},
  confineMemory: MemoryConfinementLauncher = createMemoryConfinementLauncher,
): LocalAppServerProcess {
  const env = { ...process.env, ...(options.env ?? {}) };
  const launcher = [
    process.execPath,
    ...buildLocalAppServerArgs(cliPath, options),
  ];
  if (options.filesystemConfinement !== "memory") {
    return {
      command: launcher[0] as string,
      args: launcher.slice(1),
      env,
    };
  }

  const confined = confineMemory({ launcher, env });
  return {
    command: confined.launcher[0] as string,
    args: confined.launcher.slice(1),
    env: confined.env,
  };
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
  const processSpec = buildLocalAppServerProcess(cliPath, options);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(processSpec.command, processSpec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: processSpec.env,
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
