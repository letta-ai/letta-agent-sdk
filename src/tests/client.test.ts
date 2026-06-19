import { describe, expect, test } from "bun:test";
import { LettaCodeClient, Session } from "../index.js";

describe("LettaCodeClient", () => {
  test("defaults to the implemented local backend", () => {
    const client = new LettaCodeClient();

    expect(client.backend).toBe("local");
    expect(client.environment).toBeUndefined();
  });

  test("creates local sessions without starting the subprocess until use", () => {
    const client = new LettaCodeClient({ backend: "local" });
    const session = client.resumeSession("agent-123");

    try {
      expect(session).toBeInstanceOf(Session);
    } finally {
      session.close();
    }
  });

  test("rejects environment overrides on local sessions", () => {
    const client = new LettaCodeClient({ backend: "local" });

    expect(() =>
      client.resumeSession("agent-123", { environment: "work-laptop" }),
    ).toThrow("environment overrides are only valid for remote/cloud backends");
  });

  test("keeps remote and cloud backend construction as typed placeholders", () => {
    const remoteClient = new LettaCodeClient({
      backend: "remote",
      url: "wss://example.com/ws",
    });
    const cloudClient = new LettaCodeClient({
      backend: "cloud",
      environment: { name: "LettaDevelopers" },
    });

    expect(remoteClient.backend).toBe("remote");
    expect(cloudClient.backend).toBe("cloud");
    expect(cloudClient.environment).toEqual({ name: "LettaDevelopers" });
  });

  test("throws a clear placeholder error when non-local backends are used", () => {
    const client = new LettaCodeClient({
      backend: "cloud",
      environment: "LettaDevelopers",
    });

    expect(() => client.resumeSession("agent-123")).toThrow(
      "backend 'cloud' is not implemented yet",
    );
  });

  test("keeps environment out of createAgent payloads", async () => {
    const client = new LettaCodeClient({ backend: "local" });

    await expect(
      client.createAgent({ environment: "work-laptop" } as never),
    ).rejects.toThrow("createAgent() does not accept environment");
  });
});
