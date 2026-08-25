// Real-DSH smoke: exercises the adapter's REAL source — DshRpcClient,
// DshAdapterService, TaskStore, WorkspacePolicy, DshProcessSupervisor — against
// a REAL running DeepSeek Harness (DSH) at a loopback URL (default
// http://127.0.0.1:3080). No fakes, no bypassing the adapter.
//
// Contract:
// - URL override via DSH_SMOKE_URL is still validated by lib/config.js
//   normalizeDshUrl (loopback-only); non-loopback values are rejected.
// - The smoke creates ONE normal DSH session (a trivial marker-only task) and
//   leaves it in DSH — visible in the DSH Web UI. It does NOT cancel it and
//   does NOT stop DSH.
// - The only directory it creates is a project-internal temp data dir
//   (".smoke-real-*" under the project root), removed in `finally`.
// - It never installs/publishes plugins and never modifies project files.
// - Task cwd is the project root; the prompt forbids tools and file changes.
//
// Usage:
//   npm run smoke:real
//   DSH_SMOKE_URL=http://127.0.0.1:3080 npm run smoke:real
//   DSH_SMOKE_WAIT_SECONDS=300 npm run smoke:real   (default 180, max 900)
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDshUrl, DEFAULT_URL, DEFAULT_EXECUTABLE } from "../lib/config.js";
import { DshRpcClient } from "../lib/dsh-rpc-client.js";
import { DshProcessSupervisor } from "../lib/dsh-process-supervisor.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { TaskStore } from "../lib/task-store.js";
import { DshAdapterService } from "../lib/dsh-adapter-service.js";

const MARKER = "HANA-DSH-REAL-SMOKE-MARKER-4F9E7C2A";
const MAX_WAIT_SECONDS = 900;
const log = (line) => console.log(`[smoke-real] ${line}`);

const projectRoot = path.resolve(import.meta.dirname, "..");
const dataDir = await fs.mkdtemp(path.join(projectRoot, ".smoke-real-"));

let url;
try {
  url = normalizeDshUrl(process.env.DSH_SMOKE_URL ?? DEFAULT_URL);
} catch (error) {
  console.error(`[smoke-real] FAILED: invalid DSH_SMOKE_URL: ${error.message}`);
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(2);
}

let waitSeconds = 180;
const waitRaw = process.env.DSH_SMOKE_WAIT_SECONDS;
if (waitRaw !== undefined && waitRaw.trim() !== "") {
  const n = Number(waitRaw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WAIT_SECONDS) {
    console.error(
      `[smoke-real] FAILED: DSH_SMOKE_WAIT_SECONDS must be an integer 1..${MAX_WAIT_SECONDS}, got "${waitRaw}"`,
    );
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(2);
  }
  waitSeconds = n;
}

let exitCode = 0;
try {
  // Real RPC client against the real DSH. autoStart=false: the smoke never
  // starts or stops DSH — a reachable external DSH is simply reused.
  const rpc = new DshRpcClient({ baseUrl: url });
  const probe = await rpc.health();
  if (probe.ok !== true) {
    throw new Error(
      `DSH is not reachable at ${url} (${probe.error ?? `HTTP ${probe.status}`}); start it first, e.g. dsh web --host 127.0.0.1 --port 3080`,
    );
  }
  log(`DSH reachable at ${url} (probe HTTP ${probe.status})`);

  const supervisor = new DshProcessSupervisor({ executable: DEFAULT_EXECUTABLE, rpc });
  const policy = new WorkspacePolicy({ roots: [projectRoot] });
  const store = new TaskStore({ dataDir });
  await store.init();
  const service = new DshAdapterService({
    rpc,
    supervisor,
    workspacePolicy: policy,
    taskStore: store,
    config: { pluginVersion: "0.3.0", autoStart: false },
    pollIntervalMs: 1000,
    classificationGraceMs: 30_000, // production default observation grace
  });

  const prompt = `Do not call any tools and do not modify or create any files. Reply with exactly the following marker text and nothing else: ${MARKER}`;

  log(`dataDir=${dataDir}`);
  log(`cwd=${projectRoot}`);
  log(`wait=${waitSeconds}s (override with DSH_SMOKE_WAIT_SECONDS)`);

  // Full adapter submit chain: persist creating -> session.create (wire
  // passthrough of the pre-allocated sessionId) -> prompt -> wait loop.
  const submitted = await service.submit({ prompt, cwd: projectRoot, waitSeconds });
  const task = submitted.task;
  log(
    `submit -> task=${task.id} status=${task.status} terminalReason=${task.terminalReason} waitOutcome=${submitted.waitOutcome} sessionId=${task.sessionId}`,
  );

  if (submitted.waitOutcome !== "completed" || task.status !== "done") {
    throw new Error(
      `task did not settle to done within ${waitSeconds}s (status=${task.status}, waitOutcome=${submitted.waitOutcome}); check the session in the DSH Web UI at ${url}`,
    );
  }
  if (typeof task.resultText !== "string" || !task.resultText.includes(MARKER)) {
    throw new Error(`resultText does not contain the marker: ${JSON.stringify(task.resultText)}`);
  }
  // The adapter pre-allocates session-<uuid> and only reaches "done" after DSH
  // echoed the SAME id back (create-id-mismatch otherwise fails the task), so
  // a successful submit itself proves the create wire passthrough.
  if (typeof task.sessionId !== "string" || !task.sessionId.startsWith("session-")) {
    throw new Error(`sessionId is not the adapter's pre-allocated id: ${JSON.stringify(task.sessionId)}`);
  }
  log("asserted: status=done, resultText contains the marker, sessionId is the pre-allocated/echoed id");

  // A second observation through the adapter (inspect) must agree.
  const inspected = await service.inspect(task.id);
  log(
    `inspect -> status=${inspected.task.status} running=${inspected.task.dsh.running} sessionFound=${inspected.task.dsh.sessionFound} result=${JSON.stringify(inspected.resultText)}`,
  );
  if (inspected.task.status !== "done") {
    throw new Error(`inspect disagrees: task is ${inspected.task.status}, expected done`);
  }
  if (inspected.task.dsh.sessionFound !== true) {
    throw new Error("inspect: the DSH session was not found via session.list");
  }
  if (typeof inspected.resultText !== "string" || !inspected.resultText.includes(MARKER)) {
    throw new Error(`inspect: resultText does not contain the marker: ${JSON.stringify(inspected.resultText)}`);
  }

  log(`sessionId=${task.sessionId}`);
  log("REAL SMOKE OK");
} catch (error) {
  console.error(`[smoke-real] FAILED: ${error?.stack || error}`);
  exitCode = 1;
} finally {
  // Remove ONLY the temp data dir this script created; DSH sessions are never
  // deleted and DSH itself is never stopped.
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
