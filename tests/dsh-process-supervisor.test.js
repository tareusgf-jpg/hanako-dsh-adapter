// dsh-process-supervisor: fixed args, idempotent start, external reuse,
// booting-child waiting, own-child-only kill, health timeout, spawn failure.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { DshProcessSupervisor, DshStartError, buildWebArgs } from "../lib/dsh-process-supervisor.js";
import { createFakeProc, createHealthDouble } from "./helpers/fake-dsh.js";

// Any absolute path works — spawnImpl is faked; the value only needs to be a
// plausible bin.js location, never a machine-specific literal.
const EXE = path.join(os.tmpdir(), "dsh", "lib", "bin.js");
const instantSleep = () => Promise.resolve();

function makeSupervisor({ spawnImpl, health, healthTimeoutMs = 2000 }) {
  const rpc = {
    baseUrl: "http://127.0.0.1:3080",
    health: health.probe,
  };
  const spawned = [];
  const supervisor = new DshProcessSupervisor({
    executable: EXE,
    rpc,
    sleepImpl: instantSleep,
    healthTimeoutMs,
    spawnImpl: spawnImpl ?? ((executable, args) => {
      const proc = createFakeProc();
      spawned.push({ executable, args, proc });
      return proc;
    }),
  });
  return { supervisor, spawned };
}

test("buildWebArgs is fixed and rejects bad ports", () => {
  assert.deepEqual(buildWebArgs(3080), ["web", "--host", "127.0.0.1", "--port", "3080"]);
  assert.throws(() => buildWebArgs(0), DshStartError);
  assert.throws(() => buildWebArgs(70000), DshStartError);
  assert.throws(() => buildWebArgs("abc"), DshStartError);
});

test("spawns with fixed executable + args, then reports owned once healthy", async () => {
  const health = createHealthDouble(false);
  const { supervisor, spawned } = makeSupervisor({
    health,
    spawnImpl: (executable, args) => {
      const proc = createFakeProc();
      spawned.push({ executable, args, proc });
      health.makeHealthy(); // service comes up after spawn
      return proc;
    },
  });
  const result = await supervisor.ensureStarted({ autoStart: true });
  assert.deepEqual(spawned[0], {
    executable: EXE,
    args: ["web", "--host", "127.0.0.1", "--port", "3080"],
    proc: spawned[0].proc,
  });
  assert.equal(result.started, true);
  assert.equal(result.owned, true);
  assert.equal(result.pid, 4242);
  const status = await supervisor.status();
  assert.equal(status.owned, true);
  assert.equal(status.reachable, true);
  assert.equal(spawned.length, 1);
});

test("reuses an external reachable DSH without spawning", async () => {
  const health = createHealthDouble(true);
  const { supervisor, spawned } = makeSupervisor({ health });
  const result = await supervisor.ensureStarted({ autoStart: true });
  assert.deepEqual(result, { started: false, owned: false, pid: null });
  assert.equal(spawned.length, 0);
  const status = await supervisor.status();
  assert.equal(status.reachable, true);
  assert.equal(status.owned, false);
});

test("does not double-start on concurrent ensureStarted calls", async () => {
  const health = createHealthDouble(false);
  const { supervisor, spawned } = makeSupervisor({
    health,
    healthTimeoutMs: 5000,
    spawnImpl: (executable, args) => {
      const proc = createFakeProc();
      spawned.push({ executable, args, proc });
      health.makeHealthy();
      return proc;
    },
  });
  const [a, b] = await Promise.all([
    supervisor.ensureStarted({ autoStart: true }),
    supervisor.ensureStarted({ autoStart: true }),
  ]);
  assert.equal(spawned.length, 1);
  assert.equal(a.owned, true);
  assert.equal(b.owned, true);
});

test("an already-spawned booting child is waited on, never re-spawned", async () => {
  const health = createHealthDouble(false);
  const proc = createFakeProc();
  const { supervisor, spawned } = makeSupervisor({ health });
  // Seed state as a previous spawn would leave it: child alive, not healthy yet.
  supervisor.child = { proc };
  supervisor.startedByUs = true;

  const pending = supervisor.ensureStarted({ autoStart: true });
  health.makeHealthy(); // fake transitions to reachable mid-boot
  const result = await pending;

  assert.deepEqual(result, { started: false, owned: true, pid: 4242 });
  assert.equal(spawned.length, 0);
  const status = await supervisor.status();
  assert.equal(status.reachable, true);
  assert.equal(status.owned, true);
});

test("a healthy service is reused even when a child we spawned is still alive", async () => {
  const health = createHealthDouble(false);
  const { supervisor, spawned } = makeSupervisor({
    health,
    spawnImpl: (executable, args) => {
      const proc = createFakeProc();
      spawned.push({ executable, args, proc });
      health.makeHealthy();
      return proc;
    },
  });
  const first = await supervisor.ensureStarted({ autoStart: true });
  const second = await supervisor.ensureStarted({ autoStart: true });
  assert.equal(spawned.length, 1);
  assert.equal(first.owned, true);
  assert.equal(second.started, false);
  assert.equal(second.owned, false);
});

test("times out waiting for health, kills the spawned child and throws", async () => {
  const health = createHealthDouble(false);
  const { supervisor, spawned } = makeSupervisor({ health, healthTimeoutMs: 100 });
  await assert.rejects(
    () => supervisor.ensureStarted({ autoStart: true }),
    (error) => {
      assert.ok(error instanceof DshStartError);
      assert.equal(error.code, "health-timeout");
      return true;
    },
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].proc.killedWith, "SIGTERM");
  const status = await supervisor.status();
  assert.equal(status.owned, false);
  assert.equal(status.reachable, false);
});

test("propagates spawn failure and disposes the child", async () => {
  const health = createHealthDouble(false);
  const proc = createFakeProc();
  const { supervisor } = makeSupervisor({
    health,
    spawnImpl: () => {
      queueMicrotask(() => proc.emit("error", new Error("ENOENT")));
      return proc;
    },
  });
  await assert.rejects(
    () => supervisor.ensureStarted({ autoStart: true }),
    (error) => error.code === "spawn-failed",
  );
});

test("throws unreachable when autoStart is disabled", async () => {
  const health = createHealthDouble(false);
  let spawned = 0;
  const supervisor = new DshProcessSupervisor({
    executable: EXE,
    rpc: { baseUrl: "http://127.0.0.1:3080", health: health.probe },
    spawnImpl: () => {
      spawned++;
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(
    () => supervisor.ensureStarted({ autoStart: false }),
    (error) => error.code === "unreachable",
  );
  assert.equal(spawned, 0);
});

test("stopOwned kills only the child this plugin started", async () => {
  const health = createHealthDouble(false);
  const { supervisor, spawned } = makeSupervisor({
    health,
    spawnImpl: (executable, args) => {
      const proc = createFakeProc();
      spawned.push({ executable, args, proc });
      health.makeHealthy();
      return proc;
    },
  });
  await supervisor.ensureStarted({ autoStart: true });
  const stopped = await supervisor.stopOwned();
  assert.equal(stopped.stopped, true);
  assert.equal(spawned[0].proc.killedWith, "SIGTERM");
  assert.equal(spawned.length, 1);

  // External process: stopOwned is a no-op and never touches the process.
  const external = createFakeProc();
  const externalHealth = createHealthDouble(true);
  const externalSupervisor = new DshProcessSupervisor({
    executable: EXE,
    rpc: { baseUrl: "http://127.0.0.1:3080", health: externalHealth.probe },
    spawnImpl: () => {
      throw new Error("must not spawn");
    },
  });
  const result = await externalSupervisor.stopOwned();
  assert.equal(result.stopped, false);
  assert.equal(external.killedWith, null);
  const status = await externalSupervisor.status();
  assert.equal(status.reachable, true);
  assert.equal(status.owned, false);
});

test("captures stdout/stderr tails for diagnostics on failure", async () => {
  const health = createHealthDouble(false);
  const proc = createFakeProc();
  const { supervisor } = makeSupervisor({
    health,
    healthTimeoutMs: 50,
    spawnImpl: () => {
      // Emit after the supervisor attaches stream listeners (next tick).
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("booting dsh..."));
        proc.stderr.emit("data", Buffer.from("warn: port busy"));
      });
      return proc;
    },
  });
  await assert.rejects(
    () => supervisor.ensureStarted({ autoStart: true }),
    (error) => {
      assert.ok(error.message.includes("stdout tail"));
      assert.ok(error.message.includes("booting dsh"));
      assert.ok(error.message.includes("port busy"));
      return true;
    },
  );
});
