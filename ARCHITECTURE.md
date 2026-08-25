# Hana DSH Adapter — Architecture Brief

## 1. Goal

Build a HanaAgent plugin that exposes DeepSeek Harness (DSH) as a controlled local coding execution backend without reimplementing DSH and without exposing its complete unauthenticated Web control plane to plugin UI code.

The plugin is an adapter, not a second harness.

## 2. Existing systems

### Hana plugin model

Observed from installed community plugins (`tts-tools`, `hanako-hyperframes`):

- `manifest.json`: plugin identity, version, trust, page/configuration contributions.
- `index.js`: lifecycle; `onload()` initializes runtime state on `ctx`, `register()` disposes it.
- `tools/*.js`: static Agent tools exporting `name`, `description`, JSON schema `parameters`, and `execute(input, ctx)`.
- `routes/*.js`: Hono route registrars for plugin pages and JSON APIs.
- Plugin-local persistent state belongs under `ctx.dataDir`.
- A plugin page is contributed through `contributes.page` and served under `/api/plugins/<plugin-id>/...`.
- Full process control requires `trust: "full-access"`.

### DSH model

Installed version: `@deepseek-ai/dsh@0.1.0-rc.6`.

- CLI entry: `<DSH_HOME>/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js` — derived at runtime from `$DSH_HOME` (or the user's home directory) and overridable via the `dshExecutable` config.
- Web profile: long-running browser surface, default loopback URL `http://127.0.0.1:3080`.
- Session API supports `session.create`, `session.prompt`, `session.history`, `session.list`, `session.cancel`.
- Approval answering is a **client-response carrier**, not an RPC: `POST /api/respond` with `{ type: "client-response", rpcId, result: { ok: true, value: { sessionId, approvalId, outcome } } }`; `outcome ∈ { "allowed-once", "rejected" }`. The receipt is `{ accepted: true }` or `{ accepted: false, reason: "not-pending"|"bad-response" }`.
- Approval events flow on the **mux stream** (`GET /api/events.mux`, SSE; or the WebSocket upgrade of the same path): each message is a full `server-request` envelope `{ type, rpcId, method, payload }` whose payload is a MuxFrame. Relevant frames: `approval/requested { sessionId, approvalId, toolName, callId?, reason? }` (rpcId is the answer token) and `approval/resolved { sessionId, approvalId, outcome: allowed-once|rejected|cancelled|unavailable }`. Pending approvals are replayed to every new mux connection with the same rpcId.
- Session history events include the durable audit pair `approval/asked { id, toolName, callId?, reason? }` and `approval/decided { id, outcome }` — the reconnect re-pull source (DSH v1 has no `since` cursor: reconnect = re-pull).
- Agent presets exist; intended default for this environment is `router-standard`.
- Headless profile is one-shot and prints only final assistant text, but does not provide interactive follow-up and does not automatically use the Web profile's session/preset workflow.
- DSH sessions are event-sourced and tied to `cwd`/workspace.

## 3. Security boundary

DSH 0.1.0-rc.6 Web API is a local code-execution control plane and does not provide an authentication layer. Host/Origin checks are reachability protections, not authentication.

Therefore the Hana plugin MUST:

1. Accept only loopback DSH URLs (`127.0.0.1`, `[::1]`, optionally `localhost` resolved locally). Never allow LAN or arbitrary URLs.
2. Keep DSH RPC calls in Node-side plugin code. The plugin page must call narrow plugin routes only; it must never receive a generic RPC proxy.
3. Expose an allowlist of operations only: status, start, submit, inspect, cancel, open external DSH UI, approval respond.
4. Constrain task `cwd` to configured workspace roots (`dshWorkspaceRoots`). When none are configured, the adapter falls back to the host process's current working directory and logs a warning (never an empty root list).
5. Start DSH with a fixed executable path and fixed `web --host 127.0.0.1 --port <port>` arguments. Do not accept arbitrary CLI argument strings from UI/tool input.
6. Never expose credentials, settings mutation, command execution, preset mutation, or arbitrary DSH endpoint forwarding.
7. Never silently elevate DSH permission presets.
8. **Approval answering is user-triggered only and never automatic.** The single DSH-answer entry point (`ApprovalService.respondApproval`) is called exclusively by the narrow API route; the listener, the reconnect re-pull and the timeout sweep never answer. `outcome` is whitelisted to `allowed-once` / `rejected`; `never`/persistent elevation vocabulary does not exist in the codebase (source-scan tested). Approval reasons are redacted before persist/push, and API views never include rpcId, sessionId or raw reasons.
9. Preserve DSH as source of truth for sessions and outputs. Hana stores only adapter task metadata, presentation cache and (redacted) approval records.

## 4. Proposed architecture

```text
Hana Agent Tool / Hana Plugin Page
            |
            v
  Narrow plugin API / tools
            |
            v
     DshAdapterService
      |      |       |
      |      |       +-- Task metadata store (ctx.dataDir, atomic JSON)
      |      +---------- DSH process supervisor (optional local child)
      +----------------- Loopback-only DSH RPC client
                              |
                              v
                     DSH Web profile :3080
                              |
                              v
                    DSH sessions + workspace files
```

### Components

- `DshRpcClient`: exact request envelopes, timeouts, narrow endpoint methods.
- `DshProcessSupervisor`: status probe, idempotent start, child ownership tracking, graceful disposal only for child owned by this plugin. It must not kill an externally started DSH process.
- `WorkspacePolicy`: canonical Windows path containment checks against configured roots.
- `TaskStore`: records adapter task id, DSH session id, cwd, timestamps, state, and last error. Atomic write through temp + rename.
- `DshAdapterService`: orchestrates submit/status/result/cancel and the monitor aggregation `overview()` (fail-soft per-task inspect, redacted errors).
- `ApprovalStore` / `ApprovalMuxListener` / `ApprovalService`: Phase 1 approval loop (see §5.2) — redacted pending records, events.mux listening with bounded-backoff reconnect + history re-pull, user-triggered narrow answering, chat/task-board pushes.
- `routes/studio.js`: observation-only monitor page (cards, no tables, no submit form), served under the Hana plugin page convention; approval card list + toast in Phase 1.
- `routes/api.js`: narrow JSON endpoints mirroring the allowlist (+ `/api/approvals` in Phase 1).
- `tools/*.js`: Agent-facing status/run/get/cancel tools.

## 5. MVP behavior

### Status

Return plugin version, configured loopback URL, DSH reachability, whether this plugin owns a child process, executable existence, and allowed workspace roots.

### Start

- Probe first.
- If already reachable, reuse external service and report `owned: false`.
- Otherwise spawn fixed DSH CLI command.
- Wait for health with bounded timeout.
- Capture stdout/stderr tail for diagnostics.
- Do not duplicate-start.

### Submit

Input:

- `prompt` (required, bounded non-empty string)
- `cwd` (required; must exist and be under an allowed root)
- optional `agentPreset` (default `router-standard`, constrained identifier)
- optional `waitSeconds` (0 for async; bounded maximum for synchronous wait)

Flow (recoverable submit chain — Phase 0):

1. Ensure DSH reachable (optionally auto-start from config).
2. Validate/canonicalize cwd.
3. **Pre-allocate a DSH `sessionId`** (`session-<uuid>`) and **persist the local task record first** (`status: "creating"`). A crash or transient failure now leaves a traceable, recoverable task instead of an orphaned DSH session.
4. Call `session.create({ sessionId, cwd, agentPreset })`. DSH create is idempotent for the same `sessionId`+`cwd` (a different cwd fails with `session-conflict`), so one inline retry is safe on transient failures. The returned `sessionId` MUST equal the pre-allocated id: any drift marks the task `failed(create-id-mismatch)` and is thrown with `taskId` — the record is never silently rewritten to a different session. Confirm → `submitting`.
5. Call `session.prompt` in `queue` mode with one text block. This is a once-only write (DSH provides no idempotency key) and is never double-sent; a failure marks the task `failed(prompt-failed)` and is recorded in `lastError`.
6. Confirm → `running`.
7. If wait requested, watch boundedly using `session.list` and read `session.history` after the session is idle.
8. Return task id + DSH session id + state; include final assistant text when available.

Every submit-chain failure after the local record is persisted lands in `lastError` + status and the thrown `DshAdapterError` carries `error.taskId`; if persisting the initial record itself fails, no DSH RPC has been sent and the error still carries the pre-allocated task id. Side-effect windows are documented, not papered over: a prompt accepted by DSH whose `running`-persist then fails leaves the record at `submitting` (traceable, reconcile settles it from DSH history), and a failed prompt leaves the created DSH session identified by `sessionId` without auto-deleting anything (the adapter never performs destructive DSH-side cleanup). The prompt raw text is deliberately NOT persisted (redaction boundary), so cross-restart recovery covers create (idempotent) and state reconciliation only.

### Inspect/result

- Read task metadata.
- Read DSH session status and history (the same observation pass drives the state machine).
- Extract final assistant text conservatively from durable events.
- Return raw relevant event summary only when explicitly requested; do not dump full tool arguments by default.

### Cancel

Call `session.cancel` for the mapped DSH session. Do not terminate the DSH service.
`session.cancel` returns `accepted: true` while the stop is asynchronous, so Phase 0 semantics are **accepted → `cancelling` → observed terminal**: the task moves to `cancelling` (non-terminal, records `cancelledAt`/`cancelRequestedAt`) and the terminal verdict (`cancelled`/`done`/`failed`/`orphaned`) comes from the next observation (inspect / overview / startup reconcile). Race safety: `cancelling` is persisted BEFORE the RPC (compare-and-swap on the current status), so a concurrent observation in the RPC window can never finalize the task as `failed`, and concurrent cancel calls cannot double-send the RPC. A failed cancel request rolls back through the state machine's cancel-rollback edge (`cancelling → previous non-terminal status`), records `lastError`, and throws with `taskId` — never falsely reported as cancelled. Cancelling an already-terminal task is an idempotent no-op.

### Startup reconciliation

On plugin load, `DshAdapterService.reconcilePending()` runs once in the background over every non-terminal task: DSH unreachable → tasks stay pending and the plugin load is unaffected; otherwise each task is classified by the same state machine (settling `running → done`, `cancelling → cancelled`, confirming absent sessions as `orphaned`, etc.). It is fail-soft per task, logs results, and never produces an unhandled promise rejection.

## 5.1 Task state machine (Phase 0)

Defined centrally in `lib/task-state.js` (single source of truth); all writes go through `DshAdapterService`:

- Non-terminal: `creating`, `submitting`, `running`, `cancelling`.
- Terminal (sticky, no outgoing moves): `done`, `failed`, `cancelled`, `orphaned`, `no-final-output`.
- Non-terminal edges: `creating → submitting|running|cancelling`, `submitting → running|cancelling`, `running → cancelling`, and the explicit **cancel-rollback** edge `cancelling → creating|submitting|running` (service-only, on failed `session.cancel`; observations on a cancelling task only return null or a terminal verdict). Any non-terminal → terminal move is allowed (the classifier is authoritative).
- Legacy statuses `running/done/cancelled/failed` are first-class members; old `tasks.json` records are normalized on load (new fields default, unknown statuses → `running` for reconciliation to judge).

Terminal classification of an idle session (durable evidence only, robust to `{ event }` wrappers and legacy event shapes):

- last `turn/end` reason: `completed` → `done` (text present) or `no-final-output` (no text); `aborted` → `cancelled`; `error` → `failed`; `max-tokens|interrupted|blocked|unknown` → `failed`.
- no `turn/end` but text or a started turn (torn log) → `failed`; nothing at all → `failed(no-turn)` (with an accepted cancel → `cancelled(cancel-settled)`).
- `session.list` absence is NEVER success: `session.history` proves existence (cold session → classify by history) or confirms absence (`session-not-found` → `orphaned`).
- Transient read failures (transport/bad-response/internal/cancelled) never produce terminal states.
- Absence verdicts (`no-turn`, `interrupted`, `prompt-lost`, `prompt-ambiguous`, `session-missing`, `cancel-settled`) are observed through a **persisted observation grace window** (default 30 s): `uncertainSince`/`uncertainReason` are written to the task record, the clock starts on the FIRST observation of a given verdict, and only continuous observation of the SAME verdict past the window becomes terminal; re-running, a durable `turn/end`, or a changed verdict clears/restarts the clock. This is independent of when the task entered its current status, so a long-running task observed idle for the first time is never falsely failed. Verdicts anchored to an explicit durable `turn/end` apply immediately.
- Records with no `sessionId` (legacy/malformed) are never probed and settle conservatively to `failed(missing-session-id)` instead of pending forever.

## 5.2 Approval loop (Phase 1)

Components:

- `ApprovalStore` (`approvals.json`): atomic JSON store mirroring TaskStore's durability contract (tmp+rename, serialized commits, corrupt-file recovery, legacy normalization). Records are keyed by approvalId: `{ approvalId, sessionId, taskId, toolName, reasonSummary (REDACTED), rpcId, status: pending|resolved, outcome, source: mux|replay, requestedAt, resolvedAt, updatedAt }`. `pending → resolved` is sticky: a stale `approval/requested` replay never resurrects a settled record; a pending record's missing rpcId IS refreshed when a later frame carries it (history-first + mux-replay ordering).
- `ApprovalMuxListener`: connects `ws://127.0.0.1:<port>/api/events.mux` (SSE fallback on Node 20), parses full `server-request` envelopes, forwards only `approval/requested` / `approval/resolved`, reconnects with bounded exponential backoff (500ms → 30s cap), fires `onOpen` after every successful (re)connect for the history re-pull, and is disposed via `stop()` (idempotent; generation counter kills in-flight reconnects). Downlink-only, never throws out of callbacks.
- `ApprovalService`: the orchestration core.
  - Ingest order: **persist first, push after** — a failed `session:send` or `task:update` never affects the record (fail-soft, logged).
  - Ownership: only approvals for sessions present in TaskStore are recorded; others are ignored with a log line.
  - Reconnect re-pull (`reconcileFromHistory`): for each owned session, read `session.history`, turn undecided `approval/asked` events into pending records (source `replay`, chat push, no rpcId → not answerable until a mux replay supplies it) and `approval/decided` events into resolved records with feedback. Per-session failures are skipped; never rejects.
  - `respondApproval({ approvalId, outcome, taskId? })`: validates (exists / pending / whitelist / optional taskId cross-check / rpcId present), sends the client-response envelope via `DshRpcClient.respondApproval`, then resolves the record + feedback. `accepted: false, reason: not-pending` folds reality in (`superseded`) and still fails the request; transport failures keep the record pending (502).
  - Timeout (`dshApprovalTimeoutMs > 0`): a sweep abandons overdue pendings locally (`timed-out` + feedback). It NEVER answers DSH — auto-approval and auto-rejection are both forbidden; DSH keeps the ask pending. `0` (default) waits forever.
  - Chat text follows hana-notify-spec §3: `[DSH 审批] 任务 <id> 请求提权：<toolName> <reason摘要> —— 请在 DSH 监听页批准或拒绝`, resolved feedback 「已批准一次 / 已拒绝 / 已取消 / 已失效 / 等待超时…」. The `dshApprovalNotify` switch (default true) gates these pushes only — records and the page keep working either way. `task:update { taskId, status: "blocked" }` is best-effort (host capability optional).
- Routes: `GET /api/approvals` → redacted pending views `{ approvalId, taskId, toolName, reasonSummary, requestedAt }`; `POST /api/approvals/:approvalId/respond` with `{ outcome }` → `respondApproval`. All errors are `{ error: code, detail: message }` — never stacks.
- Page: the monitor page gains a 待处理审批 card list (polled with the 3s refresh), per-card 批准一次 / 拒绝 buttons (POST through the plugin API), a new-arrival toast (minimal `toast.show({ message, type: "warning" })` equivalent of `@hana/plugin-sdk`, same call shape), and never touches DSH directly.

Lifecycle: `index.js` builds the store + service, starts the listener (fail-soft inside), and `register()` disposes the listener and the sweep timer alongside the existing supervisor teardown.

## 6. Non-goals for MVP / Phase 0

- No generic reverse proxy to DSH.
- No embedded/nested DSH Web UI.
- No credential or model settings editor.
- No automatic privilege escalation or automatic approval answering (answering exists ONLY as a user-triggered narrow route; persistent elevation vocabulary is banned).
- No deletion/archival of DSH sessions.
- No modification of files outside the task cwd.
- No attempt to translate Hana sessions into DSH event logs.
- No multi-turn Session steering, chat-reply-triggered approval answering, or approval policy configuration (Phase 2+ candidates).
- No persistence of prompt raw text (redaction boundary; overview/get-task never gain prompt raw leakage).

## 7. Files expected

```text
hana-dsh-adapter/
  manifest.json
  package.json
  index.js
  README.md
  ARCHITECTURE.md
  lib/
    task-state.js            # centralized task state machine + terminal classifier
    dsh-rpc-client.js        # narrow RPC allowlist + respondApproval carrier
    dsh-process-supervisor.js
    workspace-policy.js
    task-store.js
    dsh-adapter-service.js   # submit / status / inspect / cancel / reconcile
    approval-store.js        # approvals.json (redacted pending records)
    approval-mux-listener.js # events.mux WS/SSE listener + backoff reconnect
    approval-service.js      # approval loop orchestration + respondApproval
    config.js
  routes/
    api.js                   # narrow JSON API incl. /api/approvals
    studio.js
  assets/
    studio.css
    studio.js                # monitor + approval cards + toast
  tools/
    status.js
    start.js
    run-task.js
    get-task.js
    cancel-task.js
  tests/
    *.test.js
```

## 8. Acceptance criteria

1. `node --test` passes with no external network and without requiring a real DSH process.
2. Tests cover loopback URL rejection, path traversal/sibling-prefix rejection, duplicate start prevention, external-vs-owned process behavior, RPC envelope shape/error handling, task persistence (incl. legacy-record compatibility), **preallocated sessionId persisted before create, idempotent create retry, traceable create/prompt failures, terminal classification (idle+text→done, idle+error→failed, idle+no-text→no-final-output, session missing→orphaned, cold session not misjudged), grace-window race protection, transient RPC failures never terminal, cancel failure never reports cancelled, cancelling→observed terminal, fail-soft startup reconcile, no raw tool-argument leakage**, submit orchestration, result extraction, and cancel.
3. Phase 1 approval tests cover: mux envelope parsing (full server-request + rpcId), approval-frame scoping, backoff reconnect (bounded, reset on success, stop-cancelling), ingest→persist→push ordering with redaction, ownership filtering, replay idempotency and no-resurrection, resolved feedback per outcome, respondApproval wire envelope + whitelist + all error classes (404/409/400/502) + not-pending/superseded folding, notify master switch, timeout abandonment (never answering DSH), history re-pull (replay source, decided settling, rpcId backfill, fail-soft), redacted API views, route error redaction without stacks, and the source-level auto-approval impossibility scan.
4. `manifest.json`, static tools, routes, and lifecycle match Hana plugin conventions used by installed plugins.
5. No shell command is assembled from user-controlled input.
6. No generic DSH RPC proxy exists (the `/api/respond` client-response carrier is a dedicated narrow method).
7. All source files are UTF-8.
8. README contains install/dev-smoke instructions and a security warning about DSH's local control plane (incl. the approval-loop red lines).
9. Plugin remains a source package in the repository root; do not install it into Hana automatically.
