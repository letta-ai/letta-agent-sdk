# Agent instructions

This repository is a teaching project for the Letta Agent SDK. Keep the code
easy to navigate. Do not move interface choices into the SDK boundary.

## Read first

1. Read `README.md` for setup and the file map.
2. Read `docs/ARCHITECTURE.md` before you change state or session behavior.
3. Read `docs/CUSTOMIZE.md` before you change the interface.
4. Run `npm run verify` before you hand off a change.

## Source boundaries

- `components/chat/` owns visible React markup.
- `hooks/` owns browser interaction state.
- `lib/letta/` owns browser-safe events and transcript projection.
- `app/api/` owns credentials and Agent SDK sessions.
- `styles/tokens.css` owns common design values.
- `styles/chat.module.css` owns layout and component presentation.
- `tests/` owns protocol and ordering fixtures.

## Invariants

- Keep `LETTA_API_KEY` in server code. Do not add `NEXT_PUBLIC_` to it.
- Use `resumeSession(conversationId)` for an existing conversation.
- Call `bootstrapState()` when the interface restores a conversation.
- Close every Agent SDK session in a `finally` block.
- Preserve text, reasoning, and tool calls in one ordered `MessagePart[]` list.
- Join `rawArguments` fragments by tool-call ID before parsing them.
- Group only consecutive tool calls.
- Set unresolved tools to complete at `done` and failed at terminal `error`.
- Keep raw tool-return content on the server unless a component needs a safe,
  explicit projection.
- Keep the sidebar and composer outside the scrolling transcript viewport.
- Preserve manual scroll position when the user scrolls away from the bottom.

## Common tasks

### Restyle the app

Edit `styles/tokens.css` first. Edit `styles/chat.module.css` only when the
change needs a new layout rule. Do not edit the SDK routes for visual changes.

### Change one transcript item

Edit the matching component in `components/chat/`. Keep the ordered parts model
unchanged unless the Agent SDK emits a new event type.

### Add an SDK event

1. Project the SDK event in `app/api/chat/route.ts`.
2. Add its browser-safe type to `lib/letta/browser-events.ts`.
3. Update the pure reducer in the same file.
4. Render the resulting part in `components/chat/transcript-message.tsx`.
5. Add a deterministic fixture to `tests/browser-events.test.ts`.

### Change restored history

Edit `lib/letta/transcript.ts`. Add a persisted-message fixture to
`tests/transcript.test.ts`. Verify that live and persisted paths produce the
same ordered part model.

## Validation

Use the following sequence:

```bash
npm run test
npm run lint
npm run build
```

For session or route changes, also run the app with a real Cloud agent. Verify
a `text → parallel tools → text` turn, reload the conversation, and compare the
restored order and tool status.
