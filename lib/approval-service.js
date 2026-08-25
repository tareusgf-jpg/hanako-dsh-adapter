// hana-dsh-adapter: DSH approval loop service (Phase 1).
//
// Owns the approval lifecycle between DSH and the user:
//   1. events.mux frames (via ApprovalMuxListener) → persist pending records
//      in ApprovalStore (persist FIRST, push AFTER — a failed push never
//      affects the record), push a redacted summary via bus 'session:send'
//      and best-effort 'task:update' (blocked) for host task-board visibility.
//   2. respondApproval() — the ONLY code path that ever answers DSH: it
//      validates the record (exists / pending / outcome whitelist) and sends
//      the client-response envelope through DshRpcClient.respondApproval().
//      Auto-approval is structurally impossible: nothing in this service or
//      the listener ever calls respondApproval on its own — only the plugin's
//      narrow API route does (verified by a source-scan test).
//   3. approval/resolved frames and respond receipts resolve the record and
//      push user-visible feedback ("已批准一次" / "已拒绝" / …).
//
// Security boundaries (hana-notify-spec §4):
//   - outcome whitelist is exactly { 'allowed-once', 'rejected' }; 'never' or
//     any persistent elevation is never constructed anywhere.
//   - reason is REDACTED to reasonSummary (token/secret patterns stripped,
//     whitespace collapsed, bounded length) before it is persisted or pushed.
//   - only approvals for sessions the adapter itself manages (TaskStore) are
//     recorded; everything else is ignored with a log line.
//   - bus pushes are fail-soft: session:send / task:update failures only log.
//   - timeout (config.dshApprovalTimeoutMs > 0) ABANDONS an unanswered
//     approval locally (record timed-out + chat feedback) and never answers
//     DSH — DSH keeps the ask pending. 0 (default) = wait forever.
import { ApprovalMuxListener } from "./approval-mux-listener.js";
import { unwrapHistoryEvents } from "./task-state.js";
import { summarizeText } from "./dsh-adapter-service.js";

/** Respond outcomes allowed on the wire — the DSH approval contract. */
export const APPROVAL_OUTCOMES = Object.freeze(["allowed-once", "rejected"]);
/**
 * Resolved-record vocabulary: the four DSH outcomes plus the two LOCAL-only
 * labels (never sent anywhere): 'superseded' (DSH no longer had the ask when
 * we answered) and 'timed-out' (operator-configured abandonment; DSH was
 * never answered). Unknown frame outcomes normalize to 'unavailable'
 * (fail-closed label).
 */
export const RESOLVED_OUTCOMES = Object.freeze([
  "allowed-once",
  "rejected",
  "cancelled",
  "unavailable",
  "superseded",
  "timed-out",
]);

export const APPROVAL_REASON_MAX = 160;
export const DEFAULT_HISTORY_MAX_MESSAGES = 50;
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export class ApprovalError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ApprovalError";
    this.code = code;
    this.status = status;
  }
}

/** Token/secret-looking patterns stripped from approval reasons before any persist/push. */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Za-z0-9_-]{40,}/g,
  /\b(api[_-]?key|secret|token|password|passwd|authorization)\b\s*[=:]\s*[^\s,;]+/gi,
];

/**
 * Redact a DSH approval reason: strip token/secret patterns, collapse
 * whitespace and truncate by code points (CJK-safe). Returns null for
 * missing values. NEVER keeps raw credentials — the output is the only form
 * that reaches the store, the chat push and the page.
 */
export function redactReason(reason, max = APPROVAL_REASON_MAX) {
  if (typeof reason !== "string") {
    return null;
  }
  let cleaned = reason;
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, "***");
  }
  return summarizeText(cleaned, max);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Chat message pushed when a new approval is discovered (redacted inputs only). */
export function requestedMessage(record) {
  const who = record.taskId ?? record.sessionId ?? "unknown";
  const reason = record.reasonSummary ? ` ${record.reasonSummary}` : "（无理由说明）";
  return `[DSH 审批] 任务 ${who} 请求提权：${record.toolName}${reason} —— 请在 DSH 监听页批准或拒绝`;
}

/** Chat feedback pushed when an approval settles (any outcome). */
export function resolvedMessage(record, outcome, { timeoutMs = null } = {}) {
  const who = record.taskId ?? record.sessionId ?? "unknown";
  const tool = record.toolName ?? "未知工具";
  switch (outcome) {
    case "allowed-once":
      return `[DSH 审批] 任务 ${who} 的审批已批准一次（${tool}）`;
    case "rejected":
      return `[DSH 审批] 任务 ${who} 的审批已拒绝（${tool}）`;
    case "cancelled":
      return `[DSH 审批] 任务 ${who} 的审批已取消（会话中止）（${tool}）`;
    case "unavailable":
      return `[DSH 审批] 任务 ${who} 的审批已失效（unavailable）（${tool}）`;
    case "superseded":
      return `[DSH 审批] 任务 ${who} 的审批已失效（DSH 侧不再挂起）（${tool}）`;
    case "timed-out":
      return `[DSH 审批] 任务 ${who} 的审批等待超时（${timeoutMs ?? "?"} 毫秒），未自动应答；DSH 侧仍挂起，可到 DSH Web 界面自行处理（${tool}）`;
    default:
      return `[DSH 审批] 任务 ${who} 的审批已结束（${outcome}）（${tool}）`;
  }
}

function toView(record) {
  return {
    approvalId: record.approvalId,
    taskId: record.taskId,
    toolName: record.toolName,
    reasonSummary: record.reasonSummary,
    requestedAt: record.requestedAt,
  };
}

export class ApprovalService {
  /**
   * @param {object} opts
   * @param {ApprovalStore} opts.store
   * @param {import("./task-store.js").TaskStore} opts.taskStore  ownership check (session → task)
   * @param {import("./dsh-rpc-client.js").DshRpcClient} opts.rpc  for respondApproval + history re-pull
   * @param {object} opts.config  { url, approvalNotify, approvalTimeoutMs }
   * @param {object} [opts.bus]  Hana ctx.bus (session:send / task:update)
   * @param {Function} [opts.busRequest]  (name, payload) => Promise — injectable (tests)
   * @param {object} [opts.log]
   * @param {Function} [opts.now]  injectable clock
   * @param {Function} [opts.sleep]  injectable sleep (passed to the listener)
   * @param {number} [opts.historyMaxMessages]  history page size for the reconnect re-pull
   * @param {number} [opts.sweepIntervalMs]  timeout sweep cadence (default 30s)
   * @param {ApprovalMuxListener} [opts.listener]  injectable listener (tests)
   * @param {Function} [opts.transportFactory]  injected into a default listener
   */
  constructor({
    store,
    taskStore,
    rpc,
    config = {},
    bus = null,
    busRequest = null,
    log = null,
    now = null,
    sleep = null,
    historyMaxMessages = DEFAULT_HISTORY_MAX_MESSAGES,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    listener = null,
    transportFactory = null,
  }) {
    this.store = store;
    this.taskStore = taskStore;
    this.rpc = rpc;
    this.bus = bus;
    this.busRequest =
      busRequest ?? ((name, payload) => this.bus?.request?.(name, payload) ?? Promise.resolve());
    this.log = log;
    this.now = now ?? (() => Date.now());
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseUrl = typeof config.url === "string" ? config.url : "http://127.0.0.1:3080";
    // Master switch for chat push of approval events; records and the page
    // keep working regardless.
    this.notify = config.approvalNotify !== false;
    // 0 (default) = wait forever; > 0 abandons overdue pendings locally.
    this.timeoutMs =
      Number.isInteger(config.approvalTimeoutMs) && config.approvalTimeoutMs > 0
        ? config.approvalTimeoutMs
        : 0;
    this.historyMaxMessages = historyMaxMessages;
    this.sweepIntervalMs = sweepIntervalMs;
    this.listener = listener;
    this.transportFactory = transportFactory;
    this.#started = false;
    this.#sweepTimer = null;
  }

  #started = false;
  #sweepTimer = null;

  /** Start the mux listener (and the timeout sweep when configured). Never throws. */
  start() {
    if (this.#started) {
      return this;
    }
    this.#started = true;
    this.listener ??= new ApprovalMuxListener({
      baseUrl: this.baseUrl,
      onFrame: (frame, envelope) => {
        this.#onFrame(frame, envelope).catch((error) => {
          this.log?.error?.(
            `hana-dsh-adapter approval frame handling failed: ${error?.message || error}`,
          );
        });
      },
      onOpen: () => {
        // Reconnect = re-pull (DSH v1 has no `since` cursor): durable history
        // settles approvals decided while we were offline and re-discovers
        // asks we missed. Fail-soft, never unhandled.
        this.reconcileFromHistory().catch((error) => {
          this.log?.error?.(
            `hana-dsh-adapter approval history re-pull failed: ${error?.message || error}`,
          );
        });
      },
      log: this.log,
      sleep: this.sleep,
      transportFactory: this.transportFactory,
    });
    this.listener.start();
    if (this.timeoutMs > 0) {
      this.sweepTimeouts().catch((error) => {
        this.log?.error?.(`hana-dsh-adapter approval timeout sweep failed: ${error?.message || error}`);
      });
      this.#sweepTimer = setInterval(() => {
        this.sweepTimeouts().catch((error) => {
          this.log?.error?.(
            `hana-dsh-adapter approval timeout sweep failed: ${error?.message || error}`,
          );
        });
      }, this.sweepIntervalMs);
      this.#sweepTimer.unref?.();
    }
    return this;
  }

  /** Dispose: stop the listener and the sweep timer. Idempotent. */
  dispose() {
    this.#started = false;
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    if (this.listener) {
      this.listener.stop();
      this.listener = null;
    }
  }

  // ── Frame ingest (listener → store → push, in that order) ────────────────

  async #onFrame(frame, envelope) {
    if (frame.type === "approval/requested") {
      await this.#onFrameRequested(frame, envelope);
    } else if (frame.type === "approval/resolved") {
      await this.#onFrameResolved(frame);
    }
  }

  async #onFrameRequested(frame, envelope) {
    const { sessionId, approvalId, toolName } = frame;
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(approvalId) || !isNonEmptyString(toolName)) {
      this.log?.warn?.("hana-dsh-adapter: dropping malformed approval/requested frame");
      return;
    }
    const taskId = this.#taskIdForSession(sessionId);
    if (!taskId) {
      // Only approvals for sessions this adapter manages are recorded.
      this.log?.info?.(
        `hana-dsh-adapter: ignoring approval ${approvalId} for non-owned session ${sessionId}`,
      );
      return;
    }
    const rpcId = typeof envelope?.rpcId === "string" && envelope.rpcId ? envelope.rpcId : null;
    const reason = typeof frame.reason === "string" ? frame.reason : null;
    await this.#recordRequested({
      approvalId,
      sessionId,
      taskId,
      toolName,
      reason,
      rpcId,
      source: "mux",
    });
  }

  async #onFrameResolved(frame) {
    const { sessionId, approvalId, outcome } = frame;
    if (!isNonEmptyString(approvalId)) {
      this.log?.warn?.("hana-dsh-adapter: dropping malformed approval/resolved frame");
      return;
    }
    const record = this.store.get(approvalId);
    if (!record || record.status !== "pending") {
      return; // unknown or already settled — nothing to do
    }
    if (typeof sessionId === "string" && record.sessionId !== sessionId) {
      this.log?.warn?.(
        `hana-dsh-adapter: approval/resolved sessionId mismatch for ${approvalId}; ignoring`,
      );
      return;
    }
    const normalized = RESOLVED_OUTCOMES.includes(outcome) ? outcome : "unavailable";
    await this.#resolveApproval(record, normalized);
  }

  /**
   * Shared ingest for mux frames and history re-pull: persist FIRST, push
   * AFTER (a failed push never affects the record — fail-soft, logged).
   * Returns the record, or null when the approval was already settled.
   */
  async #recordRequested({ approvalId, sessionId, taskId, toolName, reason, rpcId, source }) {
    const { record, created } = await this.store.upsert({
      approvalId,
      sessionId,
      taskId,
      toolName,
      reasonSummary: redactReason(reason),
      rpcId,
      source,
    });
    if (!record || record.status !== "pending" || !created) {
      // Re-delivered frame for an already-tracked/settled approval (mux
      // replay / stale ask): never resurrect, never re-notify.
      return record;
    }
    await this.#notifyRequested(record);
    return record;
  }

  async #notifyRequested(record) {
    if (this.notify) {
      await this.#busSend(record.sessionId, requestedMessage(record));
    }
    await this.#notifyTaskBlocked(record.taskId);
  }

  /** Best-effort host task-board visibility: mark the mapped task blocked. */
  async #notifyTaskBlocked(taskId) {
    if (!taskId) {
      return;
    }
    try {
      // The host bus 'task:update' capability is optional (hana-notify-spec
      // §2): when the host does not provide it (or rejects), the approval
      // record and the session:send push still carry the notification —
      // skipped and logged, never thrown.
      await this.busRequest("task:update", { taskId, status: "blocked" });
    } catch (error) {
      this.log?.info?.(
        `hana-dsh-adapter task:update(blocked) skipped for task ${taskId}: ${error?.message || error}`,
      );
    }
  }

  /** Fail-soft chat push; a failed send only logs. */
  async #busSend(sessionId, text) {
    try {
      await this.busRequest("session:send", { sessionId, text });
    } catch (error) {
      this.log?.warn?.(
        `hana-dsh-adapter session:send to ${sessionId} failed (approval record unaffected): ${error?.message || error}`,
      );
    }
  }

  /** Resolve a pending record + push feedback. Returns the record or null. */
  async #resolveApproval(record, outcome, { notify = true } = {}) {
    const resolved = await this.store.resolve(record.approvalId, outcome);
    if (!resolved) {
      return null;
    }
    if (notify && this.notify) {
      await this.#busSend(resolved.sessionId, resolvedMessage(resolved, outcome, { timeoutMs: this.timeoutMs }));
    }
    return resolved;
  }

  // ── Answering (the ONLY path that writes to DSH /api/respond) ────────────

  /**
   * Answer one pending approval. Validates existence / pending state / the
   * outcome whitelist, then sends the client-response envelope through
   * DshRpcClient.respondApproval (rpcId echo + { sessionId, approvalId,
   * outcome }). Auto-approval is structurally impossible: the caller must be
   * a user-triggered path (the plugin page) — nothing in the listener or this
   * service ever calls this method on its own.
   *
   * @param {object} opts
   * @param {string} opts.approvalId
   * @param {'allowed-once'|'rejected'} opts.outcome
   * @param {string} [opts.taskId]  optional ownership cross-check
   * @returns {Promise<{ ok: true, approval: object }>}
   * @throws {ApprovalError}
   */
  async respondApproval({ approvalId, outcome, taskId = null }) {
    if (!isNonEmptyString(approvalId)) {
      throw new ApprovalError("invalid-approval-id", "approvalId is required", { status: 400 });
    }
    const record = this.store.get(approvalId);
    if (!record) {
      throw new ApprovalError("not-found", `approval ${approvalId} not found`, { status: 404 });
    }
    if (record.status !== "pending") {
      throw new ApprovalError(
        "not-pending",
        `approval ${approvalId} is already ${record.status}`,
        { status: 409 },
      );
    }
    if (taskId !== null && taskId !== undefined && taskId !== record.taskId) {
      throw new ApprovalError(
        "task-mismatch",
        `approval ${approvalId} does not belong to task ${taskId}`,
        { status: 409 },
      );
    }
    if (!APPROVAL_OUTCOMES.includes(outcome)) {
      throw new ApprovalError(
        "invalid-outcome",
        `outcome must be one of: ${APPROVAL_OUTCOMES.join(", ")}`,
        { status: 400 },
      );
    }
    if (!record.rpcId) {
      // History-recovered approvals carry no DSH answer token; answering is
      // impossible by construction — surface it instead of guessing.
      throw new ApprovalError(
        "not-answerable",
        "approval has no DSH answer token (re-discovered from session.history); respond in the DSH Web UI",
        { status: 409 },
      );
    }
    let receipt;
    try {
      receipt = await this.rpc.respondApproval({
        rpcId: record.rpcId,
        sessionId: record.sessionId,
        approvalId,
        outcome,
      });
    } catch (error) {
      throw new ApprovalError(
        "dsh-unavailable",
        `DSH respond failed: ${error?.message || String(error)}`,
        { status: 502, cause: error },
      );
    }
    if (receipt.accepted !== true) {
      if (receipt.reason === "not-pending") {
        // DSH already settled it (e.g. the turn was cancelled): fold reality
        // into the record with feedback, then fail the request honestly.
        await this.#resolveApproval(record, "superseded");
        throw new ApprovalError(
          "not-pending",
          `approval ${approvalId} is no longer pending on the DSH side`,
          { status: 409 },
        );
      }
      // bad-response: DSH rejected the envelope; nothing was decided. The
      // record stays pending so the user can retry or ignore.
      throw new ApprovalError(
        "bad-response",
        `DSH rejected the approval response (${receipt.reason ?? "bad-response"})`,
        { status: 502 },
      );
    }
    const resolved = await this.#resolveApproval(record, outcome);
    return { ok: true, approval: toView(resolved ?? record) };
  }

  // ── Presentation ──────────────────────────────────────────────────────────

  /**
   * Redacted pending list for GET /api/approvals. NEVER includes rpcId,
   * sessionId, raw reasons or any credential-shaped data.
   */
  listPending() {
    return this.store.listPending().map(toView);
  }

  // ── Reconnect re-pull (DSH v1: reconnect = re-pull) ──────────────────────

  /**
   * One fail-soft pass over the durable history of every owned session:
   * - `approval/asked` events without a matching `approval/decided` become
   *   pending records (source 'replay') with a chat push — asks missed while
   *   disconnected are surfaced, never silently dropped.
   * - `approval/decided` events resolve matching pending records with
   *   feedback.
   * History records have no rpcId, so they are visible but not answerable
   * through this plugin (the mux-open replay of still-pending asks carries
   * the rpcId and refreshes it via the store's pending upsert).
   * Per-session failures are logged and skipped; the promise never rejects.
   */
  async reconcileFromHistory() {
    const sessions = new Map(); // sessionId → taskId
    for (const record of this.taskStore.list()) {
      if (typeof record.sessionId === "string" && record.sessionId !== "") {
        sessions.set(record.sessionId, record.id);
      }
    }
    let scanned = 0;
    let discovered = 0;
    let settled = 0;
    for (const [sessionId, taskId] of sessions) {
      let history;
      try {
        history = await this.rpc.history({ sessionId, maxMessages: this.historyMaxMessages });
      } catch (error) {
        this.log?.warn?.(
          `hana-dsh-adapter approval re-pull for session ${sessionId} failed-soft: ${error?.message || error}`,
        );
        continue;
      }
      const events = unwrapHistoryEvents(Array.isArray(history?.events) ? history.events : []);
      const decided = new Map();
      for (const event of events) {
        if (event.type === "approval/decided" && typeof event.data?.id === "string") {
          decided.set(event.data.id, event.data.outcome);
        }
      }
      const askedIds = new Set();
      for (const event of events) {
        if (
          event.type === "approval/asked" &&
          typeof event.data?.id === "string" &&
          typeof event.data?.toolName === "string" &&
          !decided.has(event.data.id)
        ) {
          askedIds.add(event.data.id);
          const existing = this.store.get(event.data.id);
          if (existing) {
            continue; // already tracked (mux or earlier re-pull)
          }
          await this.#recordRequested({
            approvalId: event.data.id,
            sessionId,
            taskId,
            toolName: event.data.toolName,
            reason: typeof event.data.reason === "string" ? event.data.reason : null,
            rpcId: null,
            source: "replay",
          });
          discovered++;
        }
      }
      for (const [approvalId, outcome] of decided) {
        const existing = this.store.get(approvalId);
        if (existing && existing.status === "pending") {
          const normalized = RESOLVED_OUTCOMES.includes(outcome) ? outcome : "unavailable";
          await this.#resolveApproval(existing, normalized);
          settled++;
        }
      }
      scanned++;
    }
    this.log?.info?.(
      `hana-dsh-adapter approval re-pull: scanned ${scanned} session(s), discovered ${discovered}, settled ${settled}`,
    );
    return { scanned, discovered, settled };
  }

  // ── Timeout abandonment (opt-in; NEVER answers DSH) ───────────────────────

  /**
   * When dshApprovalTimeoutMs > 0, pendings past the deadline are abandoned:
   * record → resolved('timed-out') with chat feedback. No auto-approval and
   * no auto-rejection — DSH is never answered by this path; its ask stays
   * pending and can be handled in the DSH Web UI. 0 (default) waits forever.
   */
  async sweepTimeouts() {
    if (this.timeoutMs <= 0) {
      return { scanned: 0, resolved: 0 };
    }
    const now = this.now();
    let resolved = 0;
    for (const record of this.store.listPending()) {
      if (now - record.requestedAt >= this.timeoutMs) {
        const settled = await this.#resolveApproval(record, "timed-out");
        if (settled) {
          resolved++;
        }
      }
    }
    return { scanned: this.store.listPending().length + resolved, resolved };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Map a DSH session to its adapter task id, or null when not owned. */
  #taskIdForSession(sessionId) {
    for (const record of this.taskStore.list()) {
      if (record.sessionId === sessionId) {
        return record.id;
      }
    }
    return null;
  }
}
