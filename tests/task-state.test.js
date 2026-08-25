// task-state: the centralized adapter task state machine — status vocabulary,
// terminal/non-terminal sets, transition legality, legacy compatibility, and
// the idle-session terminal classifier.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  isTerminal,
  isNonTerminal,
  normalizeStatus,
  canTransition,
  assertTransition,
  TaskStateError,
  classifyIdle,
  unwrapHistoryEvents,
  hasTurnEvidence,
  lastTurnEnd,
} from "../lib/task-state.js";

const ev = (type, data = {}, seq = 0) => ({ event: { seq, type, time: 1, data } });

test("status vocabulary and terminal/non-terminal sets", () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), [
    "cancelled",
    "done",
    "failed",
    "no-final-output",
    "orphaned",
  ]);
  assert.deepEqual([...NON_TERMINAL_STATUSES].sort(), [
    "cancelling",
    "creating",
    "running",
    "submitting",
  ]);
  assert.equal(TASK_STATUSES.length, 9);
  for (const status of TASK_STATUSES) {
    assert.equal(isTerminal(status), TERMINAL_STATUSES.has(status));
    assert.equal(isNonTerminal(status), !TERMINAL_STATUSES.has(status));
  }
  // Legacy statuses are first-class members, so old tasks.json records work.
  for (const legacy of ["running", "done", "cancelled", "failed"]) {
    assert.ok(TASK_STATUSES.includes(legacy), `${legacy} must stay a valid status`);
  }
});

test("normalizeStatus keeps known statuses and maps unknown to running", () => {
  for (const status of TASK_STATUSES) {
    assert.equal(normalizeStatus(status), status);
  }
  assert.equal(normalizeStatus(undefined), "running");
  assert.equal(normalizeStatus("whatever"), "running");
  assert.equal(normalizeStatus(""), "running");
});

test("canTransition: identity is always allowed", () => {
  for (const status of TASK_STATUSES) {
    assert.equal(canTransition(status, status), true, `${status} -> ${status}`);
  }
});

test("canTransition: terminal states are sticky (no outgoing moves)", () => {
  for (const terminal of ["done", "failed", "cancelled", "orphaned", "no-final-output"]) {
    for (const to of TASK_STATUSES) {
      if (to === terminal) continue;
      assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to}`);
    }
  }
});

test("canTransition: non-terminal edges", () => {
  assert.equal(canTransition("creating", "submitting"), true);
  assert.equal(canTransition("creating", "running"), true);
  assert.equal(canTransition("creating", "cancelling"), true);
  assert.equal(canTransition("submitting", "running"), true);
  assert.equal(canTransition("submitting", "cancelling"), true);
  assert.equal(canTransition("running", "cancelling"), true);
  assert.equal(canTransition("running", "submitting"), false);
  assert.equal(canTransition("submitting", "creating"), false);
  // cancelling -> previous non-terminal statuses: the explicit cancel-rollback
  // edge (service-only, when the session.cancel RPC fails).
  assert.equal(canTransition("cancelling", "running"), true);
  assert.equal(canTransition("cancelling", "submitting"), true);
  assert.equal(canTransition("cancelling", "creating"), true);
});

test("canTransition: any non-terminal -> terminal is allowed (classifier authority)", () => {
  for (const from of ["creating", "submitting", "running", "cancelling"]) {
    for (const to of ["done", "failed", "cancelled", "orphaned", "no-final-output"]) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
    }
  }
});

test("assertTransition throws TaskStateError on illegal moves", () => {
  assert.equal(assertTransition("running", "done"), "done");
  assert.equal(assertTransition("creating", "submitting"), "submitting");
  assert.equal(assertTransition("cancelling", "running"), "running");
  assert.throws(() => assertTransition("done", "running"), TaskStateError);
  assert.throws(() => assertTransition("done", "failed"), (e) => e.code === "invalid-transition");
  assert.throws(() => assertTransition("running", "submitting"), TaskStateError);
});

// ── classifyIdle ────────────────────────────────────────────────────────────

test("classifyIdle: completed turn + assistant text -> done", () => {
  const events = [
    ev("user/message", { message: { role: "user", content: [{ type: "text", text: "p" }] } }, 1),
    ev("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }, 2),
    ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 3),
  ];
  assert.deepEqual(classifyIdle({ text: "answer", events }), {
    status: "done",
    terminalReason: "completed",
  });
});

test("classifyIdle: completed turn without text -> no-final-output (never fake success)", () => {
  const events = [ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 1)];
  assert.deepEqual(classifyIdle({ text: null, events }), {
    status: "no-final-output",
    terminalReason: "completed",
  });
});

test("classifyIdle: explicit error turn -> failed", () => {
  const events = [
    ev("turn/end", { turn: 1, reason: { kind: "error", error: { code: "UPSTREAM", message: "boom" } } }, 1),
  ];
  assert.deepEqual(classifyIdle({ text: null, events }), {
    status: "failed",
    terminalReason: "error",
  });
});

test("classifyIdle: aborted turn -> cancelled (including legacy cancel cause)", () => {
  const events = [
    ev("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }, 1),
  ];
  assert.deepEqual(classifyIdle({ text: null, events }), {
    status: "cancelled",
    terminalReason: "aborted",
  });
  const legacy = [ev("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "legacy" } } }, 1)];
  assert.deepEqual(classifyIdle({ text: null, events: legacy }), {
    status: "cancelled",
    terminalReason: "aborted",
  });
});

test("classifyIdle: other explicit non-success reasons -> failed", () => {
  for (const kind of ["max-tokens", "interrupted", "blocked"]) {
    const events = [ev("turn/end", { turn: 1, reason: { kind } }, 1)];
    assert.deepEqual(classifyIdle({ text: null, events }), {
      status: "failed",
      terminalReason: kind,
    }, `reason kind ${kind}`);
  }
});

test("classifyIdle: unknown reason kind never reports success", () => {
  const events = [ev("turn/end", { turn: 1, reason: { kind: "plugin-extra" } }, 1)];
  assert.deepEqual(classifyIdle({ text: "answer", events }), {
    status: "failed",
    terminalReason: "unknown-turn-end:plugin-extra",
  });
  const missing = [ev("turn/end", { turn: 1 }, 1)];
  assert.deepEqual(classifyIdle({ text: "answer", events: missing }), {
    status: "failed",
    terminalReason: "unknown-turn-end:missing",
  });
});

test("classifyIdle: torn logs and empty sessions are conservative failures", () => {
  // assistant text without a closing turn/end
  const torn = [ev("assistant/message", { message: { role: "assistant", content: "partial" } }, 1)];
  assert.deepEqual(classifyIdle({ text: "partial", events: torn }), {
    status: "failed",
    terminalReason: "interrupted",
  });
  // started turn without an end
  const open = [ev("turn/start", { turn: 1 }, 1)];
  assert.deepEqual(classifyIdle({ text: null, events: open }), {
    status: "failed",
    terminalReason: "interrupted",
  });
  // nothing at all
  assert.deepEqual(classifyIdle({ text: null, events: [] }), {
    status: "failed",
    terminalReason: "no-turn",
  });
  // cancel requested, no turn ever ran -> cancelled (settled)
  assert.deepEqual(classifyIdle({ text: null, events: [], cancelling: true }), {
    status: "cancelled",
    terminalReason: "cancel-settled",
  });
});

test("classifyIdle parses wrapped and bare event entries (backward compatible)", () => {
  const wrapped = [
    { event: { seq: 1, type: "turn/end", time: 1, data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } } },
  ];
  const bare = [
    { seq: 1, type: "turn/end", time: 1, data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } },
  ];
  assert.equal(classifyIdle({ text: null, events: wrapped }).status, "cancelled");
  assert.equal(classifyIdle({ text: null, events: bare }).status, "cancelled");
  // garbage entries are ignored, not fatal
  assert.deepEqual(classifyIdle({ text: null, events: [null, "x", {}] }), {
    status: "failed",
    terminalReason: "no-turn",
  });
});

test("history helpers: unwrap / turn evidence / last turn/end", () => {
  const entries = [
    { event: { seq: 1, type: "turn/start", time: 1, data: {} } },
    { seq: 2, type: "tool/call", time: 1, data: {} },
    { event: { seq: 3, type: "turn/end", time: 1, data: { turn: 1, reason: { kind: "completed" } } } },
    { event: { seq: 4, type: "todo/write", time: 1, data: { todos: [] } } },
    null,
  ];
  const events = unwrapHistoryEvents(entries);
  assert.equal(events.length, 4);
  assert.equal(events[0].type, "turn/start");
  assert.equal(hasTurnEvidence(events), true);
  assert.equal(lastTurnEnd(events).seq, 3);
  assert.equal(hasTurnEvidence([{ seq: 1, type: "tool/call", time: 1, data: {} }]), false);
  assert.equal(hasTurnEvidence([]), false);
  assert.equal(lastTurnEnd([]), null);
});
