// hana-dsh-adapter: events.mux approval listener (Phase 1).
//
// Connects to the DSH web profile's mux stream — loopback only (the base URL
// already passed lib/config.js normalizeDshUrl) — and forwards the two
// approval frames to the service:
//   approval/requested { sessionId, approvalId, toolName, callId?, reason? }
//   approval/resolved  { sessionId, approvalId, outcome }
// Every wire message is a FULL server-request envelope
//   { type: "server-request", rpcId, method: <frame type>, payload: <frame> }
// (verified against @deepseek-ai/dsh-host-apiproxy events.schema.js); the
// envelope rpcId is kept — it is the DSH-side correlation token the later
// POST /api/respond client-response must echo.
//
// Transport: ws://127.0.0.1:<port>/api/events.mux via the built-in WebSocket
// (Node >= 22 has it globally); on Node 20 (no global WebSocket) the same
// endpoint's SSE variant is used — both carry identical full envelopes.
//
// Resilience: a dropped stream reconnects with bounded exponential backoff
// (initialDelayMs doubling up to maxDelayMs, deterministic — no jitter).
// Every successful (re)connect fires onOpen so the service re-pulls pending
// approvals from session.history (DSH v1 has no `since` cursor:
// reconnect = re-pull). The listener is downlink-only (never sends a message),
// never throws out of its callbacks and never produces an unhandled
// rejection; its lifetime ends with dispose()/stop().
import { URL } from "node:url";

export const DEFAULT_INITIAL_RECONNECT_MS = 500;
export const DEFAULT_MAX_RECONNECT_MS = 30_000;

/** Derive the loopback WebSocket URL for the mux endpoint from a base http URL. */
export function muxWebSocketUrl(baseUrl) {
  const url = new URL(String(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/events.mux";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Parse one mux wire message (WebSocket frame payload or SSE `data:` line).
 * Returns `{ envelope, frame }` for a valid full server-request envelope, or
 * null for anything else (binary, malformed JSON, non-server-request). Never
 * throws.
 */
export function parseMuxEnvelope(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object" || envelope.type !== "server-request") {
    return null;
  }
  if (typeof envelope.rpcId !== "string" || envelope.rpcId === "") {
    return null;
  }
  const frame = envelope.payload;
  if (!frame || typeof frame !== "object" || typeof frame.type !== "string") {
    return null;
  }
  return { envelope, frame };
}

/** Split an SSE text chunk into the JSON strings of its `data:` lines. */
export function splitSseDataLines(text) {
  const out = [];
  for (const chunk of String(text).split(/\r?\n\r?\n/)) {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith("data: ")) {
        out.push(line.slice("data: ".length));
      }
    }
  }
  return out;
}

// ── Transports (pluggable for tests; both drive the same callbacks) ────────

/** WebSocket downlink transport (Node >= 22 global WebSocket). */
function createWsTransport({ url, onOpen, onFrame, onError, onClose }) {
  const socket = new globalThis.WebSocket(url);
  socket.addEventListener("open", () => onOpen());
  socket.addEventListener("message", (event) => {
    const parsed = parseMuxEnvelope(event.data);
    if (!parsed) {
      onError?.(new Error("malformed events.mux message dropped"));
      return;
    }
    onFrame(parsed);
  });
  socket.addEventListener("error", (event) => {
    onError?.(event?.error ?? new Error("events.mux WebSocket error"));
  });
  socket.addEventListener("close", () => onClose());
  return {
    close: () => {
      try {
        socket.close();
      } catch {
        // already closed — fine
      }
    },
  };
}

/**
 * SSE fallback transport for the same /api/events.mux endpoint (Node 20 has
 * no global WebSocket). Streams the identical full envelopes as `data:` lines.
 */
function createSseTransport({ url, onOpen, onFrame, onError, onClose, fetchImpl = globalThis.fetch }) {
  let aborted = false;
  const controller = new AbortController();
  const httpUrl = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  (async () => {
    let response;
    try {
      response = await fetchImpl(httpUrl, { method: "GET", signal: controller.signal });
    } catch (error) {
      if (!aborted) {
        onError?.(error);
        onClose();
      }
      return;
    }
    if (!response.ok || !response.body) {
      if (!aborted) {
        onError?.(new Error(`events.mux SSE HTTP ${response.status}`));
        onClose();
      }
      return;
    }
    onOpen();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Consume complete \n\n-separated events; keep a partial tail buffered
      // across chunk boundaries.
      const segments = buffer.split("\n\n");
      buffer = segments.pop();
      for (const segment of segments) {
        for (const line of splitSseDataLines(segment)) {
          const parsed = parseMuxEnvelope(line);
          if (parsed) {
            onFrame(parsed);
          }
        }
      }
    }
    if (!aborted) {
      onClose();
    }
  })().catch((error) => {
    if (!aborted) {
      onError?.(error);
      onClose();
    }
  });
  return {
    close: () => {
      aborted = true;
      try {
        controller.abort();
      } catch {
        // already aborted — fine
      }
    },
  };
}

/** Pick the transport factory: WebSocket when the runtime has it, else SSE. */
export function createDefaultTransport() {
  return typeof globalThis.WebSocket === "function" ? createWsTransport : createSseTransport;
}

// ── Listener ────────────────────────────────────────────────────────────────

export class ApprovalMuxListener {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  loopback DSH base URL (config.url)
   * @param {Function} [opts.onFrame]  (frame, envelope) => void — approval frames only
   * @param {Function} [opts.onOpen]  () => void — fired after every successful (re)connect
   * @param {Function} [opts.onClose]  () => void — fired when a stream drops
   * @param {object} [opts.log]
   * @param {Function} [opts.sleep]  injectable sleep (tests)
   * @param {number} [opts.initialDelayMs]  first reconnect delay (default 500)
   * @param {number} [opts.maxDelayMs]  reconnect delay cap (default 30s)
   * @param {Function} [opts.transportFactory]  ({url,onOpen,onFrame,onError,onClose}) => { close() }
   */
  constructor({
    baseUrl,
    onFrame = null,
    onOpen = null,
    onClose = null,
    log = null,
    sleep = null,
    initialDelayMs = DEFAULT_INITIAL_RECONNECT_MS,
    maxDelayMs = DEFAULT_MAX_RECONNECT_MS,
    transportFactory = null,
  }) {
    this.url = muxWebSocketUrl(baseUrl);
    this.onFrame = onFrame;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.log = log;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.initialDelayMs = initialDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.transportFactory = transportFactory ?? createDefaultTransport();
    this.state = "idle"; // idle | connecting | open | stopped
    this.connectCount = 0;
    this.#started = false;
    this.#generation = 0;
    this.#handle = null;
    this.#attempt = 0;
  }

  #started = false;
  #generation = 0;
  #handle = null;
  #attempt = 0;

  /** Connect (or start the reconnect loop). No-op when already started/stopped. */
  start() {
    if (this.#started) {
      return this;
    }
    this.#started = true;
    const gen = ++this.#generation;
    this.#connect(gen).catch((error) => {
      this.log?.error?.(`hana-dsh-adapter events.mux listener failed: ${error?.message || error}`);
    });
    return this;
  }

  /**
   * Dispose: idempotent; closes the stream and cancels any scheduled
   * reconnect (a generation bump invalidates in-flight work). Safe to call
   * from the plugin register() path.
   */
  stop() {
    this.#started = false;
    this.#generation++;
    this.state = "stopped";
    const handle = this.#handle;
    this.#handle = null;
    if (handle) {
      try {
        handle.close();
      } catch {
        // best-effort close
      }
    }
  }

  async #connect(gen) {
    this.state = "connecting";
    this.connectCount++;
    const factory = this.transportFactory;
    let handle;
    try {
      handle = await factory({
        url: this.url,
        onOpen: () => this.#onTransportOpen(gen),
        onFrame: (parsed) => this.#onTransportFrame(gen, parsed),
        onError: (error) =>
          this.log?.warn?.(`hana-dsh-adapter events.mux stream error: ${error?.message || error}`),
        onClose: () => this.#onTransportClose(gen),
      });
    } catch (error) {
      // The transport factory itself threw (e.g. unsupported URL): reconnect
      // with backoff rather than dying — the stream is optional.
      this.log?.warn?.(
        `hana-dsh-adapter events.mux connect failed: ${error?.message || error}; retrying`,
      );
      await this.#scheduleReconnect(gen);
      return;
    }
    if (this.#generation !== gen || !this.#started) {
      // Stopped while connecting: close the late handle, never keep it open.
      try {
        handle.close();
      } catch {
        // best-effort
      }
      return;
    }
    this.#handle = handle;
  }

  #onTransportOpen(gen) {
    if (this.#generation !== gen || !this.#started) {
      return;
    }
    this.state = "open";
    this.#attempt = 0;
    try {
      this.onOpen?.();
    } catch (error) {
      this.log?.error?.(
        `hana-dsh-adapter events.mux onOpen handler failed: ${error?.message || error}`,
      );
    }
  }

  #onTransportFrame(gen, parsed) {
    if (this.#generation !== gen || !this.#started) {
      return;
    }
    const frame = parsed.frame;
    if (frame.type !== "approval/requested" && frame.type !== "approval/resolved") {
      return; // the listener is approval-scoped; other mux frames are ignored
    }
    try {
      this.onFrame?.(frame, parsed.envelope);
    } catch (error) {
      this.log?.error?.(
        `hana-dsh-adapter approval frame handler failed: ${error?.message || error}`,
      );
    }
  }

  #onTransportClose(gen) {
    if (this.#generation !== gen || !this.#started) {
      return;
    }
    this.state = "idle";
    this.#handle = null;
    try {
      this.onClose?.();
    } catch (error) {
      this.log?.error?.(
        `hana-dsh-adapter events.mux onClose handler failed: ${error?.message || error}`,
      );
    }
    this.#scheduleReconnect(gen).catch(() => {
      // never an unhandled rejection
    });
  }

  /** Exponential backoff, bounded by maxDelayMs; reset on successful open. */
  async #scheduleReconnect(gen) {
    if (this.#generation !== gen || !this.#started) {
      return;
    }
    const delay = Math.min(this.initialDelayMs * 2 ** this.#attempt, this.maxDelayMs);
    this.#attempt++;
    this.log?.warn?.(
      `hana-dsh-adapter events.mux disconnected; reconnecting in ${delay}ms (attempt ${this.#attempt})`,
    );
    try {
      await this.sleep(delay);
    } catch {
      return; // sleep interrupted (test hook) — reconnect loop is cancelled
    }
    if (this.#generation !== gen || !this.#started) {
      return;
    }
    await this.#connect(gen);
  }
}
