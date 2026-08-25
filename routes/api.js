// hana-dsh-adapter: narrow JSON API routes (mirror of the allowlist).
// status / start / submit / inspect / cancel / overview / approvals.
// No generic RPC proxy exists. Errors are returned as { error: code,
// detail: message } — never stacks/secrets.
export default function registerApiRoutes(app, ctx) {
  const runtime = () => requireRuntime(ctx);

  app.get("/api/status", h(() => runtime().service.status()));

  // Monitor snapshot: status + light summary of the most recent tasks.
  // Fail-soft — per-task DSH read failures are redacted, never fatal.
  app.get("/api/overview", h(() => runtime().service.overview()));

  app.post("/api/start", h(async (c) => {
    const body = await readJson(c);
    return runtime().service.start({ autoStart: body.autoStart });
  }));

  app.get("/api/tasks", h(() => ({ tasks: runtime().taskStore.list() })));

  app.post("/api/tasks", h(async (c) => {
    const body = await readJson(c);
    return runtime().service.submit({
      prompt: body.prompt,
      cwd: body.cwd,
      agentPreset: body.agentPreset,
      waitSeconds: body.waitSeconds,
      autoStart: body.autoStart,
    });
  }));

  app.get("/api/tasks/:id", h((c) => {
    const raw = c.req.query("raw") === "1" || c.req.query("raw") === "true";
    return runtime().service.inspect(c.req.param("id"), { includeRaw: raw });
  }));

  app.post("/api/tasks/:id/cancel", h((c) => runtime().service.cancel(c.req.param("id"))));

  // ── Phase 1 — DSH approval loop (narrow; the page's only approval surface) ──

  // Pending approvals, redacted: no rpcId, no sessionId, no raw reason,
  // no credentials. The page polls this and renders one card per approval.
  app.get("/api/approvals", h(() => ({ approvals: runtime().approvalService.listPending() })));

  // Answer one pending approval. body: { outcome: "allowed-once" | "rejected" }.
  // Validation (existence / pending / whitelist) lives in the service; the
  // DSH client-response is sent ONLY from here — there is no other caller.
  app.post("/api/approvals/:approvalId/respond", h(async (c) => {
    const body = await readJson(c);
    return runtime().approvalService.respondApproval({
      approvalId: c.req.param("approvalId"),
      outcome: body.outcome,
    });
  }));
}

function h(fn) {
  return async (c) => {
    try {
      return c.json(await fn(c));
    } catch (error) {
      const status = typeof error?.status === "number" ? error.status : 500;
      const code = typeof error?.code === "string" ? error.code : "internal";
      const detail = status === 500 ? "Internal error" : error?.message || String(error);
      if (status === 500) {
        c.get("pluginCtx")?.log?.error?.(`hana-dsh-adapter route error: ${error?.message || error}`);
      }
      return c.json({ error: code, detail }, status);
    }
  };
}

function requireRuntime(ctx) {
  if (!ctx._dshAdapter) {
    throw new Error("hana-dsh-adapter runtime is not initialized");
  }
  return ctx._dshAdapter;
}

async function readJson(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
