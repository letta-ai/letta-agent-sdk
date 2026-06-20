# SLOP_PART2: Cloud SDK V2 Deslop Follow-up

## Goal
Keep Cloud sandbox backend aligned with the app-server/listener runtime protocol. Cloud should own Cloud-only concerns (REST agent/conversation/environment/sandbox resolution and Cloud status-websocket transport reliability), while turn execution, request correlation, runtime startup, external tools, and terminality flow through the shared app-server client/controller path.

This is an execution punch list, not another audit. Do not launch more agents for this pass.

## Current fixed baseline
Already fixed in the current working tree:
- Cloud `createAgent()` goes through the app-server harness instead of a bespoke Cloud REST-only create path.
- Cloud create-agent no longer rejects caller tags or suppresses `origin:letta-code`.
- Cloud create-agent no longer suppresses app-server MemFS/default harness behavior.
- Cloud pending approval recovery uses `sync` + `sync_response` with `recover_approvals:true` and `force_device_status:true`.
- Cloud enables `reflectionSettings` and sends `set_reflection_settings` for supported sleeptime trigger settings.
- Cloud sandbox cleanup tracks the sandbox owner agent id and cleans up failed ephemeral init.
- Cloud sandbox environment matching uses `deviceId` only.
- `environment` is Cloud-only; remote app-server clients reject it.
- Direct Cloud status sessions now open an `AppServerClient` over `/v1/environments/{connectionId}/status/ws` and issue `runtime_start` for the resolved `{agent_id, conversation_id}`.
- The large duplicate `CloudStatusRuntimeController` turn state machine was removed. Cloud now reuses `AppServerRuntimeController` / `AppServerClient.runTurn()` for turn input, terminality, request correlation, `sync`, and external tool responses.
- Cloud transport reliability remains a narrow gateway socket adapter: auth URL/header construction, split control/stream channels, Cloud gateway fanout de-dupe, ACKs, event-sequence gap `sync`, idempotency de-dupe, and heartbeat pings.
- Permission approvals are not Cloud-specific. `control_request` / `can_use_tool` -> SDK `canUseTool` -> app-server `approval_response` is core app-server/listener protocol behavior and now lives in the shared app-server-backed session path.
- Approval responses now use the app-server/listener wire contract (`updated_input` and `selected_permission_suggestion_ids`) rather than SDK-only camelCase fields.
- SDK-hosted tools are registered through `runtime_start.external_tools` and executed through the shared app-server external-tool handler.
- Cloud create-agent preserves the shared app-server harness default for global pinning instead of forcing `pin_global:false`.
- Remote/cloud history/bootstrap pagination flags are best-effort: app-server/cloud no longer fabricate `hasMore:false`, `nextBefore:null`, `memfsEnabled:false`, or `hasPendingApproval:false` when the backend has not reported them.

## Remaining P1 fixes

### 0. Lift approval bridge out of Cloud — completed
The listener client was originally written with the Cloud gateway/bridge in mind, then later formalized as app-server. Apparent post-registration WS differences should be treated as historical artifacts unless live contracts prove otherwise. Once a runtime is started on a device, local app-server, remote app-server, and Cloud gateway sessions should speak the same protocol.

Executed in this pass:
- Moved `control_request` / `can_use_tool` handling and `CanUseToolResponse` resolution out of `CloudEnvironmentSession` into shared app-server-backed session code.
- Both `AppServerSession` and `CloudEnvironmentSession` now register the same approval bridge on their `AppServerClient`.
- App-server/Cloud turn input no longer injects SDK-only transport hints such as `supports_control_response` or `payload.source`.
- Approval responses prefer the runtime scope carried on the control request (`runtime` or top-level `agent_id`/`conversation_id`) before falling back to locally cached session runtime.
- Cloud-only code stays focused on sandbox lifecycle, Cloud REST lookup, gateway auth/routing, and gateway delivery-envelope quirks.

### 1. Runtime-start contract verification against Cloud service
The local fake now asserts `runtime_start` on Cloud status sockets, but live Cloud still needs confirmation.

Validation to add/run:
- Live Cloud sandbox smoke: initialize direct Cloud session, confirm `/status/ws?channel=control|stream` accepts `runtime_start` and returns `runtime_start_response`.
- Live turn smoke: after runtime_start, `runTurn()` completes through app-server client terminality.
- Live external tool smoke: `runtime_start.external_tools` registers schemas and a Cloud-issued `external_tool_call_request` receives `external_tool_call_response`.

If live Cloud does not yet forward `runtime_start`, do not reintroduce the deleted controller. Fix the Cloud listener/status route or add a tiny protocol adapter at the transport boundary.

### 2. Approval terminality parity coverage
The duplicate Cloud terminality code is gone, so parity now depends on `AppServerClient.runTurn()`.

Tests still worth adding around the shared path:
- Auto-approval continuation: `requires_approval` stop followed by more activity and final `end_turn` succeeds.
- Stale/manual approval guard: `WAITING_ON_APPROVAL` before turn activity does not terminalize.
- Genuine pending approval: `requires_approval` stop then `WAITING_ON_APPROVAL` returns approval conflict.

Keep these tests in shared app-server/client coverage where possible; add Cloud fake coverage only for Cloud transport routing/ACK/gap behavior.

### 3. Transport adapter edge cases
Added narrow tests for the Cloud socket adapter, not turn state:
- Duplicate `idempotency_key` frame is ACKed but emitted once.
- Event sequence gap on stream channel sends `sync { recover_approvals:true, force_device_status:true }` on the control socket.
- Header auth and query auth continue to behave across both control and stream sockets.
- Unknown SDK-hosted tool and thrown SDK-hosted tool errors return `external_tool_call_response.error` via the shared handler.
- `sync_response { success:false, error }` surfaces a failed recovery result.

### 4. Smaller parity cleanup
- Enable `updateToolset` capability for Cloud only if the Cloud status listener accepts `update_toolset` / returns `update_toolset_response` the same way app-server does.
- Removed the Cloud create-agent `pinGlobalAgent:false` override for harness parity.

## P1/P2 public contract decision: listMessages/bootstrapState
The audits call this merge-blocking, but it is a cross-backend API contract problem rather than direct Cloud runtime state-machine slop.

Decision options:
1. Narrow now: document/list types as raw best-effort history and mark pagination/bootstrap state fields as best-effort/nullable/not authoritative for app-server/cloud.
2. Finish properly: extend app-server protocol to return cursor/hasMore and source `bootstrapState()` from backend state.

This pass did option 1. Do not pretend hardcoded `hasMore:false` is truthful.

## Validation
Run at minimum:
- `bun test src/tests/cloud-session.test.ts src/tests/client.test.ts --timeout 10000`
- `bun run check`
- `bun test --timeout 15000` before declaring done.
