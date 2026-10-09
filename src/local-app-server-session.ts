import {
  AppServerSession,
  type AppServerSessionMode,
  type AppServerSessionOptions,
} from "./app-server-session.js";
import { startLocalAppServer } from "./local-app-server.js";
import type { SharedLocalAppServer } from "./shared-local-app-server.js";
import type {
  LettaCodeClientSessionOptions,
  LettaCodeLocalAppServerOptions,
} from "./types.js";

export function createLocalAppServerSession(
  options: LettaCodeLocalAppServerOptions | undefined,
  mode: AppServerSessionMode,
  sharedServer?: SharedLocalAppServer,
): AppServerSession {
  const appServer = options ?? {};
  const session = mode.options as LettaCodeClientSessionOptions;
  const needsOwnProcess = session.filesystemConfinement === "memory" ||
    Object.keys(session.env ?? {}).length > 0;
  const sessionOptions: AppServerSessionOptions = {
    ...(mode.kind === "conversation" &&
    (appServer.harnessBackend ?? "local") === "local"
      ? { requireLocalConversationCapability: true }
      : {}),
    ...(appServer.url !== undefined
      ? { url: appServer.url }
      : {
          connect: (sessionEnv?: Record<string, string>) =>
            sharedServer && !needsOwnProcess ? sharedServer.connect() : startLocalAppServer({
              listen: appServer.listen,
              backend: appServer.harnessBackend ?? "local",
              startupTimeoutMs: appServer.startupTimeoutMs,
              env: sessionEnv,
              filesystemConfinement:
                mode.kind === "session"
                  ? (mode.options as LettaCodeClientSessionOptions)
                      .filesystemConfinement
                  : undefined,
              agentId:
                mode.kind === "session" && "agentId" in mode
                  ? mode.agentId
                  : undefined,
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
  };
  return new AppServerSession(sessionOptions, mode);
}
