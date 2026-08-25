// hana-dsh-adapter: pending-approval metadata store under ctx.dataDir
// (approvals.json), mirroring TaskStore's durability contract:
// - Atomic snapshot writes (temp file + rename), one serialized commit chain.
// - A corrupt JSON file must never crash plugin startup (warn + empty store).
// - Legacy/malformed records are normalized on load (new fields default).
//
// Security boundary: this store persists ONLY redacted presentation data —
// the reason is redacted to reasonSummary BEFORE it ever reaches the store
// (lib/approval-service.js owns the redaction), and no credentials, raw
// tool arguments or stacks are ever written here. `rpcId` is kept because it
// is the DSH-side correlation token required to answer the approval; it is
// never exposed through any API view.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class ApprovalStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApprovalStoreError";
    this.code = code;
  }
}

export class ApprovalStore {
  constructor({ dataDir, log = null, now = null }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "approvals.json");
    this.log = log;
    this.now = now ?? (() => Date.now());
    this.approvals = new Map();
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
        this.approvals = new Map();
        return;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("unexpected JSON shape");
      }
      const now = this.now();
      const normalized = {};
      for (const [approvalId, rawRecord] of Object.entries(parsed)) {
        if (!rawRecord || typeof rawRecord !== "object") {
          this.log?.warn?.(`hana-dsh-adapter: skipping malformed approval record ${approvalId}`);
          continue;
        }
        normalized[approvalId] = normalizeApproval(rawRecord, now);
      }
      this.approvals = new Map(Object.entries(normalized));
    } catch (error) {
      this.log?.warn?.(
        `hana-dsh-adapter: approvals.json is corrupt, starting with an empty store: ${error.message}`,
      );
      this.approvals = new Map();
    }
  }

  /**
   * Insert (or refresh) a pending approval record keyed by approvalId.
   * Idempotent for re-delivered frames (mux-open replay / history re-pull):
   * an existing PENDING record keeps its original requestedAt, but a new
   * frame that carries an answer token (rpcId) REFRESHES a pending record
   * that only has one as null — the history re-pull may discover an ask
   * before the mux replay delivers its rpcId, and that rpcId is what makes
   * the approval answerable. An existing RESOLVED record is never
   * resurrected — a stale replay must not flip a settled approval back to
   * pending. Serialized commit with rollback on persist failure.
   * Returns `{ record, created }`.
   */
  upsert({ approvalId, sessionId, taskId, toolName, reasonSummary, rpcId, source = "mux" }) {
    return this.#enqueue(async () => {
      const existing = this.approvals.get(approvalId);
      if (existing) {
        if (existing.status === "pending" && rpcId && !existing.rpcId) {
          const now = this.now();
          const next = {
            ...existing,
            rpcId,
            source,
            updatedAt: now,
          };
          this.approvals.set(approvalId, next);
          try {
            await this.#persistNow();
          } catch (error) {
            this.approvals.set(approvalId, existing);
            throw error;
          }
          return { record: clone(next), created: false };
        }
        // Already settled or no refresh needed: never resurrect, never churn.
        return { record: clone(existing), created: false };
      }
      const now = this.now();
      const record = {
        approvalId,
        sessionId,
        taskId: typeof taskId === "string" ? taskId : null,
        toolName,
        reasonSummary: typeof reasonSummary === "string" ? reasonSummary : null,
        rpcId: typeof rpcId === "string" ? rpcId : null,
        status: "pending",
        outcome: null,
        source,
        requestedAt: now,
        resolvedAt: null,
        updatedAt: now,
      };
      this.approvals.set(approvalId, record);
      try {
        await this.#persistNow();
      } catch (error) {
        this.approvals.delete(approvalId);
        throw error;
      }
      return { record: clone(record), created: true };
    });
  }

  /**
   * Resolve a pending approval. Only pending → resolved is allowed (a
   * resolved record is sticky; calling resolve twice returns null). Returns
   * the updated record or null when there was nothing pending to resolve.
   */
  resolve(approvalId, outcome) {
    return this.#enqueue(async () => {
      const record = this.approvals.get(approvalId);
      if (!record || record.status !== "pending") {
        return null;
      }
      const now = this.now();
      const next = {
        ...record,
        status: "resolved",
        outcome: typeof outcome === "string" ? outcome : null,
        resolvedAt: now,
        updatedAt: now,
      };
      this.approvals.set(approvalId, next);
      try {
        await this.#persistNow();
      } catch (error) {
        this.approvals.set(approvalId, record);
        throw error;
      }
      return clone(next);
    });
  }

  get(approvalId) {
    const record = this.approvals.get(approvalId);
    return record ? clone(record) : null;
  }

  /** Pending approvals, newest first. */
  listPending() {
    return [...this.approvals.values()]
      .filter((record) => record.status === "pending")
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .map(clone);
  }

  /** All records, newest first (audit / tests). */
  list() {
    return [...this.approvals.values()]
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .map(clone);
  }

  /** Resolves once all pending operations (mutations + persists) have settled (test hook). */
  flush() {
    return this.#opChain;
  }

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
    const body = JSON.stringify(Object.fromEntries(this.approvals), null, 2);
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
function normalizeApproval(raw, now) {
  const requestedAt = Number.isFinite(raw.requestedAt) ? raw.requestedAt : now;
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : requestedAt;
  const status = raw.status === "resolved" ? "resolved" : "pending";
  return {
    approvalId: typeof raw.approvalId === "string" ? raw.approvalId : null,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    toolName: typeof raw.toolName === "string" ? raw.toolName : null,
    reasonSummary: typeof raw.reasonSummary === "string" ? raw.reasonSummary : null,
    rpcId: typeof raw.rpcId === "string" ? raw.rpcId : null,
    status,
    outcome: typeof raw.outcome === "string" ? raw.outcome : null,
    source: raw.source === "replay" ? "replay" : "mux",
    requestedAt,
    resolvedAt: Number.isFinite(raw.resolvedAt) ? raw.resolvedAt : null,
    updatedAt,
  };
}

function clone(value) {
  return structuredClone(value);
}
