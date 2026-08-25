// approval-store: atomic persistence, legacy normalization, idempotent upsert,
// rpcId refresh, sticky resolve, corrupt-file recovery.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../lib/approval-store.js";

async function makeStore(t, { now = null } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-approvals-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  const store = new ApprovalStore({ dataDir, now: now ?? (() => 1_700_000_000_000) });
  await store.init();
  return { store, dataDir };
}

const BASE = {
  approvalId: "approval-1",
  sessionId: "s-1",
  taskId: "task_1",
  toolName: "write_file",
  reasonSummary: "write to C:\\x",
  rpcId: "rpc-1",
};

test("upsert persists a pending record; get/listPending/list round-trip", async (t) => {
  const { store } = await makeStore(t);
  const { record, created } = await store.upsert(BASE);
  assert.equal(created, true);
  assert.equal(record.status, "pending");
  assert.equal(record.approvalId, "approval-1");
  assert.equal(record.rpcId, "rpc-1");
  assert.equal(record.requestedAt, 1_700_000_000_000);

  const pending = store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolName, "write_file");
  assert.equal(store.get("approval-1").status, "pending");
  assert.equal(store.list().length, 1);
});

test("upsert is idempotent for re-delivered frames: keeps original requestedAt, no re-persist churn", async (t) => {
  const { store } = await makeStore(t, { now: () => 1_700_000_000_000 });
  await store.upsert(BASE);
  // A second delivery (mux replay) must not reset requestedAt nor resurrect.
  const second = await store.upsert({ ...BASE, reasonSummary: "different" });
  assert.equal(second.created, false);
  assert.equal(second.record.requestedAt, 1_700_000_000_000);
  assert.equal(second.record.reasonSummary, "write to C:\\x", "pending record keeps the first redaction");
});

test("upsert refreshes a missing rpcId on a pending record (history re-pull then mux replay)", async (t) => {
  const { store } = await makeStore(t);
  const first = await store.upsert({ ...BASE, rpcId: null, source: "replay" });
  assert.equal(first.record.rpcId, null);
  const second = await store.upsert({ ...BASE, rpcId: "rpc-9", source: "mux" });
  assert.equal(second.created, false);
  assert.equal(second.record.rpcId, "rpc-9", "mux replay supplies the answer token");
  assert.equal(second.record.requestedAt, first.record.requestedAt);
});

test("resolve transitions pending → resolved with outcome; sticky afterwards", async (t) => {
  const { store } = await makeStore(t);
  await store.upsert(BASE);
  const resolved = await store.resolve("approval-1", "allowed-once");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.outcome, "allowed-once");
  assert.ok(resolved.resolvedAt > 0);
  assert.equal(store.listPending().length, 0);
  // Sticky: a second resolve is a no-op, and a stale upsert never resurrects.
  assert.equal(await store.resolve("approval-1", "rejected"), null);
  const replay = await store.upsert(BASE);
  assert.equal(replay.created, false);
  assert.equal(replay.record.status, "resolved");
  assert.equal(replay.record.outcome, "allowed-once");
});

test("records survive reopen (atomic file); malformed records are skipped", async (t) => {
  const { store, dataDir } = await makeStore(t);
  await store.upsert(BASE);
  await store.upsert({ ...BASE, approvalId: "approval-2", toolName: "edit_file" });

  const reopened = new ApprovalStore({ dataDir, now: () => 1_700_000_100_000 });
  await reopened.init();
  const all = reopened.list();
  assert.equal(all.length, 2);
  const one = reopened.get("approval-1");
  assert.equal(one.sessionId, "s-1");
  assert.equal(one.taskId, "task_1");
  assert.equal(one.status, "pending");
});

test("corrupt approvals.json must not crash startup: warn + empty store", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-approvals-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  const warnings = [];
  await fs.writeFile(
    path.join(dataDir, "approvals.json"),
    "{ this is not json ",
    "utf8",
  );
  const store = new ApprovalStore({ dataDir, log: { warn: (m) => warnings.push(m) } });
  await store.init();
  assert.equal(store.list().length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("corrupt"));
  // The store must remain fully writable afterwards.
  await store.upsert(BASE);
  assert.equal(store.listPending().length, 1);
});

test("legacy records normalize: missing new fields default, unknown statuses → pending", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-approvals-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(
    path.join(dataDir, "approvals.json"),
    JSON.stringify({
      "approval-old": {
        approvalId: "approval-old",
        sessionId: "s-9",
        toolName: "bash",
        status: "weird-legacy",
      },
    }),
    "utf8",
  );
  const store = new ApprovalStore({ dataDir, now: () => 1_700_000_000_000 });
  await store.init();
  const record = store.get("approval-old");
  assert.equal(record.status, "pending", "unknown status normalizes to pending");
  assert.equal(record.taskId, null);
  assert.equal(record.reasonSummary, null);
  assert.equal(record.rpcId, null);
  assert.equal(record.source, "mux");
  assert.equal(record.resolvedAt, null);
  assert.equal(record.requestedAt, 1_700_000_000_000);
});

test("persist failure rolls back the in-memory mutation and rejects (never poisoned)", async (t) => {
  const { store, dataDir } = await makeStore(t);
  await store.upsert(BASE);
  // Break the store's write path by replacing the file with a directory.
  await fs.rm(path.join(dataDir, "approvals.json"));
  await fs.mkdir(path.join(dataDir, "approvals.json"));
  await assert.rejects(() => store.upsert({ ...BASE, approvalId: "approval-2" }));
  await fs.rm(path.join(dataDir, "approvals.json"), { recursive: true, force: true });
  assert.equal(store.get("approval-2"), null, "failed insert is rolled back");
  // The store must stay usable for later operations.
  const recovered = await store.upsert({ ...BASE, approvalId: "approval-3" });
  assert.equal(recovered.created, true);
  assert.equal(store.list().length, 2);
});
