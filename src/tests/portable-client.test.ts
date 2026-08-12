import { describe, expect, test } from "bun:test";
import {
  LettaAgentClient,
  createReactNativeWebSocketConstructor,
  createTranscriptAccumulator,
  extractStreamTextDelta,
  type LettaCodeReactNativeSocketConstructor,
  type LettaCodeSocketOptions,
  type TranscriptRow,
} from "../client-entry.js";

describe("portable client entry", () => {
  test("rejects local execution", () => {
    expect(
      () =>
        new LettaAgentClient(
          { backend: "local" } as never,
        ),
    ).toThrow('supports backend: "remote" and backend: "cloud" only');
  });

  test("creates a Cloud agent without a local runtime", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = (async (
      input: Parameters<typeof fetch>[0] | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "agent-portable" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new LettaAgentClient({
      backend: "cloud",
      apiBaseUrl: "https://api.test",
      apiKey: "sk-test",
      fetch: fetchMock,
    });

    await expect(
      client.createAgent({
        model: "anthropic/claude-sonnet-4",
        memfs: false,
      }),
    ).resolves.toBe("agent-portable");

    expect(requests).toHaveLength(1);
    const body = JSON.parse(String(requests[0]!.init?.body)) as {
      tags: string[];
    };
    expect(body.tags).toEqual(["origin:letta-code"]);
  });

  test("adapts React Native websocket headers to the third argument", () => {
    let received:
      | { url: string; protocols: string | string[] | null | undefined; options?: LettaCodeSocketOptions }
      | undefined;

    class ReactNativeSocket {
      readyState = 1;

      constructor(
        url: string,
        protocols?: string | string[] | null,
        options?: LettaCodeSocketOptions,
      ) {
        received = { url, protocols, options };
      }

      send(): void {}
      close(): void {}
    }

    const WebSocket = createReactNativeWebSocketConstructor(
      ReactNativeSocket as LettaCodeReactNativeSocketConstructor,
    );
    const socket = new WebSocket("ws://example.test", {
      headers: { Authorization: "Bearer token" },
    });

    expect(socket).toBeInstanceOf(ReactNativeSocket);
    expect(received).toEqual({
      url: "ws://example.test",
      protocols: undefined,
      options: { headers: { Authorization: "Bearer token" } },
    });
  });

  test("exports the streaming helpers browser consumers need", () => {
    expect(typeof extractStreamTextDelta).toBe("function");

    const accumulator = createTranscriptAccumulator();
    const rows: readonly TranscriptRow[] = accumulator.apply({
      type: "assistant",
      content: "hello",
      uuid: "m1",
      otid: "o1",
      seqId: 1,
      runId: "r1",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "assistant", text: "hello" });
  });
});
