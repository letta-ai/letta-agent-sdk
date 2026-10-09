import assert from "node:assert/strict";
import { createServer } from "node:net";
import { LettaAgentClient, resumeSession } from "../../index.js";

const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const url = `ws://127.0.0.1:${port}`;
await using client = new LettaAgentClient({ backend: "local", appServer: { listen: url } });
const agentId = await client.createAgent({ memfs: false });
console.log("agent created");
// A fixed port makes accidental per-call process startup fail deterministically.
const sessions = Array.from({ length: 16 }, () => client.createSession(agentId));
try {
  const ready = await Promise.all(sessions.map((session) => session.ready()));
  console.log("16 sessions ready");
  assert.equal(new Set(ready.map((r) => r.conversationId)).size, 16);
  await client.models.list(); // Management shares the same process too.
  sessions[0]!.close();
  await Promise.all(sessions.slice(1).map((session) => session.listMessages()));

  const confined = client.resumeSession(ready[1]!.conversationId!, {
    filesystemConfinement: "memory",
  });
  try {
    // Conversation resumes have no agent-derived memory root. Confinement must
    // still fail closed instead of borrowing the unrestricted shared process.
    await assert.rejects(confined.ready());
  } finally { confined.close(); }
  await sessions[1]!.listMessages();
  console.log("sibling and confinement checks complete");

  await using external = new LettaAgentClient({ backend: "local", appServer: { url } });
  await external.models.list();
  await external.close();
  await client.models.list();
} finally { for (const session of sessions) session.close(); }

await using next = client.createSession(agentId);
await next.ready(); // Closing every prior session does not terminate the owner.
console.log("replacement session ready");

const isolatedOwner = new LettaAgentClient({ backend: "local" });
const ordinary = isolatedOwner.createSession(agentId);
const isolated = isolatedOwner.createSession(agentId, { env: { SDK_ISOLATION_TEST: "yes" } });
try {
  await Promise.all([ordinary.ready(), isolated.ready()]);
  await isolatedOwner.close();
  await isolated.listMessages(); // Explicit env still owns an independent process.
  await next.listMessages(); // Another client has an independent server lifetime.
  console.log("independent client checks complete");
} finally {
  ordinary.close();
  isolated.close();
  await isolatedOwner.close();
}

const convenience = resumeSession(agentId);
await convenience.ready();
convenience.close(); // Its otherwise hidden client must not keep this fixture alive.
await client.close();
console.log("SHARED_CLIENT_OK");
