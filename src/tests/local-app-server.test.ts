import { describe, expect, test } from "bun:test";
import {
  buildLocalAppServerArgs,
  buildLocalAppServerProcess,
} from "../local-app-server.js";

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

describe("buildLocalAppServerProcess", () => {
  test("keeps the normal app-server launcher unwrapped", () => {
    const processSpec = buildLocalAppServerProcess("/path/to/letta.js", {
      env: { SDK_TEST_VALUE: "present" },
    });

    expect(processSpec.command).toBe(process.execPath);
    expect(processSpec.args).toEqual([
      "/path/to/letta.js",
      "app-server",
      "--listen",
      "ws://127.0.0.1:0",
    ]);
    expect(processSpec.env.SDK_TEST_VALUE).toBe("present");
  });

  test("wraps memory-confined app-server processes", () => {
    let received: unknown;
    const processSpec = buildLocalAppServerProcess(
      "/path/to/letta.js",
      {
        filesystemConfinement: "memory",
        env: { MEMORY_DIR: "/state/agent/memory" },
      },
      (input) => {
        received = input;
        return {
          launcher: ["sandbox-exec", "--", ...input.launcher],
          env: { ...input.env, LETTA_SANDBOX_ACTIVE: "seatbelt" },
          backend: "seatbelt",
        };
      },
    );

    const confinementInput = received as {
      launcher: string[];
      env: NodeJS.ProcessEnv;
    };
    expect(confinementInput.launcher).toEqual([
      process.execPath,
      "/path/to/letta.js",
      "app-server",
      "--listen",
      "ws://127.0.0.1:0",
    ]);
    expect(confinementInput.env.MEMORY_DIR).toBe("/state/agent/memory");
    expect(processSpec.command).toBe("sandbox-exec");
    expect(processSpec.args).toContain("/path/to/letta.js");
    expect(processSpec.env.LETTA_SANDBOX_ACTIVE).toBe("seatbelt");
  });
});
