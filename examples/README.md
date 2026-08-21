# Examples

These examples show one path from a local agent to persistent and multi-agent applications. Start with the SDK tour, then choose an application that matches the concept you need.

Run `bun install` from the repository root before you start. The examples import `../src/index.js` so that they run against this checkout. In your application, import from `@letta-ai/letta-agent-sdk`.

## Learning path

| Example | What it teaches | Backend | Side effects |
| --- | --- | --- | --- |
| [`sdk-tour.ts`](./sdk-tour.ts) | Agent creation, streaming, conversations, tools, permissions, and MemFS | Local | Creates local agents and can run tools |
| [`custom-tools/`](./custom-tools) | Tools that execute in your SDK process for a Cloud agent | Cloud | Creates a Cloud agent and runs local functions |
| [`dungeon-master/`](./dungeon-master) | One persistent agent with visible files and resumable state | Local | Writes a rulebook, campaign files, and `state.json` |
| [`web-chat/`](./web-chat) | Server-Sent Events, browser streaming, and repository-backed memory | Local or Cloud | Starts an HTTP server and writes `state.json` |
| [`focus-group/`](./focus-group) | Several persistent agents coordinated by TypeScript | Local | Creates agents and writes `state.json` |
| [`research-team/`](./research-team) | File handoffs, user feedback, and reuse of the same agents in another script | Local | Creates agents and writes reports under `output/` |

The other application demos apply the same session pattern to bug fixing, file organization, release notes, and an economics seminar. Read them after the SDK tour if that use case is useful to you.

## Choose a backend

Most examples pin `backend: "local"`. The SDK starts and owns a local Letta Code app-server for those sessions.

The custom-tools example pins `backend: "cloud"`. Set `LETTA_API_KEY` before you run it:

```bash
export LETTA_API_KEY=your-key
bun examples/custom-tools/main.ts
```

The web chat selects Cloud when `LETTA_API_KEY` is set. Otherwise, it uses the local backend. Its memory-file editor is available only on Cloud because it edits files in an attached Cloud repository.

## Understand the safety boundary

Several local demos use `permissionMode: "unrestricted"` so that they can run without an approval UI. Run them only in a directory where their tools can operate safely. Use the file organizer's `--dry-run` option before you allow it to move files.

Each `--reset` command clears the example's saved agent ID. Some examples also remove their generated files. Reset does not delete the agent from its backend.

## Run the SDK tour

List the available lessons:

```bash
bun examples/sdk-tour.ts help
```

Run the first lesson:

```bash
bun examples/sdk-tour.ts basic
```

Then read the function that produced the output. Each lesson is a separate function in [`sdk-tour.ts`](./sdk-tour.ts).

## Fork a conversation

A fork copies in-context messages into a new conversation. Omit `messageId` to copy the full history. Set `messageId` to stop at that source message, inclusive.

```ts
const fork = await client.conversations.fork(sourceConversationId, {
  messageId: checkpointMessageId,
  hidden: true,
});

try {
  // The fork has independent history but uses the same agent and memory.
  await using session = client.resumeSession(fork.id);
  await session.send('Review the first approach without changing the source.');

  for await (const message of session.stream()) {
    if (message.type === 'assistant') process.stdout.write(message.content);
  }
} finally {
  // Closing a session does not archive its conversation.
  await client.conversations.update(fork.id, { archived: true });
}
```

Use `update()` before the session if the fork needs a different model:

```ts
await client.conversations.update(fork.id, {
  model: 'letta/auto-fast',
});
```
