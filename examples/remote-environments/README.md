# Remote Environment Examples

These examples show the remote-agent programming model added in this branch:
keep the agent/conversation as the stable actor, then target a Letta Code remote
environment for the turn.

Remote dispatch is currently **ACK-only**. The call confirms that Cloud accepted
and forwarded the message to the selected online Letta Code environment. It does
not yet stream the final assistant answer through the SDK.

## Prerequisites

1. Start an online remote environment, for example with `letta server` on the
   machine you want to target.
2. Create or choose a Letta agent.
3. Export the IDs used by the scripts:

```bash
export LETTA_API_KEY="sk-..."
export LETTA_AGENT_ID="agent-..."

# Optional. Defaults to the agent's default conversation when omitted.
export LETTA_CONVERSATION_ID="conv-..."

# Preferred stable target selector.
export LETTA_REMOTE_DEVICE_ID="device-..."

# Optional if you are using a non-production Cloud API.
export LETTA_BASE_URL="https://api.letta.com"
```

If you do not know the remote device ID yet, run:

```bash
bun examples/remote-environments/list-and-send.ts --list-only
```

## High-level actor wrapper

Use `createRemoteAgent()` when your application already knows which agent,
conversation, and environment it wants to target:

```bash
bun examples/remote-environments/send-to-device.ts \
  "Pull main, run tests, and summarize failures."
```

This uses a stable `deviceId` and lets the SDK resolve the current ephemeral
`connectionId`.

## Last-used environment

If the agent/conversation has a recorded last remote environment, target it with:

```bash
bun examples/remote-environments/send-to-last-used.ts \
  "Continue the task on the machine I used last time."
```

The script falls back to any online environment if the last-used one is offline.

## Lower-level client flow

Use `RemoteEnvironmentClient` directly when you want to list environments, choose
a target in your own UI, and then dispatch:

```bash
bun examples/remote-environments/list-and-send.ts \
  "Run pwd and tell me which repo you are in."
```

Selectors supported by the helper:

```bash
export LETTA_REMOTE_DEVICE_ID="device-..."        # stable, preferred
export LETTA_REMOTE_ENVIRONMENT_ID="env-..."     # stable Cloud environment row
export LETTA_REMOTE_CONNECTION_NAME="Work Mac"   # user-facing, must be unique
export LETTA_REMOTE_CONNECTION_ID="conn-..."     # low-level, ephemeral
```
