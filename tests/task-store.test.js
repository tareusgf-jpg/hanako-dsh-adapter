// task-store: atomic persistence, corrupt-JSON resilience, round trips.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore, TaskStoreError } from "../lib/task-store.js";

// Generic absolute paths (os.tmpdir-based) — TaskStore persists cwd verbatim
// and never resolves it, so any plausible absolute path keeps the semantics.
const WS = path.join(os.tmpdir(), "dsh-task-store-ws");
const DRIVE_ROOT = path.parse(os.tmpdir()).root;

async function tempDataDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-task-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

test("create/update/get/list round trip with persistence", async (t) => {
  const dir = await tempDataDir(t);
  const store = new TaskStore({ dataDir: dir });
  await store.init();

  const record = await store.create({
    sessionId: "s-1",
    cwd: WS,
    agentPreset: "router-standard",
    promptSummary: "fix the bug…",
    promptLength: 42,
  });
  assert.ok(record.id.startsWith("task_"));
  assert.equal(record.status, "running");
  assert.equal(store.get(record.id).sessionId, "s-1");

  const updated = await store.update(record.id, { status: "done", resultText: "fixed" });
  assert.equal(updated.status, "done");
  assert.equal(updated.resultText, "fixed");
  assert.ok(updated.updatedAt >= updated.createdAt);

  // Re-open: data persisted.
  const reopened = new TaskStore({ dataDir: dir });
  await reopened.init();
  const loaded = reopened.get(record.id);
  assert.equal(loaded.status, "done");
  assert.equal(loaded.resultText, "fixed");

  const list = reopened.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, record.id);

  await reopened.flush();
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("update of a missing task throws not-found", async (t) => {
  const dir = await tempDataDir(t);
  const store = new TaskStore({ dataDir: dir });
  await store.init();
  await assert.rejects(() => store.update("task_missing", { status: "done" }), TaskStoreError);
  assert.equal(store.get("task_missing"), null);
});

test("corrupt tasks.json does not crash init", async (t) => {
  const dir = await tempDataDir(t);
  await fs.writeFile(path.join(dir, "tasks.json"), "{ not valid json !!!", "utf8");
  const warnings = [];
  const store = new TaskStore({ dataDir: dir, log: { warn: (m) => warnings.push(m) } });
  await store.init(); // must not throw
  assert.equal(store.list().length, 0);
  assert.equal(warnings.length, 1);

  // Store remains writable after corruption.
  const record = await store.create({
    sessionId: "s-2",
    cwd: WS,
    agentPreset: "router-standard",
    promptSummary: "x",
    promptLength: 1,
  });
  assert.ok(store.get(record.id));
});

test("list orders by createdAt descending and returns clones", async (t) => {
  const dir = await tempDataDir(t);
  let clock = 1_700_000_000_000;
  const store = new TaskStore({ dataDir: dir, now: () => clock++ });
  await store.init();
  const a = await store.create({ sessionId: "a", cwd: "D:\\", agentPreset: "p", promptSummary: "a", promptLength: 1 });
  const b = await store.create({ sessionId: "b", cwd: "D:\\", agentPreset: "p", promptSummary: "b", promptLength: 1 });
  assert.deepEqual(store.list().map((r) => r.id), [b.id, a.id]);
  const got = store.get(a.id);
  got.status = "mutated";
  assert.equal(store.get(a.id).status, "running");
});

test("create accepts an explicit id and status (submit chain starts at creating)", async (t) => {
  const dir = await tempDataDir(t);
  const store = new TaskStore({ dataDir: dir });
  await store.init();
  const record = await store.create({
    id: "task_prealloc",
    status: "creating",
    sessionId: "session-prealloc",
    cwd: WS,
    agentPreset: "router-standard",
    promptSummary: "p",
    promptLength: 1,
  });
  assert.equal(record.id, "task_prealloc");
  assert.equal(record.status, "creating");
  assert.equal(record.terminalReason, null);
  assert.equal(record.statusChangedAt, record.createdAt);
  assert.equal(store.get("task_prealloc").sessionId, "session-prealloc");
});

test("update tracks statusChangedAt and supports touch:false refreshes", async (t) => {
  const dir = await tempDataDir(t);
  let tick = 1000;
  const store = new TaskStore({ dataDir: dir, now: () => tick });
  await store.init();
  const record = await store.create({
    sessionId: "s",
    cwd: DRIVE_ROOT,
    agentPreset: "p",
    promptSummary: "s",
    promptLength: 1,
  });
  assert.equal(record.statusChangedAt, 1000);

  tick = 2000;
  const touched = await store.update(record.id, { resultText: "x" });
  assert.equal(touched.updatedAt, 2000);
  assert.equal(touched.statusChangedAt, 1000, "a non-status patch must not reset statusChangedAt");

  tick = 3000;
  const changed = await store.update(record.id, { status: "done" });
  assert.equal(changed.statusChangedAt, 3000);
  assert.equal(changed.updatedAt, 3000);

  tick = 4000;
  const noTouch = await store.update(record.id, { resultText: "y" }, { touch: false });
  assert.equal(noTouch.updatedAt, 3000, "touch:false must not bump updatedAt");
  assert.equal(noTouch.resultText, "y");
});

test("uncertainSince/uncertainReason survive a store reopen — the observation clock is durable, never re-derived (P3-4)", async (t) => {
  const dir = await tempDataDir(t);
  let tick = 1000;
  const store = new TaskStore({ dataDir: dir, now: () => tick });
  await store.init();
  const record = await store.create({
    sessionId: "s-1",
    cwd: WS,
    agentPreset: "router-standard",
    promptSummary: "p",
    promptLength: 1,
    status: "running",
  });
  await store.update(record.id, { uncertainSince: 1000, uncertainReason: "no-turn" });

  // Simulate a restart: a fresh store instance re-reads the persisted snapshot
  // after a long wall-clock gap. The stored clock must NOT follow `now` — the
  // grace window keeps counting from the FIRST observation.
  tick = 60_000;
  const reopened = new TaskStore({ dataDir: dir, now: () => tick });
  await reopened.init();
  const loaded = reopened.get(record.id);
  assert.equal(loaded.status, "running");
  assert.equal(loaded.uncertainSince, 1000, "first-observation time is persisted as-is");
  assert.equal(loaded.uncertainReason, "no-turn", "the observed verdict survives the reopen");
  assert.equal(loaded.updatedAt, 1000, "the reopen itself must not bump timestamps");
});

test("legacy tasks.json records load without new fields and without crashing", async (t) => {
  const dir = await tempDataDir(t);
  const legacy = {
    task_legacy_1: {
      id: "task_legacy_1",
      sessionId: "s-1",
      cwd: WS,
      agentPreset: "router-standard",
      promptSummary: "fix",
      promptLength: 3,
      status: "running",
      createdAt: 100,
      updatedAt: 200,
      lastError: null,
      resultText: null,
    },
    task_legacy_2: {
      id: "task_legacy_2",
      sessionId: "s-2",
      cwd: WS,
      agentPreset: "router-standard",
      promptSummary: "go",
      promptLength: 2,
      status: "done",
      createdAt: 50,
      updatedAt: 150,
      lastError: null,
      resultText: "done text",
    },
    task_legacy_3: {
      id: "task_legacy_3",
      sessionId: "s-3",
      cwd: WS,
      agentPreset: "router-standard",
      promptSummary: "stop",
      promptLength: 4,
      status: "cancelled",
      createdAt: 10,
      updatedAt: 110,
      lastError: null,
      resultText: null,
    },
    // Malformed legacy variant: missing id and unknown status — must not crash.
    task_legacy_4: {
      sessionId: "s-4",
      cwd: WS,
      status: "what-is-this",
      createdAt: 5,
      updatedAt: 105,
    },
  };
  await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(legacy), "utf8");

  const warnings = [];
  const store = new TaskStore({ dataDir: dir, log: { warn: (m) => warnings.push(m) } });
  await store.init(); // must not throw

  assert.equal(store.list().length, 4);
  const r1 = store.get("task_legacy_1");
  assert.equal(r1.status, "running");
  assert.equal(r1.terminalReason, null);
  assert.equal(r1.cancelledAt, null);
  assert.equal(r1.cancelRequestedAt, null);
  assert.equal(r1.previousStatus, null);
  assert.equal(r1.uncertainSince, null);
  assert.equal(r1.uncertainReason, null);
  assert.equal(typeof r1.statusChangedAt, "number");
  assert.equal(r1.promptSummary, "fix");
  assert.equal(store.get("task_legacy_2").status, "done");
  assert.equal(store.get("task_legacy_2").resultText, "done text");
  assert.equal(store.get("task_legacy_3").status, "cancelled");
  // Unknown status normalizes to running so reconciliation can judge it.
  assert.equal(store.get("task_legacy_4").status, "running");
  assert.equal(warnings.length, 0, "well-shaped legacy records produce no warnings");

  // The store stays writable after loading legacy records.
  const record = await store.create({
    sessionId: "s-new",
    cwd: WS,
    agentPreset: "router-standard",
    promptSummary: "x",
    promptLength: 1,
  });
  assert.ok(store.get(record.id));
});

// ── M5: one failed write must never poison the store or silently commit ─────

/** Make every persist fail by placing a DIRECTORY at the tasks.json path. */
async function blockPersists(dir) {
  const filePath = path.join(dir, "tasks.json");
  await fs.rm(filePath, { force: true });
  await fs.mkdir(filePath); // rename(tmp -> filePath) now fails
}

test("a failed create rolls back memory, cleans tmp, and does not poison the store (M5)", async (t) => {
  const dir = await tempDataDir(t);
  const store = new TaskStore({ dataDir: dir });
  await store.init();
  const a = await store.create({
    sessionId: "s-a",
    cwd: DRIVE_ROOT,
    agentPreset: "p",
    promptSummary: "a",
    promptLength: 1,
  });

  await blockPersists(dir);
  await assert.rejects(
    () =>
      store.create({
        sessionId: "s-b",
        cwd: DRIVE_ROOT,
        agentPreset: "p",
        promptSummary: "b",
        promptLength: 1,
      }),
    (e) => e instanceof TaskStoreError || e instanceof Error,
  );
  assert.equal(store.list().length, 1, "the failed create must not stay in memory");
  assert.equal(store.get(a.id)?.sessionId, "s-a");
  // tmp file was cleaned up best-effort.
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);

  // Recovery: the store is NOT poisoned — later writes commit again.
  await fs.rm(path.join(dir, "tasks.json"), { recursive: true, force: true });
  const c = await store.create({
    sessionId: "s-c",
    cwd: DRIVE_ROOT,
    agentPreset: "p",
    promptSummary: "c",
    promptLength: 1,
  });
  assert.ok(store.get(c.id));

  // Re-open: disk has ONLY a and c — the failed b was never silently committed.
  const reopened = new TaskStore({ dataDir: dir });
  await reopened.init();
  assert.deepEqual(reopened.list().map((r) => r.sessionId).sort(), ["s-a", "s-c"]);
});

test("a failed update rolls back the in-memory patch and is never silently committed later (M5)", async (t) => {
  const dir = await tempDataDir(t);
  const store = new TaskStore({ dataDir: dir });
  await store.init();
  const record = await store.create({
    sessionId: "s-a",
    cwd: DRIVE_ROOT,
    agentPreset: "p",
    promptSummary: "a",
    promptLength: 1,
  });

  await blockPersists(dir);
  await assert.rejects(() => store.update(record.id, { status: "done", resultText: "fixed" }));
  const after = store.get(record.id);
  assert.equal(after.status, "running", "the failed patch must be rolled back in memory");
  assert.equal(after.resultText, null);

  // A later successful write must NOT carry the failed patch to disk.
  await fs.rm(path.join(dir, "tasks.json"), { recursive: true, force: true });
  const c = await store.create({
    sessionId: "s-c",
    cwd: DRIVE_ROOT,
    agentPreset: "p",
    promptSummary: "c",
    promptLength: 1,
  });
  const reopened = new TaskStore({ dataDir: dir });
  await reopened.init();
  const loaded = reopened.get(record.id);
  assert.equal(loaded.status, "running", "the rolled-back patch was not silently committed");
  assert.equal(loaded.resultText, null);
  assert.ok(reopened.get(c.id));
});

test("concurrent updates serialize: every patch lands, no lost writes, no rejection (M5)", async (t) => {
  const dir = await tempDataDir(t);
  const store = new TaskStore({ dataDir: dir });
  await store.init();
  const a = await store.create({
    sessionId: "s-a",
    cwd: DRIVE_ROOT,
    agentPreset: "p",
    promptSummary: "a",
    promptLength: 1,
  });
  const b = await store.create({
    sessionId: "s-b",
    cwd: DRIVE_ROOT,
    agentPreset: "p",
    promptSummary: "b",
    promptLength: 1,
  });

  // Same-record concurrent patches build on each other (serial commit).
  await Promise.all([
    store.update(a.id, { resultText: "x" }),
    store.update(a.id, { lastError: "y" }),
  ]);
  const both = store.get(a.id);
  assert.equal(both.resultText, "x");
  assert.equal(both.lastError, "y");

  // Cross-record concurrent updates all persist.
  await Promise.all([
    store.update(a.id, { status: "done" }),
    store.update(b.id, { status: "failed" }),
  ]);
  const reopened = new TaskStore({ dataDir: dir });
  await reopened.init();
  assert.equal(reopened.get(a.id).status, "done");
  assert.equal(reopened.get(b.id).status, "failed");
  assert.equal(reopened.get(a.id).resultText, "x");
  assert.equal(reopened.get(a.id).lastError, "y");
});

test("casStatus: conflicting update is rejected without mutating (M5)", async (t) => {
  const dir = await tempDataDir(t);
  const store = new TaskStore({ dataDir: dir });
  await store.init();
  const record = await store.create({
    sessionId: "s-a",
    cwd: DRIVE_ROOT,
    agentPreset: "p",
    promptSummary: "a",
    promptLength: 1,
  });
  await store.update(record.id, { status: "cancelling" });
  await assert.rejects(
    () => store.update(record.id, { status: "running", cancelledAt: null }, { casStatus: "running" }),
    (e) => e instanceof TaskStoreError && e.code === "conflict",
  );
  assert.equal(store.get(record.id).status, "cancelling", "a CAS conflict must not mutate the record");
  // Matching CAS succeeds.
  const ok = await store.update(record.id, { status: "running" }, { casStatus: "cancelling" });
  assert.equal(ok.status, "running");
});
