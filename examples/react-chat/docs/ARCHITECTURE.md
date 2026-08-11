# Architecture

The application has three state layers. Each layer has one owner.

## Letta state

Letta stores the persistent agent, conversations, messages, reasoning, tool
calls, and tool returns. A page reload does not remove this state.

`app/api/conversations/route.ts` lists and creates conversations. When the
browser selects a conversation, the route calls:

```typescript
const session = client.resumeSession(conversationId);
const state = await session.bootstrapState({ order: "desc", limit: 100 });
```

`bootstrapState()` returns the initial session state in one request. The route
reverses the descending page and passes the messages to `projectTranscript()`.

## Server session state

`app/api/chat/route.ts` owns the live Agent SDK session:

```text
resumeSession()
→ send()
→ stream()
→ close()
```

The route converts each SDK message into a small browser event. The projection
keeps credentials and raw tool returns on the server.

The route closes the session in `finally`. A session is an active connection,
not the durable conversation.

## Browser state

`hooks/use-chat-session.ts` owns the selected conversation, input, loading
state, and rendered messages. The browser stores only the selected conversation
ID in `sessionStorage`.

Both history and live events produce this display model:

```typescript
type MessagePart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string; complete: boolean }
  | { type: "tools"; tools: ToolState[] };
```

One ordered list preserves sequences such as:

```text
reasoning → text → parallel tools → reasoning → text
```

Separate text and tool arrays would move later text above earlier tools.

## Live and persisted projection

The application has two inputs and one display model:

```text
persisted SDK messages ─→ projectTranscript() ─┐
                                               ├─→ MessagePart[] ─→ React
live browser events ────→ applyBrowserEvent() ─┘
```

`lib/letta/transcript.ts` handles persisted messages. It collects tool return
status before it builds the transcript because persisted returns can appear
before their matching calls in the retrieved page.

`lib/letta/browser-events.ts` handles live events. It joins fragmented tool
arguments by tool-call ID and settles unresolved tools at the terminal event.

The reducers are pure. Their fixture tests do not need a browser or network.

## Conversation lifecycle

The interface creates conversations lazily. **New conversation** clears the
page, but it does not create an empty stored conversation. The first message
creates the conversation and sends the turn.

Selecting a stored conversation resumes a temporary SDK session, calls
`bootstrapState()`, projects the messages, and closes the session. Sending the
next turn opens a new temporary session for the same durable conversation.

## Scrolling

`hooks/use-follow-output.ts` measures the transcript viewport. Streamed content
stays visible while the reader is near the bottom. Scrolling upward disables
follow mode. Selecting another conversation restores follow mode.

The page itself does not scroll. The sidebar and composer stay outside the
transcript viewport, so streamed Markdown cannot move them during reflow.

## Production boundary

This example uses one agent for one trusted user. A multi-user application must
authenticate each route and authorize every conversation ID. Do not use an
agent-wide conversation list as a user access policy.

After an uncertain network failure, inspect persisted conversation history
before you retry a user message. The original `send()` can succeed before the
connection fails.
