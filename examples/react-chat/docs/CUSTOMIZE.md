# Customize the chat

Start with the smallest file that owns the requested change. Run
`npm run verify` after each change.

## Change the theme

Edit `styles/tokens.css`:

```css
:root {
  --chat-background: #fff;
  --chat-text: #212121;
  --chat-muted: #777;
  --chat-content-width: 720px;
  --chat-sidebar-width: 200px;
  --chat-composer-radius: 28px;
}
```

These variables control the common visual values. Keep component selectors in
`styles/chat.module.css`.

Pass condition: the new theme appears without changes to `app/api/` or
`lib/letta/`.

## Change message markup

Edit `components/chat/transcript-message.tsx`. The component receives one
`ChatMessage` and renders each ordered part.

Keep the `message.parts.map(...)` loop. Do not render text, reasoning, and tools
in separate sections because that changes their emitted order.

Pass condition: the `browser-events.test.ts` ordering test remains green.

## Change tool calls

Edit `components/chat/tool-disclosure.tsx` to change labels, argument display,
or expansion behavior. Each `ToolState` includes:

```typescript
type ToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  rawInput: string;
  status: "running" | "complete" | "failed";
};
```

Use `rawInput` while arguments stream. Use `input` after the SDK supplies a
parsed object. Do not add raw tool-return content to this type without a clear
user need and a server-side safety review.

## Change reasoning

Edit `components/chat/thinking-disclosure.tsx`. Active reasoning uses a
fixed-height preview. Completed reasoning uses a collapsed disclosure at its
event position.

The display choice is replaceable. The ordered reasoning part in
`MessagePart[]` is the behavior contract.

## Change the loading state

Edit `components/chat/chat-composer.tsx`. The composer uses both text and motion:

- the input says **Agent is working…**;
- the send button contains an animated orb;
- `aria-busy` reports the state to assistive technology.

Do not rely on motion alone to communicate progress.

## Change conversation behavior

Edit `hooks/use-chat-session.ts` for browser interaction. Edit
`app/api/conversations/route.ts` for server operations.

The current behavior creates a stored conversation only after the first
message. This rule prevents duplicate empty conversations in the sidebar.

## Add a visible SDK event

Trace the event through the complete boundary:

1. Convert the SDK message in `app/api/chat/route.ts`.
2. Add a browser-safe event in `lib/letta/browser-events.ts`.
3. Reduce the event into `MessagePart[]`.
4. Render the part in `components/chat/transcript-message.tsx`.
5. Add a fixture test.

Do not send a complete SDK message to the browser as a shortcut. Project only
the fields that the interface uses.

## Replace the backend

Complete the Cloud version before you change the backend. Local mode imports
the package root and uses `backend: "local"`. It also requires Next.js to keep
the Agent SDK and Letta Code packages outside the server bundle.

See the deployment guide for Cloud, local, and remote configuration. Keep each
backend in a separate example or branch so that setup instructions stay clear.
