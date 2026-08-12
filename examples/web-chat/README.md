# Web chat

This example streams a Letta agent response from a Bun server to a browser with Server-Sent Events.

It demonstrates the following parts:

- `session.send()` and `session.stream()` on the server
- translation of SDK messages into a small browser event stream
- reuse of one saved agent across server restarts
- Cloud repository files that the agent and browser can edit

## Run the server

From the repository root, run:

```bash
bun examples/web-chat/server.ts
```

Open <http://localhost:3000>. Use `--port=8080` to select a different port.

Without `LETTA_API_KEY`, the example uses the local backend. If `LETTA_API_KEY` is set, the example creates a Cloud agent and an attached repository with `read_write` access.

The **Memory files** panel is available only with the Cloud backend. A local agent still has MemFS, but this small server does not expose its local memory checkout to the browser.

## Saved state

The server stores the agent ID, repository ID, and backend in `state.json`. Restart the server with the same backend to resume the agent.

Delete `state.json`, or send `POST /api/reset`, to clear this saved state. Reset does not delete the agent or Cloud repository.

## Read the flow

Start in [`server.ts`](./server.ts):

1. `getSession()` creates or resumes the agent.
2. `POST /api/chat` sends one user message.
3. The server converts `assistant`, `tool_call`, and `result` messages into browser events.
4. The browser reads the event stream and appends text as it arrives.

The example keeps the browser code in [`index.html`](./index.html) so that the full path stays visible without a framework.
