import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LettaAgentClient } from "../index.js";

const enabled = process.env.LETTA_LIVE_INTEGRATION === "1" && !!process.env.LETTA_API_KEY;

test.skipIf(!enabled)("local App Server reuse preserves concurrent query and tool isolation", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const root = await mkdtemp(join(tmpdir(), "sdk-query-isolation-"));
  const client = new LettaAgentClient({
    backend: "local",
    appServer: { harnessBackend: "api", listen: `ws://127.0.0.1:${port}` },
  });
  await using management = new LettaAgentClient({
    backend: "cloud", apiKey: process.env.LETTA_API_KEY!,
    apiBaseUrl: process.env.LETTA_BASE_URL ?? "https://api.letta.com",
  });
  const queries: ReturnType<typeof client.query>[] = [];
  const markers = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  try {
    async function run(index: number): Promise<void> {
      const cwd = join(root, String(index));
      await mkdir(cwd);
      await writeFile(join(cwd, "token.txt"), markers[index]!);
      const query = client.query({
        prompt: "Use Read to read token.txt in your working directory, then reply with its contents.",
        options: {
          model: process.env.LETTA_LIVE_MODEL ?? "openai/gpt-5.6-luna",
          system: "Read the requested file with the Read tool. Do not access any other directory.",
          parentAgentId: process.env.LETTA_AGENT_ID,
          isSubagent: true,
          cwd, permissionMode: "unrestricted", allowedTools: ["Read"],
          toolset: { base: "none", include: ["Read"] }, skillSources: [],
          disableMemoryGuard: true,
          outputFormat: {
            type: "json_schema",
            schema: {
              type: "object", properties: { [`worker_${index}`]: { type: "string" } },
              required: [`worker_${index}`], additionalProperties: false,
            },
          },
        },
      });
      queries.push(query);
      let read = "";
      let success = false;
      let failure: unknown;
      let structured: unknown;
      const readCalls = new Set<string>();
      for await (const message of query) {
        if (message.type === "tool_call" && message.toolName === "Read") readCalls.add(message.toolCallId);
        if (message.type === "tool_result" && readCalls.has(message.toolCallId) && !message.isError) read += message.content;
        if (message.type === "result") {
          success = message.success; failure = message.error; structured = message.structuredOutput;
        }
        if (message.type === "error") failure = message;
      }
      if (!success) throw new Error(`Query ${query.conversationId} failed: ${JSON.stringify(failure)}`);
      expect(success).toBe(true);
      expect(read).toContain(markers[index]!);
      expect(Object.keys(structured as Record<string, string>)).toEqual([`worker_${index}`]);
      expect((structured as Record<string, string>)[`worker_${index}`]).toContain(markers[index]!);
      for (const other of markers.filter((_, i) => i !== index)) expect(read).not.toContain(other);
    }
    const results = await Promise.allSettled([run(0), run(1)]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    await run(2); // Completed queries must not terminate the shared process.
    expect(new Set(queries.map((q) => q.conversationId)).size).toBe(3);
  } finally {
    for (const query of queries) query.close();
    await client.close();
    for (const query of queries) {
      if (query.conversationId) await management.conversations.update(query.conversationId, { archived: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
