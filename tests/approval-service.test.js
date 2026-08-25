// approval-service: frame ingest → persist → push, redaction, ownership
// filtering, respondApproval (whitelist / receipts / errors), reconnect
// re-pull, timeout abandonment, fail-soft pushes, no-auto-approval guarantee.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../lib/approval-store.js";
import { TaskStore } from "../lib/task-store.js";
import {
  ApprovalService,
  ApprovalError,
  APPROVAL_OUTCOMES,
  redactReason,
  requestedMessage,
  resolvedMessage,
} from "../lib/approval-service.js";
import { DshRpcError } from "../lib/dsh-rpc-client.js";
import {
  approvalRequestedFrame,
  approvalResolvedFrame,
  createFakeMuxTransport,
} from "./helpers/fake-dsh.js";

const T0 = 1_700_000_000_000;

async function makeHarness(t, { config = {}, seedTask = true, historyEvents = null } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-approval-svc-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  let clock = T0;
  const store = new ApprovalStore({ dataDir, now: () => clock });
  await store.init();
  const taskStore = new TaskStore({ dataDir, now: () => clock });
  await taskStore.init();
  const task = seedTask
    ? await taskStore.create({
        sessionId: "s-1",
        cwd: dataDir,
        agentPreset: "router-standard",
        promptSummary: "p",
        promptLength: 1,
      })
    : null;
  const sends = [];
  const taskUpdates = [];
  const respondCalls = [];
  let respondResult = { accepted: true };
  let respondImpl = null;
  const rpc = {
    async respondApproval(payload) {
      respondCalls.push(payload);
      if (respondImpl) {
        return respondImpl(payload);
      }
      return respondResult;
    },
    async history({ sessionId, maxMessages }) {
      return { events: historyEvents ?? [], hasMore: false };
    },
  };
  const mux = createFakeMuxTransport();
  const service = new ApprovalService({
    store,
    taskStore,
    rpc,
    config: { url: "http://127.0.0.1:3080", ...config },
    busRequest: async (name, payload) => {
      if (name === "session:send") sends.push(payload);
      if (name === "task:update") taskUpdates.push(payload);
    },
    now: () => clock,
    sleep: async () => {},
    transportFactory: mux.transportFactory,
  });
  service.start();
  await mux.controller.whenConnected();
  return {
    service,
    store,
    taskStore,
    task,
    sends,
    taskUpdates,
    respondCalls,
    mux: mux.controller,
    rpc,
    setRespondResult: (result) => {
      respondResult = result;
    },
    setRespondImpl: (fn) => {
      respondImpl = fn;
    },
    setHistoryEvents: (events) => {
      historyEvents = events;
    },
    setClock: (value) => {
      clock = value;
    },
    dataDir,
  };
}

/** Let the service's async frame pipeline (store chain + bus pushes) settle. */
async function settle(h) {
  await h.store.flush();
  await h.taskStore.flush();
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

const REQUESTED = (overrides = {}) =>
  approvalRequestedFrame({ approvalId: "approval-1", toolName: "write_file", ...overrides });
const RESOLVED = (overrides = {}) =>
  approvalResolvedFrame({ approvalId: "approval-1", outcome: "allowed-once", ...overrides });

// ── Ingest: persist → push ──────────────────────────────────────────────────

test("approval/requested frame → pending record + redacted session:send + task:update blocked", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED({ reason: "需要写入 C:\\project\\src\\main.js" }));
  await settle(h);

  const record = h.store.get("approval-1");
  assert.ok(record, "record persisted");
  assert.equal(record.status, "pending");
  assert.equal(record.sessionId, "s-1");
  assert.equal(record.taskId, h.task.id);
  assert.equal(record.toolName, "write_file");
  assert.equal(record.rpcId, "rpc-1", "envelope rpcId kept for the later answer");

  assert.equal(h.sends.length, 1);
  const send = h.sends[0];
  assert.equal(send.sessionId, "s-1");
  assert.ok(send.text.includes("[DSH 审批]"), "message carries the approval marker");
  assert.ok(send.text.includes(h.task.id), "message names the task");
  assert.ok(send.text.includes("write_file"), "message names the tool");
  assert.ok(send.text.includes("需要写入 C:\\project\\src\\main.js"), "redacted reason summary");
  assert.ok(send.text.includes("请在 DSH 监听页批准或拒绝"));

  assert.deepEqual(h.taskUpdates, [{ taskId: h.task.id, status: "blocked" }]);
});

test("reason is redacted (token patterns stripped) before persist and push", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(
    REQUESTED({
      reason: "访问 sk-abc12345678901234567890 与 ghp_abcdefghijklmnopqrstuvwx 与 Bearer eyJhbGciOiJIUzI1NiJ9 的内容",
    }),
  );
  await settle(h);
  const record = h.store.get("approval-1");
  assert.ok(!record.reasonSummary.includes("sk-abc12345678901234567890"));
  assert.ok(!record.reasonSummary.includes("ghp_abcdefghijklmnopqrstuvwx"));
  assert.ok(!record.reasonSummary.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.ok(record.reasonSummary.includes("***"));
  assert.ok(!h.sends[0].text.includes("sk-abc"));
  assert.ok(h.sends[0].text.includes("***"));
});

test("non-owned sessions are ignored: no record, no push, no task update", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED({ sessionId: "someone-elses-session" }));
  await settle(h);
  assert.equal(h.store.list().length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.taskUpdates.length, 0);
});

test("malformed frames are dropped without crashing the pipeline", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame({ type: "approval/requested", sessionId: "s-1", toolName: "" });
  h.mux.injectFrame({ type: "approval/requested" });
  h.mux.injectFrame({ type: "approval/resolved" });
  await settle(h);
  assert.equal(h.store.list().length, 0);
  assert.equal(h.sends.length, 0);
});

test("duplicate requested frames (mux replay) do not re-notify", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED({ reason: "one" }));
  await settle(h);
  h.mux.injectFrame(REQUESTED({ reason: "two" }));
  await settle(h);
  assert.equal(h.store.list().length, 1);
  assert.equal(h.sends.length, 1, "re-delivery never pushes twice");
  assert.equal(h.taskUpdates.length, 1);
});

test("approval/resolved frame → record resolved + feedback; replay never resurrects", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED({ reason: "x" }));
  await settle(h);
  h.mux.injectFrame(RESOLVED({ outcome: "allowed-once" }));
  await settle(h);

  const record = h.store.get("approval-1");
  assert.equal(record.status, "resolved");
  assert.equal(record.outcome, "allowed-once");
  assert.equal(h.sends.length, 2);
  assert.ok(h.sends[1].text.includes("已批准一次"), "feedback names the outcome");
  assert.ok(!h.sends[1].text.includes("请求提权"), "feedback is not a request message");

  // A stale replay of the requested frame must not resurrect the record.
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  assert.equal(h.store.get("approval-1").status, "resolved");
  assert.equal(h.sends.length, 2, "no extra push for the stale replay");
});

test("resolved frame for unknown/settled/mismatched approvals is a no-op", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(RESOLVED({ approvalId: "unknown-approval" }));
  await settle(h);
  assert.equal(h.store.list().length, 0);
  assert.equal(h.sends.length, 0);

  h.mux.injectFrame(REQUESTED());
  await settle(h);
  h.mux.injectFrame(RESOLVED({ sessionId: "different-session" }));
  await settle(h);
  assert.equal(h.store.get("approval-1").status, "pending", "sessionId mismatch ignored");
  assert.equal(h.sends.length, 1);
});

test("rejected / cancelled / unavailable resolved outcomes get distinct feedback", async (t) => {
  for (const [outcome, expected] of [
    ["rejected", "已拒绝"],
    ["cancelled", "已取消"],
    ["unavailable", "已失效"],
  ]) {
    const h = await makeHarness(t);
    h.mux.injectFrame(REQUESTED());
    await settle(h);
    h.mux.injectFrame(RESOLVED({ outcome }));
    await settle(h);
    assert.equal(h.store.get("approval-1").outcome, outcome);
    assert.ok(h.sends[1].text.includes(expected), `${outcome} → ${expected}`);
  }
});

test("unknown resolved outcome normalizes to unavailable (fail-closed label)", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  h.mux.injectFrame(RESOLVED({ outcome: "future-outcome" }));
  await settle(h);
  assert.equal(h.store.get("approval-1").outcome, "unavailable");
});

// ── respondApproval ─────────────────────────────────────────────────────────

test("respondApproval success: exact client-response wire payload, record resolved, feedback", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED({ reason: "x" }));
  await settle(h);

  const result = await h.service.respondApproval({ approvalId: "approval-1", outcome: "allowed-once" });
  assert.equal(result.ok, true);
  assert.equal(result.approval.approvalId, "approval-1");
  assert.equal(result.approval.taskId, h.task.id);

  assert.equal(h.respondCalls.length, 1);
  assert.deepEqual(h.respondCalls[0], {
    rpcId: "rpc-1",
    sessionId: "s-1",
    approvalId: "approval-1",
    outcome: "allowed-once",
  });

  const record = h.store.get("approval-1");
  assert.equal(record.status, "resolved");
  assert.equal(record.outcome, "allowed-once");
  assert.equal(h.sends.length, 2);
  assert.ok(h.sends[1].text.includes("已批准一次"));

  const rejected = await makeHarness(t);
  rejected.mux.injectFrame(REQUESTED());
  await settle(rejected);
  await rejected.service.respondApproval({ approvalId: "approval-1", outcome: "rejected" });
  assert.deepEqual(rejected.respondCalls[0].outcome, "rejected");
  assert.ok(rejected.sends[1].text.includes("已拒绝"));
});

test("respondApproval rejects out-of-whitelist outcomes before any DSH call", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  for (const bad of ["never", "always", "allowed-always", "maybe", "", 42, null]) {
    await assert.rejects(
      () => h.service.respondApproval({ approvalId: "approval-1", outcome: bad }),
      (error) => error instanceof ApprovalError && error.code === "invalid-outcome" && error.status === 400,
    );
    assert.equal(h.store.get("approval-1").status, "pending", `${bad} leaves the record pending`);
  }
  assert.equal(h.respondCalls.length, 0, "no DSH call ever happened for bad outcomes");
  assert.deepEqual(APPROVAL_OUTCOMES, ["allowed-once", "rejected"]);
});

test("respondApproval on an unknown approval → 404; on a resolved one → 409", async (t) => {
  const h = await makeHarness(t);
  await assert.rejects(
    () => h.service.respondApproval({ approvalId: "nope", outcome: "allowed-once" }),
    (error) => error instanceof ApprovalError && error.code === "not-found" && error.status === 404,
  );
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  await h.service.respondApproval({ approvalId: "approval-1", outcome: "allowed-once" });
  await assert.rejects(
    () => h.service.respondApproval({ approvalId: "approval-1", outcome: "allowed-once" }),
    (error) => error instanceof ApprovalError && error.code === "not-pending" && error.status === 409,
  );
  assert.equal(h.respondCalls.length, 1, "the second answer never reached DSH");
});

test("respondApproval enforces taskId ownership cross-check", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  await assert.rejects(
    () => h.service.respondApproval({ approvalId: "approval-1", outcome: "allowed-once", taskId: "task_other" }),
    (error) => error instanceof ApprovalError && error.code === "task-mismatch" && error.status === 409,
  );
  assert.equal(h.respondCalls.length, 0);
});

test("respondApproval on a history-recovered approval (no rpcId) → 409 not-answerable", async (t) => {
  const h = await makeHarness(t);
  h.setHistoryEvents([ASKED("approval-hist", "bash", "run thing")]);
  await h.service.reconcileFromHistory();
  assert.equal(h.store.get("approval-hist").status, "pending");
  await assert.rejects(
    () => h.service.respondApproval({ approvalId: "approval-hist", outcome: "allowed-once" }),
    (error) => error instanceof ApprovalError && error.code === "not-answerable" && error.status === 409,
  );
  assert.equal(h.respondCalls.length, 0, "no answer token → no /api/respond call");
});

test("respondApproval when DSH says not-pending: record resolves (superseded) + feedback + 409", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  h.setRespondResult({ accepted: false, reason: "not-pending" });
  await assert.rejects(
    () => h.service.respondApproval({ approvalId: "approval-1", outcome: "allowed-once" }),
    (error) => error instanceof ApprovalError && error.code === "not-pending" && error.status === 409,
  );
  const record = h.store.get("approval-1");
  assert.equal(record.status, "resolved");
  assert.equal(record.outcome, "superseded");
  assert.ok(h.sends[1].text.includes("已失效"));
});

test("respondApproval on transport failure: record stays pending, error 502", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  h.setRespondImpl(() => {
    throw new DshRpcError("transport", "ECONNREFUSED http://127.0.0.1:3080/api/respond");
  });
  await assert.rejects(
    () => h.service.respondApproval({ approvalId: "approval-1", outcome: "allowed-once" }),
    (error) => error instanceof ApprovalError && error.code === "dsh-unavailable" && error.status === 502,
  );
  assert.equal(h.store.get("approval-1").status, "pending", "transient failure keeps it pending");
  assert.equal(h.sends.length, 1, "no feedback for an unanswered attempt");
});

// ── Presentation ────────────────────────────────────────────────────────────

test("listPending exposes a redacted view only: no rpcId, no sessionId, no raw data", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED({ reason: "sk-abcdefghijklmnopqrstuvwxyz0123456789 secret" }));
  await settle(h);
  const view = h.service.listPending()[0];
  assert.deepEqual(Object.keys(view).sort(), [
    "approvalId",
    "reasonSummary",
    "requestedAt",
    "taskId",
    "toolName",
  ]);
  assert.equal(view.approvalId, "approval-1");
  assert.equal(view.taskId, h.task.id);
  assert.ok(!JSON.stringify(view).includes("rpc-1"), "rpcId never leaves the service");
  assert.ok(!JSON.stringify(view).includes("s-1"), "sessionId never leaves the service");
  assert.ok(!view.reasonSummary.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"));
});

// ── Fail-soft pushes ────────────────────────────────────────────────────────

test("a throwing session:send never affects the persisted record", async (t) => {
  const h = await makeHarness(t);
  const original = h.service.busRequest.bind(h.service);
  h.service.busRequest = async (name) => {
    if (name === "session:send") {
      throw new Error("host bus exploded");
    }
    return original(name);
  };
  h.mux.injectFrame(REQUESTED({ reason: "x" }));
  await settle(h);
  assert.equal(h.store.get("approval-1").status, "pending", "record persisted despite failed send");
  // And the resolved feedback push fails the same way without breaking resolve.
  h.mux.injectFrame(RESOLVED());
  await settle(h);
  assert.equal(h.store.get("approval-1").status, "resolved");
});

test("a throwing task:update is skipped and logged, record and push intact", async (t) => {
  const h = await makeHarness(t);
  const original = h.service.busRequest.bind(h.service);
  h.service.busRequest = async (name) => {
    if (name === "task:update") {
      throw new Error("no task:update capability");
    }
    return original(name);
  };
  h.mux.injectFrame(REQUESTED({ reason: "x" }));
  await settle(h);
  assert.equal(h.store.get("approval-1").status, "pending");
  assert.equal(h.sends.length, 1, "session:send still delivered");
});

test("dshApprovalNotify=false: records + task:update work, chat push is suppressed", async (t) => {
  const h = await makeHarness(t, { config: { approvalNotify: false } });
  h.mux.injectFrame(REQUESTED({ reason: "x" }));
  await settle(h);
  assert.equal(h.store.get("approval-1").status, "pending");
  assert.equal(h.sends.length, 0, "master switch off → no chat pushes at all");
  assert.equal(h.taskUpdates.length, 1, "task board visibility is independent of the switch");
  h.mux.injectFrame(RESOLVED());
  await settle(h);
  assert.equal(h.store.get("approval-1").status, "resolved");
  assert.equal(h.sends.length, 0);
});

// ── Timeout abandonment (never answers DSH) ─────────────────────────────────

test("timeoutMs=0 (default): sweep never abandons pending approvals", async (t) => {
  const h = await makeHarness(t);
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  h.setClock(T0 + 3_600_000);
  const outcome = await h.service.sweepTimeouts();
  assert.deepEqual(outcome, { scanned: 0, resolved: 0 });
  assert.equal(h.store.get("approval-1").status, "pending");
  assert.equal(h.respondCalls.length, 0);
});

test("timeoutMs>0: overdue pending is abandoned locally (timed-out + feedback), DSH never answered", async (t) => {
  const h = await makeHarness(t, { config: { approvalTimeoutMs: 1000 } });
  h.mux.injectFrame(REQUESTED());
  await settle(h);
  assert.equal(h.store.get("approval-1").status, "pending", "not overdue yet");

  h.setClock(T0 + 1000);
  const outcome = await h.service.sweepTimeouts();
  assert.equal(outcome.resolved, 1);
  const record = h.store.get("approval-1");
  assert.equal(record.status, "resolved");
  assert.equal(record.outcome, "timed-out");
  assert.ok(h.sends[1].text.includes("等待超时"));
  assert.ok(h.sends[1].text.includes("未自动应答"));
  assert.equal(h.respondCalls.length, 0, "timeout NEVER answers DSH (no auto-approve, no auto-reject)");
});

// ── Reconnect re-pull from session.history ──────────────────────────────────

const ASKED = (id, toolName, reason = null) => ({
  event: { seq: 1, type: "approval/asked", time: 100, data: { id, toolName, ...(reason ? { reason } : {}) } },
});
const DECIDED = (id, outcome) => ({
  event: { seq: 2, type: "approval/decided", time: 101, data: { id, outcome } },
});

test("reconcileFromHistory discovers undecided asks (replay source) and settles already-tracked decided ones", async (t) => {
  const h = await makeHarness(t);
  // Track one approval via the mux BEFORE the disconnect so the re-pull can
  // settle it from the durable decided event.
  h.mux.injectFrame(approvalRequestedFrame({ approvalId: "a-tracked", toolName: "write_file" }));
  await settle(h);
  assert.equal(h.sends.length, 1);

  h.setHistoryEvents([
    ASKED("a-open", "bash", "run tests"),
    ASKED("a-tracked", "write_file"),
    DECIDED("a-tracked", "rejected"),
  ]);
  const result = await h.service.reconcileFromHistory();
  assert.equal(result.scanned, 1);
  assert.equal(result.discovered, 1);
  assert.equal(result.settled, 1);

  const open = h.store.get("a-open");
  assert.equal(open.status, "pending");
  assert.equal(open.source, "replay");
  assert.equal(open.rpcId, null, "history carries no answer token");
  assert.equal(open.taskId, h.task.id);
  assert.equal(open.reasonSummary, "run tests");

  const tracked = h.store.get("a-tracked");
  assert.equal(tracked.status, "resolved", "decided event settles the tracked pending");
  assert.equal(tracked.outcome, "rejected");

  // sends: requested(a-tracked via mux) + requested(a-open replay) + feedback(a-tracked).
  assert.equal(h.sends.length, 3);
  assert.ok(h.sends[1].text.includes("bash"), "request message names the tool");
  assert.ok(h.sends[2].text.includes("已拒绝"), "feedback names the outcome");
});

test("a later mux replay supplies the rpcId to a history-recovered approval (no double push)", async (t) => {
  const h = await makeHarness(t);
  h.setHistoryEvents([ASKED("a-open", "bash", "run")]);
  await h.service.reconcileFromHistory();
  assert.equal(h.sends.length, 1);

  h.mux.injectFrame(approvalRequestedFrame({ approvalId: "a-open", toolName: "bash" }));
  await settle(h);
  const record = h.store.get("a-open");
  assert.equal(record.rpcId, "rpc-1", "mux replay fills the answer token");
  assert.equal(record.status, "pending");
  assert.equal(h.sends.length, 1, "no re-notification for the re-delivered frame");

  const result = await h.service.respondApproval({ approvalId: "a-open", outcome: "allowed-once" });
  assert.equal(result.ok, true);
  assert.deepEqual(h.respondCalls[0].rpcId, "rpc-1");
});

test("reconcileFromHistory is fail-soft per session: a history error is skipped, promise resolves", async (t) => {
  const h = await makeHarness(t);
  h.rpc.history = async () => {
    throw new DshRpcError("transport", "ECONNREFUSED");
  };
  const result = await h.service.reconcileFromHistory();
  assert.equal(result.scanned, 0);
  assert.equal(h.store.list().length, 0);
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test("redactReason strips token patterns, collapses whitespace, truncates, null-safe", () => {
  assert.equal(redactReason(null), null);
  assert.equal(redactReason(undefined), null);
  assert.equal(redactReason(42), null);
  assert.ok(redactReason("use sk-abcdefghijklmnopqrstuvwxyz0123456789 now").includes("***"));
  assert.ok(!redactReason("use sk-abcdefghijklmnopqrstuvwxyz0123456789 now").includes("sk-abc"));
  assert.ok(redactReason("token=abc123def456ghi789jkl012mno345pqr678stu901").includes("***"));
  assert.ok(!redactReason("token=abc123def456ghi789jkl012mno345pqr678stu901").includes("token=abc"));
  assert.equal(redactReason("a\nb\tc"), "a b c");
  assert.equal(redactReason("好".repeat(300)).length, 160);
  assert.equal(redactReason("  clean  "), "clean");
});

test("requestedMessage / resolvedMessage formats are redacted, bounded, task-anchored", () => {
  const record = {
    taskId: "task_1",
    toolName: "write_file",
    reasonSummary: "write a file",
  };
  const requested = requestedMessage(record);
  assert.ok(requested.startsWith("[DSH 审批]"));
  assert.ok(requested.includes("task_1"));
  assert.ok(requested.includes("write_file"));
  assert.ok(requested.includes("write a file"));
  assert.ok(requested.includes("请在 DSH 监听页批准或拒绝"));

  assert.ok(resolvedMessage(record, "allowed-once").includes("已批准一次"));
  assert.ok(resolvedMessage(record, "rejected").includes("已拒绝"));
  assert.ok(resolvedMessage(record, "cancelled").includes("已取消"));
  assert.ok(resolvedMessage(record, "unavailable").includes("已失效"));
  assert.ok(resolvedMessage(record, "superseded").includes("已失效"));
  assert.ok(resolvedMessage(record, "timed-out", { timeoutMs: 5000 }).includes("5000"));
  assert.ok(resolvedMessage(record, "timed-out", { timeoutMs: 5000 }).includes("未自动应答"));

  // Without a task (defensive): falls back to sessionId/unknown, still bounded.
  assert.ok(requestedMessage({ sessionId: "s-9", toolName: "bash", reasonSummary: null }).includes("s-9"));
  assert.ok(requestedMessage({ sessionId: "s-9", toolName: "bash", reasonSummary: null }).includes("（无理由说明）"));
});

// ── Auto-approval impossibility (source-level review point) ─────────────────

test("auto-approval is structurally impossible: respondApproval has exactly one caller (the API route)", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (rel) => fs.readFile(path.join(root, rel), "utf8");
  const [serviceSrc, listenerSrc, storeSrc, routesSrc, clientSrc] = await Promise.all([
    read("lib/approval-service.js"),
    read("lib/approval-mux-listener.js"),
    read("lib/approval-store.js"),
    read("routes/api.js"),
    read("lib/dsh-rpc-client.js"),
  ]);
  // Review the CODE only — comments about the guarantee must not count.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*/gm, "");

  // The listener and the store have no concept of answering at all.
  assert.ok(!stripComments(listenerSrc).includes("respondApproval"), "listener never answers approvals");
  assert.ok(!stripComments(storeSrc).includes("respondApproval"), "store never answers approvals");

  // In the service, the ONLY call to the DSH answer method sits inside
  // respondApproval itself (definition + its own rpc call = 2 occurrences).
  const serviceCode = stripComments(serviceSrc);
  const serviceCalls = serviceCode.match(/respondApproval\(/g) ?? [];
  assert.equal(serviceCalls.length, 2, "definition + the single rpc call inside it");
  const defIndex = serviceCode.indexOf("async respondApproval(");
  const callIndex = serviceCode.indexOf("this.rpc.respondApproval(");
  assert.ok(defIndex >= 0 && callIndex > defIndex, "the rpc call is inside the method");
  const methodTail = serviceCode.slice(defIndex, serviceCode.indexOf("\n  async listPending("));
  assert.ok(methodTail.includes("this.rpc.respondApproval("), "only the user-triggered method answers DSH");

  // The API route is the only external caller.
  const routeCalls = stripComments(routesSrc).match(/respondApproval\(/g) ?? [];
  assert.equal(routeCalls.length, 1, "exactly one route call site");

  // The DSH client exposes the answer method but no generic proxy to it.
  const clientCalls = stripComments(clientSrc).match(/respondApproval\(/g) ?? [];
  assert.equal(clientCalls.length, 1, "client defines it once, no self-calls");

  // Persistent elevation vocabulary never appears in code anywhere.
  for (const src of [serviceCode, stripComments(listenerSrc), stripComments(storeSrc), stripComments(routesSrc), stripComments(clientSrc)]) {
    assert.ok(!src.includes('"never"'), "no 'never' outcome literal");
    assert.ok(!src.includes("allowed-always"), "no persistent elevation vocabulary");
  }
});
