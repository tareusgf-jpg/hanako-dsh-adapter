// Real-DSH approval-loop smoke: exercises the Phase 1 approval chain against
// a REAL running DSH — ApprovalMuxListener (events.mux WS) → ApprovalStore
// → ApprovalService.respondApproval (POST /api/respond) → task completes.
//
// Scenario: submit a task whose prompt REQUIRES a tool call (write a marker
// file). DSH's sandbox asks for approval; the adapter must observe the
// approval/requested frame, let the smoke approve it once (allowed-once),
// and then the task must settle to done with the file actually written.
//
// Contract (same spirit as smoke-real.mjs):
// - URL override via DSH_SMOKE_URL, validated loopback-only by lib/config.js.
// - Creates ONE marker file in the project root, removed in `finally`.
// - Never installs/publishes plugins; never stops DSH; never cancels sessions.
//
// Usage:
//   DSH_SMOKE_WAIT_SECONDS=420 npm run smoke:approval:real
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDshUrl, DEFAULT_URL, DEFAULT_EXECUTABLE } from "../lib/config.js";
import { DshRpcClient } from "../lib/dsh-rpc-client.js";
import { DshProcessSupervisor } from "../lib/dsh-process-supervisor.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { TaskStore } from "../lib/task-store.js";
import { ApprovalStore } from "../lib/approval-store.js";
import { ApprovalService } from "../lib/approval-service.js";
import { DshAdapterService } from "../lib/dsh-adapter-service.js";

const MARKER_FILE = ".smoke-approval-marker.txt";
const MARKER = "HANA-DSH-APPROVAL-SMOKE-7B1D3A9F";
const OUTSIDE_MARKER_FILE = path.join(
  process.env.USERPROFILE || "C:\\Users\\Dawalithy",
  "Desktop",
  "hana-dsh-approval-marker.txt",
);
const MAX_WAIT_SECONDS = 900;
const APPROVAL_POLL_MS = 1000;
const APPROVAL_GRACE_SECONDS = 120;
const log = (line) => console.log(`[smoke-approval-real] ${line}`);

const projectRoot = path.resolve(import.meta.dirname, "..");
const dataDir = await fs.mkdtemp(path.join(projectRoot, ".smoke-approval-real-"));

let url;
try {
  url = normalizeDshUrl(process.env.DSH_SMOKE_URL ?? DEFAULT_URL);
} catch (error) {
  console.error(`[smoke-approval-real] FAILED: invalid DSH_SMOKE_URL: ${error.message}`);
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(2);
}

let waitSeconds = 420;
const waitRaw = process.env.DSH_SMOKE_WAIT_SECONDS;
if (waitRaw !== undefined && waitRaw.trim() !== "") {
  const n = Number(waitRaw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WAIT_SECONDS) {
    console.error(
      `[smoke-approval-real] FAILED: DSH_SMOKE_WAIT_SECONDS must be an integer 1..${MAX_WAIT_SECONDS}, got "${waitRaw}"`,
    );
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(2);
  }
  waitSeconds = n;
}

let exitCode = 0;
const markerPath = path.join(projectRoot, MARKER_FILE);
let approvalService = null;
try {
  await fs.rm(markerPath, { force: true });

  const rpc = new DshRpcClient({ baseUrl: url });
  const probe = await rpc.health();
  if (probe.ok !== true) {
    throw new Error(
      `DSH is not reachable at ${url} (${probe.error ?? `HTTP ${probe.status}`}); start it first`,
    );
  }
  log(`DSH reachable at ${url} (probe HTTP ${probe.status})`);

  const policy = new WorkspacePolicy({ roots: [projectRoot] });
  const supervisor = new DshProcessSupervisor({ executable: DEFAULT_EXECUTABLE, rpc });
  const store = new TaskStore({ dataDir });
  await store.init();
  const approvalStore = new ApprovalStore({ dataDir });
  await approvalStore.init();

  approvalService = new ApprovalService({
    store: approvalStore,
    taskStore: store,
    rpc,
    config: { url, approvalNotify: false, approvalTimeoutMs: 0 },
    log: null,
  });
  approvalService.start();
  log("approval service started (events.mux listener connected)");

  const service = new DshAdapterService({
    rpc,
    supervisor, // autoStart=false semantics: never start/stop DSH
    workspacePolicy: policy,
    taskStore: store,
    config: { pluginVersion: "0.4.0", autoStart: false },
    pollIntervalMs: 1000,
    classificationGraceMs: 30_000,
  });

  const prompt = [
    `Using your available write tool, create a file at this exact absolute path: ${OUTSIDE_MARKER_FILE}`,
    `The file content must be exactly: ${MARKER}`,
    `This path is OUTSIDE the workspace and NOT a temporary area, so your sandbox will deny it first.`,
    `If denied, follow the tool's escalation guidance: retry with sandbox_permissions and a one-sentence justification — that will ask the user for approval, which is expected.`,
    `Then reply with the exact marker text: ${MARKER}`,
  ].join(" ");

  log(`dataDir=${dataDir}`);
  log(`cwd=${projectRoot}`);
  log(`wait=${waitSeconds}s (override with DSH_SMOKE_WAIT_SECONDS)`);

  // 0. Start the approval observer FIRST: it races with the task, approving
  // exactly one pending approval as soon as it surfaces (the real-time flow:
  // denial -> escalation retry -> ask -> our approve -> task continues).
  let approvalObserved = null;
  const approvalRace = (async () => {
    const deadline = Date.now() + APPROVAL_GRACE_SECONDS * 1000;
    while (Date.now() < deadline) {
      const pendings = approvalService.listPending();
      if (pendings.length > 0) {
        approvalObserved = approvalStore.get(pendings[0].approvalId);
        if (!approvalObserved) {
          throw new Error("approval record vanished between list and get");
        }
        return approvalObserved;
      }
      await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_MS));
    }
    throw new Error(
      `no approval surfaced through the adapter within ${APPROVAL_GRACE_SECONDS}s`,
    );
  })();

  // 1. Submit — the task blocks on the sandbox denial + escalation ask.
  const submitted = await service.submit({ prompt, cwd: projectRoot, waitSeconds });
  const task = submitted.task;
  log(
    `submit -> task=${task.id} status=${task.status} waitOutcome=${submitted.waitOutcome} sessionId=${task.sessionId}`,
  );

  // 2. Wait for the approval to surface through the adapter's own listener.
  const record = await approvalRace;
  log(
    `approval observed -> approvalId=${record.approvalId} toolName=${record.toolName} reason=${record.reasonSummary} source=${record.source} rpcId=${record.rpcId ? "present" : "MISSING"}`,
  );
  if (typeof record.rpcId !== "string" || record.rpcId === "") {
    throw new Error("approval record has no rpcId — answering is impossible (chain broken)");
  }

  // 3. Approve exactly once (allowed-once), through the service's ONLY answer
  // path. The user may have already answered in the DSH Web UI (the native
  // fallback channel) — that race is by design: whoever answers first wins,
  // the plugin never re-answers. In that case the task settles on its own and
  // the approval record is already resolved; treat it as the same success.
  let answered = null;
  try {
    answered = await approvalService.respondApproval({
      approvalId: record.approvalId,
      outcome: "allowed-once",
    });
    log(`respondApproval -> ok=${answered.ok} (plugin answered first)`);
  } catch (error) {
    if (error?.code === "not-pending") {
      log(`respondApproval -> already resolved (user answered in the DSH Web UI); racing is by design`);
    } else {
      throw error;
    }
  }

  // 4. The task must now settle to done (poll through the adapter; the DSH
  // session state may lag the turn end by a moment).
  const doneDeadline = Date.now() + APPROVAL_GRACE_SECONDS * 1000;
  let done = task.status === "done";
  while (!done && Date.now() < doneDeadline) {
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_MS));
    const inspected = await service.inspect(task.id);
    done = inspected.task.status === "done";
  }
  if (!done) {
    throw new Error(`task did not reach done after approval (last status=${task.status})`);
  }
  let fileContent = null;
  try {
    fileContent = await fs.readFile(OUTSIDE_MARKER_FILE, "utf8");
  } catch {
    // fall through — check below
  }
  if (fileContent !== MARKER) {
    throw new Error(
      `marker file missing or wrong after approval (content=${JSON.stringify(fileContent)})`,
    );
  }
  log("asserted: sandbox denial -> escalation retry -> approval observed -> approved once -> task done -> file written outside workspace");
  log("APPROVAL REAL SMOKE OK");
} catch (error) {
  console.error(`[smoke-approval-real] FAILED: ${error?.stack || error}`);
  exitCode = 1;
} finally {
  approvalService?.dispose?.();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(markerPath, { force: true }).catch(() => {});
  await fs.rm(OUTSIDE_MARKER_FILE, { force: true }).catch(() => {});
}
process.exit(exitCode);
