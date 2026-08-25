// tools: agent-facing tool wrappers forward to the service WITHOUT forcing
// operator policy (M6: run-task must not hardcode autoStart:true).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { runTaskModule, getTaskModule, cancelTaskModule } from "./helpers/tool-imports.js";

// Generic absolute paths — the fake service only forwards them.
const WS = path.join(os.tmpdir(), "dsh-tools-workspace");
const ROOT = path.parse(os.tmpdir()).root;

function makeCtx(service) {
  return { _dshAdapter: { service } };
}

test("run-task forwards prompt/cwd/preset/wait and does NOT force autoStart (falls back to plugin config)", async () => {
  let received = null;
  const ctx = makeCtx({
    submit: async (opts) => {
      received = opts;
      return { task: { id: "task_1", status: "running" }, waitOutcome: "none" };
    },
  });
  const out = await runTaskModule.execute(
    { prompt: "do the work", cwd: WS, agentPreset: "router-standard", waitSeconds: 30 },
    ctx,
  );
  assert.ok(out.content[0].text.includes("task_1"));
  assert.equal(received.prompt, "do the work");
  assert.equal(received.cwd, WS);
  assert.equal(received.agentPreset, "router-standard");
  assert.equal(received.waitSeconds, 30);
  assert.equal("autoStart" in received, false, "autoStart must be left undefined so the plugin config decides");
});

test("run-task rejects when the plugin runtime is not initialized", async () => {
  await assert.rejects(() => runTaskModule.execute({ prompt: "p", cwd: ROOT }, {}), /尚未初始化/);
});

test("get-task forwards includeRaw and cancel-task forwards taskId", async () => {
  let inspectOpts = null;
  let cancelId = null;
  const ctx = makeCtx({
    inspect: async (id, opts) => {
      inspectOpts = { id, opts };
      return { task: { id }, resultText: "x" };
    },
    cancel: async (id) => {
      cancelId = id;
      return { task: { id, status: "cancelling" }, accepted: true };
    },
  });
  await getTaskModule.execute({ taskId: "task_9", includeRaw: true }, ctx);
  assert.deepEqual(inspectOpts, { id: "task_9", opts: { includeRaw: true } });
  const out = await cancelTaskModule.execute({ taskId: "task_9" }, ctx);
  assert.equal(cancelId, "task_9");
  assert.ok(out.content[0].text.includes("cancelling"));
});
