// hana-dsh-adapter: configuration normalization.
// All DSH URLs are restricted to loopback; all workspace roots must be absolute.
import os from "node:os";
import path from "node:path";

export const PLUGIN_VERSION = "0.3.0";

export const DEFAULT_URL = "http://127.0.0.1:3080";

/**
 * Derive the default DSH CLI entry at runtime — never a machine-specific
 * literal. Uses $DSH_HOME when set, otherwise the user's home directory,
 * joined with DSH's conventional profile install layout:
 *   <base>/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js
 * An explicit `dshExecutable` config value always overrides this default.
 */
export function defaultExecutablePath(home = process.env.DSH_HOME || os.homedir()) {
  return path.join(home, ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}
export const DEFAULT_EXECUTABLE = defaultExecutablePath();

/**
 * Default workspace roots: intentionally EMPTY — workspace roots are
 * operator-supplied configuration. loadConfig() maps an unconfigured/empty
 * value to the host process's current working directory (with an explicit
 * warning), so the plugin always boots with at least one real absolute root
 * while operators are nudged to configure a tighter boundary.
 */
export const DEFAULT_ROOTS = [];
export const DEFAULT_AUTO_START = true;
export const DEFAULT_AGENT_PRESET = "router-standard";
export const MAX_WAIT_SECONDS = 900;
export const MAX_PROMPT_CHARS = 200_000;
// Phase 1 — approval loop:
// - dshApprovalNotify: master switch for chat push (session:send) of approval
//   events. Records are persisted and the page keeps working either way.
// - dshApprovalTimeoutMs: 0 = a pending approval waits forever (commander's
//   decision); > 0 abandons an unanswered approval after the given
//   milliseconds — the record is marked timed-out with a chat feedback and is
//   never auto-answered (auto-approval AND auto-rejection are both forbidden;
//   DSH keeps the ask pending).
export const DEFAULT_APPROVAL_NOTIFY = true;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 0;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function stripBrackets(host) {
  if (typeof host === "string" && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * Validate and canonicalize a DSH base URL.
 * Accepts only http://127.0.0.1:port, http://[::1]:port, http://localhost:port.
 * Rejects LAN addresses, domain names, non-http schemes, credentials, paths, query/hash.
 */
export function normalizeDshUrl(input) {
  if (typeof input !== "string") {
    throw new ConfigError("DSH URL must be a string");
  }
  const raw = input.trim();
  if (!raw) {
    throw new ConfigError("DSH URL is empty");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`invalid DSH URL: ${raw}`);
  }
  if (parsed.protocol !== "http:") {
    throw new ConfigError(`DSH URL must use http://, got "${parsed.protocol}//"`);
  }
  const host = stripBrackets(parsed.hostname).toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `DSH URL host must be loopback (127.0.0.1, ::1 or localhost), got "${parsed.hostname}"`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new ConfigError("DSH URL must not contain credentials");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new ConfigError("DSH URL must not contain a path");
  }
  if (parsed.search || parsed.hash) {
    throw new ConfigError("DSH URL must not contain query or hash");
  }
  const port = parsed.port === "" ? 3080 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`DSH URL port must be 1-65535, got "${parsed.port}"`);
  }
  const displayHost = host === "::1" ? `[${host}]` : host;
  return `http://${displayHost}:${port}`;
}

/** True when a config value carries no workspace root entries at all. */
function isEmptyRoots(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "string" && value.trim() === "";
}

/**
 * Normalize configured workspace roots: an array of absolute paths, or a string
 * with entries separated by ';' / ',' / newline. Returns unique canonical paths.
 */
export function parseWorkspaceRoots(input) {
  let entries;
  if (typeof input === "string") {
    entries = input.split(/[;,]+|\r?\n/);
  } else if (Array.isArray(input)) {
    entries = input;
  } else {
    throw new ConfigError("workspace roots must be an array of paths or a string");
  }
  const roots = [];
  const seen = new Set();
  for (const entry of entries) {
    const value = typeof entry === "string" ? entry.trim() : "";
    if (!value) continue;
    if (!path.isAbsolute(value)) {
      throw new ConfigError(`workspace root must be an absolute path, got "${value}"`);
    }
    const canonical = path.normalize(path.resolve(value));
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(canonical);
    }
  }
  if (roots.length === 0) {
    throw new ConfigError("at least one workspace root is required");
  }
  return roots;
}

/**
 * Read and normalize plugin configuration from the Hana ctx.
 * Returns `{ url, executable, workspaceRoots, autoStart, pluginVersion, warnings }`.
 * A broken config value falls back to its default and is reported in `warnings`,
 * so a bad setting never bricks plugin startup.
 */
export async function loadConfig(ctx) {
  const warnings = [];
  const read = async (key, fallback) => {
    try {
      const value = await ctx?.config?.get?.(key);
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };

  const urlRaw = await read("dshUrl", DEFAULT_URL);
  let url = DEFAULT_URL;
  try {
    url = normalizeDshUrl(urlRaw);
  } catch (error) {
    warnings.push(`dshUrl: ${error.message}`);
  }

  const executableRaw = await read("dshExecutable", DEFAULT_EXECUTABLE);
  let executable = DEFAULT_EXECUTABLE;
  if (typeof executableRaw === "string" && executableRaw.trim()) {
    if (path.isAbsolute(executableRaw.trim())) {
      executable = path.normalize(executableRaw.trim());
    } else {
      warnings.push(`dshExecutable must be an absolute path, using default (${DEFAULT_EXECUTABLE})`);
    }
  } else if (executableRaw !== "" && executableRaw !== null && executableRaw !== undefined) {
    warnings.push(`dshExecutable is not a valid path, using default (${DEFAULT_EXECUTABLE})`);
  }

  const rootsRaw = await read("dshWorkspaceRoots", DEFAULT_ROOTS);
  let workspaceRoots;
  if (isEmptyRoots(rootsRaw)) {
    // Unconfigured/empty roots: fall back to the host's current working
    // directory so WorkspacePolicy never sees an empty root list (which would
    // break plugin startup), and warn so the operator tightens the boundary.
    workspaceRoots = [process.cwd()];
    warnings.push(
      `dshWorkspaceRoots: no workspace roots configured; defaulting to the current working directory (${process.cwd()}) — configure dshWorkspaceRoots for a stricter boundary`,
    );
  } else {
    try {
      workspaceRoots = parseWorkspaceRoots(rootsRaw);
    } catch (error) {
      warnings.push(`dshWorkspaceRoots: ${error.message}`);
      workspaceRoots = [process.cwd()];
      warnings.push(`dshWorkspaceRoots: falling back to the current working directory (${process.cwd()})`);
    }
  }

  const autoStartRaw = await read("dshAutoStart", DEFAULT_AUTO_START);
  const autoStart = autoStartRaw === true || autoStartRaw === "true";

  // Phase 1 — approval loop. dshApprovalNotify: master switch for chat push
  // of approval events (default true; records + page keep working either
  // way). dshApprovalTimeoutMs: 0 = pendings wait forever (default);
  // > 0 abandons unanswered pendings after the deadline (local record +
  // feedback only — DSH is never auto-answered).
  const notifyRaw = await read("dshApprovalNotify", DEFAULT_APPROVAL_NOTIFY);
  const approvalNotify = notifyRaw === true || notifyRaw === "true";
  const timeoutRaw = await read("dshApprovalTimeoutMs", DEFAULT_APPROVAL_TIMEOUT_MS);
  let approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;
  const timeoutNumber = Number(timeoutRaw);
  if (Number.isInteger(timeoutNumber) && timeoutNumber >= 0) {
    approvalTimeoutMs = timeoutNumber;
  } else {
    warnings.push(
      `dshApprovalTimeoutMs: invalid value (${timeoutRaw}); using ${DEFAULT_APPROVAL_TIMEOUT_MS} (no timeout)`,
    );
  }

  return {
    url,
    executable,
    workspaceRoots,
    autoStart,
    approvalNotify,
    approvalTimeoutMs,
    pluginVersion: PLUGIN_VERSION,
    warnings,
  };
}
