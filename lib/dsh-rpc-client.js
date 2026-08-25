// hana-dsh-adapter: loopback-only DSH RPC client.
// Sends the exact DSH wire envelope { type:"client-request", rpcId, method, payload }
// to POST /api/<method> and validates the server-response envelope.
// Exposes a NARROW method set only: health, session.create, session.prompt (queue),
// session.list, session.history, session.cancel, respondApproval (the dedicated
// /api/respond client-response carrier). No generic endpoint forwarding.
import { randomUUID } from "node:crypto";

export class DshRpcError extends Error {
  constructor(code, message, details, options) {
    super(message, options);
    this.name = "DshRpcError";
    this.code = code;
    this.details = details;
  }
}

export class DshRpcClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  loopback base URL, e.g. http://127.0.0.1:3080
   * @param {number} [opts.timeoutMs]  bounded unary call timeout (default 30s)
   * @param {typeof fetch} [opts.fetchImpl]  injectable fetch for tests
   * @param {number} [opts.healthTimeoutMs]  health probe timeout (default 5s)
   * @param {object} [opts.log]
   */
  constructor({ baseUrl, timeoutMs = 30_000, fetchImpl = globalThis.fetch, healthTimeoutMs = 5_000, log = null }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.healthTimeoutMs = healthTimeoutMs;
    this.log = log;
  }

  /** GET / health probe — never throws; returns { ok, status?, error? }. */
  async health() {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return { ok: response.ok === true, status: response.status };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  // ── Narrow allowlist methods ───────────────────────────────────────────────

  /**
   * Pre-allocated-sessionId create (the adapter persists its own sessionId
   * before the RPC; DSH create is idempotent for the same sessionId+cwd).
   * The full payload is { sessionId, cwd, agentPreset } — sessionId is
   * passed through, never dropped.
   */
  async createSession({ sessionId, cwd, agentPreset }) {
    return this.call("session.create", { sessionId, cwd, agentPreset });
  }

  /** Queue-mode prompt with exactly one text block (per DSH prompt contract). */
  async promptSession({ sessionId, text }) {
    return this.call("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    });
  }

  async listSessions() {
    return this.call("session.list", {});
  }

  async history({ sessionId, maxMessages = 50 }) {
    return this.call("session.history", { sessionId, maxMessages });
  }

  async cancelSession({ sessionId }) {
    return this.call("session.cancel", { sessionId });
  }

  /**
   * Narrow approval response — NOT a client-request RPC. DSH's approval answer
   * is a ClientResponse full form posted to /api/respond (a dedicated carrier,
   * not an endpoint method): `{ type: "client-response", rpcId, result: {
   * ok: true, value: { sessionId, approvalId, outcome } } }`, where `rpcId`
   * echoes the rpcId of the `approval/requested` frame from events.mux.
   * outcome is restricted to the DSH contract vocabulary: 'allowed-once' |
   * 'rejected' (never 'never' / persistent elevation — the whitelist lives in
   * approval-service.js, this client only ever passes it through).
   * Returns the carrier receipt `{ accepted: true }` or
   * `{ accepted: false, reason: 'not-pending'|'bad-response' }`.
   * @throws {DshRpcError} on transport / malformed receipt.
   */
  async respondApproval({ rpcId, sessionId, approvalId, outcome }) {
    const envelope = {
      type: "client-response",
      rpcId,
      result: { ok: true, value: { sessionId, approvalId, outcome } },
    };
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DshRpcError(
        "transport",
        `DSH /api/respond failed: ${error?.message || String(error)}`,
        undefined,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new DshRpcError("transport", `DSH /api/respond failed: HTTP ${response.status}`);
    }
    let receipt;
    try {
      receipt = await response.json();
    } catch {
      throw new DshRpcError("bad-response", "DSH /api/respond returned a non-JSON receipt");
    }
    if (!receipt || typeof receipt !== "object" || typeof receipt.accepted !== "boolean") {
      throw new DshRpcError("bad-response", "DSH /api/respond returned an unexpected receipt");
    }
    if (
      receipt.accepted === false &&
      (typeof receipt.reason !== "string" || !["not-pending", "bad-response"].includes(receipt.reason))
    ) {
      throw new DshRpcError("bad-response", "DSH /api/respond returned an unexpected rejection reason");
    }
    return receipt;
  }

  /**
   * One unary RPC call. Internal core shared by the narrow methods above;
   * no route or tool ever exposes this as a generic proxy.
   * Returns the ok `value` (may be undefined for void results).
   * @throws {DshRpcError}
   */
  async call(method, payload) {
    const rpcId = randomUUID();
    const envelope = { type: "client-request", rpcId, method, payload };
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DshRpcError(
        "transport",
        `DSH RPC ${method} failed: ${error?.message || String(error)}`,
        undefined,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new DshRpcError("transport", `DSH RPC ${method} failed: HTTP ${response.status}`);
    }
    let full;
    try {
      full = await response.json();
    } catch {
      throw new DshRpcError("bad-response", `DSH RPC ${method} returned a non-JSON response`);
    }
    if (!full || typeof full !== "object" || full.type !== "server-response") {
      throw new DshRpcError("bad-response", `DSH RPC ${method} returned an unexpected envelope`);
    }
    if (full.rpcId !== rpcId) {
      throw new DshRpcError("bad-response", `DSH RPC ${method} rpcId mismatch`);
    }
    const result = full.result;
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
      throw new DshRpcError("bad-response", `DSH RPC ${method} missing result`);
    }
    if (result.ok === false) {
      const error = result.error || {};
      throw new DshRpcError(
        typeof error.code === "string" ? error.code : "rpc-error",
        typeof error.message === "string" ? error.message : `DSH RPC ${method} failed`,
        error.details,
      );
    }
    return result.value;
  }
}
