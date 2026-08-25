// Offline smoke: run-task -> get-task -> cancel closed loop with fakes under
// Phase 0 semantics (state machine + cancelling->observed-terminal), plus the
// Phase 1 approval loop (events.mux frame -> record -> chat push -> respond ->
// resolved feedback).
// Usage: node scripts/smoke-offline.mjs   (no network, no real DSH process)
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { TaskStore } from "../lib/task-store.js";
import { ApprovalStore } from "../lib/approval-store.js";
import { ApprovalService } from "../lib/approval-service.js";
import { DshAdapterService } from "../lib/dsh-adapter-service.js";
import {
  createFakeRpc,
  createFakeSupervisor,
  createFakeMuxTransport,
  approvalRequestedFrame,
  approvalResolvedFrame,
} from "../tests/helpers/fake-dsh.js";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-smoke-cli-"));
const log = (line) => console.log(`[smoke] ${line}`);

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

try {
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
  const supervisor = createFakeSupervisor({ ensureResult: { started: false, owned: false, pid: null } });
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

  log("dataDir=" + dataDir);
  const submitted = await service.submit({ prompt: "offline smoke task", cwd: dataDir, waitSeconds: 5 });
  log(`run-task -> task=${submitted.task.id} status=${submitted.task.status} terminalReason=${submitted.task.terminalReason} wait=${submitted.waitOutcome} result=${JSON.stringify(submitted.task.resultText)}`);
  if (submitted.task.status !== "done") throw new Error("submit with wait should settle to done");
  if (submitted.task.resultText !== "smoke done") throw new Error("unexpected result text");

  const inspected = await service.inspect(submitted.task.id, { includeRaw: true });
  log(`get-task  -> status=${inspected.task.status} running=${inspected.task.dsh.running} rawEvents=${inspected.raw.length}`);
  if (inspected.task.dsh.running !== false) throw new Error("session should be idle");

  const cancelled = await service.cancel(submitted.task.id);
  log(`cancel(terminal) -> accepted=${cancelled.accepted} status=${cancelled.task.status}`);
  if (cancelled.accepted !== false || cancelled.task.status !== "done") {
    throw new Error("cancel on a terminal task must be a no-op");
  }

  const asyncTask = await service.submit({ prompt: "second task", cwd: dataDir, waitSeconds: 0 });
  log(`run-task(async) -> status=${asyncTask.task.status}`);
  const cancelReq = await service.cancel(asyncTask.task.id);
  log(`cancel    -> accepted=${cancelReq.accepted} status=${cancelReq.task.status}`);
  if (cancelReq.accepted !== true || cancelReq.task.status !== "cancelling") {
    throw new Error("accepted cancel must move the task to cancelling");
  }
  const observed = await service.inspect(asyncTask.task.id);
  log(`observe   -> status=${observed.task.status} terminalReason=${observed.task.terminalReason}`);
  if (observed.task.status !== "cancelled") throw new Error("cancelling task should settle to cancelled");

  const status = await service.status();
  log(`status    -> reachable=${status.reachable} taskCount=${status.taskCount}`);

  const overview = await service.overview();
  log(`overview  -> tasks=${overview.tasks.length} first=${overview.tasks[0]?.status} summary=${JSON.stringify(overview.tasks[0]?.resultSummary)} recentError=${overview.recentError ? overview.recentError.code : "none"}`);
  if (overview.tasks.length !== 2) throw new Error("overview should aggregate exactly the two smoke tasks");
  if (overview.recentError !== null) throw new Error("overview should have no recent error");

  // ── Phase 1: approval loop (fake events.mux + recorded bus) ──────────────
  const approvalStore = new ApprovalStore({ dataDir });
  await approvalStore.init();
  const sends = [];
  const taskUpdates = [];
  const respondCalls = [];
  const mux = createFakeMuxTransport();
  const approvalService = new ApprovalService({
    store: approvalStore,
    taskStore: store,
    rpc: {
      respondApproval: async (payload) => {
        respondCalls.push(payload);
        return { accepted: true };
      },
      history: async () => ({ events: [], hasMore: false }),
    },
    config: { url: "http://127.0.0.1:3080" },
    busRequest: async (name, payload) => {
      if (name === "session:send") sends.push(payload);
      if (name === "task:update") taskUpdates.push(payload);
    },
    sleep: async () => {},
    transportFactory: mux.transportFactory,
  });
  approvalService.start();
  await mux.controller.whenConnected();

  mux.controller.injectFrame(approvalRequestedFrame({ sessionId: firstId, reason: "smoke approval reason" }));
  await approvalStore.flush();
  await new Promise((resolve) => setImmediate(resolve));
  const pending = approvalService.listPending();
  log(`approval  -> pending=${pending.length} tool=${pending[0]?.toolName} pushes=${sends.length}`);
  if (pending.length !== 1) throw new Error("approval frame must persist one pending approval");
  if (sends.length !== 1 || !sends[0].text.includes("[DSH 审批]")) throw new Error("approval request must push a chat summary");
  if (taskUpdates.length !== 1 || taskUpdates[0].status !== "blocked") throw new Error("approval request must mark the task blocked");

  const answered = await approvalService.respondApproval({ approvalId: pending[0].approvalId, outcome: "allowed-once" });
  log(`respond   -> ok=${answered.ok} pushes=${sends.length}`);
  if (answered.ok !== true) throw new Error("respondApproval should succeed");
  if (respondCalls.length !== 1 || respondCalls[0].outcome !== "allowed-once") throw new Error("respond must reach DSH exactly once with allowed-once");
  if (approvalService.listPending().length !== 0) throw new Error("approval must be resolved after respond");
  if (!sends[1].text.includes("已批准一次")) throw new Error("resolve must push approved feedback");

  mux.controller.injectFrame(approvalResolvedFrame({ sessionId: firstId, approvalId: "approval-unknown" }));
  await approvalStore.flush();
  log("approval  -> resolved feedback for unknown id is a no-op (ok)");

  log("SMOKE OK");
  process.exit(0);
} catch (error) {
  console.error("[smoke] FAILED:", error?.stack || error);
  process.exit(1);
} finally {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
