// approval-mux-listener: envelope parsing, approval-frame scoping, bounded
// exponential-backoff reconnects, dispose semantics, no unhandled rejections.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalMuxListener,
  muxWebSocketUrl,
  parseMuxEnvelope,
  splitSseDataLines,
} from "../lib/approval-mux-listener.js";
import {
  approvalRequestedFrame,
  approvalResolvedFrame,
  createFakeMuxTransport,
} from "./helpers/fake-dsh.js";

// ── Pure parsing ────────────────────────────────────────────────────────────

test("muxWebSocketUrl derives the loopback ws URL from the base http URL", () => {
  assert.equal(muxWebSocketUrl("http://127.0.0.1:3080"), "ws://127.0.0.1:3080/api/events.mux");
  assert.equal(muxWebSocketUrl("http://localhost:9999/"), "ws://localhost:9999/api/events.mux");
  assert.equal(muxWebSocketUrl("http://[::1]:3080"), "ws://[::1]:3080/api/events.mux");
});

test("parseMuxEnvelope accepts a full server-request envelope and returns frame + rpcId", () => {
  const frame = approvalRequestedFrame({ reason: "write files" });
  const raw = JSON.stringify({
    type: "server-request",
    rpcId: "rpc-42",
    method: "approval/requested",
    payload: frame,
  });
  const parsed = parseMuxEnvelope(raw);
  assert.ok(parsed);
  assert.equal(parsed.envelope.rpcId, "rpc-42");
  assert.deepEqual(parsed.frame, frame);
});

test("parseMuxEnvelope rejects malformed/binary/non-server-request input, never throws", () => {
  assert.equal(parseMuxEnvelope(null), null);
  assert.equal(parseMuxEnvelope(undefined), null);
  assert.equal(parseMuxEnvelope("not json"), null);
  assert.equal(parseMuxEnvelope('{"type":"server-response"}'), null);
  assert.equal(parseMuxEnvelope('{"type":"server-request","rpcId":""}'), null);
  assert.equal(parseMuxEnvelope('{"type":"server-request","rpcId":"r","payload":null}'), null);
  assert.equal(parseMuxEnvelope('{"type":"server-request","rpcId":"r","payload":{"type":5}}'), null);
  assert.equal(parseMuxEnvelope("[]"), null);
});

test("splitSseDataLines extracts data: payloads (SSE fallback transport)", () => {
  assert.deepEqual(
    splitSseDataLines(": connected\n\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\n"),
    ['{"a":1}', '{"b":2}'],
  );
  assert.deepEqual(splitSseDataLines("data: {\"a\":1}"), ['{"a":1}']);
  assert.deepEqual(splitSseDataLines(""), []);
});

// ── Listener behaviour ──────────────────────────────────────────────────────

function makeListener(t, { onFrame = null, onOpen = null, onClose = null, sleep = null } = {}) {
  const received = [];
  const opens = [];
  const closes = [];
  const listener = new ApprovalMuxListener({
    baseUrl: "http://127.0.0.1:3080",
    onFrame: (frame, envelope) => {
      received.push({ frame, envelope });
      onFrame?.(frame, envelope);
    },
    onOpen: () => {
      opens.push(listener.connectCount);
      onOpen?.();
    },
    onClose: () => {
      closes.push(listener.connectCount);
      onClose?.();
    },
    sleep: sleep ?? (async () => {}),
    initialDelayMs: 50,
    maxDelayMs: 400,
  });
  t.after(() => listener.stop());
  return { listener, received, opens, closes };
}

async function tick(n = 4) {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

test("connects to the derived ws URL and forwards only approval frames", async (t) => {
  const mux = createFakeMuxTransport();
  const { listener, received } = makeListener(t);
  listener.transportFactory = mux.transportFactory;
  listener.start();
  await mux.controller.whenConnected();
  assert.equal(mux.controller.url, "ws://127.0.0.1:3080/api/events.mux");
  assert.equal(listener.state, "open");
  assert.equal(listener.connectCount, 1);

  // Approval frames are forwarded with their envelope (rpcId kept).
  mux.controller.injectFrame(approvalRequestedFrame({ approvalId: "a-1" }));
  mux.controller.injectFrame(approvalResolvedFrame({ approvalId: "a-1", outcome: "rejected" }));
  await tick();
  assert.equal(received.length, 2);
  assert.equal(received[0].frame.type, "approval/requested");
  assert.equal(received[0].envelope.rpcId, "rpc-1");
  assert.equal(received[1].frame.outcome, "rejected");

  // Other mux frames (session/event etc.) are ignored by the listener.
  mux.controller.injectFrame({ type: "session/event", sessionId: "s-1", event: { type: "user/message", seq: 1, time: 1, data: {} } });
  mux.controller.injectFrame({ type: "stream/error", error: { code: "internal", message: "x", details: {} } });
  await tick();
  assert.equal(received.length, 2, "non-approval frames never reach the handler");
});

test("a transport error notification is contained: stream recovers via reconnect", async (t) => {
  const mux = createFakeMuxTransport();
  const { listener } = makeListener(t);
  listener.transportFactory = mux.transportFactory;
  listener.start();
  await mux.controller.whenConnected();
  mux.controller.failWithError(new Error("stream broke"));
  await tick(6);
  assert.equal(mux.controller.connectCount, 2, "error + close lead to one reconnect");
  assert.equal(listener.state, "open");
});

test("disconnect triggers reconnect at the initial delay; a successful open resets the backoff", async (t) => {
  const mux = createFakeMuxTransport();
  const delays = [];
  const { listener, opens, closes } = makeListener(t, {
    sleep: async (ms) => delays.push(ms),
  });
  listener.transportFactory = mux.transportFactory;
  listener.start();
  await mux.controller.whenConnected();
  assert.equal(opens.length, 1);

  mux.controller.fail(); // drop → reconnect at the initial delay
  await tick(8);
  assert.equal(closes.length, 1);
  assert.equal(mux.controller.connectCount, 2, "reconnected automatically");
  assert.equal(opens.length, 2);
  assert.equal(listener.state, "open");
  assert.equal(delays[0], 50, "first reconnect delay = initialDelayMs");

  // A second drop starts a fresh cycle (the previous reconnect opened fine):
  // the backoff is reset by the successful open, so the delay is initial again.
  mux.controller.fail();
  await tick(8);
  assert.equal(mux.controller.connectCount, 3);
  assert.equal(delays[1], 50, "successful open resets the backoff");
});

test("consecutive connect failures grow the backoff exponentially and cap at maxDelayMs", async (t) => {
  const mux = createFakeMuxTransport();
  const delays = [];
  const { listener } = makeListener(t, { sleep: async (ms) => delays.push(ms) });
  listener.transportFactory = mux.transportFactory;
  listener.start();
  await mux.controller.whenConnected();
  // Drop the healthy stream, then let the next FIVE connects fail before one
  // succeeds — no successful open in between, so the delay must double.
  mux.controller.connectErrorsRemaining = 5;
  mux.controller.fail();
  await tick(40);
  // 1 wait from the drop + 5 waits after each failed connect (the 6th
  // connect succeeds and opens). Delays double, then cap at maxDelayMs.
  assert.equal(delays.length, 6, "one backoff wait for the drop plus one per failed attempt");
  assert.deepEqual(delays, [50, 100, 200, 400, 400, 400], "doubles then caps at maxDelayMs");
  assert.equal(mux.controller.connectCount, 7, "1 initial + 5 failed attempts + 1 success");
  assert.equal(listener.state, "open", "the final attempt succeeded");
});

test("a throwing transport factory is retried with backoff, not fatal", async (t) => {
  const mux = createFakeMuxTransport();
  mux.controller.connectErrorsRemaining = 1;
  const delays = [];
  const { listener, opens } = makeListener(t, { sleep: async (ms) => delays.push(ms) });
  listener.transportFactory = mux.transportFactory;
  listener.start();
  await tick(30);
  assert.equal(mux.controller.connectCount, 2, "failed once, then retried");
  assert.equal(delays[0], 50, "backoff applied after the failed connect");
  assert.equal(opens.length, 1, "the second attempt succeeded");
  assert.equal(listener.state, "open");
});

test("stop() is idempotent, cancels reconnects and closes the live transport", async (t) => {
  const mux = createFakeMuxTransport();
  const { listener } = makeListener(t, { sleep: async () => {} });
  listener.transportFactory = mux.transportFactory;
  listener.start();
  await mux.controller.whenConnected();
  assert.equal(mux.controller.connectCount, 1);

  listener.stop();
  assert.equal(listener.state, "stopped");
  assert.equal(mux.controller.closeCount, 1, "the live transport was closed");
  listener.stop(); // idempotent
  assert.equal(mux.controller.closeCount, 1);

  // A drop after stop must NOT reconnect.
  mux.controller.fail();
  await tick(6);
  assert.equal(mux.controller.connectCount, 1, "no reconnect after dispose");
});

test("stop() while connecting closes the late handle and never reconnects", async (t) => {
  const mux = createFakeMuxTransport();
  const { listener } = makeListener(t, { sleep: async () => {} });
  listener.transportFactory = mux.transportFactory;
  listener.start();
  await tick();
  listener.stop(); // during the connect microtask window
  await tick(6);
  assert.equal(listener.state, "stopped");
  mux.controller.fail();
  await tick(6);
  assert.equal(mux.controller.connectCount, 1, "no further connects after stop");
});

test("a frame handler error is contained: the stream stays open and the loop survives", async (t) => {
  const mux = createFakeMuxTransport();
  const { listener, received } = makeListener(t, {
    onFrame: () => {
      throw new Error("handler boom");
    },
  });
  listener.transportFactory = mux.transportFactory;
  listener.start();
  await mux.controller.whenConnected();
  mux.controller.injectFrame(approvalRequestedFrame());
  mux.controller.injectFrame(approvalResolvedFrame());
  await tick();
  assert.equal(listener.state, "open");
  assert.equal(received.length, 2, "both frames reached the (throwing) handler");
  assert.equal(mux.controller.connectCount, 1, "no reconnect triggered by handler errors");
});
