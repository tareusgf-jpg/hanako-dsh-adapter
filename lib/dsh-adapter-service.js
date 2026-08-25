// hana-dsh-adapter: orchestration service (submit / status / inspect / cancel / reconcile).
// DSH stays the source of truth for sessions and outputs; this service stores
// only adapter task metadata and returns conservative presentation views.
//
// Phase 0 semantics:
// - submit persists a local task record ("creating") with a pre-allocated
//   sessionId BEFORE any RPC; session.create is retried once on transient
//   failures (DSH create is idempotent for same sessionId+cwd); session.prompt
//   is a once-only write (no idempotency key) and is never double-sent.
// - Observation (inspect/overview/wait loop/reconcile) drives every task
//   through the central state machine (lib/task-state.js). "idle" alone is
//   never success: terminal verdicts require durable evidence. Absence-style
//   verdicts (no-turn / interrupted / prompt-lost / prompt-ambiguous /
//   session-missing / cancel-settled) are observed through a PERSISTED
//   observation grace window (uncertainSince/uncertainReason): the clock
//   starts on the FIRST observation of a given uncertain verdict, and the
//   verdict becomes terminal only after that same verdict has been observed
//   continuously past the grace window. Re-running, durable turn/end evidence
//   or a verdict change clears/restarts the observation.
// - cancel persists "cancelling" (cancelRequestedAt, previousStatus) BEFORE
//   the session.cancel RPC so a concurrent observation can never finalize the
//   task as failed in the RPC window; if the RPC fails, the state machine's
//   cancel-rollback edge restores the previous non-terminal status.
// - reconcilePending() runs at plugin startup, fail-soft, in the background.
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DshRpcError } from "./dsh-rpc-client.js";
import { DshStartError } from "./dsh-process-supervisor.js";
import { WorkspacePolicyError } from "./workspace-policy.js";
import { TaskStoreError } from "./task-store.js";
import {
  classifyIdle,
  unwrapHistoryEvents,
  hasTurnEvidence,
  isTerminal,
  canTransition,
  TaskStateError,
} from "./task-state.js";
import {
  DEFAULT_AGENT_PRESET,
  MAX_PROMPT_CHARS,
  MAX_WAIT_SECONDS,
} from "./config.js";

export class DshAdapterError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DshAdapterError";
    this.code = code;
    this.status = status;
  }
}

const AGENT_PRESET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Max recent tasks a single overview() snapshot inspects. */
export const MAX_OVERVIEW_TASKS = 6;
/** Max length of a redacted error message / result summary in overview. */
export const OVERVIEW_TEXT_MAX = 160;
/**
 * Verdicts that assert absence or a torn log (no explicit durable turn/end
 * reason) wait out a classification grace window before going terminal, so a
 * task that was just submitted/persisted can never be falsely failed by a
 * racing poll. Explicit turn/end reasons (completed/aborted/error/max-tokens/
 * blocked/…) are durable and classify immediately.
 * The grace is OBSERVATION-based (uncertainSince/uncertainReason, persisted):
 * the clock starts on the first observation of a given reason and only
 * continuous observation of the SAME reason past the grace window becomes
 * terminal. Re-running, durable turn/end evidence or a changed reason
 * clears/restarts the observation. `cancel-settled` is included: after a
 * cancel request the session is expected to settle, but that absence is only
 * confirmed by sustained observation, never by a single racing poll.
 */
export const CLASSIFICATION_GRACE_MS = 30_000;
/** RPC error codes that are transient by nature: never terminal on their own. */
const TRANSIENT_RPC_CODES = new Set(["transport", "bad-response", "cancelled", "internal"]);
/** Terminal reasons that need the observation grace window before they stick. */
const UNCERTAIN_REASONS = new Set([
  "no-turn",
  "interrupted",
  "prompt-lost",
  "prompt-ambiguous",
  "session-missing",
  "cancel-settled",
]);
/**
 * Legacy/malformed records with no DSH session id: one shared terminal reason
 * and message across inspect / reconcile / cancel, so every code path that
 * cannot identify the session settles the record the same way.
 */
const MISSING_SESSION_ID_REASON = "missing-session-id";
const MISSING_SESSION_ID_MESSAGE =
  "task record has no DSH sessionId (legacy/malformed record); the session cannot be identified — resubmit a new task";

export class DshAdapterService {
  /**
   * @param {object} opts
   * @param {import("./dsh-rpc-client.js").DshRpcClient} opts.rpc
   * @param {import("./dsh-process-supervisor.js").DshProcessSupervisor} opts.supervisor
   * @param {import("./workspace-policy.js").WorkspacePolicy} opts.workspacePolicy
   * @param {import("./task-store.js").TaskStore} opts.taskStore
   * @param {object} opts.config
   * @param {Function} [opts.now]  injectable clock (tests)
   * @param {Function} [opts.sleep]  injectable sleep (tests)
   * @param {number} [opts.pollIntervalMs]  wait-loop poll interval (default 500ms)
   * @param {number} [opts.classificationGraceMs]  grace window for absence verdicts (default CLASSIFICATION_GRACE_MS)
   */
  constructor({ rpc, supervisor, workspacePolicy, taskStore, config, log = null, now = null, sleep = null, pollIntervalMs = 500, classificationGraceMs = CLASSIFICATION_GRACE_MS }) {
    this.rpc = rpc;
    this.supervisor = supervisor;
    this.policy = workspacePolicy;
    this.store = taskStore;
    this.config = config;
    this.log = log;
    this.now = now ?? (() => Date.now());
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = pollIntervalMs;
    this.classificationGraceMs = classificationGraceMs;
    this.#reconciling = null;
  }

  #reconciling = null;

  async status() {
    const s = await this.supervisor.status();
    return {
      pluginVersion: this.config.pluginVersion,
      url: s.url,
      reachable: s.reachable,
      probeError: s.probeError,
      owned: s.owned,
      pid: s.pid,
      executableExists: s.executableExists,
      executablePath: s.executablePath,
      workspaceRoots: this.policy.listRoots(),
      autoStart: this.config.autoStart,
      defaultAgentPreset: DEFAULT_AGENT_PRESET,
      taskCount: this.store.list().length,
    };
  }

  async start({ autoStart } = {}) {
    const result = await this.supervisor.ensureStarted({
      autoStart: autoStart ?? this.config.autoStart,
    });
    return { ok: true, ...result };
  }

  /**
   * One lightweight observation snapshot for the monitor page: status plus the
   * most recent tasks (default MAX_OVERVIEW_TASKS). Fail-soft: a per-task DSH
   * read failure never fails the whole overview — it becomes a redacted error
   * entry while status and the other tasks are still returned. Never includes
   * raw events, tool arguments, prompts or session ids.
   */
  async overview({ maxTasks = MAX_OVERVIEW_TASKS } = {}) {
    const status = await this.status();
    const records = this.store.list().slice(0, maxTasks);
    const tasks = [];
    let recentError = null;
    for (const record of records) {
      const entry = await this.#overviewTask(record);
      if (entry.error || entry.lastError) {
        recentError ??= {
          taskId: entry.id,
          code: entry.error?.code ?? "task-error",
          message: entry.error?.message ?? entry.lastError,
        };
      }
      tasks.push(entry);
    }
    return { status, tasks, recentError, refreshedAt: this.now() };
  }

  /** Inspect one task for overview; any failure is redacted, never thrown. */
  async #overviewTask(record) {
    try {
      const inspected = await this.inspect(record.id);
      const task = inspected.task;
      return {
        id: task.id,
        status: task.status,
        cwd: task.cwd,
        updatedAt: task.updatedAt,
        dshRunning: task.dsh?.running ?? null,
        sessionFound: task.dsh?.sessionFound ?? null,
        resultSummary: summarizeText(inspected.resultText ?? task.resultText ?? null, OVERVIEW_TEXT_MAX),
        error: task.dsh?.error ? redactError(task.dsh.error) : null,
        lastError: task.lastError ? summarizeText(task.lastError, OVERVIEW_TEXT_MAX) : null,
      };
    } catch (error) {
      return {
        id: record.id,
        status: record.status,
        cwd: record.cwd,
        updatedAt: record.updatedAt,
        dshRunning: null,
        sessionFound: null,
        resultSummary: summarizeText(record.resultText ?? null, OVERVIEW_TEXT_MAX),
        error: redactError(error),
        lastError: record.lastError ? summarizeText(record.lastError, OVERVIEW_TEXT_MAX) : null,
      };
    }
  }

  /**
   * Submit one DSH task.
   *
   * Chain (each step after the local record is persisted lands
   * status/lastError; the thrown DshAdapterError always carries `error.taskId`):
   *   1. pre-allocate sessionId, persist record as "creating" (if THIS persist
   *      fails, no RPC was sent — the error still carries the task id)
   *   2. session.create (idempotent; one inline retry on transient failure) → "submitting"
   *   3. session.prompt (queue, one text block; once-only) → "running"
   *   4. optional wait loop observes until a terminal state or the deadline.
   * Side-effect windows (documented, conservative): if step 3 succeeds but
   * persisting "running" fails, DSH already holds the session+prompt while the
   * record stays "submitting" — reconcile will settle it from DSH history. If
   * step 3 itself fails, the created DSH session (identified by sessionId) is
   * left without a prompt; the adapter never auto-deletes DSH sessions.
   *
   * @returns {Promise<{ task: object, waitOutcome: "none"|"completed"|"timed-out" }>}
   */
  async submit({ prompt, cwd, agentPreset, waitSeconds, autoStart } = {}) {
    const text = validatePrompt(prompt);
    const canonicalCwd = await this.#validateCwd(cwd);
    const preset = validateAgentPreset(agentPreset);
    const wait = validateWaitSeconds(waitSeconds);

    try {
      await this.supervisor.ensureStarted({ autoStart: autoStart ?? this.config.autoStart });
    } catch (error) {
      if (error instanceof DshStartError) {
        throw new DshAdapterError("dsh-unavailable", `DSH ${error.code}: ${error.message}`, {
          status: 502,
          cause: error,
        });
      }
      throw error;
    }

    // Persist BEFORE any RPC: a crash or transient failure leaves a
    // traceable, recoverable task instead of an orphaned DSH session.
    const sessionId = `session-${randomUUID()}`;
    const taskId = `task_${randomUUID()}`;
    let record;
    try {
      record = await this.store.create({
        id: taskId,
        sessionId,
        cwd: canonicalCwd,
        agentPreset: preset,
        promptSummary: summarizePrompt(text),
        promptLength: text.length,
        status: "creating",
      });
    } catch (error) {
      const mapped = new DshAdapterError(
        error instanceof TaskStoreError ? `store-${error.code}` : "store-write-failed",
        `failed to persist the task record (no DSH RPC was sent): ${error?.message || error}`,
        { status: 500, cause: error },
      );
      throw attachTaskId(mapped, taskId);
    }

    let confirmedSessionId;
    try {
      confirmedSessionId = await this.#createWithRetry(record);
    } catch (error) {
      throw attachTaskId(this.#dshError("session.create", error), record.id);
    }

    try {
      await this.rpc.promptSession({ sessionId: confirmedSessionId, text });
    } catch (error) {
      const mapped = attachTaskId(this.#dshError("session.prompt", error), record.id);
      await this.store
        .update(record.id, {
          status: "failed",
          terminalReason: "prompt-failed",
          lastError: mapped.message,
          uncertainSince: null,
          uncertainReason: null,
        })
        .catch(() => {});
      throw mapped;
    }

    let running;
    try {
      running = await this.store.update(record.id, { status: "running" });
    } catch (error) {
      // The prompt WAS accepted: DSH holds the session. Keep the record
      // traceable ("submitting") and report the failure with the task id.
      const mapped = new DshAdapterError(
        error instanceof TaskStoreError ? `store-${error.code}` : "store-write-failed",
        `task record update failed after the prompt was accepted (DSH has session ${confirmedSessionId}; task stays traceable as ${record.id}): ${error?.message || error}`,
        { status: 500, cause: error },
      );
      throw attachTaskId(mapped, record.id);
    }

    let waitOutcome = "none";
    if (wait > 0) {
      waitOutcome = await this.#waitForIdle(running, wait);
    }
    const final = this.store.get(record.id);
    return { task: final, waitOutcome };
  }

  /**
   * Inspect a task: read DSH state, apply the state machine, return task
   * metadata + DSH status + final text. Never fails the whole request when DSH
   * is briefly unreachable; transient read failures never make a task terminal.
   */
  async inspect(id, { includeRaw = false } = {}) {
    let record = this.store.get(id);
    if (!record) {
      throw new DshAdapterError("not-found", `task ${id} not found`, { status: 404 });
    }
    const dsh = {
      reachable: null,
      running: null,
      updatedAt: null,
      blank: null,
      sessionFound: null,
      sessionExists: null,
      error: null,
    };
    let resultText = record.resultText ?? null;
    let raw = null;
    let next = record;
    try {
      const state = await this.#readDshState(record);
      if (!state.sessionIdMissing && (!state.reachable || state.error)) {
        const error = state.error ?? new Error("DSH read failed");
        dsh.error = error instanceof DshRpcError ? `${error.code}: ${error.message}` : String(error?.message || error);
        dsh.reachable = false;
      } else {
        dsh.reachable = true;
        dsh.running = state.running;
        dsh.updatedAt = state.updatedAt;
        dsh.blank = state.blank;
        dsh.sessionFound = state.sessionFound;
        dsh.sessionExists = state.sessionExists;
        if (state.text) {
          resultText = state.text;
        }
        if (includeRaw) {
          raw = sanitizeEventSummary(state.events);
        }
        const decision = this.#decide(record, state);
        if (decision.transition || decision.uncertain || decision.clearUncertain) {
          const applied = await this.#applyDecision(record, decision);
          next = applied.record;
        }
        if (state.text && state.text !== next.resultText) {
          next = await this.store.update(next.id, { resultText: state.text }, { touch: false }).catch(() => next);
        }
      }
    } catch (error) {
      const rpcError = error instanceof DshRpcError ? error : null;
      this.log?.error?.(`hana-dsh-adapter inspect task ${id} failed: ${error?.message || error}`);
      dsh.error = rpcError ? `${rpcError.code}: ${rpcError.message}` : String(error?.message || error);
      dsh.reachable = false;
    }
    return { task: { ...next, dsh }, resultText, raw };
  }

  /**
   * Cancel the mapped DSH session. Never stops the DSH service.
   * `session.cancel` returns accepted immediately while the stop happens
   * asynchronously, so the task moves to "cancelling" (non-terminal) and the
   * terminal verdict (cancelled / done / failed / orphaned) comes from the
   * next observation.
   *
   * Race-safety (M3): "cancelling" (with cancelRequestedAt and previousStatus)
   * is persisted BEFORE the session.cancel RPC, via a compare-and-swap on the
   * current status, so a concurrent inspection in the RPC window can never
   * finalize the task as failed and two concurrent cancel calls cannot send
   * duplicate RPCs. If the RPC fails, the state machine's cancel-rollback edge
   * restores the previous non-terminal status and the failure is recorded in
   * lastError and thrown — never falsely reported as cancelled.
   * P3-1: a legacy/malformed record with NO sessionId is settled to
   * failed(missing-session-id) (same terminalReason/lastError as inspect and
   * reconcile) BEFORE any RPC, then the request fails with code
   * missing-session-id — cancelSession({ sessionId: null }) is never sent.
   */
  async cancel(id) {
    const record = this.store.get(id);
    if (!record) {
      throw new DshAdapterError("not-found", `task ${id} not found`, { status: 404 });
    }
    if (isTerminal(record.status)) {
      return { task: record, accepted: false, note: `task already ${record.status}` };
    }
    if (typeof record.sessionId !== "string" || record.sessionId === "") {
      // Legacy/malformed record with no session id (P3-1): session.cancel can
      // never be sent for an unidentifiable session — sending
      // cancelSession({ sessionId: null }) is forbidden. Settle the record
      // exactly like inspect/reconcile (failed/missing-session-id, same
      // terminalReason and lastError) BEFORE any RPC, then fail the request
      // explicitly. The persisted lastError keeps the shared message; the
      // thrown error additionally carries the task id.
      const error = new DshAdapterError(
        MISSING_SESSION_ID_REASON,
        MISSING_SESSION_ID_MESSAGE,
        { status: 409 },
      );
      await this.store
        .update(id, {
          status: "failed",
          terminalReason: MISSING_SESSION_ID_REASON,
          lastError: error.message,
          uncertainSince: null,
          uncertainReason: null,
        })
        .catch(() => {});
      throw attachTaskId(error, id);
    }
    if (record.status === "cancelling") {
      return { task: record, accepted: false, note: "cancel already in progress; awaiting terminal observation" };
    }
    const previousStatus = record.status;
    const requestedAt = this.now();
    let cancelling;
    try {
      cancelling = await this.store.update(
        id,
        {
          status: "cancelling",
          cancelledAt: requestedAt,
          cancelRequestedAt: requestedAt,
          previousStatus,
        },
        { casStatus: previousStatus },
      );
    } catch (error) {
      if (error instanceof TaskStoreError && error.code === "conflict") {
        // A concurrent cancel won the race (or the task moved on): no RPC.
        const fresh = this.store.get(id);
        if (!fresh) {
          throw new DshAdapterError("not-found", `task ${id} not found`, { status: 404 });
        }
        return {
          task: fresh,
          accepted: false,
          note:
            fresh.status === "cancelling"
              ? "cancel already in progress; awaiting terminal observation"
              : `task already ${fresh.status}`,
        };
      }
      throw error;
    }

    try {
      await this.rpc.cancelSession({ sessionId: record.sessionId });
    } catch (error) {
      const mapped = attachTaskId(this.#dshError("session.cancel", error), id);
      // Roll back to the previous non-terminal status — only while the record
      // is still "cancelling" (a terminal observation may have won in between;
      // terminal states are sticky, so we never roll back through them).
      const rolledBack = await this.store
        .update(
          id,
          {
            status: previousStatus,
            cancelledAt: null,
            cancelRequestedAt: null,
            previousStatus: null,
            lastError: mapped.message,
          },
          { casStatus: "cancelling" },
        )
        .catch((rollbackError) => {
          if (rollbackError instanceof TaskStoreError && rollbackError.code === "conflict") {
            return null; // already terminal — nothing to roll back
          }
          // Best-effort rollback: on a store failure the task stays
          // "cancelling" (non-terminal, recoverable by observation) and the
          // original cancel failure still propagates below.
          this.log?.error?.(
            `hana-dsh-adapter cancel rollback for task ${id} failed: ${rollbackError?.message || rollbackError}`,
          );
          return undefined;
        });
      if (rolledBack === null) {
        // Best-effort note on the terminal record; the cancel failure still throws.
        await this.store.update(id, { lastError: mapped.message }).catch(() => {});
      }
      throw mapped;
    }

    // RPC accepted: the record is already "cancelling". Drop the rollback
    // bookkeeping (best-effort) and return the observed task.
    await this.store
      .update(id, { previousStatus: null }, { touch: false })
      .catch(() => {});
    return { task: this.store.get(id) ?? cancelling, accepted: true };
  }

  /**
   * Startup reconciliation: one fail-soft pass over every non-terminal task.
   * - DSH unreachable → tasks stay pending, nothing breaks (and the promise
   *   never rejects).
   * - "creating" tasks: if the pre-allocated session exists and is running,
   *   resume to "running" without prompting; a created-but-never-prompted
   *   session (prompt text is not persisted) and a prompt whose delivery is
   *   unprovable are failed conservatively — nothing is double-sent.
   * - everything else is classified by durable history (see lib/task-state.js).
   * Returns `{ scanned, changed, skipped? }`; never throws.
   */
  async reconcilePending() {
    if (this.#reconciling) {
      return this.#reconciling;
    }
    this.#reconciling = this.#reconcilePendingInner().finally(() => {
      this.#reconciling = null;
    });
    return this.#reconciling;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * session.create with one inline retry on transient failures. DSH create is
   * idempotent for the same pre-allocated sessionId+cwd, so a retry is safe.
   * Returns the confirmed session id.
   * Hard failures mark the task failed("create-failed"); two consecutive
   * transient failures leave it "creating" for reconcile to recover.
   * A returned sessionId that does NOT equal the pre-allocated record id is
   * a protocol violation: the task is marked failed("create-id-mismatch")
   * with the drift in lastError and the error is thrown — the record is never
   * silently rewritten to a different DSH session id.
   */
  async #createWithRetry(record) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const created = await this.rpc.createSession({
          sessionId: record.sessionId,
          cwd: record.cwd,
          agentPreset: record.agentPreset,
        });
        const confirmed =
          typeof created?.sessionId === "string" && created.sessionId ? created.sessionId : null;
        if (!confirmed) {
          const error = new DshAdapterError("dsh-invalid-response", "DSH session.create returned no sessionId", {
            status: 502,
          });
          await this.store
            .update(record.id, {
              status: "failed",
              terminalReason: "create-failed",
              lastError: error.message,
              uncertainSince: null,
              uncertainReason: null,
            })
            .catch(() => {});
          throw error;
        }
        if (confirmed !== record.sessionId) {
          const error = new DshAdapterError(
            "dsh-invalid-response",
            `DSH session.create returned sessionId "${confirmed}" but the task record pre-allocated "${record.sessionId}"; refusing to rewrite the record to a different session`,
            { status: 502 },
          );
          await this.store
            .update(record.id, {
              status: "failed",
              terminalReason: "create-id-mismatch",
              lastError: error.message,
              uncertainSince: null,
              uncertainReason: null,
            })
            .catch(() => {});
          throw error;
        }
        await this.store.update(record.id, { status: "submitting", sessionId: confirmed });
        return confirmed;
      } catch (error) {
        lastError = error;
        if (error instanceof DshAdapterError) {
          throw error; // already terminal
        }
        const transient = error instanceof DshRpcError && TRANSIENT_RPC_CODES.has(error.code);
        await this.store.update(record.id, { lastError: describeRpcError(error) }).catch(() => {});
        if (!transient) {
          await this.store.update(record.id, { status: "failed", terminalReason: "create-failed" }).catch(() => {});
          break;
        }
        if (attempt === 1) {
          break; // keep "creating": recoverable via reconcile
        }
      }
    }
    throw lastError;
  }

  /**
   * Read DSH state for one task without making any decision:
   * list → history (also the cold-session / missing-session probe).
   * A session absent from session.list but readable via session.history is a
   * cold (unattached) session that EXISTS — never an orphan. Only an explicit
   * `session-not-found` from history confirms absence. Transport/bad-response
   * failures are inconclusive and reported via `error`/`reachable`.
   * A record with NO sessionId (legacy/malformed) cannot be probed at all:
   * the state is flagged `sessionIdMissing` and #decide settles it
   * conservatively instead of leaving it pending forever.
   */
  async #readDshState(record) {
    const state = {
      reachable: null,
      error: null,
      sessionFound: false,
      sessionExists: null, // null = unknown
      running: null,
      updatedAt: null,
      blank: null,
      events: [],
      text: null,
      hasTurn: false,
      sessionIdMissing: false,
    };
    if (typeof record.sessionId !== "string" || record.sessionId === "") {
      state.sessionIdMissing = true;
      return state;
    }
    let items;
    try {
      const list = await this.rpc.listSessions();
      items = Array.isArray(list?.items) ? list.items : [];
    } catch (error) {
      state.reachable = false;
      state.error = asRpcError(error);
      return state;
    }
    state.reachable = true;
    const item = items.find((entry) => entry?.sessionId === record.sessionId) ?? null;
    state.sessionFound = item !== null;
    if (item) {
      state.sessionExists = true;
      state.running = item.running === true;
      state.updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : null;
      state.blank = typeof item.blank === "boolean" ? item.blank : null;
    }
    try {
      const history = await this.rpc.history({ sessionId: record.sessionId, maxMessages: 50 });
      const events = Array.isArray(history?.events) ? history.events : [];
      const unwrapped = unwrapHistoryEvents(events);
      state.events = unwrapped;
      state.hasTurn = hasTurnEvidence(unwrapped);
      const extracted = extractFinalAssistantText(unwrapped);
      state.text = extracted?.text ?? null;
      // A readable history proves the session exists even when session.list
      // does not show it (cold session): it is never an orphan. Cold sessions
      // are unattached, so they never run.
      if (!state.sessionFound) {
        state.sessionExists = true;
        state.running = false;
      }
      return state;
    } catch (error) {
      const rpcError = error instanceof DshRpcError ? error : asRpcError(error);
      if (rpcError.code === "session-not-found") {
        state.sessionExists = false;
        state.running = false;
        return state;
      }
      // Any other history failure is inconclusive — never a terminal decision.
      state.error = rpcError;
      state.reachable = false;
      return state;
    }
  }

  /**
   * The state machine decision for one observation. Returns
   * `{ transition, terminalReason?, lastError?, text?, clearUncertain? }`,
   * `{ transition: null, uncertain: { reason, since } }` (an absence verdict
   * is being observed: persist/keep the observation clock), or
   * `{ transition: null, clearUncertain: true }` (observation resolved —
   * running, durable evidence — clear the clock), or
   * `{ transition: null, error? }` when observation is inconclusive.
   *
   * Absence verdicts (UNCERTAIN_REASONS) are NEVER terminal on the first
   * observation: the clock starts at the first observation of a given reason,
   * and only continuous observation of the SAME reason past the grace window
   * becomes terminal. Re-running, a durable turn/end verdict, or a changed
   * reason clears/restarts the clock. This makes the grace independent of
   * when the task entered its current status (a long-running task that is
   * observed idle for the first time cannot be failed instantly).
   */
  #decide(record, state) {
    const text = state.text ?? null;
    if (isTerminal(record.status)) {
      return { transition: null };
    }
    if (state.sessionIdMissing) {
      // Legacy/malformed record with no session id: unrecoverable by probing.
      // Settle conservatively instead of pending forever.
      return {
        transition: "failed",
        terminalReason: MISSING_SESSION_ID_REASON,
        lastError: MISSING_SESSION_ID_MESSAGE,
        clearUncertain: true,
      };
    }
    if (!state.reachable || state.error) {
      return { transition: null, error: state.error };
    }
    if (state.sessionExists === false) {
      // Confirmed absent: never "done" — orphaned, after the observation
      // grace, so a create still in flight can never be falsely orphaned.
      return this.#uncertainOrTerminal(record, "session-missing", {
        transition: "orphaned",
        terminalReason: "session-missing",
        lastError: "DSH session not found; confirmed absent via session.history",
      });
    }
    if (state.running === true) {
      // A running turn is non-terminal and resolves any absence observation.
      // Never downgrade "cancelling".
      if (record.status === "cancelling") {
        return { transition: null, clearUncertain: true };
      }
      if (record.status === "creating" || record.status === "submitting") {
        return { transition: "running", clearUncertain: true };
      }
      return { transition: null, clearUncertain: true };
    }
    // Idle, session exists.
    if (record.status === "creating" && !state.hasTurn) {
      return this.#uncertainOrTerminal(record, "prompt-lost", {
        transition: "failed",
        terminalReason: "prompt-lost",
        lastError: "session was created but the prompt was never delivered; prompt text is not persisted — resubmit a new task",
      });
    }
    if (record.status === "submitting" && !state.hasTurn) {
      return this.#uncertainOrTerminal(record, "prompt-ambiguous", {
        transition: "failed",
        terminalReason: "prompt-ambiguous",
        lastError: "session.prompt delivery could not be confirmed and no turn ever started; refusing to double-send",
      });
    }
    const classification = classifyIdle({
      text,
      events: state.events,
      cancelling: record.status === "cancelling",
    });
    if (UNCERTAIN_REASONS.has(classification.terminalReason)) {
      // no-turn / interrupted / cancel-settled: absence-style, observe first.
      return this.#uncertainOrTerminal(record, classification.terminalReason, {
        transition: classification.status,
        terminalReason: classification.terminalReason,
        text,
      });
    }
    return {
      transition: classification.status,
      terminalReason: classification.terminalReason,
      text,
      clearUncertain: true,
    };
  }

  /**
   * Absence verdict helper: never terminal on first observation; same-reason
   * continuous observation past the grace window becomes terminal. With
   * `classificationGraceMs <= 0` the verdict applies immediately (test
   * convenience — production uses CLASSIFICATION_GRACE_MS).
   */
  #uncertainOrTerminal(record, reason, terminal) {
    if (this.classificationGraceMs <= 0) {
      return { ...terminal, clearUncertain: true };
    }
    const since = record.uncertainSince;
    if (since === null || record.uncertainReason !== reason) {
      // First observation of this verdict (or the verdict changed): start the clock.
      return { transition: null, uncertain: { reason, since: this.now() } };
    }
    if (this.now() - since >= this.classificationGraceMs) {
      return { ...terminal, clearUncertain: true };
    }
    return { transition: null, uncertain: { reason, since } };
  }

  /**
   * Persist a decided observation. Handles status transitions (which always
   * clear the uncertainty clock), uncertainty bookkeeping (start/keep the
   * observation clock), and clock clearing on resolved observations.
   * Illegal transitions throw TaskStateError.
   */
  async #applyDecision(record, decision) {
    if (decision.transition) {
      const to = decision.transition;
      if (to === record.status) {
        return { record, changed: false };
      }
      if (!canTransition(record.status, to)) {
        throw new TaskStateError(record.status, to);
      }
      const patch = { status: to, uncertainSince: null, uncertainReason: null };
      if (decision.terminalReason) {
        patch.terminalReason = decision.terminalReason;
      }
      if (decision.lastError) {
        patch.lastError = decision.lastError;
      }
      if (decision.text) {
        patch.resultText = decision.text;
      }
      const next = await this.store.update(record.id, patch);
      return { record: next, changed: true };
    }
    if (decision.uncertain) {
      if (
        record.uncertainSince === decision.uncertain.since &&
        record.uncertainReason === decision.uncertain.reason
      ) {
        return { record, changed: false }; // clock already running for this verdict
      }
      const next = await this.store.update(record.id, {
        uncertainSince: decision.uncertain.since,
        uncertainReason: decision.uncertain.reason,
      });
      return { record: next, changed: false };
    }
    if (decision.clearUncertain && (record.uncertainSince !== null || record.uncertainReason !== null)) {
      const next = await this.store.update(record.id, {
        uncertainSince: null,
        uncertainReason: null,
      });
      return { record: next, changed: false };
    }
    return { record, changed: false };
  }

  /** Poll DSH state and fold a terminal decision into the task record. */
  async #refresh(record) {
    const current = this.store.get(record.id) ?? record;
    if (isTerminal(current.status)) {
      return { state: current.status, record: current, text: current.resultText ?? null };
    }
    const state = await this.#readDshState(current);
    if (!state.sessionIdMissing && (!state.reachable || state.error)) {
      // Transient read failure: never terminal; keep polling.
      return { state: current.status, record: current, text: state.text ?? current.resultText ?? null };
    }
    const decision = this.#decide(current, state);
    let next = current;
    if (decision.transition || decision.uncertain || decision.clearUncertain) {
      const applied = await this.#applyDecision(current, decision);
      next = applied.record;
    }
    return { state: next.status, record: next, text: state.text ?? next.resultText ?? null };
  }

  async #waitForIdle(record, waitSeconds) {
    const deadline = this.now() + waitSeconds * 1000;
    let outcome = "timed-out";
    let current = record;
    for (;;) {
      await this.sleep(this.pollIntervalMs);
      const refreshed = await this.#refresh(current);
      current = refreshed.record;
      if (isTerminal(refreshed.state)) {
        outcome = "completed";
        break;
      }
      if (this.now() >= deadline) {
        break;
      }
    }
    return outcome;
  }

  async #reconcilePendingInner() {
    const pending = this.store.list().filter((record) => !isTerminal(record.status));
    if (pending.length === 0) {
      this.log?.info?.("hana-dsh-adapter reconcile: no pending tasks");
      return { scanned: 0 };
    }
    const probe = await this.rpc.health().catch((error) => ({ ok: false, error }));
    if (probe.ok !== true) {
      this.log?.warn?.(
        `hana-dsh-adapter reconcile: DSH unreachable (${probe?.error ?? "probe failed"}); leaving ${pending.length} task(s) pending`,
      );
      return { scanned: 0, skipped: pending.length, reason: "dsh-unreachable" };
    }
    let scanned = 0;
    let changed = 0;
    for (const record of pending) {
      try {
        const outcome = await this.#reconcileOne(record);
        scanned++;
        if (outcome.changed) {
          changed++;
          this.log?.info?.(
            `hana-dsh-adapter reconcile: task ${record.id} -> ${outcome.status}${outcome.terminalReason ? ` (${outcome.terminalReason})` : ""}`,
          );
        }
      } catch (error) {
        this.log?.warn?.(
          `hana-dsh-adapter reconcile: task ${record.id} failed-soft: ${error?.message || error}`,
        );
      }
    }
    this.log?.info?.(`hana-dsh-adapter reconcile: scanned ${scanned} pending task(s), ${changed} changed`);
    return { scanned, changed };
  }

  async #reconcileOne(record) {
    const state = await this.#readDshState(record);
    if (state.error) {
      // Fail-soft: record the transient read failure once, keep the task pending.
      const message = describeRpcError(state.error);
      if (message !== record.lastError) {
        await this.store.update(record.id, { lastError: message }).catch(() => {});
      }
      return { changed: false };
    }
    const decision = this.#decide(record, state);
    if (!decision.transition && !decision.uncertain && !decision.clearUncertain) {
      return { changed: false };
    }
    const applied = await this.#applyDecision(record, decision);
    return { changed: applied.changed, status: applied.record.status, terminalReason: applied.record.terminalReason };
  }

  async #validateCwd(cwd) {
    if (typeof cwd !== "string" || !cwd.trim()) {
      throw new DshAdapterError("invalid-cwd", "cwd is required", { status: 400 });
    }
    let canonical;
    try {
      canonical = this.policy.checkAllowed(cwd);
    } catch (error) {
      if (error instanceof WorkspacePolicyError) {
        throw new DshAdapterError(error.code, error.message, { status: 422, cause: error });
      }
      throw error;
    }
    let stat;
    try {
      stat = await fs.stat(canonical);
    } catch (error) {
      throw new DshAdapterError("invalid-cwd", `cwd does not exist: ${canonical}`, {
        status: 422,
        cause: error,
      });
    }
    if (!stat.isDirectory()) {
      throw new DshAdapterError("invalid-cwd", `cwd is not a directory: ${canonical}`, {
        status: 422,
      });
    }
    // Symlink/junction escape defense: resolve the real path and re-check containment.
    try {
      const real = await fs.realpath(canonical);
      if (real !== canonical) {
        this.policy.checkAllowed(real);
        return real;
      }
    } catch {
      // realpath unavailable — the string-level containment check stands.
    }
    return canonical;
  }

  #dshError(phase, error) {
    if (error instanceof DshAdapterError) {
      return error;
    }
    if (error instanceof DshRpcError) {
      const status =
        error.code === "session-not-found" || error.code === "agent-busy"
          ? 409
          : error.code === "transport" || error.code === "bad-response"
            ? 502
            : 502;
      return new DshAdapterError("dsh-error", `DSH ${phase}: ${error.message}`, {
        status,
        cause: error,
      });
    }
    if (error instanceof TaskStoreError) {
      return new DshAdapterError(error.code, error.message, { status: 404, cause: error });
    }
    return new DshAdapterError("internal", error?.message || String(error), {
      status: 500,
      cause: error,
    });
  }
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function validatePrompt(prompt) {
  if (typeof prompt !== "string") {
    throw new DshAdapterError("invalid-prompt", "prompt must be a string", { status: 400 });
  }
  const text = prompt.trim();
  if (text.length === 0) {
    throw new DshAdapterError("invalid-prompt", "prompt must not be empty", { status: 400 });
  }
  if (text.length > MAX_PROMPT_CHARS) {
    throw new DshAdapterError(
      "invalid-prompt",
      `prompt exceeds ${MAX_PROMPT_CHARS} characters`,
      { status: 400 },
    );
  }
  if (text.startsWith("/")) {
    // DSH interprets a single text block whose first character is "/" as a
    // slash command. This adapter is a task bridge, not a command channel:
    // slash inputs are rejected explicitly instead of being silently executed.
    throw new DshAdapterError(
      "invalid-prompt",
      "prompt must not start with '/' — DSH slash commands are not supported by the adapter",
      { status: 400 },
    );
  }
  return text;
}

export function validateAgentPreset(agentPreset) {
  const value =
    agentPreset === undefined || agentPreset === null || agentPreset === ""
      ? DEFAULT_AGENT_PRESET
      : String(agentPreset).trim();
  if (!AGENT_PRESET_PATTERN.test(value)) {
    throw new DshAdapterError("invalid-preset", `invalid agentPreset "${value}"`, {
      status: 400,
    });
  }
  return value;
}

export function validateWaitSeconds(waitSeconds) {
  if (waitSeconds === undefined || waitSeconds === null) {
    return 0;
  }
  const n = Number(waitSeconds);
  if (!Number.isInteger(n) || n < 0 || n > MAX_WAIT_SECONDS) {
    throw new DshAdapterError(
      "invalid-wait",
      `waitSeconds must be an integer between 0 and ${MAX_WAIT_SECONDS}`,
      { status: 400 },
    );
  }
  return n;
}

export function summarizePrompt(text, max = 120) {
  return summarizeText(text, max);
}

/**
 * Short single-line text for overview summaries: collapses ALL consecutive
 * whitespace/control characters into a single space, trims, and truncates by
 * code points (keeps CJK intact). Null-safe.
 * Hard guarantee: the result's length never exceeds `max` — when truncating,
 * max-1 characters plus the trailing "…" are returned (max<=1 handled).
 */
export function summarizeText(text, max = OVERVIEW_TEXT_MAX) {
  if (text === null || text === undefined) {
    return null;
  }
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  const chars = [...cleaned];
  if (chars.length <= limit) {
    return cleaned;
  }
  if (limit <= 1) {
    return limit === 1 ? "…" : "";
  }
  return `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * Redact an error for the overview payload: keep only a short code and a
 * truncated, control-character-free message. Never propagates stacks, full
 * payloads or raw DSH details. Accepts an Error-like object or a plain string
 * (the format inspect() stores in task.dsh.error, e.g. "transport: ECONNREFUSED").
 */
export function redactError(error) {
  if (typeof error === "string") {
    const colon = error.indexOf(": ");
    const code = colon > 0 ? error.slice(0, colon) : "dsh-read-failed";
    return {
      code,
      message: summarizeText(colon > 0 ? error.slice(colon + 2) : error, OVERVIEW_TEXT_MAX),
    };
  }
  const code =
    typeof error?.code === "string" && error.code ? error.code : "dsh-read-failed";
  const raw = typeof error?.message === "string" ? error.message : String(error ?? "unknown error");
  return { code, message: summarizeText(raw, OVERVIEW_TEXT_MAX) };
}

/**
 * Extract the final assistant text conservatively from durable history events.
 * Handles content as an array of blocks (DSH contract) or a plain string.
 * Never returns tool arguments.
 */
export function extractFinalAssistantText(events) {
  let result = null;
  for (const entry of events ?? []) {
    const event = entry?.event ?? entry;
    if (!event || event.type !== "assistant/message") {
      continue;
    }
    const message = event.data?.message;
    const text = contentToText(message?.content);
    if (text) {
      result = { text, seq: event.seq ?? null, time: event.time ?? null };
    }
  }
  return result;
}

/**
 * Raw relevant event summary — only when explicitly requested. Leak boundary
 * (M4): assistant/message TEXT and tool NAME are the only payload-bearing
 * fields ever included. user/message text (which would carry the original
 * prompt and any credentials typed by the user), tool arguments, full `data`
 * payloads, error details and stacks are NEVER included — not even with
 * includeRaw enabled.
 */
export function sanitizeEventSummary(events, { maxTextChars = 2000 } = {}) {
  const out = [];
  for (const entry of events ?? []) {
    const event = entry?.event ?? entry;
    if (!event || typeof event.type !== "string") {
      continue;
    }
    const row = { seq: event.seq ?? null, type: event.type, time: event.time ?? null };
    const data = event.data ?? {};
    if (event.type === "assistant/message") {
      const text = contentToText(data.message?.content);
      if (text) {
        row.text = text.slice(0, maxTextChars);
      }
    } else if (event.type === "tool/call") {
      if (typeof data.name === "string") {
        row.toolName = data.name;
      }
      // data.arguments / data.input deliberately omitted.
    }
    // Every other event type — including user/message — carries no text:
    // prompts and credentials must never appear in the summary.
    out.push(row);
  }
  return out;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function asRpcError(error) {
  return error instanceof DshRpcError
    ? error
    : new DshRpcError("internal", String(error?.message || error));
}

function describeRpcError(error) {
  if (error instanceof DshRpcError) {
    return `${error.code}: ${error.message}`;
  }
  return String(error?.message || error);
}

function attachTaskId(error, taskId) {
  error.taskId = taskId;
  error.message = `${error.message} (task ${taskId})`;
  return error;
}
