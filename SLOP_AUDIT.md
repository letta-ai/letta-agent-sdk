# PR 146 SLOP Audit — Cloud Sandbox Backend

Status: historical audit. Product code was subsequently de-slopped on this branch; see `SLOP_PART2.md` for current fixed baseline, validation status, and remaining follow-ups.
Branch: `letta/let-9238-cloud-sandbox-backend`
SDK worktree: `/Users/loaner/dev/letta-code-sdk-public/.letta/worktrees/let-9238-cloud-sandbox-backend`
App-server reference worktree: `/Users/loaner/dev/letta-code-prod/.letta/worktrees/let-9244-app-server-auth`

## Why this file exists

The audit must persist outside chat/compaction. Findings below should be evidence-based and updated as more code/app-server/Cloud behavior is checked. Avoid overconfident claims; mark live-service behavior separately from intended contract.

Post-fix note: many concrete code-smell bullets below describe the pre-fix PR state. They are retained as audit trail, not current truth. Current code no longer has the bespoke Cloud runtime controller, Cloud-only approval/recovery path, Cloud REST history path, create-agent tag/origin/MemFS suppression, fabricated app-server/cloud history/bootstrap flags, fabricated pending-approval state after `sync_response`, fabricated remote/cloud agent tools from SDK-hosted external tools, stale `/v1/agents/{agentId}/sandboxes` sandbox CRUD routes, or the SDK-local `RemoteClientSessionCore` capability matrix. Shared app-server/listener protocol commands now use one shared path for app-server and direct Cloud sessions, including Cloud `updateToolset()`. Current PR scope now requires an explicit Cloud `environment` and fails fast before Cloud conversation REST/websocket side effects when it is missing; SDK-managed sandbox lifecycle is split into a fast-follow paired with `letta-cloud#12516`.

## Context-free truth / north star (read this first)

This section is the user-corrected architecture. If a future agent opens this file with an empty, compacted, or polluted context window, treat this as the source of truth for the audit and for de-slopping PR 146.

### What Cloud is supposed to be

- Cloud is a router/provisioning layer around the same Letta Code listener websocket backend. It is not a separate SDK runtime with a separate product contract.
- The Cloud backend should differ from remote/local primarily in how the execution environment is allocated/resolved:
  1. authenticate to Cloud with `LETTA_API_KEY` / Cloud API config;
  2. create/refresh/terminate or attach to a Cloud sandbox/environment;
  3. connect to the same listener/app-server websocket semantics used elsewhere.
- Once connected, turns, stream deltas, approvals, reflection/sleeptime settings, external tools, model/cwd/permission updates, history/bootstrap, and pending-approval recovery should behave like the local/remote websocket listener path.

### What Cloud is not supposed to be

- Cloud is not a place for a bespoke SDK-side runtime controller that redefines terminality, sync/recovery, tools, reflection settings, or history shape.
- Cloud is not allowed to silently downgrade public SDK contracts because a Cloud REST route has a temporary bug.
- “Cloud capabilities” should not be used as a hand-wavy explanation for missing behavior if the underlying listener websocket already supports the same protocol command. In this audit, phrases like “Cloud capabilities disable reflection settings” should be read as evidence that the SDK adapter has drifted, not as a real product invariant.

### `createAgent()` should be boring

The desired Cloud `createAgent()` implementation should be essentially the same harness/app-server/local-websocket create-agent path as local/remote, with Cloud auth/config applied so the harness creates a Cloud-backed agent:

- start/use the bundled `letta server` / app-server harness;
- configure it for Cloud/API backend using `LETTA_API_KEY` or equivalent auth plumbing;
- let the existing harness semantics run unchanged.

That means Cloud `createAgent()` should preserve, not suppress:

- caller `tags`;
- automatic `origin:letta-code`;
- preset/system-prompt/model/body translation owned by the harness;
- MemFS/default setup semantics;
- any other app-server/CLI create-agent defaults.

The PR's current pattern — using the harness but setting `includeSdkOriginTag: false`, `enableMemfsAfterInitialize: false`, rejecting caller `tags`, and adding tests that expect those omissions — is the slop. It is not acceptable to turn a transient Cloud tag/MemFS/backend bug into durable SDK behavior. Fix Cloud or hide the bug behind a narrow verified workaround; do not weaken the SDK contract.

### Reflection/sleeptime should not be a Cloud-only capability fork

The confusing audit phrase “Cloud capabilities disable reflection settings” refers to the SDK adapter’s internal boolean capability table, not to a desired product concept. The branch currently accepts parts of `sleeptime` on Cloud while the Cloud session does not enable the shared `set_reflection_settings` path, so those options can become silent no-ops.

Correct framing:

- If the listener websocket supports `set_reflection_settings`, Cloud should use the same command/path.
- If the PR has not wired that path, call it an SDK adapter bug/gap.
- Do not describe it as an inherent Cloud limitation unless there is a real protocol/backend absence.

### Pending approval recovery should use the shared protocol

The obvious/shared recovery mechanism is protocol_v2 `sync` with approval recovery flags, matching the app-server SDK path:

```ts
sync({
  runtime,
  recover_approvals: true,
  force_device_status: true,
})
// wait for sync_response
```

The Cloud adapter's separate `recover_pending_approvals` / `recover_pending_approvals_ack` / `recover_pending_approvals_response` message family is protocol drift unless Cloud has a formally documented different status-websocket contract. Default de-slop direction: delete the fork and use the shared `sync` path.

### Review rubric

For every finding below, prefer this framing:

- Bad framing: “Cloud lacks capability X.”
- Correct framing: “The SDK Cloud adapter bypasses the shared listener/app-server path that already has capability X.”

Tests should assert Cloud parity with local/remote listener semantics. They should not codify downgraded Cloud behavior.


### Concrete PR code-smell map

If context is polluted, start by checking these symbols/files. They are where the architectural drift is encoded:

- `src/cloud-session.ts` / `cloudHarnessAppServerOptions()`:
  - forces `includeSdkOriginTag: false`;
  - forces `enableMemfsAfterInitialize: false`;
  - configures a Cloud-specific harness path instead of preserving app-server create-agent semantics unchanged.
- `src/cloud-session.ts` / `createCloudAgent()`:
  - rejects caller `tags`;
  - treats a Cloud tag/backend bug as an SDK contract change.
- `src/cloud-session.ts` / `CloudStatusRuntimeController`:
  - reimplements websocket request correlation, turn terminality, loop-status fallback, approval handling, sync, ACK/ping/event sequencing, and recovery;
  - should be deleted, shrunk to a transport adapter, or made to reuse the same app-server/listener state machine.
- `src/cloud-session.ts` / `CloudStatusRuntimeController.recoverPendingApprovals()`:
  - uses Cloud-only `recover_pending_approvals` messages;
  - should use protocol_v2 `sync({ recover_approvals: true, force_device_status: true })` unless a real Cloud protocol document says otherwise.
- `src/cloud-session.ts` / Cloud session capability config:
  - omits `reflectionSettings`, causing accepted `sleeptime.trigger` / `stepCount` values to be ignored;
  - this is adapter drift, not an inherent Cloud limitation.
- `src/cloud-session.ts` / `assertCloudSessionOptionsSupported()`:
  - rejects or narrows features that the shared listener/app-server protocol may already support (`tools`, toolsets, reflection settings, etc.);
  - each rejection should be audited as “did we bypass the shared path?” before calling it unsupported.
- `src/tests/cloud-session.test.ts`:
  - currently codifies weakened Cloud behavior for tags/origin/MemFS and mocked Cloud-only protocol messages;
  - tests should be rewritten toward parity with local/remote listener semantics.

### Minimal de-slop implementation direction

Do not try to perfect the bespoke Cloud adapter. The likely simplest fix is structural:

1. Use Cloud REST only for Cloud-specific provisioning: create/refresh/terminate sandbox, resolve environment/connection, maybe list persisted messages if contract-verified.
2. For create-agent, launch/use the same bundled app-server/listener harness with Cloud auth (`LETTA_API_KEY`, API backend config) and preserve normal harness defaults.
3. For runtime control, connect through the same app-server/listener protocol semantics as remote/local websocket.
4. Reuse the same `runtime_start`, `input/create_message`, `stream_delta`, `sync`, `set_reflection_settings`, `external_tool_call_request/response`, `conversation_messages_list`, and terminality rules.
5. Remove Cloud-only downgraded tests; replace them with parity/conformance tests.


## High-level target shape

- The SDK implementation surface should stay small and boring.
- The hard parts are already intended to live in Letta Code app-server and Remote Client / remote environments.
- Cloud sandbox CRUD exposure is pending Ari's route PR; SDK should consume that surface rather than inventing a parallel control plane where possible.
- Cloud backend should preserve SDK contracts across local/remote/cloud unless a capability is genuinely unavailable; unsupported gaps should be explicit, narrow, and temporary.
- Do not paper over Cloud/backend bugs by permanently weakening SDK contracts or docs.

## Current read-only evidence collected

- PR diff files vs merge-base `c4b13e23aac22b3b2cf1fa63dc6e2de58ed64191`:
  - `README.md`
  - `src/app-server-session.ts`
  - `src/client.ts`
  - `src/cloud-session.ts`
  - `src/index.ts`
  - `src/local-app-server.ts`
  - `src/remote-client-session-core.ts`
  - `src/tests/client.test.ts`
  - `src/tests/cloud-session.test.ts`
  - `src/tests/local-app-server.test.ts`
  - `src/types.ts`
- App-server supports `runtime_start`, `external_tools`, `enable_memfs`, `set_reflection_settings`, `update_toolset`, `conversation_messages_list`, and runtime state replay.
- App-server/CLI intentionally tags Letta Code-created agents with `origin:letta-code`:
  - `buildCreatedAgentTags` in app-server agent creation path.
  - `ensureLettaCodeOriginTag` in system prompt versioning path.
- Live Cloud tag probe:
  - Agent `agent-8bfa8833-5a62-44d8-b7df-811c09f45028` was created and deleted.
  - `PATCH /v1/agents/:id { tags }` returned `400 {"error":"column \"name\" of relation \"hosted_memfs_repositories\" does not exist"}`.
  - Subsequent retrieve showed tags persisted: `["origin:letta-code", "team:sdk"]`.
  - Interpretation: Cloud tag update currently has a response/error bug, but tags can persist. SDK should not conclude “Cloud cannot tag agents.”
- Letta Code subagents failed during this audit because Cloud agent creation hit the same hosted-MemFS 400 before tool use. Use external Codex/Claude via CLI instead.

## Findings / suspected SLOP

### 1. Cloud createAgent rejects `tags`, weakening SDK contract

Evidence:
- `src/cloud-session.ts` `createCloudAgent()` currently throws if `agentOptions.tags !== undefined`.
- `src/types.ts` still documents `CreateAgentOptions.tags` as SDK-created agents also being tagged with `origin:letta-code` if missing.
- App-server path has `includeSdkAgentOriginTag()` and `createAgentBody()` preserving origin tag behavior.
- Live Cloud update test showed tag update returns a bogus 400 but tags persisted.

Why it is SLOP:
- This bakes a transient Cloud create/update quirk into SDK behavior.
- It creates backend-specific behavior for a durable SDK creation option.
- Docs promise origin tagging, but Cloud implementation suppresses `includeSdkOriginTag` and rejects caller tags.

Likely de-slop direction:
- Prefer the normal harness/app-server create-agent path authenticated to Cloud, preserving caller tags and `origin:letta-code` the same way local/remote creation does.
- If Cloud create/update tags have a transient backend bug, hide it behind a narrow workaround that still preserves the public contract; do not reject tags or suppress origin tagging as durable SDK behavior.
- If a post-create tag verification/backfill is temporarily required, verify by retrieve before failing and mark it as a Cloud bug workaround with a removal plan.

Open questions:
- What Cloud/backend fix removes the need for any tag workaround?
- Does Ari's sandbox CRUD route PR only affect sandbox lifecycle, or is there another Cloud route dependency for preserving harness-created agent metadata?

### 2. Cloud direct controller bypasses listener/app-server semantics instead of reusing the shared runtime protocol

Evidence:
- `CloudEnvironmentSession` uses `CloudStatusRuntimeController` directly against `/v1/environments/:connectionId/status/ws`.
- App-server `runtime_start` supports registering `external_tools`, applying cwd/mode, resolving agent/conversation, state replay, etc.
- Cloud controller sends `type: "input"` with `payload.kind = "create_message"` directly and implements its own terminal detection, approval handling, ack/sync, idle success fallback.

Why it is SLOP:
- Duplicates protocol behavior that already exists in `@letta-ai/letta-code/app-server-client` + app-server listener.
- Raises risk of Cloud-only divergence in terminal detection, sync/recovery semantics, external tools, toolsets, and message listing.
- SDK should ideally mostly be: create/resolve Cloud sandbox/environment, then speak the same app-server/remote-client protocol surface.

Likely de-slop direction:
- Prefer instantiating/reusing the same app-server/listener protocol path once Cloud sandbox CRUD exposes the needed connection/routing.
- If direct Cloud status websocket is the only available transport, keep it as a tiny transport adapter over the same listener semantics, not a second product surface.
- Treat missing behavior as adapter drift unless a real documented listener/Cloud protocol absence exists.

Open questions:
- Is the Cloud status websocket intentionally the public remote-env control channel for SDK, or should SDK connect to an app-server websocket endpoint behind the environment?
- Which messages are guaranteed by Remote Client over Cloud status websocket vs local app-server client?

### 3. `listMessages()` returns raw `unknown[]` despite SDK-facing typed-message expectations

Evidence:
- `src/types.ts` defines `ListMessagesResult.messages: unknown[]` and doc says raw Letta API message objects.
- `src/cloud-session.ts` `listCloudMessages()` returns response bodies directly.
- `src/app-server-session.ts` `conversation_messages_list_response` uses `messages: unknown[]` and returns `hasMore: false`, `nextBefore: null` regardless of backend pagination metadata.
- `bootstrapState()` exposes these raw messages as initial state.

Why it is SLOP:
- SDK consumers now get an untyped raw API escape hatch where SDK previously normalizes stream/run messages.
- Pagination metadata may be misleading on app-server path.
- `bootstrapState()` becomes inconsistent: current turn messages are normalized SDK messages, history messages are raw unknown objects.

Likely de-slop direction:
- Define a minimal typed history message shape for SDK state, or explicitly separate `rawMessages` from normalized SDK messages.
- Align app-server and Cloud pagination semantics. If metadata is unavailable, do not imply `hasMore: false` unless known.
- Add tests that assert the public type/shape, not merely that an array passes through.

Open questions:
- What exact history shape does desktop/sidebar need? It may not need full Letta API objects.
- Should message normalization live in SDK core or app-server protocol response?

### 4. Cloud rejects SDK-hosted `tools` even though app-server external_tools already exists

Evidence:
- `assertCloudSessionOptionsSupported()` rejects `options.tools` with “has not wired SDK-hosted tools to remote control_response yet.”
- App-server runtime start supports `external_tools`; SDK `AppServerSession` registers `onExternalToolCall` and returns tool content.
- Cloud `CloudStatusRuntimeController.handleControlRequest()` only handles `can_use_tool` approvals, not external tool calls.

Why it is SLOP:
- This is a missing wiring problem, not a fundamental Cloud impossibility.
- Cloud gets a worse SDK contract than remote/local even though the app-server protocol already has the concept.

Likely de-slop direction:
- Because Cloud should reach the same listener semantics, implement the same `external_tools`/tool execution bridge unless there is a real documented Cloud routing/protocol absence.
- If a real absence exists, keep rejection narrow, phrase it as a temporary transport/protocol dependency, and avoid claiming “Cloud backend cannot support tools” broadly.

Open questions:
- What exact control request subtype does Cloud emit for external tool calls today (`external_tool_call`, `control_response`, or app-server v2 equivalent)?
- Is app-server-client usable directly over Cloud environment websocket to avoid reimplementing this?

### 5. Adapter capability matrix / error messages are too broad and may ossify temporary gaps

Evidence:
- Cloud rejects `systemPrompt`, allowed/disallowed tools, SDK tools, skillSources, systemInfoReminder, sleeptime.behavior, memfs=false, memfsStartup, includePartialMessages.
- Remote/app-server rejects a similar but not identical set.
- `RemoteClientSessionCore` has capability flags for `enableMemfs`, `reflectionSettings`, `updateModel`, `changeDeviceState`, `updateToolset`; Cloud enables only `enableMemfs`, `updateModel`, `changeDeviceState`.

Why it is SLOP:
- Some rejections are probably legitimate current gaps; others may already map to app-server protocol or should be represented as no-op/unsupported per backend.
- Broad “not wired yet” errors become product behavior if not narrowed.

Likely de-slop direction:
- Start from app-server/listener protocol reality, not a Cloud-specific capability table.
- For each SDK option: shared listener path already supports it, adapter failed to wire it, or there is a real documented backend/protocol absence.
- Tests should assert exact unsupported behavior only for intentional gaps; Cloud tests should otherwise assert parity with local/remote listener semantics.

### 6. Cloud sandbox lifecycle probably belongs around environment resolution only

Evidence:
- `CloudEnvironmentSession` owns sandbox lifecycle: create/refresh/wait/terminate.
- README now documents `ephemeral`, `keep-warm`, `external` sandbox lifecycle.
- User stated hard part is app-server/remote envs, already done, pending Ari's sandbox CRUD expose route PR.

Why it may be SLOP:
- SDK may be taking on too much lifecycle/control responsibility before the intended Cloud route exists.
- The simple SDK surface should likely be: choose/create Cloud sandbox via CRUD route, resolve remote environment connection, then start/control runtime using the shared listener/app-server protocol semantics.

Likely de-slop direction:
- Keep sandbox code as a thin wrapper over Cloud CRUD routes.
- Do not duplicate app-server runtime semantics inside sandbox lifecycle code.
- Gate route assumptions behind clear TODOs/tests/mocks until Ari's PR lands.

## Tests that should exist before merging

- Cloud `createAgent({ tags: [...] })` preserves caller tags and `origin:letta-code` through the same harness/app-server semantics as local/remote.
- If a temporary tag workaround remains, it handles “400 but persisted” by retrieve/verify and is clearly marked as a Cloud bug workaround, not the product contract.
- Cloud origin tag is present for SDK-created agents even when caller omits tags.
- listMessages public shape is stable and typed; app-server and Cloud behavior matches or explicitly differs.
- Cloud unsupported option errors are narrow and do not reject capabilities that app-server protocol already supports.
- If a direct Cloud status websocket transport remains, parity/conformance tests cover error, llm_api_error, max_steps, interrupted, idle WAITING_ON_INPUT, duplicate idempotency keys, and event sequence gaps using the same terminality contract as local/remote.
- External tool behavior is either wired for Cloud or tested as a narrowly documented temporary unsupported transport gap.

## External-agent review results

Completed Codex review reports are stored under `.audit-agents/`:
- `.audit-agents/codex2-architecture-report.md` — Cloud-vs-app-server architecture audit.
- `.audit-agents/codex2-contract-report.md` — public SDK contract/type audit.
- `.audit-agents/codex2-cloud-behavior-report.md` — Cloud behavior/state-machine audit.

These reports are imported/summarized later in this file.


## Source reference inventory for external agents

These are the starting points external stateless agents must receive so they do not wander or redo context discovery.

### SDK PR branch / worktree

- Repo/worktree: `/Users/loaner/dev/letta-code-sdk-public/.letta/worktrees/let-9238-cloud-sandbox-backend`
- Branch: `letta/let-9238-cloud-sandbox-backend`
- Merge-base checked: `c4b13e23aac22b3b2cf1fa63dc6e2de58ed64191`
- PR diff files:
  - `README.md`
  - `src/app-server-session.ts`
  - `src/client.ts`
  - `src/cloud-session.ts`
  - `src/index.ts`
  - `src/local-app-server.ts`
  - `src/remote-client-session-core.ts`
  - `src/tests/client.test.ts`
  - `src/tests/cloud-session.test.ts`
  - `src/tests/local-app-server.test.ts`
  - `src/types.ts`

### SDK files/functions to inspect first

- `src/client.ts`
  - `LettaCodeClient.createAgent()` backend dispatch.
  - `LettaCodeClient.createSession()` / `resumeSession()` backend dispatch.
  - `assertSessionBackend()` cloud/remote option gating.
  - `stripEnvironment()` and `hasCreateAgentEnvironment()`.
- `src/cloud-session.ts`
  - `createCloudAgent()` currently rejects `agentOptions.tags`.
  - `cloudHarnessAppServerOptions()` sets `includeSdkOriginTag: false`, `pinGlobalAgent: false`, `enableMemfsAfterInitialize: false`.
  - `assertCloudSessionOptionsSupported()` rejects many SDK options.
  - `listCloudMessages()` returns raw API payloads as `unknown[]`.
  - `CloudStatusRuntimeController` duplicates websocket send/request/ack/sync/turn terminal logic.
  - `CloudStatusRuntimeController.runTurnMessage()` sends `type: "input"`, `payload.kind: "create_message"`, `supports_control_response: true`, `source: SDK_AGENT_ORIGIN`.
  - `CloudStatusRuntimeController.handleControlRequest()` only handles `request.subtype === "can_use_tool"`.
  - `CloudEnvironmentSession.resolveRuntime()` / `createConversation()` / `retrieveConversation()`.
  - `CloudEnvironmentSession.resolveConnection()` / `createAgentSandbox()` / `refreshAgentSandbox()` / `terminateAgentSandbox()` / `waitForSandboxConnection()`.
- `src/app-server-session.ts`
  - `SDK_AGENT_ORIGIN_TAG = "origin:letta-code"`.
  - `includeSdkAgentOriginTag()` and `createAgentBody()`.
  - `assertRemoteCreateAgentOptionsSupported()` / `assertRemoteSessionOptionsSupported()`.
  - `externalToolGroups()`.
  - `AppServerRuntimeController.runTurnMessage()` uses app-server client `runTurn()`.
  - `AppServerRuntimeController.listMessages()` uses `conversation_messages_list` but currently returns `nextBefore: null`, `hasMore: false`.
  - `AppServerSession.buildRuntimeStartCommand()` sends `runtime_start`, `create_agent`, `create_conversation`, `external_tools`, cwd/mode.
  - `AppServerSession.handleExternalToolCall()` bridges SDK-hosted tools.
- `src/remote-client-session-core.ts`
  - Shared `RemoteClientRuntimeController` interface.
  - `mapPermissionMode()` mapping `bypassPermissions -> unrestricted`, `plan -> memory`.
  - `applyPostInitializeOptions()` handles `enable_memfs`, `set_reflection_settings`, `update_model`, `change_device_state` based on capabilities.
  - `transformStreamDelta()` SDK message normalization.
  - `resultFromTurn()` stop reason / error code mapping.
- `src/types.ts`
  - `LettaCodeBackend = "local" | "remote" | "cloud"`.
  - `LettaCodeCloudClientOptions` and `LettaCodeCloudSandboxOptions` docs.
  - `CreateAgentOptions.tags` docs promise SDK-created origin tag.
  - `LettaCodeSession.listMessages()` and `BootstrapStateResult` public shape.
  - `ListMessagesResult.messages: unknown[]` raw API docs.
- Tests:
  - `src/tests/cloud-session.test.ts` for mocked Cloud behavior and current assertions.
  - `src/tests/client.test.ts` for backend dispatch/option validation.
  - `src/tests/local-app-server.test.ts` for local app-server behavior.

### App-server / Letta Code reference repo

- Repo/worktree: `/Users/loaner/dev/letta-code-prod/.letta/worktrees/let-9244-app-server-auth`
- Important app-server protocol files:
  - `src/websocket/listener/commands/runtime-start.ts`
    - `handleRuntimeStartCommand()` validates exactly one of `agent_id` or `create_agent`.
    - Creates/retrieves agent, creates/retrieves/default conversation.
    - Applies cwd and permission mode.
    - Registers `parsed.external_tools` with `registerRuntimeExternalTools()`.
    - Sends `runtime_start_response` then replays sync state.
  - `src/websocket/listener/protocol-inbound.ts`
    - Validators for `runtime_start`, `enable_memfs`, `update_toolset`, `conversation_messages_list`, `set_reflection_settings`, external tools shape.
  - `src/app-server-client.ts`
    - Client wrapper for app-server protocol, including `runtimeStart()` and `runTurn()`.
  - `src/types/protocol_v2.ts`
    - Types for `runtime_start`, `RuntimeStartExternalToolsGroup`, `enable_memfs`, `update_toolset`, `conversation_messages_list`, response types.
  - `src/websocket/listener/commands/agents-conversations.ts`
    - Handles `conversation_messages_list`.
  - `src/websocket/listener/commands/memory.ts`
    - Handles `enable_memfs`.
  - `src/websocket/listener/commands/settings.ts`
    - Handles `set_reflection_settings`.
  - `src/websocket/listener/commands/model-toolset.ts`
    - Handles `update_model` / `update_toolset`.
  - `src/websocket/listener/external-tools.test.ts`
    - Tests runtime_start external tool bridge.
  - `src/websocket/listen-client-protocol.test.ts`
    - Tests protocol parsing and runtime_start behavior.
- Agent creation/tagging references:
  - `src/agent/create.ts`
    - `buildCreatedAgentTags({ tags, isSubagent, enableMemfs })` used in create request.
  - `src/agent/system-prompt-versioning.ts`
    - `ensureLettaCodeOriginTag(agent)` retrieves tags and updates missing `origin:letta-code`.
  - `src/agent/defaults.ts`
    - `addTagToAgent()` helper for origin/default tags.
  - `src/agent/memory-filesystem.ts`
    - Comments about runtime_start / LocalBackend.createAgent and memory tags.

### Live Cloud facts from this audit

- Live test agent: `agent-8bfa8833-5a62-44d8-b7df-811c09f45028` (deleted after probe).
- Cloud `PATCH /v1/agents/:id { tags }` returned `400 {"error":"column \"name\" of relation \"hosted_memfs_repositories\" does not exist"}`.
- Subsequent retrieve showed tags had persisted: `["origin:letta-code", "team:sdk"]`.
- Conclusion: do not claim Cloud cannot tag agents; current Cloud update path can persist tags while returning a bogus hosted-MemFS 400.
- Letta subagents failed during audit with same hosted-MemFS 400 during Cloud agent creation before tool use; use local external Codex/Claude for independent review.

### User constraints / corrections

- User explicitly requested: do not make product code changes yet; continue SLOP audit and “desloppify this PR.”
- User corrected process: do not shotgun overconfident findings into chat; persist audit into a file to avoid compaction brain fog.
- Use external coding agents like Codex to help audit/desloppify.
- Recall high-level picture and source references before dispatching stateless agents.
- Desired architecture should be simple in SDK: app-server and remote envs are the hard parts and are already done; pending Ari's sandbox CRUD expose route PR.
- Avoid baking temporary Cloud/backend bugs into durable SDK public behavior.


## Recalled high-level objective / prior decisions

Source: recall task `task_31` completed during this audit.

### Intended SDK architecture

- SDK should expose a simple `LettaCodeClient` backend surface over already-built harness/app-server/remote-env infrastructure.
- SDK should not become a second Letta Code runtime or accumulate Cloud-specific workarounds.
- App-server protocol already owns runtime start, turns, external tools, control commands, stream deltas, list messages, and related harness semantics.
- Remote environments/status websocket already provide the execution/control plumbing.
- Cloud sandbox CRUD is the missing lifecycle surface needed so SDK Cloud can allocate/manage agent sandboxes instead of requiring a pre-existing online environment.

### Ari sandbox CRUD dependency — historical route notes, superseded by live probe

- Cloud PR remembered as `letta-cloud#12516`, title: `feat: expose agent sandbox API routes`.
- Historical routes from the early design note below are not the current live route contract. The current SDK branch no longer calls them; live probing found `POST /v1/sandboxes` and `POST /v1/sandboxes/{sandboxId}/terminate`, and SDK-managed sandbox lifecycle is split out of this PR until the Cloud listener/backend work lands.
- Historical routes recorded during audit:
  - `POST /v1/agents/{agentId}/sandboxes` -> returns `{ sandboxId, deviceId, connectionName }`.
  - `POST /v1/agents/{agentId}/sandboxes/refresh` -> optional `{ ttlMinutes?: number }`; calls Daytona `setAutostopInterval(ttlMinutes)` and `refreshActivity()`.
  - `DELETE /v1/agents/{agentId}/sandboxes`.
- Operation IDs:
  - `sandboxes.createAgentSandbox`
  - `sandboxes.refreshAgentSandbox`
  - `sandboxes.terminateAgentSandbox`
- Route kill switch remembered: `const AGENT_SANDBOX_API_ENABLED = true`.

### Intended Cloud SDK flow after sandbox CRUD exists

1. If no explicit `environment` is supplied, `backend: "cloud"` allocates/uses an SDK-managed sandbox.
2. Sandbox create returns `sandboxId`, `deviceId`, `connectionName`.
3. SDK waits for the matching remote environment to come online, preferring the sandbox `deviceId` as the stable key; `connectionName` fallback is suspicious unless Cloud explicitly guarantees uniqueness.
4. SDK controls runtime through the same listener/app-server websocket semantics as local/remote, not through a bespoke Cloud state machine.
5. SDK refreshes TTL before/around turns.
6. SDK terminates or keeps warm based on lifecycle policy.

Important nuance: this lifecycle work should stay around environment allocation. It should not require duplicating app-server runtime semantics in SDK.

### Prior user/architecture corrections

- `backend: "local"`: embedded/spawned Letta Code harness; not just remote localhost.
- `backend: "remote"`: connects to a user-managed app-server websocket URL. A separate `environment` selector has no meaning because the URL already selects the runtime/app-server; prior conclusion was to throw rather than silently no-op.
- `backend: "cloud"`: uses Letta Cloud/constellation. Current SDK branch requires an explicit `environment`; making it optional again belongs to the SDK-managed sandbox fast-follow after Cloud backend/listener support lands.
- `createAgent()` should be harness-mediated. Client decides where harness runs. `environment` is session-scoped/client default, not part of `createAgent()`.
- Previous mistake in earlier PR audits: unsupported guards were too broad because SDK adapter was narrow. Correct fix is mapping SDK behavior onto app-server protocol commands when the protocol already supports it.
- Same lesson applies here: Cloud-specific unsupported errors are only acceptable when API/protocol truly does not exist.
- Cloud direct `POST /v1/agents` can skip Letta Code harness defaults/translation. Cloud `createAgent()` should go through harness/app-server semantics authenticated to Cloud rather than direct REST reconstruction.

### Audit consequence

De-slopping should converge on a minimal SDK adapter:

- Use harness/app-server semantics for agent creation/runtime start.
- Use Cloud sandbox CRUD only for lifecycle allocation/refresh/termination.
- Use existing listener/app-server websocket protocol semantics for execution; Cloud status/router details should be transport/provisioning only.
- Preserve SDK contracts across local/remote/cloud.
- Do not encode temporary Cloud bugs as durable SDK behavior.

## Manual audit log — test/docs/code pass 1

### Finding: tests now codify weakened Cloud tag contract (high confidence, P1)

Evidence:
- `src/tests/cloud-session.test.ts` test `creates Cloud agents through the local app-server harness` asserts `runtimeStart.create_agent.body.tags` is `undefined`.
- Same test asserts `client.createAgent({ tags: ["team:sdk"] })` rejects with `Cloud backend createAgent() cannot set tags until Cloud supports tags on agent creation`.
- `src/tests/client.test.ts` remote app-server test still asserts remote `createAgent({ tags: ["sdk-test"] })` sends `tags: ["sdk-test", "origin:letta-code"]`.

Why this matters:
- The PR does not merely have an implementation gap; it adds tests that lock in a Cloud-only contract regression.
- These tests conflict with `CreateAgentOptions.tags` documentation and with Letta Code's app-server/CLI origin-tag behavior.
- The live Cloud probe showed tag update can persist despite a bogus hosted-MemFS 400 response, so the test is likely validating the workaround, not the desired behavior.

De-slop direction:
- Replace the Cloud rejection/undefined-tags assertions with expected origin/caller tag preservation through the same harness semantics as local/remote.
- Add a mocked Cloud update/retrieve verification path for the “400 but persisted” case only if SDK needs a temporary backend-bug workaround; keep that workaround invisible to the public contract.

## Recalled source-reference inventory

Source: recall task `task_32` completed during this audit.

Key additions / confirmations:
- Current SDK PR files to audit: `README.md`, `src/app-server-session.ts`, `src/client.ts`, `src/cloud-session.ts`, `src/index.ts`, `src/local-app-server.ts`, `src/remote-client-session-core.ts`, `src/tests/client.test.ts`, `src/tests/cloud-session.test.ts`, `src/tests/local-app-server.test.ts`, `src/types.ts`.
- Cloud source hot spots: `createCloudAgent()`, `assertCloudSessionOptionsSupported()`, `listCloudMessages()`, `CloudStatusRuntimeController`, `CloudEnvironmentSession`, `buildCloudStatusWebSocketUrl()`, `cloudHarnessAppServerOptions()`, `toCloudUserMessage()`, `terminalFromStreamDelta()`, `resolveToolApproval()`, `resolveRuntime()`, `createConversation()`, `retrieveConversation()`, sandbox CRUD methods.
- Shared SDK hot spots: `RemoteClientSessionCore`, `RemoteClientRuntimeController`, `mapPermissionMode()`, `transformStreamDelta()`, `resultFromTurn()`, `applyPostInitializeOptions()`, `AppServerSession`, `AppServerRuntimeController`, `createAgentBody()`, `includeSdkAgentOriginTag()`, `assertRemoteSessionOptionsSupported()`, `externalToolGroups()`, `buildRuntimeStartCommand()`, `handleExternalToolCall()`.
- App-server refs: `runtime-start.ts`, `protocol-inbound.ts`, `protocol_v2.ts`, `app-server-client.ts`, `agents-conversations.ts`, `memory.ts`, `model-toolset.ts`, `settings.ts`, `external-tools.ts`, relevant tests.
- Important correction: app-server already supports more controls than the SDK adapter exposes (`runtime_start`, `input`, `sync`, `abort_message`, `change_device_state`, `external_tools`, `update_model`, `update_toolset`, reflection settings, approval responses/recovery, `execute_command`, `conversation_messages_list`). Unsupported SDK errors need to be audited as adapter gaps, not app-server limitations.
- Tagging refs in Letta Code: `src/agent/create.ts` / `buildCreatedAgentTags()`, `src/agent/system-prompt-versioning.ts` / `ensureLettaCodeOriginTag()`, `src/agent/defaults.ts` / `addTagToAgent()`, `src/agent/memory-filesystem.ts`.
- Live smoke remembered: Cloud flow succeeded with explicit `openai/gpt-4o-mini`; `letta/auto` failed due upstream 429/0 RPM+TPM; `listMessages()` returned persisted assistant `smoke ok`.

## External agent dispatch log

- Initial Codex jobs using `gpt-5.3-codex` failed before reading files because this local Codex account rejects that model: `The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.`
- Relaunched Codex jobs with a supported model (`gpt-5.4`) and preserved prompts/outputs under `.audit-agents/`.

## Manual audit log — pass 2 (Cloud/runtime/API seams)

### Finding: `environment` is documented and typed for remote, but remote backend ignores it (high confidence, P1)

Evidence:
- `src/types.ts:336-348` includes `environment?: LettaCodeEnvironment` on `LettaCodeRemoteClientOptions`.
- `src/types.ts:559-563` documents session `environment` as a remote/cloud execution-target override.
- `README.md:80-86` says "For remote/cloud backends, `environment` is session-scoped and can override the client's default execution target".
- `src/client.ts:343-358` accepts remote `environment` by calling `assertRemoteSessionOptionsSupported(action, options)` without rejecting or consuming it.
- `src/client.ts:203-214` and `257-270` pass remote sessions to `AppServerSession(this.remoteOptions(), ...)`, but `AppServerSession.buildRuntimeStartCommand()` (`src/app-server-session.ts:474-520`) never reads `options.environment` or `remoteOptions.environment`.
- Recalled prior correction: backend `remote` URL already selects the app-server/runtime environment; a separate `environment` selector has no meaning and should not silently no-op.

Why it is SLOP:
- This is a public-contract lie: user code can pass `environment` to remote and believe it is selecting an execution target, but no runtime command changes.
- It weakens the intended backend model and will create confusing product behavior if published.

De-slop direction:
- Remove `environment` from `LettaCodeRemoteClientOptions` docs/types if remote app-server URLs are the selector, and reject `options.environment` for `backend: "remote"` with a clear error.
- Or, if remote app-server is intended to proxy Cloud environments later, wire it through `runtime_start` explicitly and add app-server protocol support/tests. Do not keep a silent no-op.
- Update README line 80 to say `environment` applies to Cloud (and to the separate ACK-only remote-environment API), not `backend: "remote"`, unless the protocol is actually implemented.

Tests to add/change:
- `new LettaCodeClient({ backend: "remote", url, environment })` rejects, or remote `resumeSession(..., { environment })` rejects.
- No test should merely assert remote construction with `environment` is typed unless it verifies a real runtime_start effect.

### Finding: Cloud direct status controller is a second runtime-client implementation with weak protocol guarantees (high confidence, P1)

Evidence:
- `src/cloud-session.ts:627-1086` implements `CloudStatusRuntimeController` from scratch: websocket open, request correlation, pings, seq/idempotency acking, terminal turn resolution, idle success fallback, approval response dispatch, and recover-pending-approval sync handling.
- `src/app-server-session.ts:246-313` delegates turn semantics to `AppServerClient.runTurn()` and app-server protocol handling instead.
- App-server reference protocol already owns major semantics: `runtime_start`, `input`, `sync`, `external_tools`, `conversation_messages_list`, `update_model`, `change_device_state`, `set_reflection_settings`, approval recovery, etc.
- `src/cloud-session.ts:722-759` sends an `input/create_message` command directly and waits for local terminal heuristics; `src/cloud-session.ts:931-972` infers success from `WAITING_ON_INPUT` after `DEFAULT_IDLE_TERMINAL_GRACE_MS = 100`.
- `src/tests/cloud-session.test.ts:203-225` makes the fake Cloud runtime "complete" successful turns via an assistant delta followed only by `WAITING_ON_INPUT`; no terminal frame is required.

Why it is SLOP:
- The SDK is now responsible for runtime protocol correctness in two places: app-server client and Cloud status client.
- Cloud terminal correctness depends on heuristics (`WAITING_ON_INPUT` + 100ms grace) rather than a durable terminal/event contract. That may be necessary as a temporary compatibility shim, but it should not become the durable SDK architecture.
- The fake tests validate the heuristic instead of validating Remote Client's real terminal contract.

De-slop direction:
- Preferred architecture after Ari sandbox CRUD: Cloud code only allocates/resolves/refreshes/terminates the sandbox/environment, then reuses existing app-server/Remote Client runtime semantics wherever possible.
- If `/status/ws` is the only Cloud connection surface, treat it as a transport/router to the same listener semantics; shrink `CloudStatusRuntimeController` to a transport adapter with conformance tests shared with app-server runtime behavior.
- Replace/augment idle-success tests with tests against explicit terminal loop/status messages once the real Cloud protocol can provide them.

Tests to add/change:
- Event ordering and duplicate tests: duplicate `idempotency_key`, missing/gapped `event_seq`, messages for a different runtime, socket close while pending turn, timeout cleanup.
- Terminal tests for `error`, `llm_api_error`, `max_steps`, `interrupted`, explicit terminal success, and `WAITING_ON_INPUT` before/after actual turn activity.
- Approval tests for callback throw/deny/allow, runtime-required tools, and bypass mode.

### Finding: Cloud `runTurnMessage()` disables partial-message behavior unconditionally, contradicting the option model (medium confidence, P2)

Evidence:
- `assertCloudSessionOptionsSupported()` rejects any `includePartialMessages` option (`src/cloud-session.ts:580-582`) with "streams Remote Client deltas directly; includePartialMessages is not a separate toggle."
- `CloudStatusRuntimeController.runTurnMessage()` sends `include_partial_messages: false` in the payload (`src/cloud-session.ts:733-741`).
- `RemoteClientSessionCore.transformStreamDelta()` already handles deltas and emits SDK `stream_event` / message events based on incoming frames; app-server path rejects `includePartialMessages` because app-server streams deltas directly too (`src/app-server-session.ts:169-171`).

Why it is SLOP:
- The rejection explanation says the toggle is not separate because deltas stream directly, but the Cloud command hardcodes the server-side flag to false.
- If Cloud devices honor `include_partial_messages`, the SDK will silently suppress token/partial deltas while claiming it streams them directly.
- If Cloud devices ignore the flag over status websocket, sending the flag is noise and should be removed or documented as compatibility glue.

De-slop direction:
- Decide one contract: either direct Remote Client streams make `includePartialMessages` irrelevant and no flag should be sent, or SDK should allow the option and pass it through.
- Align Cloud and app-server behavior/tests around the same public stream granularity.

### Finding: Cloud exposes `updateModel`/`changeDeviceState` as supported without response/error correlation for `change_device_state` (medium confidence, P2)

Evidence:
- The Cloud adapter capability config enables `updateModel: true` and `changeDeviceState: true` in `CloudEnvironmentSession` (`src/cloud-session.ts:1101-1105`). This is an SDK adapter table, not an inherent product-level “Cloud capability” model.
- `RemoteClientSessionCore.applyPostInitializeOptions()` sends `changeDeviceState()` when `cwd` or `permissionMode` are set (see source inventory); `changeDeviceState()` itself is fire-and-forget (`src/remote-client-session-core.ts:521-525`).
- Cloud tests assert only that `change_device_state` was sent (`src/tests/cloud-session.test.ts:433-436`), not that Cloud accepted/applied it.
- App-server `runtime_start` applies cwd/mode as part of the start command; Cloud does it after sync on an already-running remote device.

Why it is SLOP:
- A create/resume session can appear initialized with `cwd`/mode applied even if the Cloud remote device rejects or ignores the state change.
- This differs from app-server `runtime_start`, where the init response can fail before the session is considered started.

De-slop direction:
- If Remote Client has an ack/response for `change_device_state`, use request/response correlation and fail init on rejection.
- If it is intentionally fire-and-forget, document the weaker Cloud guarantee and add tests for best-effort behavior.
- Consider moving state changes into a Cloud/runtime start equivalent instead of post-init drift.

### Finding: app-server `conversation_messages_list` adapter discards pagination metadata while public SDK advertises pagination (high confidence, P2)

Evidence:
- `ListMessagesResult` has `nextBefore` and `hasMore` (`src/types.ts:877-882`); `BootstrapStateResult` repeats those fields (`src/types.ts:916-920`).
- `Cloud listCloudMessages()` parses `nextBefore`/`next_before` and `hasMore`/`has_more` (`src/cloud-session.ts:610-624`).
- `AppServerRuntimeController.listMessages()` always returns `nextBefore: null, hasMore: false` (`src/app-server-session.ts:362-366`).
- App-server reference listener currently sends only `messages: getPageItems(page)` in `conversation_messages_list_response` (`app-server src/websocket/listener/commands/agents-conversations.ts:443-456`), and `protocol_v2.ts:2217-2223` has no cursor fields.
- App-server reference REST-ish list/bootstrap handlers do compute `next_before` and `has_more` elsewhere (`agent/list-messages-handler.ts`, `agent/bootstrap-handler.ts`), so the information exists in product code but not this websocket response.

Why it is SLOP:
- The SDK public API advertises pagination but one backend lies that no more pages exist.
- Cloud and app-server behavior diverge for the same SDK method, and `bootstrapState()` inherits the misleading `hasMore: false`.

De-slop direction:
- Extend app-server `conversation_messages_list_response` to include cursor metadata, then map it in SDK.
- Until then, do not hardcode `hasMore: false`; either omit/undefined when unknown or mark the API as backend-limited.
- Add cross-backend tests that page through more than one page.

### Finding: Cloud `createAgent()` uses a local app-server harness but suppresses key harness defaults (high confidence, P1)

Evidence:
- `createCloudAgent()` constructs an `AppServerSession` through `cloudHarnessAppServerOptions()` (`src/cloud-session.ts:536-548`).
- `cloudHarnessAppServerOptions()` forces `pinGlobalAgent: false`, `includeSdkOriginTag: false`, and `enableMemfsAfterInitialize: false` (`src/cloud-session.ts:517-523`).
- `src/tests/cloud-session.test.ts:552-566` asserts the app-server harness path sends no direct REST requests, sets `pin_global: false`, omits `tags`, and does not send `enable_memfs`.
- `CreateAgentOptions.tags` docs still promise SDK-created agents receive `origin:letta-code` if missing (`src/types.ts:635-638`), and README also states this (`README.md:63-64`).

Why it is SLOP:
- This is not simply using harness semantics for Cloud agent creation; it is using the harness while disabling durable Letta Code defaults to dodge Cloud bugs.
- It contradicts the contract and trains tests around the workaround.

De-slop direction:
- Preserve origin tag and caller tags through the same harness semantics as local/remote. If Cloud create-time tags are broken, backfill/verify after creation as a narrow Cloud workaround.
- Do not suppress harness defaults as a broad Cloud behavior. If `pin_global: false` is required for Cloud routing, document that narrow routing reason; otherwise use the shared default.
- Do not turn `enableMemfsAfterInitialize: false` into a Cloud contract. If Cloud creates hosted MemFS by default, verify/document that; if not, ensure Cloud-created SDK agents still satisfy the MemFS-by-default promise.

### Finding: Cloud sandbox lifecycle API is plausible, but the SDK currently encodes route/response details as durable public API before Ari's route lands (medium confidence, P2)

Evidence:
- Public `LettaCodeCloudSandboxOptions` documents lifecycle/TTL/polling/terminate semantics (`src/types.ts:284-307`), and README expands it into product docs (`README.md:151-175`).
- `CloudEnvironmentSession` calls hardcoded routes `POST /v1/agents/:agentId/sandboxes`, `POST /refresh`, and `DELETE /sandboxes` (`src/cloud-session.ts:1348-1394`).
- `isCloudAgentSandbox()` requires exactly `sandboxId`, `deviceId`, and `connectionName` (`src/cloud-session.ts:496-504`).
- Recall says Ari's `letta-cloud#12516` route is pending and expected to return exactly those fields, but this SDK branch is landing docs/tests around it before the Cloud dependency is merged.

Why it is SLOP:
- If the Cloud route shape changes even slightly during review, the SDK public docs/tests are already ossified.
- The lifecycle options may be okay, but they should be treated as a thin dependency on the Ari route, not as a new SDK-owned sandbox product surface.

De-slop direction:
- Keep lifecycle public surface minimal for this PR. Avoid exposing knobs not required by the first Cloud sandbox use case (`pollIntervalMs`, maybe `terminateOnClose`) unless product has committed to them.
- Put route-shape assumptions behind explicit dependency notes/TODOs tied to `letta-cloud#12516`.
- Add integration/contract tests once Cloud route lands; mocked tests alone should not be the source of truth.

### Finding: `conversationId = "default"` is used as if it were stable across Cloud REST and status websocket paths (medium confidence, P2)

Evidence:
- `CloudEnvironmentSession.resolveRuntime()` sets `conversationId = "default"` for `resumeSession(agentId)` with default conversation (`src/cloud-session.ts:1238-1243`).
- `buildCloudStatusWebSocketUrl()` includes `conversationId=default` in the status websocket URL (`src/cloud-session.ts:299-302`, asserted in `src/tests/cloud-session.test.ts:423-425`).
- `CloudEnvironmentSession.listMessages()` can call REST `/v1/conversations/default/messages` before/after init when default conversation mode is used (`src/cloud-session.ts:1109-1114`; mock handles `/v1/conversations/default/messages` at `src/tests/cloud-session.test.ts:59-61`).
- App-server `runtime_start` understands default conversation in its own protocol; Cloud REST conversation endpoints may or may not accept literal `default` without an agent context.

Why it may be SLOP:
- Treating `default` as a REST conversation id can break if Cloud APIs require a real conversation UUID or need `agent_id` disambiguation.
- The mock test accepts `/v1/conversations/default/messages`, so it does not prove live Cloud compatibility.

De-slop direction:
- Resolve default conversation to an actual conversation id during Cloud initialization if Cloud REST/status APIs need concrete ids.
- Or explicitly require/verify Cloud APIs accept `default` plus `agentId` in status ws/list endpoints, and add live/contract tests.

### Finding: Cloud option guard rejects SDK-hosted tools while bespoke controller only implements approval subtype (high confidence, P1)

Evidence:
- `assertCloudSessionOptionsSupported()` rejects `options.tools` (`src/cloud-session.ts:562-564`).
- App-server path supports SDK-hosted tools via `externalToolGroups()` and `handleExternalToolCall()` (`src/app-server-session.ts:232-244`, `543-557`).
- `CloudStatusRuntimeController.handleControlRequest()` only handles `request.subtype === "can_use_tool"`; everything else returns `unsupported control request subtype` (`src/cloud-session.ts`, see source inventory hot spot around `handleControlRequest`).
- `src/tests/cloud-session.test.ts:577-616` covers approval requests only; there is no Cloud external-tool test.

Why it is SLOP:
- This is the same pattern as prior app-server adapter gaps: a narrow SDK adapter limitation is presented as Cloud backend incapability.
- Because Cloud should be routing to the same listener semantics, the SDK should reuse the existing external-tools bridge instead of rejecting tools unless a real Cloud routing/protocol absence is documented.
- If such an absence exists, the unsupported error should be explicitly tied to that dependency, and tests should not normalize it as permanent.

De-slop direction:
- Verify the Cloud/listener websocket exposes the same `external_tool_call_request/response` semantics; if so, wire the existing bridge.
- If Cloud routing genuinely cannot surface those frames yet, keep a narrow TODO/error with dependency and avoid docs implying full parity until fixed.


## External agent dispatch log update

- Corrected Codex prompts were created under `.audit-agents/codex2-*-prompt.md`.
- Relaunched three Codex jobs with `codex exec - -m gpt-5.4 --sandbox workspace-write --add-dir /Users/loaner/dev/letta-code-prod/.letta/worktrees/let-9244-app-server-auth`.
- Session ids: architecture `1524`, contract `1525`, cloud behavior `1526`.
- Initial polling saw all three sessions still running with large active `.out` logs. They later completed successfully and wrote `.audit-agents/codex2-architecture-report.md`, `.audit-agents/codex2-contract-report.md`, and `.audit-agents/codex2-cloud-behavior-report.md`.
- The completed reports independently confirmed the Cloud createAgent tags/origin contract regression, remote `environment` no-op, listMessages/bootstrap shape/pagination issues, unsupported-option drift, default conversation REST risk, sandbox cleanup leak, and Cloud turn-completion protocol fork.


## External contract-agent report imported

Report file: `.audit-agents/codex2-contract-report.md`.

Key independent confirmations from Codex contract audit:
- P0: Cloud `createAgent()` breaking caller tags + `origin:letta-code` is the highest-risk public contract regression.
- P1: remote `environment` is a public no-op; narrow it to Cloud or wire a real remote selector.
- P1: `listMessages()` / `bootstrapState()` are lossy synthetic contracts on remote/cloud. App-server drops pagination; remote/cloud bootstrap fills fields like `memfsEnabled`, `tools`, and `hasPendingApproval` from incomplete local state.
- P1: unsupported-option handling mixes durable protocol gaps with temporary wiring gaps.
- Resolved nuance below: Cloud previously accepted part of `sleeptime` and silently ignored it; current code sends the shared `set_reflection_settings` command and removed the fake capability matrix.

### Resolved finding: Cloud silently accepted `sleeptime.trigger` / `stepCount` and ignored them (was P1)

Evidence:
- At audit time, `assertCloudSessionOptionsSupported()` rejected only `options.sleeptime?.behavior !== undefined`, while `RemoteClientSessionCore.applyPostInitializeOptions()` sent `set_reflection_settings` only when SDK-local capability flags enabled it and `CloudEnvironmentSession` omitted that flag.
- Current branch removed the capability matrix; Cloud/app-server shared initialization now sends `set_reflection_settings` whenever supported sleeptime trigger settings are provided.
- README session-configuration docs are now scoped by backend instead of claiming blanket CLI parity for remote/app-server/Cloud sessions.

Why it is SLOP:
- Rejections are better than silent no-ops. A user passing `{ sleeptime: { trigger: "step-count", stepCount: 8 } }` to Cloud receives no error and no behavior.
- This is worse than the other unsupported Cloud gaps because tests may not catch it unless they assert emitted `set_reflection_settings` or rejection.

De-slop direction:
- Completed by using the shared `set_reflection_settings` protocol path for Cloud/app-server sessions and scoping README backend docs.

### Finding: remote/cloud `bootstrapState()` synthesizes fields that look authoritative (high confidence, P1/P2)

Evidence:
- `RemoteClientSessionCore.bootstrapState()` initializes the session, calls `listMessages()`, and returns local fields (`src/remote-client-session-core.ts:445-466`).
- It sets `memfsEnabled: this.currentOptions().memfs === true`, not actual runtime/memory filesystem state (`src/remote-client-session-core.ts:461`).
- It sets `hasPendingApproval: false` unconditionally (`src/remote-client-session-core.ts:465`).
- It returns `tools: this.toolNames`; Cloud initializes with `tools: []` (`src/cloud-session.ts:1136-1140`), so this does not represent the agent's full toolset.
- Legacy stdio `Session.bootstrapState()` asks the CLI for a real `bootstrap_session_state` response (`src/session.ts:1145-1169`).

Why it is SLOP:
- The public API shape implies initial UI state is authoritative, but remote/cloud values are partially guessed.
- This can hide pending approvals, misreport MemFS, and underreport tools.

De-slop direction:
- Either implement real app-server/Cloud bootstrap state protocol, or explicitly mark remote/cloud bootstrap fields as best-effort/unknown.
- Consider making uncertain booleans nullable/omitted instead of false.
- Add tests that fail if remote/cloud silently synthesize false/empty values for fields that should be unknown.


## External architecture-agent report imported

Report file: `.audit-agents/codex2-architecture-report.md`.

Key independent confirmations from Codex architecture audit:
- P0: The largest architectural miss is that Cloud runtime control duplicates app-server/runtime semantics instead of only adding sandbox allocation/resolution.
- P1: Cloud `createAgent()` forks harness semantics and weakens durable SDK behavior around tags, origin tagging, and default MemFS enablement.
- P1: Cloud rejects SDK-hosted tools even though shared app-server protocol already supports external tools.
- P2: `listMessages()` / `bootstrapState()` are exposed before cross-backend contract coherence exists.
- Minimal recommended post-Ari shape: keep `RemoteClientSessionCore`; keep Cloud-specific work narrow to sandbox CRUD/environment resolution; reuse harness semantics for agent creation; reuse app-server runtime protocol for actual session control; if direct status websocket remains necessary, make it transport-only rather than a second definition of turn completion/tools/history/capabilities.
- Ari dependency questions to resolve before locking design:
  1. Does sandbox CRUD expose a websocket that speaks the same app-server/runtime protocol, or only status websocket plus device/connection metadata?
  2. Will sandbox creation return `connectionId` directly, or must SDK poll by `deviceId` / `connectionName`?
  3. Should default conversation resolution happen through runtime start or REST?
  4. Can Cloud runtime channel surface external tool calls equivalent to `external_tool_call_request/response`?
  5. What tag persistence contract can SDK rely on, including current "400 but persisted" hosted-MemFS bug?
  6. Where should message pagination metadata live for app-server path if `listMessages()` is durable?

### Finding: Cloud createAgent disables default MemFS enablement without public-contract clarity (high confidence, P1/P2)

Evidence:
- `cloudHarnessAppServerOptions()` sets `enableMemfsAfterInitialize: false` (`src/cloud-session.ts:520-523`).
- `AppServerSession.shouldEnableMemfs()` enables MemFS for create-agent mode unless `memfs === false` (`src/app-server-session.ts:400-402`).
- `RemoteClientSessionCore.applyPostInitializeOptions()` sends `enable_memfs` when `capabilities.enableMemfs` and `shouldEnableMemfs(options)` are true (`src/remote-client-session-core.ts:580-592`).
- Cloud tests assert no `enable_memfs` command is sent during Cloud createAgent (`src/tests/cloud-session.test.ts:561-566`).
- Public types document created-agent MemFS behavior (`src/types.ts:641-645` per architecture report) and README session options show `memfs: true/false` (`README.md:220`).

Why it is SLOP:
- This is another case where the Cloud harness path is used but harness defaults are selectively disabled.
- It may be intentional if Cloud-hosted agents already have hosted MemFS by default or Cloud tag/memfs update is currently broken, but the PR codifies the disabled behavior without explaining the product contract.

De-slop direction:
- Preserve the same MemFS/default harness contract as local/remote create-agent unless Cloud already provides an equivalent hosted MemFS outcome.
- If disabling `enable_memfs` is only a workaround for the hosted-MemFS 400 bug, add a narrow temporary workaround with verification/removal plan, not a permanent Cloud default.
- Change tests from "no enable_memfs is sent" to "Cloud-created agent satisfies the shared MemFS/default harness contract" once the desired behavior is clear.


## External cloud-behavior-agent report imported

Report file: `.audit-agents/codex2-cloud-behavior-report.md`.

Key independent findings from Codex cloud-behavior audit:
- P0: Cloud turn completion is not faithful to app-server / Remote Client semantics. The direct Cloud controller ignores canonical `stop_reason` deltas unless `is_terminal === true`, misses several loop-status evidence states, lacks `WAITING_ON_APPROVAL` completion semantics, and collapses typed terminal errors to `error`.
- P0: Ephemeral sandboxes can leak if initialization fails after sandbox create/refresh but before `_agentId` is assigned, because `onCoreClose()` cleanup is gated on `_agentId`.
- P1: `waitForSandboxConnection()` can bind to a stale/wrong environment because it matches by `connectionName` as an OR fallback even though sandbox CRUD returns `deviceId`.
- P1: Cloud history calls treat virtual `"default"` as a real Cloud REST conversation id (`/v1/conversations/default/messages`) while app-server/CLI treat it as agent-scoped virtual state.
- P1: Direct Cloud controller invents/uses `recover_pending_approvals` messages instead of protocol_v2 `sync` + `sync_response`, and does not handle protocol_v2 `external_tool_call_request`.

### Finding: Cloud turn-completion state machine diverges from app-server Remote Client semantics (high confidence, P0)

Evidence:
- `terminalFromStreamDelta()` returns terminal only when `delta.is_terminal === true` or message type is `loop_error` / `error_message`; a canonical `message_type: "stop_reason"` delta without `is_terminal` is ignored (`src/cloud-session.ts:474-489`).
- Failure terminals hard-code `errorCode: "error"`, losing typed stop reasons such as `llm_api_error`, `max_steps`, or `interrupted` (`src/cloud-session.ts:483-488`, `src/cloud-session.ts:941-947`).
- `handleLoopStatus()` only marks activity for `SENDING_API_REQUEST` and `WAITING_FOR_API_RESPONSE`, then resolves success only on `WAITING_ON_INPUT` after a 100ms idle grace (`src/cloud-session.ts:976-994`, `src/cloud-session.ts:1020-1029`).
- App-server `AppServerClient.runTurn()` treats `message_type: "stop_reason"` as terminal; treats `requires_approval` as terminal only once loop status reaches `WAITING_ON_APPROVAL`; and allows loop-status fallback after broader run evidence (`app-server src/app-server-client.ts:592-635`).
- Protocol loop status includes additional run-evidence states such as `PROCESSING_API_RESPONSE` and `EXECUTING_CLIENT_SIDE_TOOL` (`app-server src/types/protocol_v2.ts:467-472`), which Cloud ignores.

Why it is SLOP:
- This is an observable behavior bug caused by owning a second turn state machine in the SDK.
- It can turn successful Cloud runs into timeouts, mishandle pending approvals, and erase useful error codes.

De-slop direction:
- Extract/reuse the app-server `runTurn()` completion rules, or drive Cloud through `AppServerClient` semantics directly.
- At minimum, Cloud must handle `stop_reason`, `requires_approval` + `WAITING_ON_APPROVAL`, broader loop-status evidence, and typed terminal errors exactly like app-server.
- Add conformance tests shared between app-server and Cloud controller adapters.

### Finding: Ephemeral Cloud sandboxes can leak when initialization fails before `_agentId` assignment (high confidence, P0)

Evidence:
- `resolveConnection()` creates and refreshes the sandbox before websocket connection/setup completes (`src/cloud-session.ts:1313-1319`).
- `RemoteClientSessionCore.initialize()` sets `_agentId` only after `initializeRuntimeController()` succeeds (`src/remote-client-session-core.ts:299-307` and surrounding initialize flow; cloud-behavior report points to assignment after success).
- `CloudEnvironmentSession.onCoreClose()` terminates the sandbox only if `this.sandbox !== null`, policy says terminate, and `this._agentId` is set (`src/cloud-session.ts:1156-1162`).
- Current tests cover happy-path close cleanup but not failed initialization after sandbox creation (`src/tests/cloud-session.test.ts` lifecycle coverage around happy path).

Why it is SLOP:
- `ephemeral` promises cleanup, but a timeout or websocket failure during init can leave paid/active Cloud resources running until TTL.
- This is lifecycle code in the exact area Cloud is supposed to own, so it should be robust even if runtime semantics are delegated.

De-slop direction:
- Track sandbox owner agent id independently as soon as sandbox is created, or clean up in the initialize failure catch path with the resolved runtime agent id.
- Add tests for timeout/websocket failure after sandbox creation and assert `DELETE /v1/agents/:agentId/sandboxes` is called for ephemeral policy.

### Finding: sandbox environment polling may attach to a stale environment via `connectionName` fallback (high confidence, P1)

Evidence:
- `isCloudAgentSandbox()` requires `deviceId`, so sandbox CRUD response already provides a stable key (`src/cloud-session.ts:496-504`).
- `waitForSandboxConnection()` accepts an environment when either `environment.deviceId === sandbox.deviceId` OR `environment.connectionName === sandbox.connectionName` (`src/cloud-session.ts:1417-1423`).
- Test fixture uses a connectionName shaped like `sandbox-agent-1`, which may not be unique per sandbox generation; no test covers same name/different device (`src/tests/cloud-session.test.ts` fixture references in cloud-behavior report).

Why it is SLOP:
- The SDK could bind a new sandbox session to an old online environment with a reused connectionName.
- That breaks the product promise that Cloud sandbox CRUD creates/resolves the environment used for the session.

De-slop direction:
- Match by `deviceId` only if Ari's sandbox API guarantees it.
- If `connectionName` fallback is necessary, document why and add a stale-environment test proving it cannot bind incorrectly.

### Finding: Cloud pending-approval recovery uses a Cloud-only message family instead of protocol_v2 sync (high confidence, P1/P2)

Evidence:
- Cloud `recoverPendingApprovals()` sends `recover_pending_approvals` and waits for `recover_pending_approvals_ack` / `_response` (`src/cloud-session.ts:767-783`).
- Protocol_v2 defines `sync` with `recover_approvals` and `sync_response` (`app-server src/types/protocol_v2.ts:747-760`, `app-server src/types/protocol_v2.ts:907-912`).
- App-server SDK path uses `client.sync({ recover_approvals: true, force_device_status: true })` (`src/app-server-session.ts:315-325`).

Why it is SLOP:
- Another protocol fork in the Cloud adapter. Even if Cloud status websocket requires a different contract today, the PR needs to say so and test it as a deliberate Cloud protocol, not an ad-hoc mock-only message.

De-slop direction:
- Use protocol_v2 `sync` semantics for Cloud too if the Cloud websocket is routing to the same listener protocol.
- If Cloud status ws is genuinely not protocol_v2-compatible, document that as a real Cloud protocol divergence and add contract tests against real/fake Cloud status behavior; do not infer a new contract from mocks.


## User architecture correction — Cloud is a router, not a separate runtime

The user clarified the intended model more strongly:

- Cloud should be the same listener websocket backend at the end of the day; Cloud is a router/provisioning layer, not a separate runtime with separate SDK semantics.
- Cloud `createAgent()` should be essentially the same stdio/local-websocket/app-server harness path as local/remote create-agent, with the launched `letta server` authenticated via `LETTA_API_KEY` / Cloud backend mode so it creates Cloud agents while preserving harness semantics.
- Cloud should not have bespoke SDK create-agent behavior that drops tags, `origin:letta-code`, MemFS/default setup, reflection/sleeptime behavior, tools, or approval recovery semantics.
- “Cloud capabilities disable reflection settings” is itself a smell: if Cloud is the same listener websocket protocol, reflection settings should use the same protocol capability/path, not an artificial SDK-side Cloud capability matrix.
- Pending approval recovery should use the obvious shared protocol path (`sync` with `recover_approvals` / `force_device_status`, returning `sync_response`) rather than a Cloud-only `recover_pending_approvals` message family.

Audit consequence:

- Reframe findings away from “Cloud lacks capability X” and toward “the SDK Cloud adapter incorrectly bypasses the shared listener/app-server protocol path.”
- The de-slop target is not to make a better Cloud-specific runtime controller; it is to delete or shrink the Cloud-specific controller so Cloud only allocates/resolves sandbox/environment and then uses the same create/runtime/listener protocol as remote/local websocket.
- Tests should assert Cloud parity with local/remote listener semantics, not codify downgraded Cloud behavior.
