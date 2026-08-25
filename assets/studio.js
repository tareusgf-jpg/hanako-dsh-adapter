// hana-dsh-adapter "DSH 监听" monitor page.
// Observation only: polls the plugin's narrow /api/overview route every 3s,
// plus /api/approvals for the Phase 1 approval loop (pending approvals with
// 批准一次 / 拒绝 buttons). The browser never talks to the DSH URL directly
// and never embeds the DSH Web UI; every request goes to
// /api/plugins/<pluginId>/api/*.
const body = document.body;
const pluginId = body.dataset.pluginId || "";
const BASE = `/api/plugins/${pluginId}`;
const API = `${BASE}/api`;
const token = new URLSearchParams(location.search).get("token") || "";
const AUTO_REFRESH_MS = 3000;
const MAX_TASKS = 6;

const $ = (id) => document.getElementById(id);

async function api(path) {
  const url = `${API}${path}${token ? (path.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}` : ""}`;
  const response = await fetch(url, { method: "GET", headers: {} });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function apiPost(path, payload) {
  const url = `${API}${path}${token ? (path.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}` : ""}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.error || `HTTP ${response.status}`);
  }
  return data;
}

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

// ── Toast ───────────────────────────────────────────────────────────────────
// Minimal DOM equivalent of @hana/plugin-sdk's `toast.show({ message, type })`
// (type ∈ success|error|info|warning) — the page ships without the SDK
// dependency (Phase 1). Same call shape, so swapping in the real SDK later
// (see hana-notify-spec §1, hyperframes' `Ef.toast.show`) is a one-line change.
const toast = {
  show({ message, type = "info" }) {
    const root = $("toast-root");
    if (!root) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    el.addEventListener("click", () => el.remove());
    root.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  },
};

// ── Small formatters ────────────────────────────────────────────────────────
function badge(ok, yes, no) {
  return `<span class="badge ${ok ? "ok" : "err"}">${ok ? yes : no}</span>`;
}

function shortId(id) {
  if (!id) return "—";
  return id.length > 14 ? `…${id.slice(-10)}` : id;
}

function cwdName(cwd) {
  if (!cwd) return "—";
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

function relTime(ts) {
  if (!ts) return "—";
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 1000) return "刚刚";
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  return new Date(ts).toLocaleTimeString();
}

const STATUS_LABEL = {
  running: "运行中",
  done: "已完成",
  cancelled: "已取消",
  failed: "失败",
};
const STATUS_CLASS = {
  running: "warn",
  done: "ok",
  cancelled: "muted",
  failed: "err",
};

// ── Render ──────────────────────────────────────────────────────────────────
function render(data) {
  const s = data.status || {};
  $("status-reach").innerHTML = badge(s.reachable, "可达", "不可达");
  $("status-url").textContent = s.url || "—";
  $("status-owned").innerHTML = badge(s.owned, "本插件启动", "外部复用");
  $("status-pid").textContent = s.pid ?? "—";
  const exeOk = s.executableExists === true;
  $("status-exe").innerHTML =
    badge(exeOk, "存在", "缺失") +
    `<span class="mono muted" title="${esc(s.executablePath ?? "")}">${esc(exeOk ? s.executablePath : "")}</span>`;
  $("status-tasks").textContent = s.taskCount ?? "—";

  const tasks = Array.isArray(data.tasks) ? data.tasks.slice(0, MAX_TASKS) : [];
  const rows = tasks.map((t) => {
    const label = STATUS_LABEL[t.status] || esc(t.status);
    const cls = STATUS_CLASS[t.status] || "";
    const live = t.dshRunning === true ? '<span class="badge warn">DSH 运行中</span>' : "";
    const readFail = t.error ? `<span class="badge err" title="${esc(t.error.message)}">读取失败</span>` : "";
    const result = t.resultSummary
      ? `<div class="task-result" title="${esc(t.resultSummary)}">${esc(t.resultSummary)}</div>`
      : "";
    const lastErr = t.lastError
      ? `<div class="task-lasterr" title="${esc(t.lastError)}">${esc(t.lastError)}</div>`
      : "";
    return `<li class="task-row">
      <div class="task-head">
        <span class="mono short-id" title="${esc(t.id)}">${esc(shortId(t.id))}</span>
        <span class="badge ${cls}">${label}</span>${live}${readFail}
      </div>
      <div class="task-meta"><span class="mono">${esc(cwdName(t.cwd))}</span> · 更新于 ${esc(relTime(t.updatedAt))}</div>
      ${result}${lastErr}
    </li>`;
  });
  $("task-list").innerHTML =
    rows.join("") || `<li class="task-row empty">暂无任务</li>`;
  $("task-count-label").textContent = tasks.length ? `（最近 ${tasks.length} 条）` : "";

  const recentError = data.recentError;
  if (recentError) {
    $("recent-error").textContent = `最近错误 · ${recentError.code} · ${recentError.message}`;
    $("recent-error").classList.remove("hidden");
  } else {
    $("recent-error").classList.add("hidden");
  }

  // External link only through the Hana host capability — no direct window nav.
  const canOpen = typeof window.hana?.openExternal === "function" && s.url;
  $("open-ui-btn").classList.toggle("hidden", !canOpen);
  if (canOpen) {
    $("open-ui-btn").dataset.url = s.url;
  }
}

// ── Approval section (Phase 1) ──────────────────────────────────────────────
// The page renders only what the plugin API exposes: approvalId / taskId /
// toolName / redacted reasonSummary / requestedAt. rpcId, sessionId and raw
// reasons never leave the plugin.
const seenApprovals = new Set();
let approvalsInitialized = false;

function approvalRow(a) {
  const button = (outcome, label, cls) =>
    `<button class="approval-btn ${cls}" data-id="${esc(a.approvalId)}" data-outcome="${outcome}">${label}</button>`;
  return `<li class="task-row approval-row" data-id="${esc(a.approvalId)}">
    <div class="task-head">
      <span class="badge warn">待审批</span>
      <span class="badge">${esc(a.toolName || "未知工具")}</span>
      <span class="mono short-id" title="${esc(a.approvalId)}">${esc(shortId(a.approvalId))}</span>
    </div>
    <div class="task-meta">任务 ${esc(shortId(a.taskId))} · ${esc(relTime(a.requestedAt))}</div>
    ${a.reasonSummary ? `<div class="task-result" title="${esc(a.reasonSummary)}">${esc(a.reasonSummary)}</div>` : ""}
    <div class="approval-actions">${button("allowed-once", "批准一次", "allow")}${button("rejected", "拒绝", "reject")}</div>
  </li>`;
}

function renderApprovals(approvals) {
  const list = Array.isArray(approvals) ? approvals : [];
  // Toast only genuinely NEW arrivals (the first poll is the baseline).
  if (approvalsInitialized) {
    for (const approval of list) {
      if (!seenApprovals.has(approval.approvalId)) {
        toast.show({ message: `收到审批请求：${approval.toolName}`, type: "warning" });
      }
    }
  }
  for (const approval of list) {
    seenApprovals.add(approval.approvalId);
  }
  approvalsInitialized = true;
  $("approval-list").innerHTML =
    list.map(approvalRow).join("") || `<li class="task-row empty">暂无待处理审批</li>`;
  $("approval-count-label").textContent = list.length ? `（${list.length} 条待处理）` : "";
}

async function respondApproval(button) {
  const id = button.dataset.id;
  const outcome = button.dataset.outcome;
  button.disabled = true;
  try {
    await apiPost(`/approvals/${encodeURIComponent(id)}/respond`, { outcome });
    toast.show({
      message: outcome === "allowed-once" ? "已批准一次" : "已拒绝",
      type: "success",
    });
  } catch (error) {
    // The service never returns stacks or raw DSH details — only redacted
    // codes/messages — so it is safe to show directly.
    toast.show({ message: `审批处理失败：${error.message}`, type: "error" });
    button.disabled = false;
  }
  refresh();
}

function setRefreshedAt() {
  $("refresh-time").textContent = new Date().toLocaleTimeString();
}

// ── Polling ─────────────────────────────────────────────────────────────────
let polling = false;
let autoRefresh = true;
let timer = null;

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const data = await api("/overview");
    render(data);
    $("poll-error").classList.add("hidden");
  } catch (error) {
    $("poll-error").textContent = `获取失败：${error.message}（将自动重试）`;
    $("poll-error").classList.remove("hidden");
  }
  try {
    const approvals = await api("/approvals");
    renderApprovals(approvals.approvals);
  } catch (error) {
    $("approval-error").textContent = `审批获取失败：${error.message}（将自动重试）`;
    $("approval-error").classList.remove("hidden");
  } finally {
    polling = false;
    setRefreshedAt();
  }
}

function schedule() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (autoRefresh && !document.hidden) {
    timer = setInterval(refresh, AUTO_REFRESH_MS);
  }
}

function toggleAuto() {
  autoRefresh = $("auto-toggle").checked;
  schedule();
  if (autoRefresh) refresh();
}

function onVisibility() {
  if (document.hidden) {
    schedule(); // stops the interval while the tab is hidden
  } else {
    schedule();
    refresh();
  }
}

// ── Wire up ─────────────────────────────────────────────────────────────────
function mount() {
  $("root").innerHTML = `
    <header class="page-head">
      <h1>DSH 监听</h1>
      <p class="sub">DeepSeek Harness 本地状态观察哨 · 每 ${AUTO_REFRESH_MS / 1000} 秒自动刷新</p>
      <div class="head-actions">
        <label class="switch-label"><input type="checkbox" id="auto-toggle" checked> 自动刷新</label>
        <button id="refresh-btn">手动刷新</button>
        <button id="open-ui-btn" class="hidden">打开 DSH 界面</button>
        <span class="muted">最近刷新 <b id="refresh-time">—</b></span>
      </div>
    </header>

    <section class="card">
      <h2>DSH 状态</h2>
      <div class="status-grid">
        <div class="kv">可达性 <span id="status-reach">—</span></div>
        <div class="kv">地址 <b class="mono" id="status-url">—</b></div>
        <div class="kv">进程 <span id="status-owned">—</span></div>
        <div class="kv">PID <b id="status-pid">—</b></div>
        <div class="kv">可执行文件 <span id="status-exe">—</span></div>
        <div class="kv">任务总数 <b id="status-tasks">—</b></div>
      </div>
    </section>

    <section class="card">
      <h2>待处理审批 <span class="muted" id="approval-count-label"></span></h2>
      <ul id="approval-list" class="task-list"></ul>
      <div id="approval-error" class="msg err hidden"></div>
    </section>

    <section class="card">
      <h2>最近任务 <span class="muted" id="task-count-label"></span></h2>
      <ul id="task-list" class="task-list"></ul>
    </section>

    <div id="recent-error" class="msg err hidden"></div>
    <div id="poll-error" class="msg err hidden"></div>
    <div id="toast-root" class="toast-root"></div>
  `;

  $("refresh-btn").addEventListener("click", refresh);
  $("auto-toggle").addEventListener("change", toggleAuto);
  $("open-ui-btn").addEventListener("click", (event) => {
    const url = event.currentTarget.dataset.url;
    if (url && typeof window.hana?.openExternal === "function") {
      window.hana.openExternal(url);
    }
  });
  $("approval-list").addEventListener("click", (event) => {
    const button = event.target.closest("button.approval-btn");
    if (button) {
      respondApproval(button);
    }
  });
  document.addEventListener("visibilitychange", onVisibility);

  schedule();
  refresh();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
