import type {
  AppServerSocketConstructor,
  AppServerSocketLike,
  AppServerSocketOptions,
} from "@letta-ai/letta-code/app-server-client";
import type { ProtocolMessage, RuntimeScope } from "./remote-session-protocol.js";
import type {
  LettaCodeSocketConstructor,
  LettaCodeSocketLike,
} from "./types.js";

type CloudStatusMessage = ProtocolMessage & {
  type: string;
  seq?: unknown;
  event_seq?: unknown;
  idempotency_key?: unknown;
};

type CloudStatusTransportOptions = {
  url: string;
  WebSocket: LettaCodeSocketConstructor;
  headers?: Record<string, string>;
  pingIntervalMs: number;
  runtime: RuntimeScope;
};

type SocketChannel = "control" | "stream";
type Listener = (event: unknown) => void;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MAX_IDEMPOTENCY_KEYS = 1_000;

function addSocketListener(
  socket: LettaCodeSocketLike,
  type: string,
  listener: Listener,
): () => void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  if (socket.on) {
    socket.on(type, listener);
    return () => socket.off?.(type, listener);
  }
  throw new Error("WebSocket implementation does not support event listeners.");
}

function messageEventData(event: unknown): string | null {
  if (typeof event === "string") return event;
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  return null;
}

function channelUrl(url: string, channel: SocketChannel): string {
  const parsed = new URL(url);
  parsed.searchParams.set("channel", channel);
  return parsed.toString();
}

/**
 * Cloud's status relay still exposes separate control and stream sockets.
 *
 * This adapter presents those two relay sockets as one AppServerSocketLike,
 * allowing CloudSession to reuse AppServerClient's request correlation and
 * the SDK's shared runtime controller without weakening the local app-server's
 * strict one-socket contract. Remove it when LET-10236 migrates the relay.
 */
export class CloudStatusTransport implements AppServerSocketLike {
  readonly controlSocket: LettaCodeSocketLike;
  readonly streamSocket: LettaCodeSocketLike;

  private state = CONNECTING;
  private openedChannels = new Set<SocketChannel>();
  private listeners = new Map<string, Set<Listener>>();
  private removers: Array<() => void> = [];
  private seenIdempotencyKeys = new Set<string>();
  private seenIdempotencyOrder: string[] = [];
  private lastEventSeq: number | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closeEmitted = false;

  constructor(private readonly options: CloudStatusTransportOptions) {
    const socketOptions = options.headers
      ? { headers: options.headers }
      : undefined;
    this.controlSocket = new options.WebSocket(
      channelUrl(options.url, "control"),
      socketOptions,
    );
    this.streamSocket = new options.WebSocket(
      channelUrl(options.url, "stream"),
      socketOptions,
    );
    this.bindSocket("control", this.controlSocket);
    this.bindSocket("stream", this.streamSocket);
    this.startPing();
  }

  get readyState(): number {
    return this.state;
  }

  send(data: string): void {
    if (this.state !== OPEN || this.controlSocket.readyState !== OPEN) {
      throw new Error("Cloud status control socket is not open");
    }
    this.controlSocket.send(data);
  }

  close(): void {
    if (this.state === CLOSED || this.state === CLOSING) return;
    this.state = CLOSING;
    this.stopPing();
    this.closeUnderlyingSockets();
    this.finishClose({});
  }

  addEventListener(type: string, listener: Listener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private bindSocket(
    channel: SocketChannel,
    socket: LettaCodeSocketLike,
  ): void {
    this.removers.push(
      addSocketListener(socket, "open", () => {
        this.openedChannels.add(channel);
        if (this.openedChannels.size === 2 && this.state === CONNECTING) {
          this.state = OPEN;
          this.emit("open", {});
        }
      }),
      addSocketListener(socket, "message", (event) => {
        if (this.shouldForwardMessage(channel, socket, event)) {
          this.emit("message", event);
        }
      }),
      addSocketListener(socket, "error", (event) => {
        this.emit("error", event);
      }),
      addSocketListener(socket, "close", (event) => {
        if (this.state !== CLOSED) {
          this.state = CLOSING;
          this.stopPing();
          this.closeUnderlyingSockets(socket);
          this.finishClose(event);
        }
      }),
    );
  }

  private shouldForwardMessage(
    channel: SocketChannel,
    socket: LettaCodeSocketLike,
    event: unknown,
  ): boolean {
    const data = messageEventData(event);
    if (!data) return true;
    let message: CloudStatusMessage;
    try {
      message = JSON.parse(data) as CloudStatusMessage;
    } catch {
      return true;
    }

    this.ackIfSequenced(socket, message);
    if (channel === "control" && message.type === "stream_delta") {
      return false;
    }
    if (this.isDuplicate(message)) return false;
    this.trackEventSequence(message);
    return true;
  }

  private ackIfSequenced(
    socket: LettaCodeSocketLike,
    message: CloudStatusMessage,
  ): void {
    if (typeof message.seq !== "number") return;
    this.sendCommand(socket, { type: "ack", seq: message.seq });
  }

  private isDuplicate(message: CloudStatusMessage): boolean {
    const key =
      typeof message.idempotency_key === "string"
        ? message.idempotency_key
        : null;
    if (!key) return false;
    if (this.seenIdempotencyKeys.has(key)) return true;
    this.seenIdempotencyKeys.add(key);
    this.seenIdempotencyOrder.push(key);
    while (this.seenIdempotencyOrder.length > MAX_IDEMPOTENCY_KEYS) {
      const oldest = this.seenIdempotencyOrder.shift();
      if (oldest) this.seenIdempotencyKeys.delete(oldest);
    }
    return false;
  }

  private trackEventSequence(message: CloudStatusMessage): void {
    if (typeof message.event_seq !== "number") return;
    if (
      this.lastEventSeq !== null &&
      message.event_seq > this.lastEventSeq + 1
    ) {
      this.sendCommand(this.controlSocket, {
        type: "sync",
        runtime: this.options.runtime,
        recover_approvals: true,
        force_device_status: true,
      });
    }
    if (
      this.lastEventSeq === null ||
      message.event_seq > this.lastEventSeq
    ) {
      this.lastEventSeq = message.event_seq;
    }
  }

  private sendCommand(
    socket: LettaCodeSocketLike,
    command: Record<string, unknown>,
  ): void {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(command));
    } catch {
      // ACK, sync recovery, and ping are best-effort relay reliability frames.
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.sendCommand(this.controlSocket, { type: "ping" });
      this.sendCommand(this.streamSocket, { type: "ping" });
    }, this.options.pingIntervalMs);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  private stopPing(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private closeUnderlyingSockets(
    except?: LettaCodeSocketLike,
  ): void {
    for (const socket of [this.controlSocket, this.streamSocket]) {
      if (
        socket !== except &&
        (socket.readyState === CONNECTING || socket.readyState === OPEN)
      ) {
        socket.close();
      }
    }
  }

  private finishClose(event: unknown): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.state = CLOSED;
    this.stopPing();
    for (const remove of this.removers.splice(0)) remove();
    this.emit("close", event);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export function createCloudStatusTransportConstructor(
  options: CloudStatusTransportOptions,
): AppServerSocketConstructor {
  return class CloudStatusTransportSocket extends CloudStatusTransport {
    constructor(_url: string, _socketOptions?: AppServerSocketOptions) {
      super(options);
    }
  };
}
