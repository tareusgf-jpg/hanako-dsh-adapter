// hana-dsh-adapter: adapter task metadata store under ctx.dataDir.
// Stores ONLY adapter metadata (adapter task id, DSH session id, cwd, prompt
// summary/length, timestamps, state, last error). DSH remains the source of
// truth for sessions and outputs. Atomic writes via temp file + rename.
// A corrupt JSON file must never crash plugin startup.
//
// The store is deliberately dumb about the state machine (see lib/task-state.js
// for the single source of truth): it only tracks when `status` last changed
// (statusChangedAt) so the service can apply classification grace windows.
//
// Write semantics (M5):
// - Every create/update is a SERIALIZED commit: mutate the in-memory Map, then
//   atomically persist the whole snapshot (tmp + rename). Operations queue on
//   a single chain, so a failing write can never be silently committed by a
//   later operation and a later operation always builds on the previous
//   committed state.
// - On persist failure the mutation is ROLLED BACK in memory (create deletes
//   the record, update restores the previous record), the tmp file is removed
//   best-effort, the caller still receives the rejection, and the store stays
//   fully writable for subsequent operations (never poisoned).
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeStatus } from "./task-state.js";

export class TaskStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

export class TaskStore {
  constructor({ dataDir, log = null, now = null }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "tasks.json");
    this.log = log;
    this.now = now ?? (() => Date.now());
    this.tasks = new Map();
    this.#opChain = Promise.resolve();
  }

  #opChain = Promise.resolve();

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        this.tasks = new Map();
        return;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("unexpected JSON shape");
      }
      // Normalize every legacy record so missing new fields never crash and
      // old statuses (running/done/cancelled/failed) keep their meaning.
      const now = this.now();
      const normalized = {};
      for (const [id, rawRecord] of Object.entries(parsed)) {
        if (!rawRecord || typeof rawRecord !== "object") {
          this.log?.warn?.(`hana-dsh-adapter: skipping malformed task record ${id}`);
          continue;
        }
        normalized[id] = normalizeRecord(rawRecord, now);
      }
      this.tasks = new Map(Object.entries(normalized));
    } catch (error) {
      this.log?.warn?.(
        `hana-dsh-adapter: tasks.json is corrupt, starting with an empty store: ${error.message}`,
      );
      this.tasks = new Map();
    }
  }

  /**
   * Create a task record. `id` and `status` are optional (legacy defaults keep
   * old callers working); the service always passes an explicit status so the
   * submit chain starts at "creating". Serialized commit: on persist failure
   * the record is removed from memory and the rejection is rethrown.
   */
  create({ id = null, status = "running", sessionId, cwd, agentPreset, promptSummary, promptLength }) {
    const recordId = id ?? `task_${randomUUID()}`;
    return this.#enqueue(async () => {
      const now = this.now();
      const record = {
        id: recordId,
        sessionId: typeof sessionId === "string" ? sessionId : null,
        cwd: typeof cwd === "string" && cwd !== "" ? cwd : null,
        agentPreset,
        promptSummary,
        promptLength,
        status: normalizeStatus(status),
        terminalReason: null,
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
        lastError: null,
        resultText: null,
        cancelledAt: null,
        cancelRequestedAt: null,
        previousStatus: null,
        uncertainSince: null,
        uncertainReason: null,
      };
      this.tasks.set(recordId, record);
      try {
        await this.#persistNow();
      } catch (error) {
        this.tasks.delete(recordId);
        throw error;
      }
      return clone(record);
    });
  }

  /**
   * Patch a record. `touch: false` skips the updatedAt bump (used for
   * presentation-only refreshes such as resultText folding). statusChangedAt
   * is bumped automatically whenever `status` actually changes.
   * `casStatus` (optional) makes the patch conditional: if the current status
   * differs, a TaskStoreError("conflict") is thrown WITHOUT mutating anything
   * (used by cancel() to serialize concurrent cancel requests).
   * Serialized commit: on persist failure the previous record is restored in
   * memory and the rejection is rethrown.
   */
  update(id, patch, { touch = true, casStatus = null } = {}) {
    return this.#enqueue(async () => {
      const record = this.tasks.get(id);
      if (!record) {
        throw new TaskStoreError("not-found", `task ${id} not found`);
      }
      if (casStatus !== null && casStatus !== undefined && record.status !== casStatus) {
        throw new TaskStoreError(
          "conflict",
          `task ${id} status ${record.status} does not match expected ${casStatus}`,
        );
      }
      const now = this.now();
      const next = { ...record, ...patch };
      if (typeof patch.status === "string" && patch.status !== record.status) {
        next.statusChangedAt = now;
      }
      if (touch) {
        next.updatedAt = now;
      }
      this.tasks.set(id, next);
      try {
        await this.#persistNow();
      } catch (error) {
        this.tasks.set(id, record);
        throw error;
      }
      return clone(next);
    });
  }

  get(id) {
    const record = this.tasks.get(id);
    return record ? clone(record) : null;
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map(clone);
  }

  /** Resolves once all pending operations (mutations + persists) have settled (test hook). */
  flush() {
    return this.#opChain;
  }

  /**
   * Serialize one mutation + persist as a single commit. The stored chain
   * swallows errors so one failed write never poisons the store; the returned
   * promise still rejects for THIS caller.
   */
  #enqueue(op) {
    const run = this.#opChain.then(op);
    this.#opChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Atomic snapshot write (temp file + rename); tmp is removed on failure. */
  async #persistNow() {
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    const body = JSON.stringify(Object.fromEntries(this.tasks), null, 2);
    try {
      await fs.writeFile(tmpPath, body, "utf8");
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/** Fold a (possibly legacy) raw record into the canonical shape. Never throws. */
function normalizeRecord(raw, now) {
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : now;
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    agentPreset: typeof raw.agentPreset === "string" ? raw.agentPreset : null,
    promptSummary: typeof raw.promptSummary === "string" ? raw.promptSummary : null,
    promptLength: Number.isFinite(raw.promptLength) ? raw.promptLength : null,
    status: normalizeStatus(raw.status),
    terminalReason: typeof raw.terminalReason === "string" ? raw.terminalReason : null,
    statusChangedAt: Number.isFinite(raw.statusChangedAt)
      ? raw.statusChangedAt
      : Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : now,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : updatedAt,
    updatedAt,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    resultText: typeof raw.resultText === "string" ? raw.resultText : null,
    cancelledAt: Number.isFinite(raw.cancelledAt) ? raw.cancelledAt : null,
    cancelRequestedAt: Number.isFinite(raw.cancelRequestedAt) ? raw.cancelRequestedAt : null,
    previousStatus: typeof raw.previousStatus === "string" ? raw.previousStatus : null,
    uncertainSince: Number.isFinite(raw.uncertainSince) ? raw.uncertainSince : null,
    uncertainReason: typeof raw.uncertainReason === "string" ? raw.uncertainReason : null,
  };
}

function clone(value) {
  return structuredClone(value);
}
