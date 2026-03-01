/**
 * WebSocketTransport
 *
 * Connects to a Letta Code instance over WebSocket, speaking the same
 * WireMessage JSON protocol used by stdio (SubprocessTransport).
 *
 * Usage:
 *   const transport = new WebSocketTransport("ws://localhost:8374?agent=agent-xxx");
 *   await transport.connect();
 *   await transport.write({ type: "user", message: { role: "user", content: "Hello" } });
 *   for await (const msg of transport.messages()) { ... }
 */

import WebSocket from "ws";
import type { Transport } from "./transport.js";
import type { WireMessage } from "./types.js";

// All logging gated behind DEBUG_SDK env var
function sdkLog(tag: string, ...args: unknown[]) {
  if (process.env.DEBUG_SDK)
    console.error(`[SDK-WsTransport] [${tag}]`, ...args);
}

export interface WebSocketTransportOptions {
  /** Additional headers sent during the WebSocket handshake (e.g. Authorization) */
  headers?: Record<string, string>;
}

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private messageQueue: WireMessage[] = [];
  private messageResolvers: Array<(msg: WireMessage | null) => void> = [];
  private closed = false;
  private wireMessageCount = 0;
  private lastMessageAt = 0;

  constructor(
    private url: string,
    private options: WebSocketTransportOptions = {},
  ) {}

  /**
   * Open the WebSocket connection
   */
  async connect(): Promise<void> {
    sdkLog("connect", `connecting to ${this.url}`);

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url, {
        headers: this.options.headers,
      });

      this.ws.on("open", () => {
        sdkLog("connect", "WebSocket connected");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        const raw = typeof data === "string" ? data : data.toString();
        if (!raw.trim()) return;

        try {
          const msg = JSON.parse(raw) as WireMessage;
          this.handleMessage(msg);
        } catch {
          sdkLog("message", `[non-JSON] ${raw.slice(0, 500)}`);
        }
      });

      this.ws.on("close", (code, reason) => {
        sdkLog(
          "close",
          `WebSocket closed: code=${code} reason=${reason.toString()} wireMessages=${this.wireMessageCount}`,
        );
        this.closed = true;
        // Flush pending readers so they don't hang forever
        for (const resolve of this.messageResolvers) {
          resolve(null);
        }
        this.messageResolvers = [];
      });

      this.ws.on("error", (err) => {
        sdkLog("error", `WebSocket error: ${err.message}`);
        if (!this.closed && this.ws?.readyState !== WebSocket.OPEN) {
          // Connection failed during handshake
          reject(
            new Error(`WebSocket connection failed: ${err.message}`),
          );
        }
        this.closed = true;
        // Flush pending readers
        for (const resolve of this.messageResolvers) {
          resolve(null);
        }
        this.messageResolvers = [];
      });
    });
  }

  /**
   * Send a JSON message over the WebSocket
   */
  async write(data: object): Promise<void> {
    if (!this.ws || this.closed || this.ws.readyState !== WebSocket.OPEN) {
      const err = new Error(
        `Transport not connected (closed=${this.closed}, readyState=${this.ws?.readyState})`,
      );
      sdkLog("write", err.message);
      throw err;
    }
    const payload = data as Record<string, unknown>;
    sdkLog(
      "write",
      `type=${payload.type} subtype=${(payload.request as Record<string, unknown>)?.subtype || (payload.response as Record<string, unknown>)?.subtype || "N/A"}`,
    );
    this.ws.send(JSON.stringify(data));
  }

  /**
   * Read the next message from the WebSocket
   */
  async read(): Promise<WireMessage | null> {
    // Return queued message if available
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }

    // If closed, no more messages
    if (this.closed) {
      sdkLog(
        "read",
        `returning null (closed), total wireMessages=${this.wireMessageCount}`,
      );
      return null;
    }

    // Wait for next message
    sdkLog(
      "read",
      `waiting for next message (resolvers=${this.messageResolvers.length + 1}, queue=${this.messageQueue.length})`,
    );
    return new Promise((resolve) => {
      this.messageResolvers.push(resolve);
    });
  }

  /**
   * Async iterator for messages
   */
  async *messages(): AsyncGenerator<WireMessage> {
    while (true) {
      const msg = await this.read();
      if (msg === null) {
        sdkLog(
          "messages",
          `iterator ending (closed=${this.closed}, wireMessages=${this.wireMessageCount})`,
        );
        break;
      }
      yield msg;
    }
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    sdkLog(
      "close",
      `explicit close called (wireMessages=${this.wireMessageCount}, pendingResolvers=${this.messageResolvers.length})`,
    );
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.closed = true;

    // Resolve any pending readers with null
    for (const resolve of this.messageResolvers) {
      resolve(null);
    }
    this.messageResolvers = [];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private handleMessage(msg: WireMessage): void {
    this.wireMessageCount++;
    this.lastMessageAt = Date.now();

    const wirePayload = msg as unknown as Record<string, unknown>;
    const msgType = wirePayload.message_type || wirePayload.subtype || "";
    sdkLog(
      "wire",
      `#${this.wireMessageCount} type=${msg.type} ${msgType ? `msg_type=${msgType}` : ""} resolvers=${this.messageResolvers.length} queue=${this.messageQueue.length}`,
    );

    if (msg.type === "result") {
      const result = wirePayload as unknown as {
        subtype?: string;
        result?: string;
        duration_ms?: number;
        stop_reason?: string;
      };
      sdkLog(
        "wire",
        `RESULT: subtype=${result.subtype} stop_reason=${result.stop_reason || "N/A"} duration=${result.duration_ms}ms`,
      );
    }

    if (msg.type === "control_request") {
      const req = wirePayload as unknown as {
        request_id?: string;
        request?: { subtype?: string; tool_name?: string };
      };
      sdkLog(
        "wire",
        `CONTROL_REQUEST: id=${req.request_id} subtype=${req.request?.subtype} tool=${req.request?.tool_name || "N/A"}`,
      );
    }

    // If someone is waiting for a message, give it to them
    if (this.messageResolvers.length > 0) {
      const resolve = this.messageResolvers.shift()!;
      resolve(msg);
    } else {
      // Otherwise queue it
      this.messageQueue.push(msg);
    }
  }
}
