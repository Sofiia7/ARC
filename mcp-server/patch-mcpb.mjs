// Replace exactly one entry (manifest.json) inside a .mcpb (zip) archive,
// copying every other entry's raw compressed bytes verbatim so nothing is
// recompressed and no CRC/permission metadata is lost.
//
// Needed because .NET's ZipArchive "Update" mode silently rewrote 15 empty
// hono/@hono files as STORED while keeping their 2-byte deflate payload,
// which `unzip -t` reports as bad CRC.
import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

const [, , srcPath, manifestPath, outPath] = process.argv;
if (!srcPath || !manifestPath || !outPath) {
  console.error("usage: node patch-mcpb.mjs <src.mcpb> <manifest.json> <out.mcpb>");
  process.exit(1);
}

// ── crc32 ────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const src = readFileSync(srcPath);

// ── locate EOCD ──────────────────────────────────────────────────────────────
let eocd = -1;
for (let i = src.length - 22; i >= 0 && i >= src.length - 22 - 0xffff; i--) {
  if (src.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error("EOCD not found");

const totalEntries = src.readUInt16LE(eocd + 10);
const cdSize = src.readUInt32LE(eocd + 12);
const cdOffset = src.readUInt32LE(eocd + 16);
if (totalEntries === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64 archive - not supported by this patcher");

// ── parse central directory ──────────────────────────────────────────────────
const entries = [];
let p = cdOffset;
for (let i = 0; i < totalEntries; i++) {
  if (src.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
  const nameLen = src.readUInt16LE(p + 28);
  const extraLen = src.readUInt16LE(p + 30);
  const commentLen = src.readUInt16LE(p + 32);
  entries.push({
    central: src.subarray(p, p + 46 + nameLen + extraLen + commentLen),
    flags: src.readUInt16LE(p + 8),
    csize: src.readUInt32LE(p + 20),
    name: src.toString("utf8", p + 46, p + 46 + nameLen),
    localOffset: src.readUInt32LE(p + 42),
  });
  p += 46 + nameLen + extraLen + commentLen;
}
if (p !== cdOffset + cdSize) throw new Error("central directory size mismatch");

const target = entries.find(e => e.name === "manifest.json");
if (!target) throw new Error("manifest.json not found in archive");

// ── build the replacement entry ───────────────────────────────────────────────
const raw = readFileSync(manifestPath);
const deflated = deflateRawSync(raw, { level: 9 });
const useDeflate = deflated.length < raw.length;
const newData = useDeflate ? deflated : raw;
const newMeta = { method: useDeflate ? 8 : 0, crc: crc32(raw), csize: newData.length, usize: raw.length };

// ── rewrite ──────────────────────────────────────────────────────────────────
const outChunks = [];
let outOffset = 0;
const newOffsets = new Map();

for (const e of entries) {
  const lo = e.localOffset;
  if (src.readUInt32LE(lo) !== 0x04034b50) throw new Error(`bad local header for ${e.name} at ${lo}`);
  const nameLen = src.readUInt16LE(lo + 26);
  const extraLen = src.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;

  newOffsets.set(e.name, outOffset);

  if (e === target) {
    // fresh local header, borrowing the original's version/flags/time fields
    const header = Buffer.from(src.subarray(lo, lo + 30 + nameLen + extraLen));
    header.writeUInt16LE(e.flags & ~0x08, 6); // no data descriptor
    header.writeUInt16LE(newMeta.method, 8);
    header.writeUInt32LE(newMeta.crc, 14);
    header.writeUInt32LE(newMeta.csize, 18);
    header.writeUInt32LE(newMeta.usize, 22);
    outChunks.push(header, newData);
    outOffset += header.length + newData.length;
  } else {
    let end = dataStart + e.csize;
    if (e.flags & 0x08) {
      // data descriptor follows the payload: 12 bytes, or 16 with a signature
      end += src.readUInt32LE(end) === 0x08074b50 ? 16 : 12;
    }
    const block = src.subarray(lo, end);
    outChunks.push(block);
    outOffset += block.length;
  }
}

const newCdOffset = outOffset;
for (const e of entries) {
  const central = Buffer.from(e.central);
  central.writeUInt32LE(newOffsets.get(e.name), 42);
  if (e === target) {
    central.writeUInt16LE(e.flags & ~0x08, 8);
    central.writeUInt16LE(newMeta.method, 10);
    central.writeUInt32LE(newMeta.crc, 16);
    central.writeUInt32LE(newMeta.csize, 20);
    central.writeUInt32LE(newMeta.usize, 24);
  }
  outChunks.push(central);
  outOffset += central.length;
}

const eocdBuf = Buffer.from(src.subarray(eocd, src.length));
eocdBuf.writeUInt32LE(outOffset - newCdOffset, 12);
eocdBuf.writeUInt32LE(newCdOffset, 16);
outChunks.push(eocdBuf);

writeFileSync(outPath, Buffer.concat(outChunks));
console.log(`ok: ${entries.length} entries, manifest.json ${raw.length}B -> ${newData.length}B (${useDeflate ? "deflate" : "stored"})`);
