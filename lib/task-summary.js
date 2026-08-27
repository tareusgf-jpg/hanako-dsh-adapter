// hana-dsh-adapter: task presentation summary (0.4).
//
// Builds the human-oriented completion summary the tools attach to their
// output: status, elapsed time, delivery location (cwd), result size and the
// approval ledger for the task (total + still pending). The goal is that a
// caller can report "what happened" without parsing raw task internals.
//
// Pure over read-only inputs; never throws for missing/odd records — every
// field degrades to null/0 instead.

const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "cancelled",
  "orphaned",
  "no-final-output",
]);

/**
 * @param {object} runtime  ctx._dshAdapter (needs taskStore + approvalStore)
 * @param {object} task  the adapter task record (from submit/inspect/store)
 * @returns {object} presentation summary
 */
export function buildTaskSummary(runtime, task) {
  const terminal = TERMINAL_STATUSES.has(task?.status);
  const durationMs =
    terminal &&
    Number.isFinite(task?.createdAt) &&
    Number.isFinite(task?.statusChangedAt) &&
    task.statusChangedAt >= task.createdAt
      ? task.statusChangedAt - task.createdAt
      : null;

  let approvals = { total: 0, pending: 0, resolved: 0 };
  try {
    const all = runtime?.approvalStore?.list?.() ?? [];
    const mine = all.filter((record) => record.taskId === task?.id);
    approvals = {
      total: mine.length,
      pending: mine.filter((record) => record.status === "pending").length,
      resolved: mine.filter((record) => record.status !== "pending").length,
    };
  } catch {
    // presentation-only: an approval-store failure never breaks the summary
  }

  return {
    status: task?.status ?? null,
    terminalReason: task?.terminalReason ?? null,
    durationMs,
    cwd: task?.cwd ?? null,
    resultTextLength: typeof task?.resultText === "string" ? task.resultText.length : null,
    approvals,
  };
}

/** Render the summary as a compact one-line text for chat-style reporting. */
export function formatTaskSummary(summary) {
  const parts = [`状态=${summary.status}`];
  if (summary.terminalReason) {
    parts.push(`原因=${summary.terminalReason}`);
  }
  if (summary.durationMs !== null) {
    parts.push(`耗时=${formatDuration(summary.durationMs)}`);
  }
  if (summary.cwd) {
    parts.push(`工作目录=${summary.cwd}`);
  }
  if (summary.resultTextLength !== null) {
    parts.push(`结果=${summary.resultTextLength} 字符`);
  }
  parts.push(`审批=${summary.approvals.total}（待处理 ${summary.approvals.pending}）`);
  return parts.join(" · ");
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "?";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}
