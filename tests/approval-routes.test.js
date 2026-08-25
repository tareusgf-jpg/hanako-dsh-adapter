// approval routes: GET /api/approvals (redacted pending list) and
// POST /api/approvals/:approvalId/respond through the real registrar + error
// wrapper — every error is a redacted { error, detail } body, never a stack.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerApiRoutes from "../routes/api.js";
import { ApprovalStore } from "../lib/approval-store.js";
import { TaskStore } from "../lib/task-store.js";
import { ApprovalService } from "../lib/approval-service.js";
import { approvalRequestedFrame, createFakeMuxTransport } from "./helpers/fake-dsh.js";

/**
 * Minimal Hono-shaped fake: registers routes exactly like the plugin does and
 * lets tests dispatch method+path+body through the same handlers.
 */
function createFakeApp() {
  const routes = [];
  const app = {
    get: (routePath, handler) => routes.push({ method: "GET", routePath, handler }),
    post: (routePath, handler) => routes.push({ method: "POST", routePath, handler }),
  };
  async function dispatch({ method, pathname, body = null }) {
    const route = routes.find((r) => r.method === method && matchPath(r.routePath, pathname));
    assert.ok(route, `no route for ${method} ${pathname}`);
    const params = extractParams(route.routePath, pathname);
    const responses = [];
    const c = {
      req: {
        param: (name) => params[name],
        query: () => null,
        json: async () => body,
      },
      json: (value, status = 200) => {
        responses.push({ status, value });
        return { status, value };
      },
      text: (value, status = 200) => {
        responses.push({ status, value });
        return { status, value };
      },
      html: (value) => {
        responses.push({ status: 200, value });
        return { status: 200, value };
      },
      get: () => null,
    };
    await route.handler(c);
    return responses[responses.length - 1];
  }
  return { app, dispatch };
}

function matchPath(routePath, pathname) {
  const routeParts = routePath.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (routeParts.length !== pathParts.length) return false;
  return routeParts.every((part, i) => part.startsWith(":") || part === pathParts[i]);
}

function extractParams(routePath, pathname) {
  const params = {};
  const routeParts = routePath.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  routeParts.forEach((part, i) => {
    if (part.startsWith(":")) {
      params[part.slice(1)] = pathParts[i];
    }
  });
  return params;
}

async function makeRuntime(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-approval-routes-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  const store = new ApprovalStore({ dataDir });
  await store.init();
  const taskStore = new TaskStore({ dataDir });
  await taskStore.init();
  const task = await taskStore.create({
    sessionId: "s-1",
    cwd: dataDir,
    agentPreset: "router-standard",
    promptSummary: "p",
    promptLength: 1,
  });
  const mux = createFakeMuxTransport();
  const service = new ApprovalService({
    store,
    taskStore,
    rpc: {
      respondApproval: async () => ({ accepted: true }),
      history: async () => ({ events: [], hasMore: false }),
    },
    config: { url: "http://127.0.0.1:3080" },
    busRequest: async () => {},
    sleep: async () => {},
    transportFactory: mux.transportFactory,
  });
  service.start();
  await mux.controller.whenConnected();
  const runtime = { _dshAdapter: { service: null, taskStore, approvalService: service } };
  return { runtime, mux: mux.controller, task };
}

test("GET /api/approvals returns the redacted pending list", async (t) => {
  const { runtime, mux } = await makeRuntime(t);
  const { app, dispatch } = createFakeApp();
  registerApiRoutes(app, runtime);

  const empty = await dispatch({ method: "GET", pathname: "/api/approvals" });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.value, { approvals: [] });

  mux.injectFrame(approvalRequestedFrame({ approvalId: "approval-1", reason: "sk-abc123456789012345678901234567890" }));
  await runtime._dshAdapter.approvalService.store.flush();
  const list = await dispatch({ method: "GET", pathname: "/api/approvals" });
  assert.equal(list.status, 200);
  const view = list.value.approvals[0];
  assert.equal(view.approvalId, "approval-1");
  assert.equal(view.toolName, "write_file");
  assert.ok(!JSON.stringify(list.value).includes("rpc-"), "rpcId never crosses the route");
  assert.ok(!JSON.stringify(list.value).includes("s-1"), "sessionId never crosses the route");
  assert.ok(!JSON.stringify(list.value).includes("sk-abc123456789012345678901234567890"), "tokens redacted");
});

test("POST /api/approvals/:approvalId/respond forwards the whitelisted outcome", async (t) => {
  const { runtime, mux } = await makeRuntime(t);
  const { app, dispatch } = createFakeApp();
  registerApiRoutes(app, runtime);

  mux.injectFrame(approvalRequestedFrame({ approvalId: "approval-1" }));
  await runtime._dshAdapter.approvalService.store.flush();

  const allowed = await dispatch({
    method: "POST",
    pathname: "/api/approvals/approval-1/respond",
    body: { outcome: "allowed-once" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.value.ok, true);

  const rejected = await dispatch({
    method: "POST",
    pathname: "/api/approvals/approval-1/respond",
    body: { outcome: "rejected" },
  });
  assert.equal(rejected.status, 409, "already resolved → 409, redacted body");
  assert.equal(rejected.value.error, "not-pending");
  assert.ok(typeof rejected.value.detail === "string");
  assert.ok(!JSON.stringify(rejected.value).includes("stack"), "no stack in the error body");
});

test("POST respond error mapping is redacted for every failure class", async (t) => {
  const { runtime, mux } = await makeRuntime(t);
  const { app, dispatch } = createFakeApp();
  registerApiRoutes(app, runtime);

  const notFound = await dispatch({
    method: "POST",
    pathname: "/api/approvals/ghost/respond",
    body: { outcome: "allowed-once" },
  });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.value.error, "not-found");

  mux.injectFrame(approvalRequestedFrame({ approvalId: "approval-1" }));
  await runtime._dshAdapter.approvalService.store.flush();
  const badOutcome = await dispatch({
    method: "POST",
    pathname: "/api/approvals/approval-1/respond",
    body: { outcome: "never" },
  });
  assert.equal(badOutcome.status, 400);
  assert.equal(badOutcome.value.error, "invalid-outcome");
  assert.ok(badOutcome.value.detail.includes("allowed-once"));

  const missingBody = await dispatch({
    method: "POST",
    pathname: "/api/approvals/approval-1/respond",
    body: {},
  });
  assert.equal(missingBody.status, 400);
  assert.equal(missingBody.value.error, "invalid-outcome");

  // An unexpected internal error becomes a generic 500 without details.
  const broken = await makeRuntime(t);
  const app2 = createFakeApp();
  broken.runtime._dshAdapter.approvalService.respondApproval = async () => {
    throw new Error("secret internal detail with a stack");
  };
  registerApiRoutes(app2.app, broken.runtime);
  const internal = await app2.dispatch({
    method: "POST",
    pathname: "/api/approvals/x/respond",
    body: { outcome: "allowed-once" },
  });
  assert.equal(internal.status, 500);
  assert.equal(internal.value.error, "internal");
  assert.ok(!JSON.stringify(internal.value).includes("secret internal detail"));
  assert.ok(!JSON.stringify(internal.value).includes("stack"));
});
