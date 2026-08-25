// hana-dsh-adapter: "DSH 监听" monitor page + static assets.
// Served under /api/plugins/<pluginId>/studio (Hana plugin page convention).
// The page is observation-only: it polls the plugin's narrow API and never
// talks to the DSH URL from the browser.
import fs from "node:fs/promises";
import path from "node:path";

export default function registerStudioRoutes(app, ctx) {
  app.get("/studio", (c) => c.html(renderShell(c, ctx)));

  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      return c.text("Not found", 404);
    }
    const assetsDir = path.join(ctx.pluginDir, "assets");
    const filePath = path.resolve(assetsDir, file);
    if (!filePath.startsWith(assetsDir + path.sep)) {
      return c.text("Not found", 404);
    }
    try {
      const body = await fs.readFile(filePath);
      return new Response(body, {
        headers: { "content-type": mimeFor(filePath) },
      });
    } catch {
      return c.text("Not found", 404);
    }
  });
}

function renderShell(c, ctx) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const locale = c.req.query("hana-locale") || c.req.query("locale") || c.req.query("lang") || "";
  const token = c.req.query("token") || "";
  const base = `/api/plugins/${ctx.pluginId}`;
  const cssUrl = appendTokenParam(`${base}/assets/studio.css`, token);
  const jsUrl = appendTokenParam(`${base}/assets/studio.js`, token);

  return `<!doctype html>
<html lang="${escapeAttr(htmlLangForLocale(locale))}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DSH 监听</title>
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <link rel="stylesheet" href="${escapeAttr(cssUrl)}">
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-hana-locale="${escapeAttr(locale)}"
      data-plugin-id="${escapeAttr(ctx.pluginId)}">
  <div id="root"></div>
  <script type="module" src="${escapeAttr(jsUrl)}"></script>
</body>
</html>`;
}

function appendTokenParam(url, token) {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function htmlLangForLocale(locale) {
  const normalized = String(locale || "").trim().toLowerCase();
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("ko")) return "ko";
  return "en";
}

function mimeFor(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
