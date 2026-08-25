// Syntax-check every .js/.mjs source file with `node --check`.
// Usage: node scripts/check-syntax.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set(["node_modules", ".git"]);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
}
walk(root);

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`FAIL ${path.relative(root, file)}`);
    failed++;
  }
}
console.log(`checked ${files.length} files, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
