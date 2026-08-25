// reconcile: startup fail-soft reconciliation of non-terminal tasks.
// Covers idempotent recovery semantics, terminal classification on restart,
// grace windows, sticky terminal states, and the no-unhandled-rejection rule.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DshAdapterService } from "../lib/dsh-adapter-service.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { TaskStore } from "../lib/task-store.js";
import { DshRpcError } from "../lib/dsh-rpc-client.js";
import { createFakeRpc, createFakeSupervisor } from "./helpers/fake-dsh.js";

const CONFIG = { pluginVersion: "0.3.0", autoStart: true };

async function makeService(t, { rpc = null, graceMs = 0 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-reconcile-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  const policy = new WorkspacePolicy({ roots: [dataDir] });
  let tick = 0;
  const store = new TaskStore({ dataDir, now: () => tick });
  await store.init();
  const service = new DshAdapterService({
    rpc: rpc ?? createFakeRpc(),
    supervisor: createFakeSupervisor(),
    workspacePolicy: policy,
    taskStore: store,
    config: CONFIG,
    now: () => tick,
    sleep: async () => {},
    pollIntervalMs: 10,
    classificationGraceMs: graceMs,
  });
  const advance = (ms) => {
    tick += ms;
  };
  return { service, store, dataDir, advance };
}

async function seed(store, dataDir, { status, sessionId = "s-1" }) {
  return store.create({
    sessionId,
    cwd: dataDir,
    agentPreset: "router-standard",
    promptSummary: "p",
    promptLength: 1,
    status,
  });
}

const HISTORY_DONE = (sessionId) => ({
  items: [{ sessionId, running: false, updatedAt: 123, blank: false }],
});

const ev = (type, data = {}, seq = 0) => ({ event: { seq, type, time: 100 + seq, data } });
const TURN_COMPLETED = () => ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 9);
const TURN_ABORTED = () =>
  ev("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }, 9);
const DONE_EVENTS = [
  {
    event: {
      seq: 1,
      type: "assistant/message",
      time: 100,
      data: { message: { content: [{ type: "text", text: "done" }] } },
    },
  },
  TURN_COMPLETED(),
];

test("reconcile with no pending tasks resolves without touching DSH", async (t) => {
  const { service, store } = await makeService(t);
  const rpc = createFakeRpc({
    script: () => {
      throw new Error("must not be called");
    },
  });
  service.rpc = rpc;
  const result = await service.reconcilePending();
  assert.deepEqual(result, { scanned: 0 });
  assert.equal(rpc.calls.length, 0);
  assert.equal(store.list().length, 0);
});

test("reconcile is fail-soft when DSH is unreachable: tasks stay pending, no throw", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: () => {
      throw new DshRpcError("transport", "ECONNREFUSED");
    },
  });
  rpc.health = async () => ({ ok: false, error: "connection refused" });
  service.rpc = rpc;
  const creating = await seed(store, dataDir, { status: "creating", sessionId: "s-1" });
  const running = await seed(store, dataDir, { status: "running", sessionId: "s-2" });
  const cancelling = await seed(store, dataDir, { status: "cancelling", sessionId: "s-3" });

  const result = await service.reconcilePending(); // must resolve, never reject
  assert.equal(result.scanned, 0);
  assert.equal(result.skipped, 3);
  assert.equal(result.reason, "dsh-unreachable");
  assert.equal(store.get(creating.id).status, "creating");
  assert.equal(store.get(running.id).status, "running");
  assert.equal(store.get(cancelling.id).status, "cancelling");
});

test("reconcile settles a running task with a completed turn + text to done", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: DONE_EVENTS, hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "running", sessionId: "s-1" });
  const result = await service.reconcilePending();
  assert.equal(result.scanned, 1);
  assert.equal(result.changed, 1);
  const task = store.get(record.id);
  assert.equal(task.status, "done");
  assert.equal(task.terminalReason, "completed");
  assert.equal(task.resultText, "done");
});

test("reconcile orphans a task whose session is confirmed missing", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return { items: [] };
      if (method === "session.history") throw new DshRpcError("session-not-found", "gone");
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "running", sessionId: "s-1" });
  await service.reconcilePending();
  const task = store.get(record.id);
  assert.equal(task.status, "orphaned");
  assert.equal(task.terminalReason, "session-missing");
  assert.ok(task.lastError);
});

test("reconcile fails a creating task whose session exists but never ran a turn (prompt lost)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "creating", sessionId: "s-1" });
  await service.reconcilePending();
  const task = store.get(record.id);
  assert.equal(task.status, "failed");
  assert.equal(task.terminalReason, "prompt-lost");
  assert.ok(task.lastError);
});

test("reconcile fails a submitting task with no turn evidence (prompt ambiguous, no double-send)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "submitting", sessionId: "s-1" });
  await service.reconcilePending();
  const task = store.get(record.id);
  assert.equal(task.status, "failed");
  assert.equal(task.terminalReason, "prompt-ambiguous");
  const promptCalls = rpc.calls.filter((c) => c.method === "session.prompt");
  assert.equal(promptCalls.length, 0, "reconcile must never re-send a prompt");
});

test("reconcile resumes a creating task to running when the session is already running", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return { items: [{ sessionId: "s-1", running: true, updatedAt: 1, blank: false }] };
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "creating", sessionId: "s-1" });
  await service.reconcilePending();
  const task = store.get(record.id);
  assert.equal(task.status, "running");
  assert.equal(rpc.calls.filter((c) => c.method === "session.prompt").length, 0, "no prompt for an already-running session");
});

test("reconcile settles a cancelling task whose turn aborted to cancelled", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [TURN_ABORTED()], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "cancelling", sessionId: "s-1" });
  await service.reconcilePending();
  assert.equal(store.get(record.id).status, "cancelled");
});

test("reconcile keeps terminal tasks sticky and never re-judges them", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const done = await seed(store, dataDir, { status: "done", sessionId: "s-1" });
  const failed = await seed(store, dataDir, { status: "failed", sessionId: "s-2" });
  const cancelled = await seed(store, dataDir, { status: "cancelled", sessionId: "s-3" });
  const result = await service.reconcilePending();
  assert.equal(result.scanned, 0, "terminal tasks are not scanned");
  assert.equal(store.get(done.id).status, "done");
  assert.equal(store.get(failed.id).status, "failed");
  assert.equal(store.get(cancelled.id).status, "cancelled");
});

test("reconcile settles a legacy task with null sessionId to failed(missing-session-id), never pending forever", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: () => {
      throw new Error("a null-sessionId task must never be probed against DSH");
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "running", sessionId: null });
  const result = await service.reconcilePending();
  assert.equal(result.scanned, 1);
  assert.equal(result.changed, 1);
  const task = store.get(record.id);
  assert.equal(task.status, "failed");
  assert.equal(task.terminalReason, "missing-session-id");
  assert.ok(task.lastError.includes("no DSH sessionId"));
  assert.equal(rpc.calls.length, 0);
});

test("reconcile records a transient read failure once and keeps the task pending", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: () => {
      throw new DshRpcError("transport", "ECONNREFUSED");
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "running", sessionId: "s-1" });
  await service.reconcilePending();
  const task = store.get(record.id);
  assert.equal(task.status, "running", "transient read failures never make a task terminal");
  assert.ok(task.lastError);
  assert.ok(task.lastError.includes("transport"));
});

test("reconcile keeps recent tasks pending inside the classification grace window", async (t) => {
  const { service, store, dataDir, advance } = await makeService(t, { graceMs: 5000 });
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "running", sessionId: "s-1" });
  await service.reconcilePending();
  assert.equal(store.get(record.id).status, "running", "inside grace: absence verdicts wait");

  advance(6000);
  await service.reconcilePending();
  assert.equal(store.get(record.id).status, "failed");
  assert.equal(store.get(record.id).terminalReason, "no-turn");
});

test("restart reconcile keeps the first-observation clock: reopen preserves uncertainSince, grace is not reset, the same reason lands terminal (P3-4)", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-reconcile-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  let tick = 0;
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.list") {
        return { items: [{ sessionId: "s-1", running: false, updatedAt: 1, blank: false }] };
      }
      if (method === "session.history") {
        if (payload.sessionId === "s-1") return { events: [], hasMore: false }; // idle, no turn
        if (payload.sessionId === "s-2") throw new DshRpcError("session-not-found", "gone");
        throw new Error(`unknown session ${payload.sessionId}`);
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  // Every "boot" opens a FRESH TaskStore over the same tasks.json (restart).
  const boot = async () => {
    const store = new TaskStore({ dataDir, now: () => tick });
    await store.init();
    const service = new DshAdapterService({
      rpc,
      supervisor: createFakeSupervisor(),
      workspacePolicy: new WorkspacePolicy({ roots: [dataDir] }),
      taskStore: store,
      config: CONFIG,
      now: () => tick,
      sleep: async () => {},
      pollIntervalMs: 10,
      classificationGraceMs: 30_000,
    });
    return { service, store };
  };

  // Boot 1: the first observations start the clock for both absence verdicts.
  const first = await boot();
  const r1 = await seed(first.store, dataDir, { status: "running", sessionId: "s-1" });
  const r2 = await seed(first.store, dataDir, { status: "running", sessionId: "s-2" });
  tick = 1000;
  await first.service.reconcilePending();
  assert.equal(first.store.get(r1.id).status, "running", "first observation is never terminal");
  assert.equal(first.store.get(r1.id).uncertainSince, 1000);
  assert.equal(first.store.get(r1.id).uncertainReason, "no-turn");
  assert.equal(first.store.get(r2.id).uncertainSince, 1000);
  assert.equal(first.store.get(r2.id).uncertainReason, "session-missing");

  // Restart: the startup reconcile runs on a reopened store + fresh service.
  // The clock must NOT restart at the new observation time.
  tick = 5000;
  const second = await boot();
  await second.service.reconcilePending();
  assert.equal(second.store.get(r1.id).status, "running", "still inside grace after the restart");
  assert.equal(
    second.store.get(r1.id).uncertainSince,
    1000,
    "the FIRST observation time survives the restart — grace is not reset",
  );
  assert.equal(second.store.get(r1.id).uncertainReason, "no-turn");
  assert.equal(second.store.get(r2.id).uncertainSince, 1000);
  assert.equal(second.store.get(r2.id).uncertainReason, "session-missing");

  // Beyond grace: the SAME persisted reason goes terminal on the next reconcile.
  tick = 40_000;
  await second.service.reconcilePending();
  assert.equal(second.store.get(r1.id).status, "failed");
  assert.equal(second.store.get(r1.id).terminalReason, "no-turn");
  assert.equal(second.store.get(r2.id).status, "orphaned");
  assert.equal(second.store.get(r2.id).terminalReason, "session-missing");
});

test("reconcile is safe to call concurrently and never rejects", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: DONE_EVENTS, hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const record = await seed(store, dataDir, { status: "running", sessionId: "s-1" });
  const [a, b] = await Promise.all([service.reconcilePending(), service.reconcilePending()]);
  assert.equal(a.scanned, 1);
  assert.equal(b.scanned, 1, "concurrent calls share the same pass");
  assert.equal(store.get(record.id).status, "done");
});
