// config: loopback URL validation, root parsing, fallback behavior.
// All paths come from os.tmpdir() — no machine-specific literals.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  normalizeDshUrl,
  parseWorkspaceRoots,
  loadConfig,
  ConfigError,
  defaultExecutablePath,
  DEFAULT_URL,
  DEFAULT_EXECUTABLE,
  DEFAULT_ROOTS,
  DEFAULT_AUTO_START,
} from "../lib/config.js";

const WS_A = path.join(os.tmpdir(), "dsh-config-workspace-a");
const WS_B = path.join(os.tmpdir(), "dsh-config-workspace-b");

test("normalizeDshUrl accepts loopback URLs", () => {
  assert.equal(normalizeDshUrl("http://127.0.0.1:3080"), "http://127.0.0.1:3080");
  assert.equal(normalizeDshUrl("  http://127.0.0.1:3080/  "), "http://127.0.0.1:3080");
  assert.equal(normalizeDshUrl("http://localhost:3080"), "http://localhost:3080");
  assert.equal(normalizeDshUrl("http://[::1]:3080"), "http://[::1]:3080");
  assert.equal(normalizeDshUrl("http://127.0.0.1"), "http://127.0.0.1:3080"); // missing port -> 3080
});

test("normalizeDshUrl rejects non-loopback URLs", () => {
  const rejects = [
    "http://192.168.1.5:3080",
    "http://10.0.0.1:3080",
    "http://dsh.example.com:3080",
    "http://127.0.0.1.evil.com:3080",
    "https://127.0.0.1:3080",
    "ftp://127.0.0.1:3080",
    "http://user:pass@127.0.0.1:3080",
    "http://127.0.0.1:3080/path",
    "http://127.0.0.1:3080/?q=1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:70000",
    "http://127.0.0.1:abc",
    "",
    "   ",
    "127.0.0.1:3080", // scheme required
    null,
    42,
  ];
  for (const value of rejects) {
    assert.throws(() => normalizeDshUrl(value), ConfigError, `should reject: ${String(value)}`);
  }
});

test("parseWorkspaceRoots handles arrays and delimited strings", () => {
  const roots = parseWorkspaceRoots([WS_A, WS_B]);
  assert.deepEqual(roots, [WS_A, WS_B]);
  const fromString = parseWorkspaceRoots(`${WS_A};${WS_B}`);
  assert.deepEqual(fromString, [WS_A, WS_B]);
});

test("parseWorkspaceRoots dedupes and rejects relative paths", () => {
  const roots = parseWorkspaceRoots([WS_A, WS_A]);
  assert.equal(roots.length, 1);
  // Windows roots are case-insensitive; the dedup fold is win32-only.
  if (process.platform === "win32") {
    const folded = parseWorkspaceRoots([WS_A, WS_A.toUpperCase()]);
    assert.equal(folded.length, 1);
  }
  assert.throws(() => parseWorkspaceRoots(["relative\\path"]), ConfigError);
  assert.throws(() => parseWorkspaceRoots([]), ConfigError);
  assert.throws(() => parseWorkspaceRoots(123), ConfigError);
});

test("defaultExecutablePath derives from DSH_HOME or the home directory — never a literal", () => {
  const base = path.join(os.tmpdir(), "dsh-home");
  const derived = defaultExecutablePath(base);
  assert.equal(
    derived,
    path.join(base, ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  );
  assert.ok(path.isAbsolute(DEFAULT_EXECUTABLE), "the exported default is an absolute path");
  assert.ok(DEFAULT_EXECUTABLE.includes(path.join(".dsh", "profiles")), "follows the ~/.dsh profile layout");

  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = base;
    assert.equal(defaultExecutablePath(), derived, "$DSH_HOME wins over the home directory");
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test("loadConfig falls back to defaults with warnings on bad values", async () => {
  const ctx = {
    config: {
      async get(key) {
        if (key === "dshUrl") return "http://192.168.1.9:3080"; // invalid -> default
        if (key === "dshExecutable") return "not-absolute.js"; // invalid -> default
        if (key === "dshWorkspaceRoots") return "relative"; // invalid -> default
        if (key === "dshAutoStart") return false;
        return undefined;
      },
    },
  };
  const config = await loadConfig(ctx);
  assert.equal(config.url, DEFAULT_URL);
  assert.equal(config.executable, DEFAULT_EXECUTABLE);
  // Invalid roots fall back to the process working directory (never empty).
  assert.deepEqual(config.workspaceRoots, [process.cwd()]);
  assert.equal(config.autoStart, false);
  assert.equal(config.warnings.length, 4); // url + executable + roots parse + roots fallback
});

test("loadConfig reads valid values", async () => {
  const ctx = {
    config: {
      async get(key) {
        if (key === "dshUrl") return "http://localhost:4000";
        if (key === "dshWorkspaceRoots") return [WS_A];
        return undefined;
      },
    },
  };
  const config = await loadConfig(ctx);
  assert.equal(config.url, "http://localhost:4000");
  assert.deepEqual(config.workspaceRoots, [WS_A]);
  assert.equal(config.autoStart, DEFAULT_AUTO_START);
  assert.equal(config.warnings.length, 0);
});

test("loadConfig tolerates a missing config service and unconfigured roots", async () => {
  const config = await loadConfig({});
  assert.equal(config.url, DEFAULT_URL);
  assert.equal(config.executable, DEFAULT_EXECUTABLE);
  // DEFAULT_ROOTS is empty by design; loadConfig maps it to process.cwd()
  // with a warning so the plugin always boots with at least one real root.
  assert.deepEqual(DEFAULT_ROOTS, []);
  assert.deepEqual(config.workspaceRoots, [process.cwd()]);
  assert.equal(config.warnings.length, 1);
});

test("loadConfig treats an explicitly empty roots value like an unconfigured one", async () => {
  const ctx = {
    config: {
      async get(key) {
        if (key === "dshWorkspaceRoots") return [];
        return undefined;
      },
    },
  };
  const config = await loadConfig(ctx);
  assert.deepEqual(config.workspaceRoots, [process.cwd()]);
  assert.equal(config.warnings.length, 1);
});

// ── Phase 1 approval config ─────────────────────────────────────────────────

test("loadConfig reads approval config values", async () => {
  const ctx = {
    config: {
      async get(key) {
        if (key === "dshApprovalNotify") return false;
        if (key === "dshApprovalTimeoutMs") return 5000;
        return undefined;
      },
    },
  };
  const config = await loadConfig(ctx);
  assert.equal(config.approvalNotify, false);
  assert.equal(config.approvalTimeoutMs, 5000);
});

test("loadConfig defaults approval config to notify on, no timeout", async () => {
  const config = await loadConfig({});
  assert.equal(config.approvalNotify, true);
  assert.equal(config.approvalTimeoutMs, 0);
});

test("loadConfig normalizes invalid approval values with warnings", async () => {
  const ctx = {
    config: {
      async get(key) {
        if (key === "dshApprovalTimeoutMs") return -3; // negative → 0 + warning
        return undefined;
      },
    },
  };
  const config = await loadConfig(ctx);
  assert.equal(config.approvalNotify, true);
  assert.equal(config.approvalTimeoutMs, 0);
  assert.ok(config.warnings.some((w) => w.includes("dshApprovalTimeoutMs")));

  const stringy = { config: { async get(key) { if (key === "dshApprovalTimeoutMs") return "1.5"; return undefined; } } };
  const config2 = await loadConfig(stringy);
  assert.equal(config2.approvalTimeoutMs, 0, "non-integer values fall back to 0");
  assert.equal(config2.warnings.length, 2, "roots fallback + timeout warning");
});
