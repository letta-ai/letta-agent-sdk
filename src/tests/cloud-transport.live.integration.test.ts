import { describe, expect, test } from "bun:test";
import { LettaAgentClient } from "../index.js";
import type {
  LettaCodeSession,
  LettaCodeSocketConstructor,
  LettaCodeSocketLike,
  SDKMessage,
} from "../types.js";
import { asAdvanced } from "./advanced-session.js";

const API_KEY = process.env.LETTA_API_KEY;
const RUN_LIVE = process.env.LETTA_LIVE_INTEGRATION === "1" && !!API_KEY;
const BASE_URL = process.env.LETTA_BASE_URL ?? "https://api.letta.com";
const TEST_TIMEOUT_MS = Number(process.env.LETTA_LIVE_TEST_TIMEOUT_MS ?? "180000");

const describeLive = RUN_LIVE ? describe : describe.skip;

function captureCloudSockets(): {
  WebSocket: LettaCodeSocketConstructor;
  sockets: Map<"control" | "stream", LettaCodeSocketLike>;
} {
  const NativeWebSocket = globalThis.WebSocket as unknown as
    | LettaCodeSocketConstructor
    | undefined;
  if (!NativeWebSocket) {
    throw new Error("A native WebSocket implementation is required");
  }

  const sockets = new Map<"control" | "stream", LettaCodeSocketLike>();
  const WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args) as LettaCodeSocketLike;
      const channel = new URL(String(args[0])).searchParams.get("channel");
      if (channel === "control" || channel === "stream") {
        sockets.set(channel, socket);
      }
      return socket;
    },
  }) as LettaCodeSocketConstructor;

  return { WebSocket, sockets };
}

async function deleteAgent(agentId: string): Promise<void> {
  if (!API_KEY) throw new Error("LETTA_API_KEY is required");
  const response = await fetch(`${BASE_URL}/v1/agents/${agentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete live test agent ${agentId}: ${response.status}`);
  }
}

describeLive("live Cloud transport disconnect", () => {
  test(
    "a dropped relay stream socket terminates a parked SDK stream",
    async () => {
      const { WebSocket, sockets } = captureCloudSockets();
      const client = new LettaAgentClient({
        backend: "cloud",
        apiKey: API_KEY!,
        apiBaseUrl: BASE_URL,
        WebSocket,
        requestTimeoutMs: 60_000,
        sandbox: { terminateOnClose: true },
      });

      let agentId: string | null = null;
      let session: LettaCodeSession | null = null;
      try {
        agentId = await client.createAgent({
          name: `sdk-cloud-disconnect-test-${Date.now()}`,
          model: "anthropic/claude-haiku-4-5",
          tags: ["sdk-live-test"],
          memfs: false,
        });
        session = client.createSession(agentId);
        await asAdvanced(session).initialize();

        const streamSocket = sockets.get("stream");
        const controlSocket = sockets.get("control");
        expect(streamSocket).toBeDefined();
        expect(controlSocket).toBeDefined();

        await session.send("Reply with exactly: this response should not arrive");
        const messages: SDKMessage[] = [];
        const drained = (async () => {
          for await (const message of session!.stream()) messages.push(message);
        })();

        // This closes the real production relay connection after the turn was
        // accepted for transport, while stream() is parked awaiting events.
        streamSocket!.close();
        await Promise.race([
          drained,
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("Cloud stream remained parked after relay disconnect")),
              10_000,
            );
          }),
        ]);

        expect(controlSocket!.readyState).toBe(3);
        expect(messages).toContainEqual(expect.objectContaining({
          type: "error",
          stopReason: "error",
        }));
        expect(messages.at(-1)).toMatchObject({
          type: "result",
          success: false,
          errorCode: "error",
        });
      } finally {
        session?.close();
        if (agentId) await deleteAgent(agentId);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
