// Shared test fakes: scripted DSH RPC client, stateful health double,
// fake child process, fake supervisor.
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { DshRpcError } from "../../lib/dsh-rpc-client.js";

/**
 * Build a fetch implementation backed by a JSON handler.
 * handler({ httpMethod, rpcMethod, url, body }) => { status?, json? } | { status?, text? }
 * `httpMethod` is the real HTTP verb ("GET"/"POST"); `rpcMethod` is the RPC
 * method carried by the envelope (body.method, e.g. "session.create").
 */
export function createJsonFetch(handler) {
  return async (url, init = {}) => {
    const httpMethod = (init.method || "GET").toUpperCase();
    let body = null;
    if (init.body !== undefined) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const result = await handler({
      httpMethod,
      rpcMethod: body && typeof body === "object" ? body.method : undefined,
      url: String(url),
      body,
    });
    const status = result?.status ?? 200;
    const json = result?.json;
    const text = result?.text;
    if (json !== undefined) {
      return new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(text ?? "", { status });
  };
}

/**
 * Stateful health double: starts unhealthy, tests call makeHealthy() to
 * transition the fake service to reachable (e.g. mid-boot scenarios).
 */
export function createHealthDouble(initial = false) {
  let ok = initial;
  return {
    isHealthy: () => ok,
    makeHealthy: () => {
      ok = true;
    },
    makeUnhealthy: () => {
      ok = false;
    },
    probe: async () => (ok ? { ok: true, status: 200 } : { ok: false, error: "connection refused" }),
  };
}

/**
 * Scripted DSH RPC double with method-contract default returns:
 *   session.create  -> echoes the caller's pre-allocated sessionId (idempotent same-id contract)
 *   session.prompt  -> { accepted: true }
 *   session.list    -> { items: [] }
 *   session.history -> { events: [], hasMore: false }
 *   session.cancel  -> { accepted: true }
 * The fake mirrors the SERVICE-level calling contract — the service calls
 * rpc.promptSession({ sessionId, text }); the real DshRpcClient wraps that
 * into the wire payload { sessionId, mode: "queue", content: [{ type: "text",
 * text }] }. Wire shaping is the client's job and is covered by the
 * dsh-rpc-client tests, so the fake records payloads exactly as the service
 * passed them.
 * `script` may be a function ({ method, payload, calls }) => value, or
 *   { error: { code, message, details } }  -> throws a real DshRpcError.
 * All calls are recorded in `calls`.
 */
export function createFakeRpc({ script } = {}) {
  const calls = [];
  const make = (method, fallback) => async (payload) => {
    calls.push({ method, payload });
    if (script) {
      const out = await script({ method, payload, calls });
      if (out && typeof out === "object" && "error" in out) {
        throw new DshRpcError(
          out.error.code || "rpc-error",
          out.error.message || "rpc failed",
          out.error.details,
        );
      }
      return out ?? (typeof fallback === "function" ? fallback(payload) : fallback);
    }
    return typeof fallback === "function" ? fallback(payload) : fallback;
  };
  return {
    baseUrl: "http://127.0.0.1:3080",
    calls,
    health: async () => ({ ok: true, status: 200 }),
    // DSH create echoes the pre-allocated sessionId, mirroring the real
    // idempotent contract for the same sessionId+cwd.
    createSession: make("session.create", (payload) => ({ sessionId: payload?.sessionId ?? "s-default" })),
    promptSession: make("session.prompt", { accepted: true }),
    listSessions: make("session.list", { items: [] }),
    history: make("session.history", { events: [], hasMore: false }),
    cancelSession: make("session.cancel", { accepted: true }),
  };
}

/**
 * Fake child process: EventEmitter with pid/kill/exitCode plus pipe emitters.
 * kill() records the signal and schedules an exit, so stopOwned settles fast.
 */
export function createFakeProc({ pid = 4242 } = {}) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killedWith = null;
  proc.kill = (signal) => {
    proc.killedWith = signal ?? "SIGTERM";
    if (proc.exitCode === null && !proc._exitScheduled) {
      proc._exitScheduled = true;
      queueMicrotask(() => proc.fakeExit(1));
    }
    return true;
  };
  proc.fakeExit = (code = 0) => {
    if (proc.exitCode !== null) return;
    proc.exitCode = code;
    proc.signalCode = null;
    proc.emit("exit", code, null);
  };
  return proc;
}

/** Fake supervisor with scriptable behavior. */
export function createFakeSupervisor({
  ensureResult = { started: false, owned: false, pid: null },
  statusResult = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async ensureStarted(opts = {}) {
      calls.push({ op: "ensureStarted", opts });
      if (ensureResult instanceof Error) {
        throw ensureResult;
      }
      return typeof ensureResult === "function" ? ensureResult(opts) : ensureResult;
    },
    async status() {
      calls.push({ op: "status" });
      if (statusResult instanceof Error) {
        throw statusResult;
      }
      return (
        statusResult ?? {
          url: "http://127.0.0.1:3080",
          reachable: true,
          probeError: null,
          owned: false,
          pid: null,
          executableExists: true,
          executablePath: path.join(os.tmpdir(), "dsh", "bin.js"),
        }
      );
    },
    async stopOwned() {
      calls.push({ op: "stopOwned" });
      return { stopped: false };
    },
  };
}

/** Sequential script helper: shift-based responses per call. */
export function sequence(...steps) {
  return () => {
    const step = steps.shift();
    if (step === undefined) {
      throw new Error("fake script exhausted");
    }
    if (step instanceof Error) {
      throw step;
    }
    return step;
  };
}

/**
 * Fake events.mux transport (Phase 1): a controllable connector for
 * ApprovalMuxListener. Pass `transportFactory` to the listener/service; the
 * returned `controller` lets tests:
 *   - `whenConnected()`   await the first (or next) successful open
 *   - `injectFrame(frame, envelope?)`  push an approval frame exactly as the
 *     real server would (full server-request envelope; auto-built unless
 *     given, rpcId = `rpc-<n>`)
 *   - `fail()`            simulate a stream drop (fires the transport's
 *     onClose → listener reconnects with backoff)
 *   - `connectError`      set to an Error to make the next connect() throw
 *     (listener backoff-retries)
 *   - `open`              set false before start to create a transport that
 *     never opens (then drive it with fail()/manual onClose)
 * `frames` records every injected frame; `connectCount`/`closeCount` count
 * transport creations/closes.
 */
export function createFakeMuxTransport({ open = true } = {}) {
  const controller = {
    open,
    connected: false,
    connectCount: 0,
    closeCount: 0,
    frameCount: 0,
    frames: [],
    connectError: null,
    /** Number of upcoming connects that throw before the next success. */
    connectErrorsRemaining: 0,
    url: null,
    onOpen: null,
    onFrame: null,
    onError: null,
    onClose: null,
    _connectWaiters: [],
    whenConnected() {
      if (this.connected) return Promise.resolve();
      return new Promise((resolve) => this._connectWaiters.push(resolve));
    },
    /** Push one approval frame as a full server-request envelope. */
    injectFrame(frame, envelope = null) {
      const rpcId = typeof envelope?.rpcId === "string" ? envelope.rpcId : `rpc-${++this.frameCount}`;
      const full = envelope ?? {
        type: "server-request",
        rpcId,
        method: frame.type,
        payload: frame,
      };
      this.frames.push(full);
      this.onFrame?.({ envelope: full, frame });
    },
    /** Simulate a dropped stream: the listener will back off and reconnect. */
    fail() {
      this.connected = false;
      this.onClose?.();
    },
    /** Force the stream closed with an error notification first. */
    failWithError(error) {
      this.onError?.(error);
      this.fail();
    },
  };
  const transportFactory = ({ url, onOpen, onFrame, onError, onClose }) => {
    controller.connectCount++;
    controller.url = url;
    controller.onOpen = onOpen;
    controller.onFrame = onFrame;
    controller.onError = onError;
    controller.onClose = onClose;
    if (controller.connectErrorsRemaining > 0) {
      controller.connectErrorsRemaining--;
      throw new Error("connection refused");
    }
    if (controller.connectError) {
      const error = controller.connectError;
      controller.connectError = null;
      throw error;
    }
    if (controller.open) {
      controller.connected = true;
      onOpen();
      for (const resolve of controller._connectWaiters.splice(0)) resolve();
    }
    return {
      close: () => {
        controller.closeCount++;
        controller.connected = false;
      },
    };
  };
  return { controller, transportFactory };
}

/** Build one approval/requested frame (helper for tests). */
export function approvalRequestedFrame(overrides = {}) {
  return {
    type: "approval/requested",
    sessionId: "s-1",
    approvalId: "approval-1",
    toolName: "write_file",
    ...overrides,
  };
}

/** Build one approval/resolved frame (helper for tests). */
export function approvalResolvedFrame(overrides = {}) {
  return {
    type: "approval/resolved",
    sessionId: "s-1",
    approvalId: "approval-1",
    outcome: "allowed-once",
    ...overrides,
  };
}
