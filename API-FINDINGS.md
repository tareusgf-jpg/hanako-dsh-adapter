# DSH / Hana API Findings

## Confirmed by local inspection

- DSH Web is reachable at `http://127.0.0.1:3080` with HTTP 200.
- RPC calls use a full envelope:

```json
{
  "type": "client-request",
  "rpcId": "opaque-correlation-id",
  "method": "session.create",
  "payload": {}
}
```

- `session.create` accepts `{ cwd?, workspaceId?, sessionId?, agentPreset? }` and returns `{ sessionId, agentPreset? }`.
- `session.prompt` accepts `{ sessionId, mode: "queue" | "steer", content: [{ type: "text", text }] }` and returns `{ accepted: true }`.
- `session.history` accepts `{ sessionId, beforeSeq?, maxMessages? }` and returns event entries plus `hasMore`; tail responses may include projections.
- `session.list` returns summaries with `running`, `blank`, `cwd`, and `agentPreset`.
- DSH stores assistant output as durable `assistant/message` events. The `message.content` value is normally an array containing text and tool-call blocks; result extraction must ignore tool-call arguments.
- The running state is not a final-result channel. A caller must wait for `running: false`, then read history.
- The DSH Web server is an unauthenticated local control plane. The adapter must not expose generic forwarding from a Hana page.

## Phase 0 findings (verified against rc.6 type contracts)

### session.create is idempotent for a pre-allocated sessionId

From `sessions.d.ts` (`SessionsApi.create`): *"A caller may preallocate `sessionId`: retries with the same id and cwd return the same session, while a different cwd fails with `session-conflict`."* The schema only requires a non-empty string (`sessionIdSchema = z.string().min(1)`). This is what makes the recoverable submit chain possible: persist the record with a pre-allocated id first, then retry `create` safely.

The adapter therefore **verifies the create response**: a returned `sessionId` that differs from the pre-allocated one is treated as a protocol violation (`failed(create-id-mismatch)`, drift recorded in `lastError`, error thrown with `taskId`) and the record is never silently rewritten to another session id.

### A single text block starting with "/" is a slash command

DSH interprets a prompt whose first character is `/` as a slash command (e.g. `/compact`, `/help`), not as a task. The adapter is an encoding task bridge, not a command channel: `validatePrompt` rejects any trimmed prompt starting with `/` as `invalid-prompt` (400) before any RPC or persistence, so slash inputs are never silently executed against the local control plane.

### session.cancel is asynchronous

`SessionsApi.cancel`: *"Stops an ordinary session's active turn, preserving pending inbox work that resumes in FIFO order after cancellation settles."* The response is `{ accepted: true }` immediately; the stop happens afterwards and is observable through `turn/end` with reason `aborted`. Hence: accepted → `cancelling` → observed terminal, never "accepted ⇒ immediately cancelled".

### session.history works for cold sessions; absence is a specific error

`SessionsApi.history`: *"Reading history uses an attached Session or persistence inspection and never resumes or publishes an Agent."* So a session missing from `session.list` (e.g. cold, projection-cache miss) can still be read via `history` — that is a session that EXISTS and must never be judged "not found". Only an RPC error with code `session-not-found` confirms absence. `session.list` summaries carry `running` (always false for cold/unattached sessions), `blank` (true while no `turn/start` exists), `updatedAt`, `cwd`, `agentPreset`.

### RPC error codes relevant to the adapter

`RpcErrorDetailsMap` (from `api/rpc.d.ts`): `session-not-found {sessionId}`, `session-conflict {sessionId, requestedCwd, existingCwd?}`, `workspace-attach-failed {sessionId, workspaceId}`, `agent-preset-not-found {agentPreset, available}`, `agent-preset-invalid`, `agent-preset-locked`, `agent-preset-conflict`, `agent-busy {reason}`, `cancelled`, `internal`, `bad-request`. Transport folds to `internal` server-side; the adapter's client reports `transport` / `bad-response` for HTTP/JSON failures.

### turn/end reason kinds (durable terminal evidence)

`TurnEndReasonMap` (from `dsh-session/types`): `completed`, `aborted {reason: user|parent|hook|disposed|legacy}`, `blocked`, `error {error: LlmFailure}`, `max-tokens`, `interrupted` (persistence closes a crash-orphaned turn on reload). Legacy event shapes (`{turn, reason}` with old kind spellings) are migrated by persistence before serving. The adapter classifies: `completed` → done (with assistant text) / no-final-output (without); `aborted` → cancelled; `error` → failed; `max-tokens|interrupted|blocked|unknown` → failed (never a false success).

### session.prompt has no idempotency key

`SessionsApi.prompt` returns only `{ accepted: true }` (plus an optional slash-command slot) — no message id, no delivery receipt. Together with the redaction boundary (prompt raw text is not persisted), this means prompt delivery is at-most-once: when delivery cannot be proven and no turn ever started, the task fails conservatively (`prompt-ambiguous`/`prompt-lost`) instead of risking a duplicate send.

## Hana plugin integration facts

- Static tools are discovered from `tools/*.js` and are prefixed with the plugin id by the host.
- Lifecycle code belongs in `index.js`; runtime state can be attached to `ctx` and cleaned via `this.register()`.
- UI pages are contributed through `manifest.json`, served with `routes/*.js`, and static assets can be served by a narrow plugin-owned asset route.
- A full-access manifest is required for process supervision and HTTP routes.
- Plugin source should remain under the repository root during development; install/reload is a separate explicit dev-loop action.

## Architectural consequence

The adapter should use a Node-side service boundary:

`Hana tool/page -> adapter service -> loopback DSH RPC -> DSH session`

It should never use:

`Hana page -> arbitrary DSH endpoint`

This keeps the DSH protocol as an internal implementation detail and gives the adapter one place to enforce loopback, path, timeout, task persistence, and error-redaction rules.
