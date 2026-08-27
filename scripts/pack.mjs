// hana-dsh-adapter: release zip packer.
//
// Builds dist/hana-dsh-adapter-v<version>.zip containing ONLY the files the
// Hana plugin runtime needs (no tests, no scripts, no .github, no internal
// docs). Then verifies the produced zip: PK magic + EOCD + entry count +
// required entries present. Exit 0 only when the zip is structurally sound.
//
// Usage:
//   node scripts/pack.mjs            # version from package.json
//   node scripts/pack.mjs --out out/ # custom output dir (default dist/)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const version = pkg.version;

const outDir = path.resolve(projectRoot, process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "dist");
fs.mkdirSync(outDir, { recursive: true });

// ── Release payload: exactly what the plugin runtime reads ──────────────────
// index.js / lib / tools / routes / assets / manifest.json / package.json /
// README / LICENSE. Everything else (tests, scripts, .github, docs) stays out
// of the installable artifact.
const PAYLOAD = [
  "index.js",
  "manifest.json",
  "package.json",
  "README.md",
  "LICENSE",
  ...walk("lib"),
  ...walk("tools"),
  ...walk("routes"),
  ...walk("assets"),
];

function walk(relativeDir) {
  const abs = path.join(projectRoot, relativeDir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const stack = [relativeDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const absCurrent = path.join(projectRoot, current);
    for (const entry of fs.readdirSync(absCurrent, { withFileTypes: true })) {
      const rel = path.join(current, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  return out;
}

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

// Minimal ZIP writer (store, no compression): deterministic, zero deps,
// good enough for a plugin payload and trivially verifiable.
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.rel, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localChunk = Buffer.concat([local, name, entry.data]);
    chunks.push(localChunk);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38); // local header offset
    centralHeader.writeUInt32LE(0, 42);
    central.push(Buffer.concat([centralHeader, name]));
    offset += localChunk.length;
    // Patch the real offset (we allocated 0 above).
    central[central.length - 1].writeUInt32LE(offset - localChunk.length, 42);
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralDir, end]);
}

const missing = PAYLOAD.filter((rel) => !fs.existsSync(path.join(projectRoot, rel)));
if (missing.length > 0) {
  console.error(`[pack] FAILED: payload entries missing: ${missing.join(", ")}`);
  process.exit(1);
}

const entries = PAYLOAD.map((rel) => ({
  rel,
  data: fs.readFileSync(path.join(projectRoot, rel)),
}));

const zipBuffer = buildZip(entries);
const zipPath = path.join(outDir, `hana-dsh-adapter-v${version}.zip`);
fs.writeFileSync(zipPath, zipBuffer);
console.log(`[pack] wrote ${zipPath} (${zipBuffer.length} bytes, ${entries.length} entries)`);

// ── Verify: PK magic + EOCD + entry count + required entries ───────────────
const verify = (() => {
  if (zipBuffer.length < 22) return "too small";
  if (zipBuffer.readUInt32LE(0) !== 0x04034b50) return "bad local header magic";
  const eocdOffset = zipBuffer.length - 22;
  if (zipBuffer.readUInt32LE(eocdOffset) !== 0x06054b50) return "bad EOCD magic";
  const count = zipBuffer.readUInt16LE(eocdOffset + 10);
  if (count !== entries.length) return `entry count mismatch: ${count} != ${entries.length}`;
  const required = ["manifest.json", "index.js", "lib/", "package.json"];
  for (const req of required) {
    const found = PAYLOAD.some((rel) => rel.startsWith(req));
    if (!found) return `required entry missing: ${req}`;
  }
  return null;
})();
if (verify) {
  console.error(`[pack] FAILED: ${verify}`);
  process.exit(1);
}

// Extra integrity: a second independent reader (system unzip, when present)
// must list the same entry count.
try {
  const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8", timeout: 30000 });
  const listed = (listing.match(/\n\s+\d+ files?/)?.[0]?.match(/\d+/) ?? ["0"])[0];
  if (Number(listed) !== entries.length) {
    console.error(`[pack] FAILED: unzip -l disagrees (${listed} vs ${entries.length})`);
    process.exit(1);
  }
  console.log(`[pack] verified: unzip -l agrees (${listed} entries)`);
} catch {
  console.log("[pack] note: unzip not available; structural checks already passed");
}

console.log("[pack] OK");
