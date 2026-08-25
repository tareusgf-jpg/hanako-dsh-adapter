// Offline end-to-end closed loop with fakes under Phase 0 semantics:
//   run-task (sync wait -> done) -> get-task -> cancel on terminal is a no-op
//   -> async submit -> cancel (accepted -> cancelling) -> observe -> cancelled
//   -> store re-open -> overview aggregation.
// No network, no real DSH process. Mirrors scripts/smoke-offline.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { TaskStore } from "../lib/task-store.js";
import { DshAdapterService } from "../lib/dsh-adapter-service.js";
import { createFakeRpc, createFakeSupervisor } from "./helpers/fake-dsh.js";

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
      data: { message: { content: [{ type: "text", text: "smoke done" }] } },
    },
  },
  TURN_COMPLETED(),
];
const ABORTED_EVENTS = [TURN_ABORTED()];

test("offline smoke: run-task -> get-task -> cancel loop under Phase 0 semantics", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-smoke-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));

  let firstId = null;
  let secondId = null;
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.create") {
        firstId ??= payload.sessionId;
        secondId = payload.sessionId;
        return { sessionId: payload.sessionId };
      }
      if (method === "session.prompt") return { accepted: true };
      if (method === "session.cancel") return { accepted: true };
      if (method === "session.list") {
        return {
          items: [
            { sessionId: firstId, running: false, updatedAt: 1, blank: false },
            { sessionId: secondId, running: false, updatedAt: 1, blank: false },
          ],
        };
      }
      if (method === "session.history") {
        if (payload.sessionId === firstId) return { events: DONE_EVENTS, hasMore: false };
        if (payload.sessionId === secondId) return { events: ABORTED_EVENTS, hasMore: false };
        throw new Error("unknown session");
      }
      throw new Error(`unexpected method ${method}`);
    },
  });

  const supervisor = createFakeSupervisor({
    ensureResult: { started: false, owned: false, pid: null },
  });
  const policy = new WorkspacePolicy({ roots: [dataDir] });
  const store = new TaskStore({ dataDir });
  await store.init();
  const service = new DshAdapterService({
    rpc,
    supervisor,
    workspacePolicy: policy,
    taskStore: store,
    config: { pluginVersion: "0.3.0", autoStart: true },
    sleep: async () => {},
    pollIntervalMs: 10,
    classificationGraceMs: 0,
  });

  // 1) run-task with synchronous wait -> done (completed turn + assistant text)
  const submitted = await service.submit({ prompt: "offline smoke task", cwd: dataDir, waitSeconds: 5 });
  assert.equal(submitted.waitOutcome, "completed");
  assert.equal(submitted.task.resultText, "smoke done");
  assert.equal(submitted.task.status, "done");
  assert.equal(submitted.task.terminalReason, "completed");
  const taskId = submitted.task.id;

  // 2) get-task
  const inspected = await service.inspect(taskId, { includeRaw: true });
  assert.equal(inspected.resultText, "smoke done");
  assert.equal(inspected.task.dsh.running, false);
  assert.equal(inspected.task.status, "done");

  // 3) cancel on a terminal task is an idempotent no-op
  const cancelled = await service.cancel(taskId);
  assert.equal(cancelled.accepted, false);
  assert.equal(cancelled.task.status, "done");

  // 4) async submit -> cancel (accepted -> cancelling) -> observation -> cancelled
  const asyncTask = await service.submit({ prompt: "second task", cwd: dataDir, waitSeconds: 0 });
  assert.equal(asyncTask.task.status, "running");
  const cancelReq = await service.cancel(asyncTask.task.id);
  assert.equal(cancelReq.accepted, true);
  assert.equal(cancelReq.task.status, "cancelling", "accepted cancel is not immediately cancelled");
  const observed = await service.inspect(asyncTask.task.id);
  assert.equal(observed.task.status, "cancelled");
  assert.equal(observed.task.terminalReason, "aborted");

  // 5) task metadata survives a store re-open (legacy-safe round trip)
  const reopened = new TaskStore({ dataDir });
  await reopened.init();
  assert.equal(reopened.get(taskId).status, "done");
  assert.equal(reopened.get(taskId).resultText, "smoke done");
  assert.equal(reopened.get(asyncTask.task.id).status, "cancelled");
  assert.equal(reopened.get(asyncTask.task.id).sessionId, secondId);

  // 6) the monitor snapshot aggregates status + recent tasks, fail-soft
  const overview = await service.overview();
  assert.equal(overview.status.reachable, true);
  assert.equal(overview.status.taskCount, 2);
  assert.equal(overview.tasks.length, 2);
  const byStatus = new Map(overview.tasks.map((entry) => [entry.status, entry]));
  assert.equal(byStatus.get("cancelled").resultSummary, null);
  assert.equal(byStatus.get("done").resultSummary, "smoke done");
  assert.equal(overview.recentError, null);
  assert.equal(typeof overview.refreshedAt, "number");
});
