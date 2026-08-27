// hana-dsh-adapter tool: diagnose.
// User-facing health check: Node runtime / DSH executable / connectivity /
// workspace roots — every check carries a plain-language fix hint, so a
// broken setup is resolvable without reading code or digging into logs.
import fs from "node:fs";
import { execFile } from "node:child_process";

export const name = "diagnose";
export const description =
  "体检 DSH 适配器的运行环境：Node 运行时、DSH 可执行文件、连接状态、工作区根目录，每项带人话修复指引。连不上 DSH 时先跑这个。";

export const parameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

async function nodeCheck() {
  const nodeVersion = process.version;
  const major = Number(nodeVersion.split(".")[0]?.replace("v", "") ?? 0);
  const ok = major >= 20;
  return {
    check: "node",
    label: "Node 运行时",
    status: ok ? "ok" : "warn",
    detail: `${nodeVersion} @ ${process.execPath}`,
    fix: ok ? null : "需要 Node >= 20。请安装或切换 Node 版本后重启 Hana。",
  };
}

async function executableCheck(config) {
  const raw = config.executable;
  if (!raw) {
    return {
      check: "executable",
      label: "DSH 可执行文件",
      status: "warn",
      detail: "未显式配置 dshExecutable（将按默认路径推导）",
      fix: "可在插件配置里显式填写 dsh bin.js 的绝对路径。",
    };
  }
  let exists = false;
  try {
    exists = fs.existsSync(raw);
  } catch {
    exists = false;
  }
  if (!exists) {
    return {
      check: "executable",
      label: "DSH 可执行文件",
      status: "fail",
      detail: `路径不存在：${raw}`,
      fix: "检查 dshExecutable 配置是否为真实存在的 bin.js 路径；若 DSH 安装在其它位置，改配置指向它。",
    };
  }
  // Cheap smoke: bin.js --version. A real DSH install answers within seconds.
  const version = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [raw, "--version"],
      { timeout: 15000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout).trim().split("\n")[0] || null);
      },
    );
  });
  if (!version) {
    return {
      check: "executable",
      label: "DSH 可执行文件",
      status: "fail",
      detail: `路径存在但 --version 无响应：${raw}`,
      fix: "该文件可能不是有效的 dsh bin.js，或 DSH 依赖损坏；重新安装 DSH 后重试。",
    };
  }
  return {
    check: "executable",
    label: "DSH 可执行文件",
    status: "ok",
    detail: `${raw}（${version}）`,
    fix: null,
  };
}

async function connectivityCheck(runtime) {
  const s = await runtime.supervisor.status();
  if (s.reachable) {
    return {
      check: "connectivity",
      label: "DSH 连接",
      status: "ok",
      detail: `可达 ${s.url}${s.owned ? `（本插件启动，pid=${s.pid}）` : "（外部进程）"}`,
      fix: null,
    };
  }
  const extra =
    s.owned === true
      ? "本插件负责启动的进程不在了，可调用 start 重新拉起。"
      : "没有外部 DSH 在监听。";
  return {
    check: "connectivity",
    label: "DSH 连接",
    status: "fail",
    detail: `不可达 ${s.url}${s.probeError ? `：${String(s.probeError).slice(0, 200)}` : ""}`,
    fix: `${extra} 确认 DSH 已安装（可执行文件检查会指出路径问题），然后调用 start，或在终端手动运行：dsh web --host 127.0.0.1 --port 3080。`,
  };
}

async function workspaceCheck(runtime) {
  const roots = runtime.workspacePolicy.listRoots();
  const missing = roots.filter((root) => {
    try {
      return !fs.existsSync(root);
    } catch {
      return true;
    }
  });
  if (roots.length === 0) {
    return {
      check: "workspace",
      label: "工作区根目录",
      status: "warn",
      detail: "未配置 dshWorkspaceRoots（将回退到宿主进程 cwd）",
      fix: "建议在插件配置里显式填写允许的任务工作目录，收紧边界。",
    };
  }
  if (missing.length > 0) {
    return {
      check: "workspace",
      label: "工作区根目录",
      status: "fail",
      detail: `以下配置的根目录不存在：${missing.join("；")}`,
      fix: "修正 dshWorkspaceRoots 为真实存在的目录（绝对路径）。",
    };
  }
  return {
    check: "workspace",
    label: "工作区根目录",
    status: "ok",
    detail: roots.join("；"),
    fix: null,
  };
}

function verdict(items) {
  const fail = items.filter((item) => item.status === "fail").length;
  const warn = items.filter((item) => item.status === "warn").length;
  if (fail > 0) return "broken";
  if (warn > 0) return "degraded";
  return "healthy";
}

export async function execute(input, ctx) {
  const runtime = requireRuntime(ctx);
  const checks = [
    await nodeCheck(),
    await executableCheck(runtime.config),
    await connectivityCheck(runtime),
    await workspaceCheck(runtime),
  ];
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            verdict: verdict(checks),
            checks,
            pluginVersion: runtime.config.pluginVersion,
            url: runtime.config.url,
            autoStart: runtime.config.autoStart,
            approvalNotify: runtime.config.approvalNotify,
            approvalTimeoutMs: runtime.config.approvalTimeoutMs,
            taskCount: runtime.taskStore.list().length,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function requireRuntime(ctx) {
  if (!ctx._dshAdapter?.service) {
    throw new Error("hana-dsh-adapter 插件尚未初始化，请确认 full-access 插件已启用。");
  }
  return ctx._dshAdapter;
}
