// dsh-rpc-client: exact wire envelope, error mapping, health probe.
import test from "node:test";
import assert from "node:assert/strict";
import { DshRpcClient, DshRpcError } from "../lib/dsh-rpc-client.js";
import { createJsonFetch } from "./helpers/fake-dsh.js";

const BASE = "http://127.0.0.1:3080";

function clientFor(handler) {
  return new DshRpcClient({ baseUrl: BASE, fetchImpl: createJsonFetch(handler), timeoutMs: 5000 });
}

test("sends the exact client-request envelope to /api/<method>", async () => {
  let seen = null;
  const client = clientFor(({ httpMethod, rpcMethod, url, body }) => {
    seen = { httpMethod, rpcMethod, url, body };
    return { json: { type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { sessionId: "s-prealloc-1" } } } };
  });
  const value = await client.createSession({
    sessionId: "s-prealloc-1",
    cwd: "/workspace",
    agentPreset: "router-standard",
  });
  assert.deepEqual(value, { sessionId: "s-prealloc-1" });
  assert.equal(seen.httpMethod, "POST");
  assert.equal(seen.rpcMethod, "session.create");
  assert.equal(seen.url, `${BASE}/api/session.create`);
  assert.equal(seen.body.type, "client-request");
  assert.equal(seen.body.method, "session.create");
  assert.equal(typeof seen.body.rpcId, "string");
  assert.ok(seen.body.rpcId.length > 0);
  // The pre-allocated sessionId MUST be on the wire: DSH create is idempotent
  // for the same sessionId+cwd, and the adapter's recoverable submit chain
  // depends on it. Dropping it would let DSH mint a different id.
  assert.deepEqual(seen.body.payload, {
    sessionId: "s-prealloc-1",
    cwd: "/workspace",
    agentPreset: "router-standard",
  });
});

test("promptSession uses queue mode with one text block", async () => {
  let seen = null;
  const client = clientFor(({ body }) => {
    seen = body;
    return { json: { type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } } };
  });
  await client.promptSession({ sessionId: "s-1", text: "do the thing" });
  assert.equal(seen.method, "session.prompt");
  assert.equal(seen.payload.mode, "queue");
  assert.deepEqual(seen.payload.content, [{ type: "text", text: "do the thing" }]);
  assert.equal(seen.payload.sessionId, "s-1");
});

test("maps an ok:false envelope to DshRpcError with code/message/details", async () => {
  const client = clientFor(({ body }) => ({
    json: {
      type: "server-response",
      rpcId: body.rpcId,
      result: { ok: false, error: { code: "session-not-found", message: "no such session", details: { sessionId: "x" } } },
    },
  }));
  await assert.rejects(
    () => client.cancelSession({ sessionId: "x" }),
    (error) => {
      assert.ok(error instanceof DshRpcError);
      assert.equal(error.code, "session-not-found");
      assert.equal(error.message, "no such session");
      assert.deepEqual(error.details, { sessionId: "x" });
      return true;
    },
  );
});

test("rejects rpcId mismatch and malformed envelopes", async () => {
  const mismatch = clientFor(({ body }) => ({
    json: { type: "server-response", rpcId: "other-id", result: { ok: true, value: {} } },
  }));
  await assert.rejects(() => mismatch.listSessions(), (e) => e.code === "bad-response");

  const notEnvelope = clientFor(() => ({ json: { hello: "world" } }));
  await assert.rejects(() => notEnvelope.listSessions(), (e) => e.code === "bad-response");

  const missingResult = clientFor(({ body }) => ({
    json: { type: "server-response", rpcId: body.rpcId, result: { ok: "yes" } },
  }));
  await assert.rejects(() => missingResult.listSessions(), (e) => e.code === "bad-response");
});

test("throws transport errors on HTTP failures and fetch rejections", async () => {
  const http500 = clientFor(() => ({ status: 500, text: "boom" }));
  await assert.rejects(() => http500.listSessions(), (e) => e.code === "transport");

  const badJson = clientFor(() => ({ status: 200, text: "not json" }));
  await assert.rejects(() => badJson.listSessions(), (e) => e.code === "bad-response");

  const networkDown = new DshRpcClient({
    baseUrl: BASE,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(() => networkDown.listSessions(), (e) => e.code === "transport");
});

test("health probe reports reachable / unreachable without throwing", async () => {
  const up = clientFor(() => ({ status: 200, text: "html" }));
  assert.deepEqual(await up.health(), { ok: true, status: 200 });

  const down = new DshRpcClient({
    baseUrl: BASE,
    fetchImpl: async () => {
      throw new Error("fetch failed");
    },
  });
  const result = await down.health();
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("narrow methods use the narrow endpoints only", async () => {
  const seen = [];
  const client = clientFor(({ rpcMethod, body }) => {
    seen.push(rpcMethod);
    return { json: { type: "server-response", rpcId: body.rpcId, result: { ok: true, value: {} } } };
  });
  await client.listSessions();
  await client.history({ sessionId: "s", maxMessages: 10 });
  await client.cancelSession({ sessionId: "s" });
  assert.deepEqual(seen, ["session.list", "session.history", "session.cancel"]);
});

// ── respondApproval (Phase 1: client-response carrier, NOT a client-request) ─

test("respondApproval posts the exact client-response envelope to /api/respond", async () => {
  let seen = null;
  const client = clientFor(({ httpMethod, rpcMethod, url, body }) => {
    seen = { httpMethod, rpcMethod, url, body };
    return { json: { accepted: true } };
  });
  const receipt = await client.respondApproval({
    rpcId: "rpc-42",
    sessionId: "s-1",
    approvalId: "approval-1",
    outcome: "allowed-once",
  });
  assert.deepEqual(receipt, { accepted: true });
  assert.equal(seen.httpMethod, "POST");
  assert.equal(seen.url, `${BASE}/api/respond`);
  assert.equal(seen.rpcMethod, undefined, "respond is not an RPC method — a dedicated carrier");
  assert.deepEqual(seen.body, {
    type: "client-response",
    rpcId: "rpc-42",
    result: { ok: true, value: { sessionId: "s-1", approvalId: "approval-1", outcome: "allowed-once" } },
  });
});

test("respondApproval surfaces the rejection reason; transport failures map to DshRpcError", async () => {
  const notPending = clientFor(() => ({ json: { accepted: false, reason: "not-pending" } }));
  assert.deepEqual(await notPending.respondApproval({ rpcId: "r", sessionId: "s", approvalId: "a", outcome: "rejected" }), {
    accepted: false,
    reason: "not-pending",
  });

  const http500 = clientFor(() => ({ status: 500, text: "boom" }));
  await assert.rejects(
    () => http500.respondApproval({ rpcId: "r", sessionId: "s", approvalId: "a", outcome: "rejected" }),
    (e) => e.code === "transport",
  );

  const badJson = clientFor(() => ({ status: 200, text: "not json" }));
  await assert.rejects(
    () => badJson.respondApproval({ rpcId: "r", sessionId: "s", approvalId: "a", outcome: "rejected" }),
    (e) => e.code === "bad-response",
  );

  const weirdReceipt = clientFor(() => ({ json: { accepted: false, reason: "something-new" } }));
  await assert.rejects(
    () => weirdReceipt.respondApproval({ rpcId: "r", sessionId: "s", approvalId: "a", outcome: "rejected" }),
    (e) => e.code === "bad-response",
  );

  const noReceipt = clientFor(() => ({ json: { hello: 1 } }));
  await assert.rejects(
    () => noReceipt.respondApproval({ rpcId: "r", sessionId: "s", approvalId: "a", outcome: "rejected" }),
    (e) => e.code === "bad-response",
  );
});
