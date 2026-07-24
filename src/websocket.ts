import type {
  LettaCodeReactNativeSocketConstructor,
  LettaCodeSocketConstructor,
  LettaCodeSocketOptions,
} from "./types.js";

/**
 * Adapt React Native's three-argument WebSocket constructor to the SDK's
 * Node-compatible constructor shape. This is only needed when a remote
 * app-server authenticates its websocket upgrade with headers. Cloud clients
 * should prefer `webSocketAuth: "query"`.
 */
export function createReactNativeWebSocketConstructor(
  WebSocket: LettaCodeReactNativeSocketConstructor,
): LettaCodeSocketConstructor {
  class ReactNativeWebSocketAdapter {
    constructor(url: string, options?: LettaCodeSocketOptions) {
      return new WebSocket(url, undefined, options);
    }
  }
  return ReactNativeWebSocketAdapter as unknown as LettaCodeSocketConstructor;
}
