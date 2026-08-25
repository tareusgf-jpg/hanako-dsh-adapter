// workspace-policy: containment, sibling-prefix bypass, traversal, file paths.
// Uses REAL existing nested directories (os.tmpdir + mkdtemp) so every accepted
// path exists on disk, mirroring the service's existence requirement.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspacePolicy, WorkspacePolicyError } from "../lib/workspace-policy.js";

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  const nested = path.join(root, "sub", "deep");
  await fs.mkdir(nested, { recursive: true });
  const sibling = `${root}2`; // sibling-prefix bypass target
  await fs.mkdir(sibling, { recursive: true });
  const file = path.join(root, "a-file.txt");
  await fs.writeFile(file, "x", "utf8");
  return { root, nested, sibling, file };
}

function policy(roots) {
  return new WorkspacePolicy({ roots });
}

test("allows real nested directories inside the root", async (t) => {
  const { root, nested } = await makeWorkspace(t);
  const p = policy([root]);
  // canonical cwd is returned — never the root itself
  assert.equal(p.checkAllowed(root), root);
  assert.equal(p.checkAllowed(nested), nested);
  assert.equal(p.checkAllowed(root + path.sep), root);
  // '..' inside the root that stays inside is fine
  assert.equal(p.checkAllowed(path.join(nested, "..")), path.join(root, "sub"));
});

test("rejects sibling-prefix bypass (root + '2') even when it exists", async (t) => {
  const { root, sibling } = await makeWorkspace(t);
  const p = policy([root]);
  assert.throws(() => p.checkAllowed(sibling), (error) => error.code === "outside-root");
  assert.throws(
    () => p.checkAllowed(path.join(sibling, "x")),
    (error) => error.code === "outside-root",
  );
});

test("rejects traversal that escapes the root", async (t) => {
  const { root, nested } = await makeWorkspace(t);
  const p = policy([root]);
  assert.throws(
    () => p.checkAllowed(path.join(nested, "..", "..", "..", "..", "Windows")),
    (error) => error.code === "outside-root",
  );
});

test("rejects non-strings, empty strings and invalid inputs", async (t) => {
  const { root } = await makeWorkspace(t);
  const p = policy([root]);
  for (const value of [null, undefined, 42, {}, "", "   "]) {
    assert.throws(() => p.checkAllowed(value), WorkspacePolicyError);
  }
});

test("rejects relative input that escapes the root", async (t) => {
  const { root } = await makeWorkspace(t);
  const p = policy([root]);
  const escape = path.join("..", path.basename(root), "..", "..", "Windows");
  assert.throws(() => p.checkAllowed(escape), (error) => error.code === "outside-root");
});

test("rejects invalid roots at construction", () => {
  assert.throws(() => new WorkspacePolicy({ roots: [] }), WorkspacePolicyError);
  assert.throws(() => new WorkspacePolicy({ roots: ["relative"] }), WorkspacePolicyError);
  assert.throws(() => new WorkspacePolicy({ roots: [""] }), WorkspacePolicyError);
});

test("supports multiple real roots and drive-root containment", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-policy-multi-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }).catch(() => {}));
  const rootA = path.join(base, "a");
  const rootB = path.join(base, "b");
  const siblingB = path.join(base, "b2");
  for (const dir of [rootA, rootB, siblingB]) {
    await fs.mkdir(dir, { recursive: true });
  }
  const p = new WorkspacePolicy({ roots: [rootA, rootB] });
  assert.equal(p.checkAllowed(path.join(rootB, "x")), path.join(rootB, "x"));
  assert.throws(() => p.checkAllowed(siblingB), (e) => e.code === "outside-root");
});

test("listRoots returns canonical roots (deduped)", async (t) => {
  const { root } = await makeWorkspace(t);
  const p = policy([root, root]);
  assert.deepEqual(p.listRoots(), [root]);
});
