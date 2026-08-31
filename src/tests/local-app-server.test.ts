import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildLocalAppServerArgs,
  buildLocalAppServerProcess,
} from "../local-app-server.js";

describe("buildLocalAppServerArgs", () => {
  test("starts the app-server on an ephemeral loopback port by default", () => {
    expect(buildLocalAppServerArgs("/path/to/letta.js")).toEqual([
      "/path/to/letta.js",
      "server",
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
      "server",
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
      "server",
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
      "server",
      "--listen",
      "ws://127.0.0.1:0",
    ]);
    expect(confinementInput.env.MEMORY_DIR).toBe("/state/agent/memory");
    expect(processSpec.command).toBe("sandbox-exec");
    expect(processSpec.args).toContain("/path/to/letta.js");
    expect(processSpec.env.LETTA_SANDBOX_ACTIVE).toBe("seatbelt");
  });

  test("derives the standard local-backend memory directory from the agent id", () => {
    let received: unknown;
    buildLocalAppServerProcess(
      "/path/to/letta.js",
      {
        filesystemConfinement: "memory",
        agentId: "agent-local-123",
        env: {
          HOME: "/home/sdk",
          USERPROFILE: "/home/sdk",
          LETTA_LOCAL_BACKEND_DIR: "/state/local-backend",
        },
      },
      (input) => {
        received = input;
        return { launcher: input.launcher, env: input.env, backend: "seatbelt" };
      },
    );

    expect((received as MemoryConfinementInput).env.MEMORY_DIR).toBe(
      join("/state/local-backend", "memfs", "agent-local-123", "memory"),
    );
  });

  test("derives API-backed memory without overriding an explicit root", () => {
    const received: MemoryConfinementInput[] = [];
    const confine = (input: MemoryConfinementInput) => {
      received.push(input);
      return { launcher: input.launcher, env: input.env, backend: "seatbelt" as const };
    };

    buildLocalAppServerProcess(
      "/path/to/letta.js",
      {
        backend: "api",
        filesystemConfinement: "memory",
        agentId: "agent-123",
        env: { HOME: "/home/sdk", USERPROFILE: "/home/sdk" },
      },
      confine,
    );
    buildLocalAppServerProcess(
      "/path/to/letta.js",
      {
        filesystemConfinement: "memory",
        agentId: "agent-local-123",
        env: { MEMORY_DIR: "/memory-copy" },
      },
      confine,
    );

    expect(received[0]?.env.MEMORY_DIR).toBe(
      join("/home/sdk", ".letta", "agents", "agent-123", "memory"),
    );
    expect(received[1]?.env.MEMORY_DIR).toBe("/memory-copy");
    expect(received[1]?.env.LETTA_MEMORY_DIR).toBeUndefined();
  });

  test("does not inherit another agent's memory root", () => {
    let received: unknown;
    buildLocalAppServerProcess(
      "/path/to/letta.js",
      {
        filesystemConfinement: "memory",
        env: {},
      },
      (input) => {
        received = input;
        return { launcher: input.launcher, env: input.env, backend: "seatbelt" };
      },
    );

    expect((received as MemoryConfinementInput).env.MEMORY_DIR).toBeUndefined();
    expect(
      (received as MemoryConfinementInput).env.LETTA_MEMORY_DIR,
    ).toBeUndefined();
  });
});

type MemoryConfinementInput = {
  launcher: string[];
  env: NodeJS.ProcessEnv;
};
