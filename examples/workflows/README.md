# Dynamic Workflows

Script-orchestrated multi-agent workflows built on the Letta Agent SDK, following the shape of [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows): the script holds the loop, the branching, and the intermediate results; agents do the reading, editing, and command-running.

`runtime.ts` provides the primitives:

- `agent(task, opts)` — spawn one ephemeral worker agent, resolve to its final text (or a parsed value when `opts.schema` is set). Resolves to `null` on failure instead of rejecting.
- `reason(task, opts)` — run one tool-less stage as an agent-free query on a stateless conversation (`agent_id: null`). No agent is created or deleted. Requires `LETTA_API_KEY`.
- `parallel(thunks)` — run tasks concurrently with a barrier.
- `pipeline(items, ...stages)` — run each item through stages independently, no barrier between stages.
- `phase(title)` / `log(msg)` — progress narration.

Pick the primitive by what the stage needs. A stage that reads or edits files, runs commands, or uses server-side tools is a worker: `agent()` creates an ephemeral agent without memfs, runs the task as a one-shot conversation with `permissionMode: 'unrestricted'`, and deletes the agent when it finishes. A stage that only reasons over text the script hands it — judges, extractors, synthesizers without repository access — should be `reason()`: the SDK's `query()` API runs it in an ephemeral stateless conversation, so nothing is created that has to be cleaned up.

Concurrency is capped across both (`LETTA_WORKFLOW_CONCURRENCY`, default 4); the model defaults to `haiku` (`LETTA_WORKFLOW_MODEL`), and any Letta model handle works per-stage, so a single workflow can mix providers.

## Choosing a backend

`audit-files` and `fix-until-pass` run on the local backend, where workers read and edit the working directory directly. `plan-panel`, `research-sources`, and `migrate-files` route workers through a cloud client with `setWorkflowClient()`, because they need something the local backend does not provide:

- **Every provider.** Model handles select the provider per agent, so a workflow can mix Anthropic, OpenAI, and Moonshot in one panel — but only for providers the deployment holds credentials for. Letta Cloud reaches the whole catalog; a local backend reaches whatever this machine is configured for.
- **Server-side tools.** `web_search` and `fetch_webpage` are executed by the Letta server and attach via `baseTools` at agent creation. Ask a worker without them to search and it will emit a plausible, wrong answer rather than fail.
- **Isolated filesystems.** Each cloud session gets its own managed sandbox, so a hundred workers can edit the same file without conflicting. That is what makes parallel migration safe.

Cloud also parallelizes far better: local workers each spawn their own app-server process, so a 16-agent local audit took about 34 minutes here, while cloud agents of the same size returned in 10–30 seconds each.

Gotchas the runtime handles for you:

- Workers ask for `toolset: { base: 'none', include: [...] }` so a stage gets exactly the tools it names and nothing else — no inherited base, no browser or task tools a file auditor has no use for.
- Managed sandboxes clone into `/root/workspace/<repo>`, and a worker left in `/root` has the agent state tree below it, so the harness's cross-agent memory guard denies every recursive path tool. `sandboxRepo()` returns the sandbox and the `cwd` that avoids this.
- A cloud worker with no sandbox repository starts in an empty home directory. Tell it so; otherwise it "explores" nothing and invents file paths.
- Turns fail transiently, so `agent()` retries a failed turn once. Anything still failing resolves to `null` and the fan-out continues without it.
- A stage that must not modify anything says so with `permissionMode: 'strict'` plus a `canUseTool` that allows reads only — there is no read-only mode, and a tool allowlist decides what a worker is offered, not what it may do. When allowing a call, return `{ behavior: 'allow' }` with no `updatedInput`: supplying one *replaces* the tool's arguments, so `{}` strips every call's parameters and the worker flails against tools that suddenly take no input.
- Don't route a whole file back through a worker's return value. It truncates silently, and inlining a large file into a follow-up prompt fails the turn outright. `migrate-files` returns a `git diff` instead: compact enough to review, and a truncated patch fails to apply rather than corrupting a file.

## Examples

```bash
# Audit files for an issue, adversarially verify each finding
bun examples/workflows/audit-files.ts src "missing error handling around I/O"

# Run a check, fix failures in parallel, repeat until it passes or stalls
bun examples/workflows/fix-until-pass.ts "bunx tsc --noEmit"

# Draft a plan from three angles on three providers (Anthropic, OpenAI,
# Moonshot), judge, synthesize the winner. Override with PANEL_MODELS / JUDGE_MODEL.
LETTA_API_KEY=... PANEL_REPO=letta-ai/letta-agent-sdk \
  bun examples/workflows/plan-panel.ts "add retry logic to the websocket transport"

# Research a question: fan out searchers (server-side web_search),
# cross-check every claim against independent sources
LETTA_API_KEY=... bun examples/workflows/research-sources.ts "what changed in bun 1.3"

# Migrate files in parallel, each in its own isolated cloud sandbox clone.
# Collects reviewed patches into ./migrated/ for `git apply`.
LETTA_API_KEY=... bun examples/workflows/migrate-files.ts letta-ai/letta-agent-sdk examples "convert var to const"
```
