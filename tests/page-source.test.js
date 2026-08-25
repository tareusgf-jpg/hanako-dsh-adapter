// Static source assertions for the monitor page: it must stay observation-only.
// No DSH UI embedding, no browser-side DSH URL, no submit form, no tables,
// and every fetch must target the plugin's own /api/plugins/<id>/api base.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFile(path.join(root, rel), "utf8");

test("manifest page declares the DSH 监听 entry", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.contributes.page.title.zh, "DSH 监听");
  assert.equal(manifest.contributes.page.title.en, "DSH Monitor");
  assert.equal(manifest.contributes.page.route, "/studio");
  assert.ok(manifest.contributes.page.icon.includes("<svg"), "icon stays a simple inline svg");
});

test("studio assets never embed, direct-connect or window-open the DSH UI", async () => {
  const js = await read("assets/studio.js");
  const css = await read("assets/studio.css");
  for (const source of [js, css]) {
    assert.ok(!source.includes("iframe"), "must not embed the DSH UI");
    assert.ok(!source.includes("window.open"), "must not window-open the DSH URL");
    assert.ok(!source.includes("127.0.0.1"), "no hardcoded DSH URL in assets");
    assert.ok(!source.includes(":3080"), "no hardcoded DSH port in assets");
  }
});

test("studio page is observation-only: no submit form, no tables, plugin API only", async () => {
  const js = await read("assets/studio.js");
  // No submission UI.
  assert.ok(!js.includes("<form"), "no form element");
  assert.ok(!js.includes("textarea"), "no prompt textarea");
  assert.ok(!/<submit|f-prompt|f-cwd|task-rows|detail-card/.test(js), "no submit/detail UI");
  assert.ok(!js.includes("<table"), "no tables");
  // Monitoring behaviour.
  assert.ok(js.includes("/api/overview"), "polls the overview endpoint");
  assert.ok(js.includes("setInterval"), "auto refresh present");
  assert.ok(js.includes("AUTO_REFRESH_MS"), "refresh interval configurable");
  assert.ok(js.includes("visibilitychange"), "pauses polling while hidden");
  // Every fetch goes to the plugin API base, never to an absolute URL.
  assert.ok(js.match(/fetch\(/g)?.length >= 1, "page performs fetches");
  assert.ok(!js.includes('fetch("http'), "no absolute fetch target");
  assert.ok(!js.includes("fetch('http"), "no absolute fetch target");
  assert.ok(js.includes("/api/plugins/${pluginId}"), "requests stay under the plugin API base");
  // The optional external link may only use the Hana host capability.
  assert.ok(js.includes("hana.openExternal"), "external open goes through the host capability");
});

test("studio page approval section (Phase 1): polling, redacted cards, whitelisted buttons, toast", async () => {
  const js = await read("assets/studio.js");
  // The page polls the plugin's own narrow approvals API.
  assert.ok(js.includes("/api/approvals"), "polls the approvals endpoint");
  assert.ok(js.includes("/approvals/${encodeURIComponent(id)}/respond"), "answers via the narrow respond route");
  // Approval cards render redacted fields only.
  assert.ok(js.includes("reasonSummary"), "card shows the redacted reason summary");
  assert.ok(js.includes("approvalId"), "card identifies the approval");
  // Buttons are exactly the two whitelisted outcomes.
  assert.ok(js.includes('"allowed-once"'), "approve-once button");
  assert.ok(js.includes("批准一次"), "approve-once label");
  assert.ok(js.includes('"rejected"'), "reject button");
  assert.ok(js.includes("拒绝"), "reject label");
  assert.ok(!js.includes('"never"'), "no persistent-elevation vocabulary on the page");
  // New-approval toast (minimal @hana/plugin-sdk toast.show equivalent).
  assert.ok(js.includes("toast.show"), "toast API present");
  assert.ok(js.includes('type: "warning"'), "new approvals toast as warnings");
  // POST goes through the plugin API with JSON only.
  assert.ok(js.includes('method: "POST"'), "respond uses POST");
  assert.ok(js.includes('"content-type": "application/json"'), "JSON content type");
  // Safety constraints still hold for the new code paths.
  assert.ok(!js.includes("127.0.0.1"), "no hardcoded DSH URL");
  assert.ok(!js.includes(":3080"), "no hardcoded DSH port");
  assert.ok(!js.includes("window.open"), "no window.open");
  assert.ok(!js.includes("iframe"), "no iframe");
});

test("studio route shell carries the monitor title", async () => {
  const shell = await read("routes/studio.js");
  assert.ok(shell.includes("<title>DSH 监听</title>"), "shell title is DSH 监听");
});
