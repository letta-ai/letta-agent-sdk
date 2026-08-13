# Persistent dungeon master

This example uses one local Letta agent to run several tabletop campaigns. It saves the agent ID, resumes the same conversation, and keeps campaign state in readable Markdown files.

The example teaches three SDK patterns:

- Create an agent once, then resume it by ID.
- Stream assistant text and tool calls from an interactive session.
- Keep application state in files that you can inspect and edit.

## Prerequisites

You need the following items:

- A checkout of this repository.
- Bun 1.3.0, which is the package manager declared in `package.json`.
- Valid credentials for the local backend's current default model.
- Write access to this example directory.

Install the repository dependencies from the repository root:

```bash
bun install
```

The example pins `backend: "local"`. It does not switch to Cloud when `LETTA_API_KEY` is set. The SDK selects the current default model for the local backend.

## Run the example

Run the CLI from the repository root:

```bash
bun examples/dungeon-master/cli.ts
```

`dm.ts` sets the session `cwd` to `examples/dungeon-master`. The agent and the CLI therefore use the same paths for `rulebook.md` and `campaigns/<name>/`.

For a named campaign, skip the campaign-name prompt:

```bash
bun examples/dungeon-master/cli.ts --campaign=dragons
```

Enter actions or dialogue at the `>` prompt. Enter `save` to ask the agent to update the campaign files. Enter `quit` to ask for a final save and close the session.

## Review the file-access warning

`dm.ts` sets `permissionMode: "unrestricted"` and allows the `Read` and `Write` tools. The local app-server runs those tools on your machine without an approval prompt.

The process has the same filesystem access as your user account. The tool allowlist prevents other client-side tools. The configured `cwd` gives relative paths a base directory, but it does not limit `Read` and `Write` to that directory.

For an application that handles untrusted input, replace unrestricted mode with an approval flow. Implement `canUseTool` and approve each file path before the tool runs.

## Follow the first run

The first run follows this sequence:

1. `loadState()` returns an empty state because `state.json` does not exist.
2. The CLI validates the campaign name before it creates backend state.
3. `createDM()` creates a local agent with MemFS enabled.
4. `createDM()` stores the agent ID and resumes its default conversation.
5. `initializeDM()` asks the agent to create `rulebook.md` with its game rules.
6. The CLI records the campaign setup as pending, then creates its directory.
7. The CLI asks the agent to start the campaign.
8. The agent asks about the setting, tone, boundaries, and player character.
9. After that turn succeeds, the CLI records the active campaign.
10. Each player message starts another streamed agent turn.

The host code creates `state.json` and the campaign directory. The agent creates and updates the Markdown content through `Write`. The next CLI command removes a campaign whose setup remained pending after an error or process interruption. Verify the files after the first save because the model controls each tool call.

## Resume a later run

Run the CLI again from the repository root:

```bash
bun examples/dungeon-master/cli.ts
```

The CLI reads the saved agent ID and calls `resumeSession(agentId)`. This call resumes the agent's default conversation. If `state.json` names an active campaign, the agent reads its files. The agent then recaps the last session and sets the next scene.

Use the following commands to inspect or select saved state:

```bash
bun examples/dungeon-master/cli.ts --status
bun examples/dungeon-master/cli.ts --list
bun examples/dungeon-master/cli.ts --rulebook
bun examples/dungeon-master/cli.ts --campaign=dragons
bun examples/dungeon-master/cli.ts --new
```

`--campaign=dragons` resumes the directory if it exists. Otherwise, it starts a campaign with that name. `--new` prompts for a name and rejects a name that already exists.

## Observe persistence

The example has three state layers:

| State | Where it lives | What it contains |
| --- | --- | --- |
| Agent state | Local Letta backend | Agent identity, system prompt, MemFS, and the default conversation |
| CLI state | `state.json` | Agent ID, active campaign, and any setup in progress |
| Game state | `rulebook.md` and `campaigns/` | Rules, world details, character state, quests, and session history |

A generated directory can contain the following files:

```text
dungeon-master/
├── state.json
├── rulebook.md
└── campaigns/
    └── dragons/
        ├── world.md
        ├── player.md
        ├── npcs.md
        ├── quests.md
        ├── session-log.md
        └── consequences.md
```

The agent creates files when its prompts call for them. A new campaign starts as an empty directory, so some files can remain absent until play or a save requires them.

Use this short exercise to check persistence:

```bash
bun examples/dungeon-master/cli.ts --campaign=dragons
# Answer the setup questions, enter an action, then enter: save
# Enter: quit

bun examples/dungeon-master/cli.ts --status
bun examples/dungeon-master/cli.ts --rulebook
ls examples/dungeon-master/campaigns/dragons
bun examples/dungeon-master/cli.ts --campaign=dragons
```

Compare the recap with `session-log.md`, `player.md`, and the other campaign files. Persistence is visible in the stored agent ID, resumed transcript, and saved files. Reusing an agent does not guarantee that later output will improve.

## Distinguish the agent from the conversation

An agent owns its identity, system prompt, and memory. A conversation owns one message history for that agent.

This example stores only `dmAgentId`. Both the first run and later runs call `resumeSession(agentId)`, so every campaign uses the same default conversation. Starting a new campaign creates a new directory, not a new conversation.

Use `client.createSession(agentId)` when each campaign needs a separate message history. After the session initializes, save its `conversationId` for that campaign. Resume the campaign later with `client.resumeSession(conversationId)`. The campaigns can still share one agent and its MemFS.

## Understand where tools run

`createExampleClient({ backend: "local" })` starts an SDK-owned Letta Code app-server on this machine. Its built-in `Read` and `Write` tools also run on this machine.

The session allows only those two client-side tools. `chat()` sends one user message, then reads `session.stream()`. It prints assistant fragments as they arrive and prints a label when the agent calls a tool.

The local agent is not available in the hosted chat UI. `--status` prints the local agent ID instead of a hosted-agent URL.

## Reset the example

Run the reset command and enter `yes` at the prompt:

```bash
bun examples/dungeon-master/cli.ts --reset
```

Reset deletes the following local paths under this example:

- `state.json`
- `rulebook.md`
- `campaigns/`

Reset does not delete the agent, its MemFS, or its conversation from the local backend. The next normal run creates a new agent and campaign directory because `state.json` no longer contains the old agent ID.

## Read the code

| File | Responsibility |
| --- | --- |
| `cli.ts` | Parses commands, selects a campaign, and owns the terminal input loop. |
| `dm.ts` | Creates or resumes the agent, streams turns, and manages generated files. |
| `types.ts` | Defines the saved state, generated paths, and campaign filenames. |
| `../create-agent-session.ts` | Creates the SDK client, enables MemFS, and provides shared example helpers. |

Start with `main()` in `cli.ts`. Then follow `createDM()` and `chat()` in `dm.ts`. These functions show the create, resume, send, and stream calls without a framework around them.

## Extend the example

The current structure supports the following changes:

- **Select a model.** Add a configured model alias or handle to `DM_SESSION_OPTIONS` in `dm.ts`.
- **Separate campaign transcripts.** Store a conversation ID for each campaign. Use `createSession(agentId)` for a new campaign and `resumeSession(conversationId)` later.
- **Add a deterministic game tool.** Define a custom SDK tool for dice or card draws. Add the tool and its name to `DM_SESSION_OPTIONS`. The shared options apply after creation and on later resumes.
- **Add a campaign file.** Add the filename to `CAMPAIGN_FILES` in `types.ts`. Update the save and resume prompts if the file needs a specific read or write trigger.
- **Add approval controls.** Replace unrestricted mode and provide a `canUseTool` callback that validates each requested path.

Keep campaign artifacts separate from agent memory. Campaign files hold the full game state. MemFS is better suited to durable cross-campaign preferences and short campaign pointers.
