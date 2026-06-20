# SLOP_PART2: Cloud SDK V2 Deslop Follow-up

Status: current post-fix tracker. `SLOP_AUDIT.md` is retained as historical audit trail; this file is the source of truth for what is fixed and what remains.

## Goal
Keep the Cloud backend aligned with the app-server/listener runtime protocol. Cloud should own Cloud-only concerns (REST agent/conversation/environment resolution and Cloud status-websocket transport reliability), while turn execution, request correlation, runtime startup, external tools, and terminality flow through the shared app-server client/controller path.

This was the execution punch list for the de-slop pass. The architectural de-slop work is now complete on this branch. This PR intentionally requires callers to supply an explicit `environment`; SDK-managed Cloud sandboxes are split into a fast-follow paired with `letta-cloud#12516`.

## Current fixed baseline
Already fixed in the current working tree:
- Cloud `createAgent()` goes through the app-server harness instead of a bespoke Cloud REST-only create path.
- Cloud create-agent no longer rejects caller tags or suppresses `origin:letta-code`.
- Cloud create-agent no longer suppresses app-server MemFS/default harness behavior.
- Cloud pending approval recovery uses `sync` + `sync_response` with `recover_approvals:true` and `force_device_status:true`.
- Cloud enables `reflectionSettings` and sends `set_reflection_settings` for supported sleeptime trigger settings.
- Direct Cloud sessions require an explicit `environment` until SDK-managed Cloud sandboxes land.
- SDK-managed sandbox lifecycle options/CRUD were removed from this PR's public and runtime path; passing sandbox options fails fast instead of silently depending on unfinished Cloud listener registration.
- `environment` is Cloud-only; remote app-server clients reject it.
- Direct Cloud status sessions now open an `AppServerClient` over `/v1/environments/{connectionId}/status/ws` and issue `runtime_start` for the resolved `{agent_id, conversation_id}`.
- The large duplicate `CloudStatusRuntimeController` turn state machine was removed. Cloud now reuses `AppServerRuntimeController` / `AppServerClient.runTurn()` for turn input, terminality, request correlation, `sync`, and external tool responses.
- Cloud transport reliability remains a narrow gateway socket adapter: auth URL/header construction, split control/stream channels, Cloud gateway fanout de-dupe, ACKs, event-sequence gap `sync`, idempotency de-dupe, and heartbeat pings.
- Cloud sandbox CRUD was live-probed for the fast follow: production accepts `POST /v1/sandboxes` with `{ agentId }` to create and `POST /v1/sandboxes/{sandboxId}/terminate` for cleanup; the SDK does not call those routes in this PR.
- Permission approvals are not Cloud-specific. `control_request` / `can_use_tool` -> SDK `canUseTool` -> app-server `approval_response` is core app-server/listener protocol behavior and now lives in the shared app-server-backed session path.
- Approval responses now use the app-server/listener wire contract (`updated_input` and `selected_permission_suggestion_ids`) rather than SDK-only camelCase fields.
- SDK-hosted tools are registered through `runtime_start.external_tools` and executed through the shared app-server external-tool handler.
- Cloud create-agent preserves the shared app-server harness default for global pinning instead of forcing `pin_global:false`.
- Remote/cloud history/bootstrap pagination flags are best-effort: app-server/cloud no longer fabricate `hasMore:false`, `nextBefore:null`, `memfsEnabled:false`, or `hasPendingApproval:false` when the backend has not reported them.
- Cloud `listMessages()` and `bootstrapState()` no longer use Cloud REST `/v1/conversations/{id}/messages`; they inherit the shared app-server/listener `conversation_messages_list` path for default, resumed non-default, explicit override, and bootstrap history reads.
- Final external de-slop review after the Cloud history fix reported no blockers from both Codex GPT-5.5 and Claude Opus 4.8. Their test nits were addressed by removing the stale Cloud REST messages mock and asserting bootstrap does not invent `hasPendingApproval` / `timings`.

## Remaining follow-ups

### 0. Lift approval bridge out of Cloud — completed
The listener client was originally written with the Cloud gateway/bridge in mind, then later formalized as app-server. Apparent post-registration WS differences should be treated as historical artifacts unless live contracts prove otherwise. Once a runtime is started on a device, local app-server, remote app-server, and Cloud gateway sessions should speak the same protocol.

Executed in this pass:
- Moved `control_request` / `can_use_tool` handling and `CanUseToolResponse` resolution out of `CloudEnvironmentSession` into shared app-server-backed session code.
- Both `AppServerSession` and `CloudEnvironmentSession` now register the same approval bridge on their `AppServerClient`.
- App-server/Cloud turn input no longer injects SDK-only transport hints such as `supports_control_response` or `payload.source`.
- Approval responses prefer the runtime scope carried on the control request (`runtime` or top-level `agent_id`/`conversation_id`) before falling back to locally cached session runtime.
- Cloud-only code stays focused on explicit environment resolution, Cloud REST lookup, gateway auth/routing, and gateway delivery-envelope quirks.

### 1. Direct Cloud managed-sandbox runtime-start contract verification — split to fast follow
The local fake now asserts `runtime_start` on Cloud status sockets for explicit environments. The existing `bun run test:live` suite exercises the local app-server path against real API-backed agents; direct `backend:"cloud"` managed-sandbox `/status/ws` coverage is blocked on the Cloud sandbox backend/listener work and should be added in the fast-follow PR.

Live route probe:
- Production Cloud accepts `POST /v1/sandboxes` and immediate `POST /v1/sandboxes/{sandboxId}/terminate` with the current `LETTA_API_KEY`.
- Production Cloud rejects the SDK's former stale route `POST /v1/agents/{agentId}/sandboxes` with 404.
- After the SDK route fix, direct `backend:"cloud"` managed-sandbox initialization created a sandbox successfully but still timed out waiting for the sandbox listener environment/connection to come online. That listener/registration work is expected to land via `letta-cloud#12516`, so this PR now requires explicit `environment` instead of creating SDK-managed sandboxes.

Validation to add/run:
- Fast-follow live Cloud sandbox smoke after `letta-cloud#12516`: initialize direct Cloud session without explicit environment, confirm `/status/ws?channel=control|stream` accepts `runtime_start` and returns `runtime_start_response`.
- Live turn smoke: after runtime_start, `runTurn()` completes through app-server client terminality.
- Live external tool smoke: `runtime_start.external_tools` registers schemas and a Cloud-issued `external_tool_call_request` receives `external_tool_call_response`.

If live Cloud does not yet forward `runtime_start`, do not reintroduce the deleted controller. Fix the Cloud listener/status route or add a tiny protocol adapter at the transport boundary.

### 2. Optional approval terminality parity coverage
The duplicate Cloud terminality code is gone, so parity now depends on `AppServerClient.runTurn()`.

Tests still worth adding around the shared path:
- Auto-approval continuation: `requires_approval` stop followed by more activity and final `end_turn` succeeds.
- Stale/manual approval guard: `WAITING_ON_APPROVAL` before turn activity does not terminalize.
- Genuine pending approval: `requires_approval` stop then `WAITING_ON_APPROVAL` returns approval conflict.

Keep these tests in shared app-server/client coverage where possible; add Cloud fake coverage only for Cloud transport routing/ACK/gap behavior.

### 3. Transport adapter edge cases — covered by unit/fake tests
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
The audits called this merge-blocking, but it is a cross-backend API contract problem rather than direct Cloud runtime state-machine slop.

Decision options:
1. Narrow now: document/list types as raw best-effort history and mark pagination/bootstrap state fields as best-effort/nullable/not authoritative for app-server/cloud.
2. Finish properly: extend app-server protocol to return cursor/hasMore and source `bootstrapState()` from backend state.

This pass did option 1. Do not pretend hardcoded `hasMore:false` is truthful. Tests, docs, and callers should treat `hasMore`, `nextBefore`, `hasPendingApproval`, `memfsEnabled`, `tools`, and `timings` as optional/known-only when the backend reports them.

## Validation
Completed before the current live-test cleanup:
- `bun run check` — passed.
- `bun test src/tests/cloud-session.test.ts --timeout 10000` — 16 pass.
- `bun test --timeout 10000` — 201 pass, 9 skip, 0 fail.

Live validation status:
- `bun run test:live` uses `LETTA_LIVE_INTEGRATION=1` and `LETTA_API_KEY` from `~/dev/.env`.
- It validates the top-level/local app-server path against real API-backed agents. This is useful shared-protocol validation, but not direct Cloud sandbox backend coverage.
- Initial post-fix live run exposed a stale test expectation: `listMessages returns raw API messages and paginates` expected `hasMore` to always be boolean even though the de-slop decision made pagination flags optional/known-only when reported. The live test now accepts absent pagination flags.
- The concurrent `listMessages while stream is active` live test now records/logs the terminal result before asserting success, so future live/model/app-server failures are diagnosable.
- After the live-test contract cleanup, `bun run test:live` passed: 8 pass, 0 fail.

Final validation after this doc/test cleanup:
- `bun run check` — passed.
- `bun test src/tests/cloud-session.test.ts src/tests/client.test.ts --timeout 10000` — 38 pass, 0 fail.
- `bun test --timeout 10000` — 202 pass, 9 skip, 0 fail.
- `bash -lc 'set -a; source ~/dev/.env >/dev/null 2>&1; set +a; bun run test:live'` — 8 pass, 0 fail.
- Direct `backend:"cloud"` managed-sandbox production smoke after the sandbox route fix: sandbox creation succeeds through `POST /v1/sandboxes`, but initialization still times out waiting for an online listener connection. This is split out as a fast-follow paired with `letta-cloud#12516`; this PR's direct Cloud path requires an explicit environment.
