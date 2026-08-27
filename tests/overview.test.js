// overview aggregation: light status + recent-task summary, fail-soft per-task
// DSH reads, redacted errors, bounded task count, no tool-argument leakage.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DshAdapterService,
  MAX_OVERVIEW_TASKS,
  OVERVIEW_TEXT_MAX,
  summarizeText,
  redactError,
} from "../lib/dsh-adapter-service.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { TaskStore } from "../lib/task-store.js";
import { DshRpcError } from "../lib/dsh-rpc-client.js";
import { createFakeRpc, createFakeSupervisor } from "./helpers/fake-dsh.js";

const CONFIG = { pluginVersion: "0.1.0", autoStart: true };

async function makeService(t, { rpc = null } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-overview-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  const policy = new WorkspacePolicy({ roots: [dataDir] });
  // Monotonic store clock: consecutive creates must never share a millisecond,
  // or the newest-first ordering assertion becomes flaky (stable sort keeps
  // insertion order for equal createdAt). The service keeps its fixed clock.
  let storeClock = 1_700_000_000_000;
  const store = new TaskStore({ dataDir, now: () => storeClock++ });
  await store.init();
  const service = new DshAdapterService({
    rpc: rpc ?? createFakeRpc(),
    supervisor: createFakeSupervisor(),
    workspacePolicy: policy,
    taskStore: store,
    config: CONFIG,
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    pollIntervalMs: 10,
  });
  return { service, store, dataDir };
}

async function seed(store, dataDir, n, { prefix = "s" } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const rec = await store.create({
      sessionId: `${prefix}-${i}`,
      cwd: dataDir,
      agentPreset: "router-standard",
      promptSummary: `p${i}`,
      promptLength: 2,
    });
    ids.push(rec.id);
  }
  return ids;
}

const ASSISTANT_EVENTS = [
  {
    event: {
      seq: 1,
      type: "assistant/message",
      time: 100,
      data: { message: { content: [{ type: "text", text: "final answer" }] } },
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
      type: "turn/end",
      time: 102,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  },
];

// ── Aggregation ─────────────────────────────────────────────────────────────

test("overview returns status plus at most 6 newest tasks, light entries only", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") return { items: [] };
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const ids = await seed(store, dataDir, 8);

  const overview = await service.overview();
  assert.equal(overview.status.url, "http://127.0.0.1:3080");
  assert.equal(overview.status.reachable, true);
  assert.equal(overview.status.owned, false);
  assert.equal(overview.status.executableExists, true);
  assert.equal(overview.status.taskCount, 8);
  assert.equal(overview.refreshedAt, 1_700_000_000_000);

  assert.equal(overview.tasks.length, MAX_OVERVIEW_TASKS);
  // Newest first: seed order 0..7, so the newest id is ids[7].
  assert.equal(overview.tasks[0].id, ids[7]);
  assert.equal(overview.tasks[5].id, ids[2]);
  // No heavy fields in the light payload.
  for (const entry of overview.tasks) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.status, "string");
    assert.equal(entry.cwd, dataDir);
    assert.equal(typeof entry.updatedAt, "number");
    assert.equal("sessionId" in entry, false);
    assert.equal("promptSummary" in entry, false);
    assert.equal("resultText" in entry, false);
    assert.equal(entry.resultSummary, null);
    assert.equal(entry.error, null);
  }
});

test("overview includes a short result summary and never leaks tool arguments", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      if (method === "session.list") {
        return { items: [{ sessionId: "s-0", running: false, updatedAt: 123, blank: false }] };
      }
      if (method === "session.history") return { events: ASSISTANT_EVENTS, hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const [id] = await seed(store, dataDir, 1);

  const overview = await service.overview();
  const entry = overview.tasks[0];
  assert.equal(entry.id, id);
  assert.equal(entry.dshRunning, false);
  assert.equal(entry.sessionFound, true);
  assert.equal(entry.resultSummary, "final answer");
  assert.equal(entry.status, "done", "idle + completed turn + text settles to done");

  // The payload carries only the light summary — extraction internals, raw
  // events and tool arguments never cross the wire.
  const serialized = JSON.stringify(overview);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("arguments"), false);
  assert.equal(serialized.includes("read_file"), false);
});

test("overview truncates a long stored result into a short summary", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method }) => {
      // Empty history: nothing gets extracted, so the stored text is summarized.
      if (method === "session.list") return { items: [] };
      if (method === "session.history") return { events: [], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const [id] = await seed(store, dataDir, 1);
  await store.update(id, { resultText: "好".repeat(500) });

  const overview = await service.overview();
  assert.equal(overview.tasks[0].resultSummary, "好".repeat(OVERVIEW_TEXT_MAX - 1) + "…");
});

// ── Fail-soft ───────────────────────────────────────────────────────────────

test("overview fail-soft: a per-task DSH read failure is redacted, others intact", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const rpc = createFakeRpc({
    script: ({ method, payload }) => {
      if (method === "session.list") {
        return {
          items: [
            { sessionId: "s-0", running: false, updatedAt: 1, blank: false },
            { sessionId: "s-2", running: false, updatedAt: 3, blank: false },
          ],
        };
      }
      if (method === "session.history") {
        if (payload.sessionId === "s-1") {
          throw new DshRpcError("transport", "ECONNREFUSED http://127.0.0.1:3080/api/session.history");
        }
        return { events: [], hasMore: false };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  service.rpc = rpc;
  const [id0, id1, id2] = await seed(store, dataDir, 3);

  const overview = await service.overview();
  assert.equal(overview.tasks.length, 3);
  assert.equal(overview.status.taskCount, 3);

  const byId = new Map(overview.tasks.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(id0).error, null);
  assert.equal(byId.get(id2).error, null);

  const failed = byId.get(id1);
  assert.ok(failed.error, "the failing task must carry a redacted error");
  assert.equal(failed.error.code, "transport");
  assert.ok(failed.error.message.length <= OVERVIEW_TEXT_MAX);
  assert.equal(failed.error.message.includes("\n"), false);
  assert.equal(overview.recentError.taskId, id1);
  assert.equal(overview.recentError.code, "transport");
});

test("overview fail-soft: an unexpected inspect throw still returns status and other tasks", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const ids = await seed(store, dataDir, 2);
  const original = service.inspect.bind(service);
  let boom = false;
  service.inspect = async (id) => {
    if (id === ids[1]) {
      boom = true;
      throw new Error("unexpected internal failure");
    }
    return original(id);
  };

  const overview = await service.overview();
  assert.equal(boom, true);
  assert.equal(overview.status.reachable, true);
  assert.equal(overview.tasks.length, 2);
  const byId = new Map(overview.tasks.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(ids[0]).error, null);
  assert.deepEqual(byId.get(ids[1]).error, {
    code: "dsh-read-failed",
    message: "unexpected internal failure",
  });
  assert.equal(overview.recentError.taskId, ids[1]);
});

test("overview surfaces the most recent stored lastError as recentError", async (t) => {
  const { service, store, dataDir } = await makeService(t);
  const [older, newer] = await seed(store, dataDir, 2);
  await store.update(older, { lastError: "session.cancel: gone" });
  await store.update(newer, { lastError: "session.cancel: busy" });

  const overview = await service.overview();
  assert.equal(overview.recentError.taskId, newer);
  assert.equal(overview.recentError.code, "task-error");
  assert.equal(overview.recentError.message, "session.cancel: busy");
  const entry = overview.tasks[0];
  assert.equal(entry.lastError, "session.cancel: busy");
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test("summarizeText truncates by code points within max, collapses whitespace, null-safe", () => {
  assert.equal(summarizeText(null), null);
  assert.equal(summarizeText(undefined), null);
  assert.equal(summarizeText(""), "");
  // Total length never exceeds max: max-1 chars + ellipsis.
  assert.equal(summarizeText("abcdef", 3), "ab…");
  assert.equal(summarizeText("中文测试", 3), "中文…");
  assert.equal(summarizeText("x".repeat(500)).length, OVERVIEW_TEXT_MAX);
  assert.equal(summarizeText("x".repeat(500), 1), "…");
  assert.equal(summarizeText("x".repeat(500), 0), "");
  assert.equal(summarizeText("x".repeat(500), 2), "x…");
  // All consecutive whitespace/control (incl. \r\n pairs, \v, \f, \u3000) fold to one space.
  assert.equal(summarizeText("a\nb\tc\r\nd"), "a b c d");
  assert.equal(summarizeText("a\u3000\u3000b\vc\fd"), "a b c d");
  assert.equal(summarizeText("  a   b  "), "a b");
});

test("redactError keeps only a code and a short sanitized message", () => {
  assert.deepEqual(redactError(new DshRpcError("transport", "ECONNREFUSED")), {
    code: "transport",
    message: "ECONNREFUSED",
  });
  assert.deepEqual(redactError({ code: "session-not-found", message: "gone" }), {
    code: "session-not-found",
    message: "gone",
  });
  // Plain string form used by inspect(): "code: message"
  assert.deepEqual(redactError("timeout: read exceeded 30s"), {
    code: "timeout",
    message: "read exceeded 30s",
  });
  assert.deepEqual(redactError("plain text"), { code: "dsh-read-failed", message: "plain text" });
  assert.deepEqual(redactError(null), { code: "dsh-read-failed", message: "unknown error" });
  const long = redactError(new DshRpcError("transport", "y".repeat(500)));
  assert.ok(long.message.length <= OVERVIEW_TEXT_MAX);
  assert.equal("stack" in long, false);
  assert.equal("details" in long, false);
});
