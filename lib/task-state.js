// hana-dsh-adapter: adapter task state machine — the single source of truth
// for task statuses, allowed transitions and terminal classification.
//
// Statuses:
//   creating     (non-terminal) local record persisted, session.create not yet confirmed
//   submitting   (non-terminal) session.create confirmed, session.prompt in flight
//   running      (non-terminal) prompt accepted, DSH session active (or awaiting pickup)
//   cancelling   (non-terminal) session.cancel accepted, termination pending observation
//   done         (terminal) idle + completed turn + deliverable assistant text
//   failed       (terminal) explicit turn error / torn log / chain failure / unknown reason
//   cancelled    (terminal) turn aborted or cancel settled with no turn
//   orphaned     (terminal) DSH session confirmed absent
//   no-final-output (terminal) idle + completed turn but no assistant text
//
// Legacy statuses running / done / cancelled / failed are first-class members,
// so pre-existing tasks.json records keep working unchanged.

export const TASK_STATUSES = Object.freeze([
  "creating",
  "submitting",
  "running",
  "cancelling",
  "done",
  "failed",
  "cancelled",
  "orphaned",
  "no-final-output",
]);

export const TERMINAL_STATUSES = Object.freeze(
  new Set(["done", "failed", "cancelled", "orphaned", "no-final-output"]),
);

export const NON_TERMINAL_STATUSES = Object.freeze(
  new Set(TASK_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status))),
);

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

export function isNonTerminal(status) {
  return !isTerminal(status);
}

/** Unknown/legacy statuses normalize to "running" so reconciliation can judge them. */
export function normalizeStatus(status) {
  return TASK_STATUSES.includes(status) ? status : "running";
}

// Allowed non-terminal → non-terminal edges. Any non-terminal → terminal
// transition is allowed (the classifier is authoritative); terminal states
// are sticky — only identity is permitted out of them.
//
// cancelling → creating|submitting|running is the explicit CANCEL-ROLLBACK
// edge: DshAdapterService persists "cancelling" BEFORE the session.cancel RPC
// (so a concurrent observation can never finalize the task as failed in the
// RPC window) and rolls back to the previous non-terminal status when the RPC
// fails. No other code path may use these edges — an observation on a
// cancelling task only returns null or a terminal verdict.
const NON_TERMINAL_EDGES = Object.freeze({
  creating: ["submitting", "running", "cancelling"],
  submitting: ["running", "cancelling"],
  running: ["cancelling"],
  cancelling: ["creating", "submitting", "running"],
});

export function canTransition(from, to) {
  if (from === to) return true;
  if (isTerminal(from)) return false;
  if (isTerminal(to)) return true;
  return (NON_TERMINAL_EDGES[from] ?? []).includes(to);
}

export class TaskStateError extends Error {
  constructor(from, to) {
    super(`illegal task state transition ${from} -> ${to}`);
    this.name = "TaskStateError";
    this.code = "invalid-transition";
  }
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new TaskStateError(from, to);
  }
  return to;
}

// ── Durable-history helpers (robust against { event } wrappers) ────────────

/** Unwrap `history.events` entries ({ event, view? }) into plain events. */
export function unwrapHistoryEvents(entries) {
  const out = [];
  for (const entry of entries ?? []) {
    const event = entry?.event ?? entry;
    if (event && typeof event === "object" && typeof event.type === "string") {
      out.push(event);
    }
  }
  return out;
}

/** True when any turn/prompt evidence exists in the log (turn/start, user or assistant message). */
export function hasTurnEvidence(events) {
  for (const event of events ?? []) {
    if (
      event.type === "turn/start" ||
      event.type === "user/message" ||
      event.type === "assistant/message"
    ) {
      return true;
    }
  }
  return false;
}

/** The LAST turn/end event, or null when the log has none. */
export function lastTurnEnd(events) {
  let found = null;
  for (const event of events ?? []) {
    if (event.type === "turn/end") {
      found = event;
    }
  }
  return found;
}

/**
 * Classify an IDLE (running=false) session from its durable history.
 *
 * Rules:
 * - Success requires a completed turn AND deliverable assistant text.
 * - Explicit turn/end reasons: completed→done|no-final-output, aborted→cancelled,
 *   error→failed, other known non-success kinds (max-tokens/interrupted/blocked)
 *   and unknown kinds → failed (never a false success).
 * - No turn/end but text or a started turn (torn log) → failed.
 * - No turn evidence at all: cancelled only when a cancel was requested and
 *   settled; otherwise failed.
 *
 * Returns `{ status, terminalReason }`.
 */
export function classifyIdle({ text, events, cancelling = false }) {
  const unwrapped = unwrapHistoryEvents(events);
  const turnEnd = lastTurnEnd(unwrapped);
  if (turnEnd) {
    const kind = turnEnd.data?.reason?.kind;
    switch (kind) {
      case "completed":
        return text
          ? { status: "done", terminalReason: "completed" }
          : { status: "no-final-output", terminalReason: "completed" };
      case "aborted":
        return { status: "cancelled", terminalReason: "aborted" };
      case "error":
        return { status: "failed", terminalReason: "error" };
      case "blocked":
      case "max-tokens":
      case "interrupted":
        return { status: "failed", terminalReason: kind };
      default:
        // An unrecognized reason kind (newer harness / plugin extension) must
        // never be reported as success.
        return {
          status: "failed",
          terminalReason: `unknown-turn-end:${kind ?? "missing"}`,
        };
    }
  }
  if (text || hasTurnEvidence(unwrapped)) {
    // Assistant output or a started turn without a closing turn/end: torn log.
    return { status: "failed", terminalReason: "interrupted" };
  }
  if (cancelling) {
    // Cancel accepted and the session settled with no turn ever running.
    return { status: "cancelled", terminalReason: "cancel-settled" };
  }
  return { status: "failed", terminalReason: "no-turn" };
}
