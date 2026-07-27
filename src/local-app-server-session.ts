import {
  AppServerSession,
  type AppServerSessionMode,
  type AppServerSessionOptions,
} from "./app-server-session.js";
import { startLocalAppServer } from "./local-app-server.js";
import type { LettaCodeLocalAppServerOptions } from "./types.js";

export function createLocalAppServerSession(
  options: LettaCodeLocalAppServerOptions | undefined,
  mode: AppServerSessionMode,
  beforeConnect?: () => Promise<void>,
): AppServerSession {
  const appServer = options ?? {};
  const sessionOptions: AppServerSessionOptions = {
    ...(appServer.url !== undefined
      ? { url: appServer.url }
      : {
          connect: (sessionEnv?: Record<string, string>) =>
            startLocalAppServer({
              listen: appServer.listen,
              backend: appServer.harnessBackend ?? "local",
              startupTimeoutMs: appServer.startupTimeoutMs,
              env: sessionEnv,
            }),
        }),
    ...(appServer.WebSocket !== undefined
      ? { WebSocket: appServer.WebSocket }
      : {}),
    ...(appServer.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: appServer.requestTimeoutMs }
      : {}),
    ...(appServer.pinGlobalAgent !== undefined
      ? { pinGlobalAgent: appServer.pinGlobalAgent }
      : {}),
    ...(beforeConnect ? { beforeConnect } : {}),
  };
  return new AppServerSession(sessionOptions, mode);
}
