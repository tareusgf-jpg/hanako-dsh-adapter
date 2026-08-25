// hana-dsh-adapter: plugin lifecycle.
// onload() builds the adapter runtime on ctx; register() disposes it,
// stopping only a child DSH process this plugin started and detaching the
// approval listener (events.mux + timeout sweep) it owns.
import fs from "node:fs";
import { loadConfig } from "./lib/config.js";
import { DshRpcClient } from "./lib/dsh-rpc-client.js";
import { DshProcessSupervisor } from "./lib/dsh-process-supervisor.js";
import { WorkspacePolicy } from "./lib/workspace-policy.js";
import { TaskStore } from "./lib/task-store.js";
import { ApprovalStore } from "./lib/approval-store.js";
import { ApprovalService } from "./lib/approval-service.js";
import { DshAdapterService } from "./lib/dsh-adapter-service.js";

export default class HanaDshAdapterPlugin {
  async onload() {
    const { dataDir, log } = this.ctx;
    fs.mkdirSync(dataDir, { recursive: true });

    const config = await loadConfig(this.ctx);
    for (const warning of config.warnings) {
      log.warn?.(`hana-dsh-adapter config: ${warning}`);
    }

    const rpc = new DshRpcClient({ baseUrl: config.url, log });
    const supervisor = new DshProcessSupervisor({
      executable: config.executable,
      rpc,
      log,
    });
    const workspacePolicy = new WorkspacePolicy({ roots: config.workspaceRoots });
    const taskStore = new TaskStore({ dataDir, log });
    await taskStore.init();

    const service = new DshAdapterService({
      rpc,
      supervisor,
      workspacePolicy,
      taskStore,
      config,
      log,
    });

    // Phase 1 — DSH approval loop: persistent pending records + events.mux
    // listener. Persisted before the listener starts so a reconnect re-pull
    // never races an empty store.
    const approvalStore = new ApprovalStore({ dataDir, log });
    await approvalStore.init();
    const approvalService = new ApprovalService({
      store: approvalStore,
      taskStore,
      rpc,
      config,
      bus: this.ctx.bus,
      log,
    });
    // Listener startup is fail-soft inside (never throws, never unhandled);
    // a missing/closed stream only logs and reconnects with backoff.
    approvalService.start();

    this.ctx._dshAdapter = {
      config,
      rpc,
      supervisor,
      workspacePolicy,
      taskStore,
      approvalStore,
      approvalService,
      service,
    };

    // Fail-soft startup reconciliation of non-terminal tasks: runs in the
    // background, never blocks plugin load, and never rejects unhandled.
    service.reconcilePending().catch((error) => {
      log.error?.(`hana-dsh-adapter startup reconcile failed: ${error?.message || error}`);
    });

    this.register(() => {
      approvalService.dispose();
      supervisor.stopOwned().catch(() => {});
      delete this.ctx._dshAdapter;
    });

    log.info?.(
      `hana-dsh-adapter loaded (url=${config.url}, roots=${config.workspaceRoots.join(",")}, autoStart=${config.autoStart}, approvalNotify=${config.approvalNotify}, approvalTimeoutMs=${config.approvalTimeoutMs})`,
    );
  }
}
