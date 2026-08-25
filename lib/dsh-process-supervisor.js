// hana-dsh-adapter: DSH process supervisor.
// - Probes health first; a reachable external DSH is reused (owned: false).
// - Starts the fixed DSH CLI (bin.js) with FIXED arguments web --host 127.0.0.1
//   --port <configured port>. No user input is ever concatenated into the
//   command line and `shell` is never used.
// - Never kills a process it did not start.
// - Captures stdout/stderr tails for diagnostics; bounded health wait.
import { spawn } from "node:child_process";
import fs from "node:fs";

export class DshStartError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DshStartError";
    this.code = code;
  }
}

const HEALTH_POLL_MS = 250;
const KILL_GRACE_MS = 3_000;
const TAIL_LIMIT = 8_192;

/** Fixed DSH web-profile arguments. The port comes from the configured URL only. */
export function buildWebArgs(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new DshStartError("invalid-port", `invalid DSH port: ${port}`);
  }
  return ["web", "--host", "127.0.0.1", "--port", String(p)];
}

/**
 * Default spawn: run the current Node binary with the fixed bin.js as argv[1].
 * On Windows a bare .js cannot be CreateProcess'd (EPERM) and shell=true is
 * forbidden by the security model, so node <script> is the only shell-free way.
 */
function defaultSpawnImpl(executable, args) {
  return spawn(process.execPath, [executable, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env },
  });
}

export class DshProcessSupervisor {
  /**
   * @param {object} opts
   * @param {string} opts.executable  fixed dsh bin.js path
   * @param {object} opts.rpc  DshRpcClient (must expose health())
   * @param {string[]} [opts.args]  fixed args; defaults to buildWebArgs(port from rpc.baseUrl)
   * @param {Function} [opts.spawnImpl]  (executable, args) => ChildProcess (tests inject fakes)
   * @param {Function} [opts.sleepImpl]  (ms) => Promise (tests inject instant sleep)
   * @param {number} [opts.healthTimeoutMs]  bounded health wait after spawn (default 30s)
   * @param {object} [opts.log]
   */
  constructor({ executable, rpc, args = null, spawnImpl = null, sleepImpl = null, healthTimeoutMs = 30_000, log = null }) {
    this.executable = executable;
    this.rpc = rpc;
    const port = new URL(rpc.baseUrl).port || 3080;
    this.args = args ?? buildWebArgs(port);
    this.spawnImpl = spawnImpl ?? defaultSpawnImpl;
    this.sleepImpl = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.healthTimeoutMs = healthTimeoutMs;
    this.log = log;
    this.child = null; // { proc }
    this.startedByUs = false;
    this.tail = { stdout: "", stderr: "" };
    this.#starting = null;
  }

  #starting = null;

  async status() {
    const probe = await this.rpc.health();
    const child = this.child;
    let executableExists = false;
    try {
      executableExists = fs.existsSync(this.executable);
    } catch {
      executableExists = false;
    }
    return {
      url: this.rpc.baseUrl,
      reachable: probe.ok === true,
      probeError: probe.ok === true ? null : (probe.error ?? `HTTP ${probe.status}`),
      owned: this.startedByUs,
      pid: child && this.#isAlive(child.proc) ? child.proc.pid ?? null : null,
      executableExists,
      executablePath: this.executable,
    };
  }

  /** Idempotent start: dedupe concurrent calls, reuse external DSH, never double-start. */
  async ensureStarted({ autoStart = true } = {}) {
    if (this.#starting) {
      return this.#starting;
    }
    this.#starting = this.#ensureStartedInner({ autoStart }).finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #ensureStartedInner({ autoStart }) {
    const probe = await this.rpc.health();
    if (probe.ok === true) {
      return { started: false, owned: false, pid: null };
    }
    const child = this.child;
    if (child && this.#isAlive(child.proc)) {
      // Already spawned by us but not yet healthy: keep waiting (bounded).
      const healthy = await this.#waitForHealth();
      if (!healthy) {
        throw new DshStartError(
          "health-timeout",
          `DSH child did not become healthy within ${this.healthTimeoutMs}ms; ${this.#tailSummary()}`,
        );
      }
      return { started: false, owned: true, pid: child.proc.pid ?? null };
    }
    if (!autoStart) {
      throw new DshStartError("unreachable", "DSH is not reachable and auto-start is disabled");
    }
    return this.#spawnAndWait();
  }

  async #spawnAndWait() {
    let proc;
    try {
      proc = this.spawnImpl(this.executable, this.args);
    } catch (error) {
      throw new DshStartError("spawn-failed", `failed to spawn DSH: ${error?.message || String(error)}`);
    }
    this.child = { proc };
    this.startedByUs = true;
    this.tail = { stdout: "", stderr: "" };
    this.#attachStreams(proc);
    let spawnError = null;
    let exitInfo = null;
    proc.once("error", (error) => {
      spawnError = error;
    });
    proc.once("exit", (code, signal) => {
      exitInfo = { code, signal };
    });

    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      if (spawnError) {
        this.#disposeChild();
        throw new DshStartError("spawn-failed", `failed to spawn DSH: ${spawnError.message}`);
      }
      if (exitInfo && (exitInfo.code !== null || exitInfo.signal !== null)) {
        this.#disposeChild();
        throw new DshStartError(
          "spawn-exited",
          `DSH exited early (code=${exitInfo.code}, signal=${exitInfo.signal}); ${this.#tailSummary()}`,
        );
      }
      const probe = await this.rpc.health();
      if (probe.ok === true) {
        return { started: true, owned: true, pid: proc.pid ?? null };
      }
      if (Date.now() >= deadline) {
        this.#disposeChild();
        throw new DshStartError(
          "health-timeout",
          `DSH did not become healthy within ${this.healthTimeoutMs}ms; ${this.#tailSummary()}`,
        );
      }
      await this.sleepImpl(HEALTH_POLL_MS);
    }
  }

  /** Stop only the child this supervisor started. Never touches external processes. */
  async stopOwned() {
    const child = this.child;
    if (!child || !this.startedByUs) {
      return { stopped: false, owned: false };
    }
    const proc = child.proc;
    if (this.#isAlive(proc)) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      await this.#waitForExit(proc, KILL_GRACE_MS);
      if (this.#isAlive(proc)) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this.#disposeChild();
    return { stopped: true, owned: false };
  }

  async #waitForHealth() {
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      const probe = await this.rpc.health();
      if (probe.ok === true) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await this.sleepImpl(HEALTH_POLL_MS);
    }
  }

  #waitForExit(proc, ms) {
    if (!this.#isAlive(proc)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #attachStreams(proc) {
    proc.stdout?.on("data", (chunk) => {
      this.#appendTail("stdout", chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      this.#appendTail("stderr", chunk);
    });
  }

  #appendTail(which, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    this.tail[which] = (this.tail[which] + text).slice(-TAIL_LIMIT);
  }

  #tailSummary() {
    const stdout = this.tail.stdout.trim();
    const stderr = this.tail.stderr.trim();
    return `stdout tail: ${stdout ? JSON.stringify(stdout.slice(-400)) : "(empty)"}; stderr tail: ${stderr ? JSON.stringify(stderr.slice(-400)) : "(empty)"}`;
  }

  #disposeChild() {
    const child = this.child;
    if (child && this.#isAlive(child.proc)) {
      try {
        child.proc.kill();
      } catch {
        // ignore
      }
    }
    this.child = null;
    this.startedByUs = false;
  }

  #isAlive(proc) {
    return proc !== null && proc !== undefined && proc.exitCode === null && proc.signalCode === null;
  }
}
