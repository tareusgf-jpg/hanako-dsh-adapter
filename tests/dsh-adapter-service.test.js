// dsh-adapter-service: Phase 0 state machine — submit chain (preallocated
// sessionId, persist-before-create, idempotent create retry), observation
// (terminal classification, orphan detection, grace windows), cancel
// (cancelling → observed terminal), result extraction and raw-summary
// sanitization.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DshAdapterService,
  DshAdapterError,
  extractFinalAssistantText,
  sanitizeEventSummary,
  validateAgentPreset,
  validatePrompt,
  validateWaitSeconds,
  summarizePrompt,
} from "../lib/dsh-adapter-service.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { TaskStore } from "../lib/task-store.js";
import { DshRpcError } from "../lib/dsh-rpc-client.js";
import { DshStartError } from "../lib/dsh-process-supervisor.js";
import { createFakeRpc, createFakeSupervisor } from "./helpers/fake-dsh.js";

const CONFIG = {
  pluginVersion: "0.3.0",
  autoStart: true,
};

async function makeService(t, { rpc = null, supervisor = null, graceMs = 0 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-adapter-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  const policy = new WorkspacePolicy({ roots: [dataDir] });
  let tick = 0;
  const now = () => tick;
  const sleep = async () => {
    tick += 1000; // each poll advances one simulated second
  };
  const store = new TaskStore({ dataDir, now });
  await store.init();
  const service = new DshAdapterService({
    rpc: rpc ?? createFakeRpc(),
    supervisor: supervisor ?? createFakeSupervisor(),
    workspacePolicy: policy,
    taskStore: store,
    config: CONFIG,
    now,
    sleep,
    pollIntervalMs: 100,
    classificationGraceMs: graceMs,
  });
  const advance = (ms) => {
    tick += ms;
  };
  return { service, store, policy, dataDir, advance };
}

async function seedTask(store, dataDir, { sessionId = "s-1", status = "running" } = {}) {
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

const HISTORY_RUNNING = (sessionId) => ({
  items: [{ sessionId, running: true, updatedAt: 123, blank: false }],
});

const ev = (type, data = {}, seq = 0) => ({ event: { seq, type, time: 100 + seq, data } });

const TURN_COMPLETED = (seq = 9) => ev("turn/end", { turn: 1, reason: { kind: "completed" } }, seq);
const TURN_ERROR = (seq = 9) =>
  ev("turn/end", { turn: 1, reason: { kind: "error", error: { code: "UPSTREAM", message: "boom" } } }, seq);
const TURN_ABORTED = (seq = 9) =>
  ev("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }, seq);

const ASSISTANT_EVENTS = [
  {
    event: {
      seq: 1,
      type: "user/message",
      time: 100,
      data: { message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    },
  },
  {
    event: {
      seq: 2,
      type: "tool/call",
      time: 101,
      data: { name: "read_file", arguments: '{"path":"C:\\\\secret"}' },
    },
  },
  {
    event: {
      seq: 3,
      type: "assistant/message",
      time: 102,
      data: {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first line" },
            { type: "tool_use", id: "x", name: "write", input: {} },
            { type: "text", text: "final answer" },
          ],
        },
      },
    },
  },
];

// ── Validation ──────────────────────────────────────────────────────────────

test("submit validates prompt / preset / wait bounds", async (t) => {
  const { service, dataDir } = await makeService(t);
  // prompt validation happens before cwd validation
  await assert.rejects(() => service.submit({ prompt: "", cwd: "x" }), (e) => e.code === "invalid-prompt");
  await assert.rejects(() => service.submit({ prompt: "   ", cwd: "x" }), (e) => e.code === "invalid-prompt");
  await assert.rejects(() => service.submit({ prompt: 42, cwd: "x" }), (e) => e.code === "invalid-prompt");
  // preset / wait validation runs after cwd validation — use a real cwd
  await assert.rejects(
    () => service.submit({ prompt: "ok", cwd: dataDir, agentPreset: "../evil" }),
    (e) => e.code === "invalid-preset",
  );
  await assert.rejects(
    () => service.submit({ prompt: "ok", cwd: dataDir, waitSeconds: -1 }),
    (e) => e.code === "invalid-wait",
  );
  await assert.rejects(
    () => service.submit({ prompt: "ok", cwd: dataDir, waitSeconds: 901 }),
    (e) => e.code === "invalid-wait",
  );

  assert.equal(validateAgentPreset(undefined), "router-standard");
  assert.equal(validateAgentPreset("custom-v2.x"), "custom-v2.x");
  assert.throws(() => validateAgentPreset("has space"), DshAdapterError);
  assert.throws(() => validatePrompt("x".repeat(200_001)), DshAdapterError);
  assert.equal(validateWaitSeconds(null), 0);
  assert.equal(validateWaitSeconds(10), 10);
  assert.equal(summarizePrompt("abcdef", 3), "ab…");
});

test("submit rejects cwd outside roots / missing / file path", async (t) => {
  const { service, dataDir } = await makeService(t);
  const outside = path.join(path.dirname(dataDir), `outside-${path.basename(dataDir)}`);
  await assert.rejects(
    () => service.submit({ prompt: "p", cwd: outside }),
    (e) => e.code === "outside-root",
  );
  const missing = path.join(dataDir, "nope", "deep");
  await assert.rejects(
    () => service.submit({ prompt: "p", cwd: missing }),
    (e) => e.code === "invalid-cwd",
  );
  const filePath = path.join(dataDir, "a-file.txt");
  await fs.writeFile(filePath, "x", "utf8");
  await assert.rejects(
    () => service.submit({ prompt: "p", cwd: filePath }),
    (e) => e.code === "invalid-cwd",
  );
  await assert.rejects(() => service.submit({ prompt: "p", cwd: "" }), (e) => e.code === "invalid-cwd");
});

test("validatePrompt rejects slash-prefixed prompts (DSH slash commands are not executed)", async (t) => {
  // DSH treats a single text block starting with "/" as a slash command. The
  // adapter is a task bridge and must reject them explicitly, before any RPC.
  for (const bad of ["/help", "/compact now", "  /model gpt", "/", "/x".repeat(50)]) {
    assert.throws(() => validatePrompt(bad), (e) => e.code === "invalid-prompt", `prompt ${JSON.stringify(bad)}`);
  }
  // Non-command prompts are unaffected.
  assert.equal(validatePrompt("  fix the bug  "), "fix the bug");
  assert.equal(validatePrompt("a/b/c is a path, not a command"), "a/b/c is a path, not a command");
  // submit rejects before any RPC / persistence / supervisor action.
  const { service, store } = await makeService(t);
  const supervisor = createFakeSupervisor();
  service.supervisor = supervisor;
  await assert.rejects(
    () => service.submit({ prompt: "/help", cwd: "x" }),
    (e) => e.code === "invalid-prompt",
  );
  assert.equal(store.list().length, 0, "no task record is created for a rejected prompt");
  assert.equal(supervisor.calls.length, 0, "no supervisor/RPC action for a rejected prompt");
  assert.equal(service.rpc.calls.length, 0);
});

// ── Submit chain (Phase 0) ──────────────────────────────────────────────────

test("submit persists a creating record with a preallocated sessionId BEFORE session.create", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  let createPayload = null;
  let promptPayload = null;
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.create") {
        createPayload = payload;
        assert.equal(typeof payload.sessionId, "string");
        assert.ok(payload.sessionId.startsWith("session-"), "adapter pre-allocates the session id");
        assert.equal(payload.cwd, dataDir);
        assert.equal(payload.agentPreset, "router-standard");
        // The local record must exist and be "creating" at create time.
        const records = store.list();
        assert.equal(records.length, 1);
        assert.equal(records[0].sessionId, payload.sessionId);
        assert.equal(records[0].status, "creating");
        assert.equal(records[0].promptLength, 11);
        return { sessionId: payload.sessionId };
      }
      if (method === "session.prompt") {
        promptPayload = payload;
        return { accepted: true };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  service.rpc = rpc;

  const result = await service.submit({ prompt: "  do the work  ", cwd: dataDir, waitSeconds: 0 });
  const task = result.task;
  assert.ok(task.id.startsWith("task_"));
  assert.equal(task.status, "running");
  assert.equal(task.terminalReason, null);
  assert.equal(task.cwd, dataDir);
  assert.equal(task.agentPreset, "router-standard");
  assert.equal(task.promptSummary, "do the work");
  assert.equal(result.waitOutcome, "none");
  // The prompt targets the same pre-allocated session id.
  assert.equal(promptPayload.sessionId, createPayload.sessionId);
  assert.equal(promptPayload.text, "do the work");
  assert.equal(task.sessionId, createPayload.sessionId);
  // The store saw the full creating → submitting → running chain.
  const record = store.get(task.id);
  assert.equal(record.status, "running");
});

test("submit retries session.create idempotently on a transient failure with the SAME sessionId", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  let createCalls = 0;
  let promptCalls = 0;
  let firstSessionId = null;
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.create") {
        createCalls++;
        firstSessionId ??= payload.sessionId;
        if (createCalls === 1) {
          throw new DshRpcError("transport", "ECONNREFUSED");
        }
        assert.equal(payload.sessionId, firstSessionId, "retry must reuse the pre-allocated sessionId");
        return { sessionId: payload.sessionId };
      }
      if (method === "session.prompt") {
        promptCalls++;
        return { accepted: true };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  service.rpc = rpc;

  const result = await service.submit({ prompt: "p", cwd: dataDir });
  assert.equal(createCalls, 2);
  assert.equal(promptCalls, 1);
  assert.equal(result.task.status, "running");
  assert.equal(result.task.sessionId, firstSessionId);
  const record = store.get(result.task.id);
  assert.ok(record.lastError, "the transient failure is recorded in lastError");
  assert.equal(record.status, "running");
});

test("submit: two consecutive transient create failures leave a recoverable creating task", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  let promptCalls = 0;
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.create") {
        throw new DshRpcError("transport", "ECONNREFUSED");
      }
      if (method === "session.prompt") {
        promptCalls++;
        return { accepted: true };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  service.rpc = rpc;

  await assert.rejects(
    () => service.submit({ prompt: "p", cwd: dataDir }),
    (error) => error instanceof DshAdapterError && error.code === "dsh-error" && typeof error.taskId === "string",
  );
  assert.equal(promptCalls, 0, "prompt must never be sent before create is confirmed");
  const record = store.list()[0];
  assert.equal(record.status, "creating", "transient create failure keeps the task non-terminal and recoverable");
  assert.ok(record.lastError);
  assert.ok(record.sessionId.startsWith("session-"));
});

test("submit: hard create failure marks task failed(create-failed) and throws with taskId", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.create") {
        return { error: { code: "agent-preset-not-found", message: "no preset" } };
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  await assert.rejects(
    () => service.submit({ prompt: "p", cwd: dataDir }),
    (error) =>
      error instanceof DshAdapterError &&
      error.code === "dsh-error" &&
      error.status === 502 &&
      typeof error.taskId === "string",
  );
  const record = store.list()[0];
  assert.equal(record.status, "failed");
  assert.equal(record.terminalReason, "create-failed");
  assert.ok(record.lastError);
  assert.ok(record.sessionId, "the DSH session id stays traceable");
});

test("submit: DSH returning a DIFFERENT sessionId is failed, never silently rewritten (M2)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  let createPayload = null;
  let promptCalls = 0;
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.create") {
        createPayload = payload;
        return { sessionId: "session-drifted-other-id" };
      }
      if (method === "session.prompt") {
        promptCalls++;
        return { accepted: true };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  service.rpc = rpc;

  await assert.rejects(
    () => service.submit({ prompt: "p", cwd: dataDir }),
    (error) =>
      error instanceof DshAdapterError &&
      error.code === "dsh-invalid-response" &&
      error.status === 502 &&
      typeof error.taskId === "string" &&
      error.message.includes(createPayload.sessionId),
  );
  assert.equal(promptCalls, 0, "prompt must never be sent after an id mismatch");
  const record = store.list()[0];
  assert.equal(record.status, "failed");
  assert.equal(record.terminalReason, "create-id-mismatch");
  assert.ok(record.lastError.includes("session-drifted-other-id"), "lastError names the drifted id");
  assert.ok(record.lastError.includes(record.sessionId), "lastError names the expected id");
  assert.equal(
    record.sessionId,
    createPayload.sessionId,
    "the record must keep the pre-allocated sessionId, never the drifted one",
  );
  assert.equal(
    store.list().length,
    1,
    "no second record was created for the drifted session",
  );
});

test("submit: prompt failure marks task failed(prompt-failed) and never double-sends", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  let promptCalls = 0;
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.create") return { sessionId: payload.sessionId };
      if (method === "session.prompt") {
        promptCalls++;
        return { error: { code: "agent-busy", message: "busy" } };
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  await assert.rejects(
    () => service.submit({ prompt: "p", cwd: dataDir }),
    (error) => error instanceof DshAdapterError && error.code === "dsh-error" && typeof error.taskId === "string",
  );
  assert.equal(promptCalls, 1);
  const record = store.list()[0];
  assert.equal(record.status, "failed");
  assert.equal(record.terminalReason, "prompt-failed");
  assert.ok(record.lastError.includes("busy"));
});

test("submit maps DSH-unreachable with autoStart disabled to dsh-unavailable", async (t) => {
  const supervisor = createFakeSupervisor({
    ensureResult: new DshStartError("unreachable", "DSH is not reachable and auto-start is disabled"),
  });
  const { service, dataDir } = await makeService(t, { supervisor });
  await assert.rejects(
    () => service.submit({ prompt: "p", cwd: dataDir, autoStart: false }),
    (error) => error instanceof DshAdapterError && error.code === "dsh-unavailable" && error.status === 502,
  );
});

// ── Wait loop ───────────────────────────────────────────────────────────────

test("submit with waitSeconds polls until idle and extracts final text", async (t) => {
  const { service, dataDir } = await makeService(t);
  let sid = null;
  const rpc = createFakeRpc({
    script: ({ method, payload, calls }) => {
      if (method === "session.create") {
        sid = payload.sessionId;
        return { sessionId: payload.sessionId };
      }
      if (method === "session.prompt") return { accepted: true };
      if (method === "session.list") {
        const count = calls.filter((c) => c.method === "session.list").length;
        return count === 1 ? HISTORY_RUNNING(sid) : HISTORY_DONE(sid);
      }
      if (method === "session.history") {
        return { events: [...ASSISTANT_EVENTS, TURN_COMPLETED()], hasMore: false };
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const result = await service.submit({ prompt: "p", cwd: dataDir, waitSeconds: 30 });
  assert.equal(result.waitOutcome, "completed");
  assert.equal(result.task.status, "done");
  assert.equal(result.task.terminalReason, "completed");
  assert.equal(result.task.resultText, "first line\nfinal answer");
});

test("wait loop times out while the session keeps running", async (t) => {
  const { service, dataDir } = await makeService(t);
  let sid = null;
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.create") {
        sid = payload.sessionId;
        return { sessionId: payload.sessionId };
      }
      if (method === "session.prompt") return { accepted: true };
      if (method === "session.list") return HISTORY_RUNNING(sid);
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const result = await service.submit({ prompt: "p", cwd: dataDir, waitSeconds: 3 });
  assert.equal(result.waitOutcome, "timed-out");
  assert.equal(result.task.status, "running");
  assert.equal(result.task.resultText, null);
});

test("wait loop survives transient RPC failures without terminating the task", async (t) => {
  const { service, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.create") return { sessionId: payload.sessionId };
      if (method === "session.prompt") return { accepted: true };
      if (method === "session.list") throw new DshRpcError("transport", "ECONNREFUSED");
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const result = await service.submit({ prompt: "p", cwd: dataDir, waitSeconds: 3 });
  assert.equal(result.waitOutcome, "timed-out");
  assert.equal(result.task.status, "running", "transport failures must never make a task terminal");
});

// ── Inspect / terminal classification ───────────────────────────────────────

test("inspect returns task + DSH status + final text; raw summary hides tool args", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [...ASSISTANT_EVENTS, TURN_COMPLETED()], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });

  const result = await service.inspect(record.id, { includeRaw: true });
  assert.equal(result.resultText, "first line\nfinal answer");
  assert.equal(result.task.dsh.running, false);
  assert.equal(result.task.status, "done");
  assert.equal(result.task.terminalReason, "completed");

  const raw = result.raw;
  assert.ok(Array.isArray(raw));
  const toolRow = raw.find((row) => row.type === "tool/call");
  assert.equal(toolRow.toolName, "read_file");
  assert.equal("arguments" in toolRow, false);
  const serialized = JSON.stringify(raw);
  assert.equal(serialized.includes("C:\\secret"), false);
  // Leak boundary (M4): user/message text (the original prompt "hello") is
  // NEVER included; only assistant text survives.
  const userRow = raw.find((row) => row.type === "user/message");
  assert.ok(userRow, "user/message row is still listed (seq/type/time)");
  assert.equal("text" in userRow, false, "user/message text must never appear in raw");
  assert.equal(serialized.includes("hello"), false, "the prompt text must not leak via user/message");
  const textRows = raw.filter((row) => row.text);
  assert.equal(textRows.length, 1, "only the assistant text row carries text");
  assert.equal(textRows[0].text, "first line\nfinal answer");
});

test("sanitizeEventSummary never leaks user text, tool arguments, credentials or stacks", () => {
  const events = [
    {
      event: {
        seq: 1,
        type: "user/message",
        time: 100,
        data: { message: { role: "user", content: [{ type: "text", text: "please fix /secret with Bearer abc123token" }] } },
      },
    },
    {
      event: {
        seq: 2,
        type: "tool/call",
        time: 101,
        data: { name: "write_file", arguments: '{"path":"C:\\\\secret","content":"password=hunter2"}' },
      },
    },
    {
      event: {
        seq: 3,
        type: "assistant/message",
        time: 102,
        data: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "all done" }],
          },
        },
      },
    },
    {
      event: {
        seq: 4,
        type: "agent/error",
        time: 103,
        data: { error: { message: "boom", stack: "Error: boom\n    at file.js:1:1\n    at Bearer abc123token" } },
      },
    },
    {
      event: {
        seq: 5,
        type: "todo/write",
        time: 104,
        data: { todos: [{ id: "x", title: "secret plan" }] },
      },
    },
  ];
  const summary = sanitizeEventSummary(events);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("please fix"), false, "user prompt text must not leak");
  assert.equal(serialized.includes("abc123token"), false, "credentials must not leak");
  assert.equal(serialized.includes("hunter2"), false, "tool arguments must not leak");
  assert.equal(serialized.includes("C:\\secret"), false);
  assert.equal(serialized.includes("at file.js"), false, "stacks must not leak");
  assert.equal(serialized.includes("secret plan"), false, "arbitrary event data must not leak");
  assert.equal(serialized.includes("all done"), true, "assistant text is preserved");
  const userRow = summary.find((row) => row.type === "user/message");
  assert.deepEqual(Object.keys(userRow).sort(), ["seq", "time", "type"]);
  const toolRow = summary.find((row) => row.type === "tool/call");
  assert.deepEqual(Object.keys(toolRow).sort(), ["seq", "time", "toolName", "type"]);
});

test("inspect: idle + explicit error turn -> failed", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [TURN_ERROR()], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  const result = await service.inspect(record.id);
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.terminalReason, "error");
});

test("inspect: idle + aborted turn -> cancelled", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [TURN_ABORTED()], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  const result = await service.inspect(record.id);
  assert.equal(result.task.status, "cancelled");
  assert.equal(result.task.terminalReason, "aborted");
});

test("inspect: idle + completed turn without text -> no-final-output (never fake success)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [TURN_COMPLETED()], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  const result = await service.inspect(record.id);
  assert.equal(result.task.status, "no-final-output");
  assert.equal(result.task.terminalReason, "completed");
  assert.equal(result.task.resultText, null);
});

test("inspect: idle + torn log (text without turn/end) -> failed, never done", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: ASSISTANT_EVENTS, hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  const result = await service.inspect(record.id);
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.terminalReason, "interrupted");
});

test("inspect: idle + no turn evidence stays non-terminal inside the grace window, then fails", async (t) => {
  const { service, store, dataDir, advance } = await makeService(t, { graceMs: 5000 });
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });

  // Just submitted: a racing observation must not falsely fail the task.
  const early = await service.inspect(record.id);
  assert.equal(early.task.status, "running");
  assert.equal(early.task.uncertainSince, 0, "the observation clock starts on the first absence verdict");
  assert.equal(early.task.uncertainReason, "no-turn");

  advance(6000); // grace (5s) elapsed
  const late = await service.inspect(record.id);
  assert.equal(late.task.status, "failed");
  assert.equal(late.task.terminalReason, "no-turn");
  assert.equal(late.task.uncertainSince, null, "a terminal verdict clears the observation clock");
});

test("inspect: long-running task's FIRST torn observation is never instantly terminal; durable turn/end later settles done (M3)", async (t) => {
  const { service, store, dataDir, advance } = await makeService(t, { graceMs: 5000 });
  let torn = true;
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") {
        return torn ? { events: ASSISTANT_EVENTS, hasMore: false } : { events: [...ASSISTANT_EVENTS, TURN_COMPLETED()], hasMore: false };
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });

  // The task has been "running" for a very long time before the first observation.
  advance(1_000_000);
  const first = await service.inspect(record.id);
  assert.equal(
    first.task.status,
    "running",
    "a long-running task observed torn for the first time must NOT be finalized instantly",
  );
  assert.equal(first.task.terminalReason, null);
  assert.equal(first.task.uncertainReason, "interrupted");
  assert.equal(first.task.uncertainSince, 1_000_000, "the clock starts at the FIRST observation, not at statusChangedAt");

  // The turn completes before the grace elapses: durable evidence wins.
  torn = false;
  advance(1000);
  const second = await service.inspect(record.id);
  assert.equal(second.task.status, "done", "a durable completed turn settles done");
  assert.equal(second.task.terminalReason, "completed");
  assert.equal(second.task.resultText, "first line\nfinal answer");
  assert.equal(second.task.uncertainSince, null);
});

test("inspect: a changed uncertain verdict restarts the observation clock (M3)", async (t) => {
  const { service, store, dataDir, advance } = await makeService(t, { graceMs: 5000 });
  let mode = "empty"; // "empty" | "torn"
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") {
        return mode === "empty" ? { events: [], hasMore: false } : { events: ASSISTANT_EVENTS, hasMore: false };
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });

  // First observation: no-turn, clock starts at 0.
  await service.inspect(record.id);
  advance(3000);
  let mid = await service.inspect(record.id);
  assert.equal(mid.task.uncertainReason, "no-turn");
  assert.equal(mid.task.uncertainSince, 0, "same verdict keeps the original clock");

  // The verdict CHANGES to interrupted: the clock restarts at the new observation.
  mode = "torn";
  advance(1000);
  mid = await service.inspect(record.id);
  assert.equal(mid.task.status, "running");
  assert.equal(mid.task.uncertainReason, "interrupted");
  assert.equal(mid.task.uncertainSince, 4000, "a changed verdict restarts the clock");

  // 4s after the restart (< 5s grace): still observed, not terminal.
  advance(4000);
  mid = await service.inspect(record.id);
  assert.equal(mid.task.status, "running");

  // 2s later: 6s of continuous "interrupted" observation -> terminal.
  advance(2000);
  const late = await service.inspect(record.id);
  assert.equal(late.task.status, "failed");
  assert.equal(late.task.terminalReason, "interrupted");
});

test("inspect: re-running clears the observation clock, which then restarts fresh (M3)", async (t) => {
  const { service, store, dataDir, advance } = await makeService(t, { graceMs: 5000 });
  let running = false;
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") {
        return running ? HISTORY_RUNNING("s-1") : HISTORY_DONE("s-1");
      }
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });

  await service.inspect(record.id);
  let mid = await service.inspect(record.id);
  assert.equal(mid.task.uncertainSince, 0);

  // The session starts running again: uncertainty is cleared.
  running = true;
  advance(1000);
  mid = await service.inspect(record.id);
  assert.equal(mid.task.status, "running");
  assert.equal(mid.task.uncertainSince, null, "re-running clears the observation clock");

  // Back to idle + no turn: the clock restarts from THIS observation.
  running = false;
  advance(1000);
  mid = await service.inspect(record.id);
  assert.equal(mid.task.uncertainSince, 2000, "a fresh absence verdict starts a fresh clock");
});

test("inspect: session missing from list + history session-not-found -> orphaned (never done)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return { items: [] };
      if (method === "session.history") throw new DshRpcError("session-not-found", "no such session");
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  const result = await service.inspect(record.id);
  assert.equal(result.task.status, "orphaned");
  assert.equal(result.task.terminalReason, "session-missing");
  assert.equal(result.task.dsh.sessionFound, false);
  assert.equal(result.task.dsh.sessionExists, false);
  assert.ok(result.task.lastError);
});

test("inspect: missing from list but readable history (cold session) is NOT orphaned", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return { items: [] };
      if (method === "session.history") return { events: [...ASSISTANT_EVENTS, TURN_COMPLETED()], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  const result = await service.inspect(record.id);
  assert.equal(result.task.dsh.sessionFound, false);
  assert.equal(result.task.dsh.sessionExists, true);
  assert.equal(result.task.status, "done", "a readable cold session classifies by its history");
});

test("inspect survives DSH being unreachable (transient read failures never terminal)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: () => {
      throw new DshRpcError("transport", "ECONNREFUSED");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  const result = await service.inspect(record.id);
  assert.equal(result.task.id, record.id);
  assert.equal(result.task.dsh.reachable, false);
  assert.ok(result.task.dsh.error);
  assert.equal(result.task.status, "running", "a transport failure must not flip the task to a terminal state");
});

test("inspect: a running DSH session keeps the task non-terminal", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return HISTORY_RUNNING("s-1");
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  const result = await service.inspect(record.id);
  assert.equal(result.task.dsh.running, true);
  assert.equal(result.task.status, "running");
});

test("inspect of an unknown task throws not-found (404)", async (t) => {
  const { service } = await makeService(t);
  await assert.rejects(
    () => service.inspect("task_missing"),
    (error) => error instanceof DshAdapterError && error.status === 404,
  );
});

test("inspect: legacy task with null sessionId settles failed(missing-session-id), never pending forever", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: () => {
      throw new Error("a null-sessionId task must never be probed against DSH");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: null });

  const result = await service.inspect(record.id);
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.terminalReason, "missing-session-id");
  assert.ok(result.task.lastError.includes("no DSH sessionId"));
  assert.equal(rpc.calls.length, 0, "no RPC is attempted for an unidentifiable session");
});

test("submit: persisting the initial record failing still throws with taskId and sends no RPC", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const originalCreate = store.create.bind(store);
  store.create = async () => {
    throw new Error("disk full");
  };
  try {
    await assert.rejects(
      () => service.submit({ prompt: "p", cwd: dataDir }),
      (error) =>
        error instanceof DshAdapterError &&
        error.code === "store-write-failed" &&
        error.status === 500 &&
        typeof error.taskId === "string" &&
        error.taskId.startsWith("task_"),
    );
  } finally {
    store.create = originalCreate;
  }
  assert.equal(service.rpc.calls.length, 0, "no DSH RPC may be sent when the record was never persisted");
  assert.equal(store.list().length, 0);
});

test("submit: the final store.update(running) failure carries taskId and keeps the task traceable", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  let promptCalls = 0;
  let sid = null;
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.create") {
        sid = payload.sessionId;
        return { sessionId: payload.sessionId };
      }
      if (method === "session.prompt") {
        promptCalls++;
        return { accepted: true };
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const originalUpdate = store.update.bind(store);
  let failedOnce = false;
  store.update = async (id, patch, opts) => {
    if (!failedOnce && patch && patch.status === "running") {
      failedOnce = true;
      throw new Error("disk full");
    }
    return originalUpdate(id, patch, opts);
  };
  try {
    await assert.rejects(
      () => service.submit({ prompt: "p", cwd: dataDir }),
      (error) =>
        error instanceof DshAdapterError &&
        error.code === "store-write-failed" &&
        error.status === 500 &&
        typeof error.taskId === "string" &&
        error.message.includes(error.taskId),
    );
  } finally {
    store.update = originalUpdate;
  }
  assert.equal(promptCalls, 1, "the prompt was accepted by DSH");
  const record = store.list()[0];
  assert.equal(record.status, "submitting", "the task stays traceable for reconcile to settle");
  assert.equal(record.sessionId, sid);
});

// ── Cancel (accepted -> cancelling -> observed terminal) ────────────────────

test("cancel returns accepted, marks the task cancelling, then observation settles cancelled", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.cancel") return { accepted: true };
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [TURN_ABORTED()], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });

  const result = await service.cancel(record.id);
  assert.equal(result.accepted, true);
  assert.equal(result.task.status, "cancelling", "accepted cancel is NOT immediately cancelled");
  assert.equal(typeof result.task.cancelledAt, "number");
  assert.ok(rpc.calls.some((c) => c.method === "session.cancel"));
  assert.equal(rpc.calls.filter((c) => c.method === "session.cancel").length, 1);

  const observed = await service.inspect(record.id);
  assert.equal(observed.task.status, "cancelled");
  assert.equal(observed.task.terminalReason, "aborted");
});

test("cancel failure records lastError and never reports cancelled", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: () => ({ error: { code: "session-not-found", message: "gone" } }),
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  await assert.rejects(() => service.cancel(record.id), (e) => e.code === "dsh-error");
  const stored = store.get(record.id);
  assert.ok(stored.lastError);
  assert.equal(stored.status, "running", "a failed cancel request must not mark the task cancelled");
});

test("cancel on a terminal task is an idempotent no-op (accepted:false)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.cancel") return { accepted: true };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  await store.update(record.id, { status: "done", terminalReason: "completed", resultText: "x" });

  const result = await service.cancel(record.id);
  assert.equal(result.accepted, false);
  assert.equal(result.task.status, "done", "terminal states are sticky");
  assert.equal(rpc.calls.length, 0, "no session.cancel call for a terminal task");
});

test("cancel on a legacy task with null sessionId settles failed(missing-session-id) BEFORE any RPC (P3-1)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: () => {
      throw new Error("a null-sessionId task must never be probed against DSH");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: null });

  await assert.rejects(
    () => service.cancel(record.id),
    (e) =>
      e instanceof DshAdapterError &&
      e.code === "missing-session-id" &&
      e.status === 409 &&
      typeof e.taskId === "string" &&
      e.taskId === record.id,
  );
  const stored = store.get(record.id);
  assert.equal(stored.status, "failed", "the task lands a safe terminal state, never stays pending");
  assert.equal(stored.terminalReason, "missing-session-id", "same reason as inspect/reconcile");
  assert.ok(stored.lastError.includes("no DSH sessionId"));
  assert.equal(stored.cancelledAt, null, "cancelling bookkeeping must never be written");
  assert.equal(stored.cancelRequestedAt, null);
  assert.equal(stored.previousStatus, null);
  assert.equal(
    rpc.calls.length,
    0,
    "zero RPCs: cancelSession({ sessionId: null }) must never be sent, no list/history either",
  );
});

test("cancel while already cancelling is a no-op (no duplicate RPC)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.cancel") return { accepted: true };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  await store.update(record.id, { status: "cancelling", cancelledAt: 1 });

  const result = await service.cancel(record.id);
  assert.equal(result.accepted, false);
  assert.equal(result.task.status, "cancelling");
  assert.equal(rpc.calls.length, 0);
});

test("cancelling + completed turn observed -> done (cancel lost the race)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.cancel") return { accepted: true };
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") return { events: [...ASSISTANT_EVENTS, TURN_COMPLETED()], hasMore: false };
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  await service.cancel(record.id);
  const observed = await service.inspect(record.id);
  assert.equal(observed.task.status, "done", "a turn that actually completed is reported as done");
  assert.equal(observed.task.resultText, "first line\nfinal answer");
});

test("cancel persists cancelling BEFORE the RPC; a concurrent inspect can never finalize failed (M3)", async (t) => {
  const { service, store, dataDir, advance } = await makeService(t, { graceMs: 60_000 });
  let cancelResolve;
  const cancelGate = new Promise((resolve) => {
    cancelResolve = resolve;
  });
  let historyEvents = "empty";
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.cancel") return cancelGate;
      if (method === "session.list") return HISTORY_DONE("s-1");
      if (method === "session.history") {
        return historyEvents === "empty"
          ? { events: [], hasMore: false }
          : { events: [TURN_ABORTED()], hasMore: false };
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  // Long-running task: with the OLD grace (statusChangedAt-based) a concurrent
  // idle+no-turn inspect in the cancel window would instantly fail it.
  advance(1_000_000);

  const cancelPromise = service.cancel(record.id);
  // The cancelling record must be persisted BEFORE the RPC is answered.
  let persisted = false;
  for (let i = 0; i < 200 && !persisted; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const current = store.get(record.id);
    persisted = current?.status === "cancelling";
  }
  assert.ok(persisted, "cancelling must be persisted while the RPC is still in flight");
  const during = store.get(record.id);
  assert.equal(typeof during.cancelRequestedAt, "number");
  assert.equal(during.previousStatus, "running");
  assert.equal(typeof during.cancelledAt, "number");

  // Concurrent inspect while the RPC is in flight: idle + no turn + cancelling
  // must NEVER become failed (and with the observation grace it does not even
  // settle to cancelled yet).
  const observed = await service.inspect(record.id);
  assert.notEqual(observed.task.status, "failed", "the cancel window must never finalize failed");
  assert.notEqual(observed.task.status, "cancelled", "cancel-settled also needs sustained observation");
  assert.equal(observed.task.status, "cancelling");

  // RPC completes: cancel accepted, task still cancelling.
  cancelResolve({ accepted: true });
  const cancelResult = await cancelPromise;
  assert.equal(cancelResult.accepted, true);
  assert.equal(cancelResult.task.status, "cancelling");

  // The next observation settles the terminal verdict from durable evidence.
  historyEvents = "aborted";
  const settled = await service.inspect(record.id);
  assert.equal(settled.task.status, "cancelled");
  assert.equal(settled.task.terminalReason, "aborted");
});

test("cancel RPC failure rolls back to the previous non-terminal status (M3)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  let cancelCalls = 0;
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.cancel") {
        cancelCalls++;
        return { error: { code: "session-not-found", message: "gone" } };
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });
  await assert.rejects(
    () => service.cancel(record.id),
    (e) => e instanceof DshAdapterError && e.code === "dsh-error" && typeof e.taskId === "string",
  );
  assert.equal(cancelCalls, 1);
  const stored = store.get(record.id);
  assert.ok(stored.lastError, "the failed cancel is recorded");
  assert.equal(stored.status, "running", "the cancel-rollback edge restores the previous non-terminal status");
  assert.equal(stored.cancelledAt, null);
  assert.equal(stored.cancelRequestedAt, null);
  assert.equal(stored.previousStatus, null);
});

test("concurrent cancels send exactly one RPC (CAS on running -> cancelling)", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  let cancelResolve;
  const cancelGate = new Promise((resolve) => {
    cancelResolve = resolve;
  });
  let cancelCalls = 0;
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.cancel") {
        cancelCalls++;
        return cancelGate;
      }
      throw new Error("unexpected");
    },
  });
  service.rpc = rpc;
  const record = await seedTask(store, dataDir, { sessionId: "s-1" });

  setTimeout(() => cancelResolve({ accepted: true }), 50);
  const [a, b] = await Promise.all([service.cancel(record.id), service.cancel(record.id)]);
  assert.equal(cancelCalls, 1, "only one session.cancel RPC may be sent");
  const accepted = [a, b].filter((r) => r.accepted === true);
  const rejected = [a, b].filter((r) => r.accepted === false);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].note.includes("already in progress"));
  assert.equal(store.get(record.id).status, "cancelling");
});

// ── Extraction helpers ──────────────────────────────────────────────────────

test("extractFinalAssistantText handles content arrays and plain strings", () => {
  const events = [
    {
      event: {
        seq: 1,
        type: "assistant/message",
        time: 1,
        data: { message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } },
      },
    },
    {
      event: {
        seq: 2,
        type: "assistant/message",
        time: 2,
        data: { message: { content: "plain string" } },
      },
    },
    { event: { seq: 3, type: "assistant/message", time: 3, data: { message: {} } } },
  ];
  const result = extractFinalAssistantText(events);
  assert.equal(result.text, "plain string");
  assert.equal(result.seq, 2);

  assert.equal(extractFinalAssistantText([]), null);
  assert.equal(extractFinalAssistantText([{ event: { seq: 1, type: "tool/call", data: {} } }]), null);
});

test("sanitizeEventSummary never leaks tool arguments", () => {
  const summary = sanitizeEventSummary(ASSISTANT_EVENTS);
  const toolRow = summary.find((row) => row.type === "tool/call");
  assert.equal(toolRow.toolName, "read_file");
  assert.deepEqual(Object.keys(toolRow).sort(), ["seq", "time", "toolName", "type"]);
});
