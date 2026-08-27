// tools: agent-facing tool wrappers forward to the service WITHOUT forcing
// operator policy (M6: run-task must not hardcode autoStart:true).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTaskModule, getTaskModule, cancelTaskModule, diagnoseModule } from "./helpers/tool-imports.js";

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

test("diagnose reports healthy when node/executable/connectivity/workspace all pass", async () => {
  const fakeConfig = {
    executable: path.join(os.tmpdir(), "dsh-bin.js"),
    pluginVersion: "0.4.0",
    url: "http://127.0.0.1:3080",
    autoStart: true,
    approvalNotify: true,
    approvalTimeoutMs: 0,
  };
  // Real temp file so existsSync passes; diagnose only probes --version for
  // the executable, and this fake one won't respond — acceptable here because
  // the test focuses on plumbing (ctx wiring, output shape), not DSH install.
  const binPath = fakeConfig.executable;
  fs.writeFileSync(binPath, "");
  try {
    const ctx = {
      _dshAdapter: {
        service: {},
        config: fakeConfig,
        supervisor: {
          status: async () => ({ reachable: true, url: fakeConfig.url, owned: false, pid: null }),
        },
        workspacePolicy: { listRoots: () => [] },
        taskStore: { list: () => [] },
      },
    };
    const out = await diagnoseModule.execute({}, ctx);
    const parsed = JSON.parse(out.content[0].text);
    assert.equal(parsed.verdict, "broken", "fake bin fails the version probe -> broken");
    assert.ok(Array.isArray(parsed.checks) && parsed.checks.length === 4);
    assert.equal(parsed.checks[0].check, "node");
  } finally {
    fs.rmSync(binPath, { force: true });
  }
});

test("diagnose flags unreachable DSH with a plain-language fix hint", async () => {
  const fakeConfig = {
    executable: "",
    pluginVersion: "0.4.0",
    url: "http://127.0.0.1:3080",
  };
  const ctx = {
    _dshAdapter: {
      service: {},
      config: fakeConfig,
      supervisor: {
        status: async () => ({
          reachable: false,
          url: fakeConfig.url,
          owned: false,
          pid: null,
          probeError: "ECONNREFUSED",
        }),
      },
      workspacePolicy: { listRoots: () => ["C:\\Windows"] },
      taskStore: { list: () => [] },
    },
  };
  const out = await diagnoseModule.execute({}, ctx);
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.verdict, "broken");
  const conn = parsed.checks.find((c) => c.check === "connectivity");
  assert.equal(conn.status, "fail");
  assert.match(conn.fix, /start|dsh web/);
});
