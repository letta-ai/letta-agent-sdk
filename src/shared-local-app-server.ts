import {
  startLocalAppServer,
  type LocalAppServerHandle,
  type StartLocalAppServerOptions,
} from "./local-app-server.js";

/** One lazily started process owned by a local SDK client, not its sessions. */
export class SharedLocalAppServer {
  private starting: Promise<LocalAppServerHandle> | null = null;
  private server: LocalAppServerHandle | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: StartLocalAppServerOptions) {}

  async connect(): Promise<LocalAppServerHandle> {
    if (this.closed) throw new Error("Local App Server owner is closed");
    // A later call can replace an exited process; never replay a failed turn.
    if (this.server && !this.server.isRunning()) {
      this.server = null;
      this.starting = null;
    }
    if (!this.starting) {
      this.starting = startLocalAppServer(this.options).then(
        (server) => {
          if (this.closed) {
            server.close();
            throw new Error("Local App Server owner closed during startup");
          }
          this.server = server;
          return server;
        },
        (error: unknown) => {
          this.starting = null;
          throw error;
        },
      );
    }
    const server = await this.starting;
    if (this.closed) throw new Error("Local App Server owner is closed");
    return {
      url: server.url,
      isRunning: server.isRunning,
      // Session/management disposal releases only its socket, not the process.
      close() {},
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.starting
      ? this.starting.then((server) => server.close(), () => {})
      : Promise.resolve();
    return this.closing;
  }
}
