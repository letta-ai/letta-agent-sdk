import { describe, expect, test } from "bun:test";
import { buildLocalAppServerArgs } from "../local-app-server.js";

describe("buildLocalAppServerArgs", () => {
  test("starts the app-server on an ephemeral loopback port by default", () => {
    expect(buildLocalAppServerArgs("/path/to/letta.js")).toEqual([
      "/path/to/letta.js",
      "app-server",
      "--listen",
      "ws://127.0.0.1:0",
    ]);
  });

  test("passes backend as a global CLI flag before the app-server command", () => {
    expect(buildLocalAppServerArgs("/path/to/letta.js", {
      backend: "api",
      listen: "ws://127.0.0.1:1234",
    })).toEqual([
      "/path/to/letta.js",
      "--backend",
      "api",
      "app-server",
      "--listen",
      "ws://127.0.0.1:1234",
    ]);
  });
});
