'use strict';
/**
 * DVD-Video disc image writer: ISO 9660 + UDF 1.02 "bridge" file system, laid out the way
 * standalone DVD players need it.
 *
 * Players do not look files up by name. They read VIDEO_TS.IFO and then jump to sector offsets
 * stored inside the IFO files, which only works when every title set is stored contiguously in
 * this order: VTS_xx_0.IFO, VTS_xx_0.VOB, VTS_xx_1.VOB ... VTS_xx_0.BUP (and VIDEO_TS.IFO,
 * VIDEO_TS.VOB, VIDEO_TS.BUP first). Generic image tools (Windows IMAPI2FS) sort files
 * alphabetically (BUP before IFO), which makes players say "incorrect disc" / "no disc".
 *
 * Both file systems point at the same file data, so the image is small to describe and
 * fast to write: the file contents are streamed straight from disk.
 */
const fs = require('fs');
const path = require('path');

const SECTOR = 2048;
const PART_START = 257; // UDF partition starts right after the anchor at 256

/* ------------------------------------------------------------------ helpers */
function crcItu(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Fill in a UDF descriptor tag (16 bytes at the start of buf). crcLen = bytes after the tag. */
function udfTag(buf, ident, location, crcLen, serial = 1) {
  buf.writeUInt16LE(ident, 0);
  buf.writeUInt16LE(2, 2); // descriptor version (ECMA-167 2nd ed. = UDF 1.02)
  buf.writeUInt8(0, 4);
  buf.writeUInt8(0, 5);
  buf.writeUInt16LE(serial, 6);
  buf.writeUInt16LE(crcItu(buf.subarray(16, 16 + crcLen)), 8);
  buf.writeUInt16LE(crcLen, 10);
  buf.writeUInt32LE(location, 12);
  let sum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) sum += buf[i];
  buf.writeUInt8(sum & 0xff, 4);
  return buf;
}

function udfTimestamp(buf, off, d) {
  // type 1 (local time) with UTC offset 0
  buf.writeUInt16LE((1 << 12) | 0, off);
  buf.writeInt16LE(d.getUTCFullYear(), off + 2);
  buf.writeUInt8(d.getUTCMonth() + 1, off + 4);
  buf.writeUInt8(d.getUTCDate(), off + 5);
  buf.writeUInt8(d.getUTCHours(), off + 6);
  buf.writeUInt8(d.getUTCMinutes(), off + 7);
  buf.writeUInt8(d.getUTCSeconds(), off + 8);
  buf.writeUInt8(Math.floor(d.getUTCMilliseconds() / 10), off + 9);
  buf.writeUInt8(0, off + 10);
  buf.writeUInt8(0, off + 11);
}

function charspec(buf, off) {
  buf.writeUInt8(0, off); // CS0
  buf.write('OSTA Compressed Unicode', off + 1, 'latin1');
}

/** OSTA CS0 d-string in a fixed field: compression id 8, chars, last byte = used length. */
function dstring(buf, off, len, text) {
  const t = String(text || '').slice(0, len - 2);
  if (!t) return;
  buf.writeUInt8(8, off);
  buf.write(t, off + 1, 'latin1');
  buf.writeUInt8(t.length + 1, off + len - 1);
}

function regid(buf, off, ident, suffix) {
  buf.writeUInt8(0, off);
  buf.write(ident, off + 1, 'latin1');
  if (suffix) suffix.copy(buf, off + 24);
}
const udfRevSuffix = () => { const b = Buffer.alloc(8); b.writeUInt16LE(0x0102, 0); return b; };
const implSuffix = () => { const b = Buffer.alloc(8); b.writeUInt8(4, 0); /* OS class: Windows */ return b; };
const IMPL_ID = '*DiscForge Studio';

function shortAds(len, lbn) {
  // short_ad extents are limited to 2^30 - 1 bytes; split on a sector boundary
  const max = 0x3ffff800;
  const out = [];
  let left = len; let at = lbn;
  if (left === 0) return [{ len: 0, lbn: 0 }];
  while (left > 0) {
    const n = Math.min(left, max);
    out.push({ len: n, lbn: at });
    left -= n; at += Math.ceil(n / SECTOR);
  }
  return out;
}

/* ------------------------------------------------------------------ ISO 9660 helpers */
const both32 = (buf, off, v) => { buf.writeUInt32LE(v, off); buf.writeUInt32BE(v, off + 4); };
const both16 = (buf, off, v) => { buf.writeUInt16LE(v, off); buf.writeUInt16BE(v, off + 2); };
function isoDate7(buf, off, d) {
  buf.writeUInt8(d.getUTCFullYear() - 1900, off);
  buf.writeUInt8(d.getUTCMonth() + 1, off + 1);
  buf.writeUInt8(d.getUTCDate(), off + 2);
  buf.writeUInt8(d.getUTCHours(), off + 3);
  buf.writeUInt8(d.getUTCMinutes(), off + 4);
  buf.writeUInt8(d.getUTCSeconds(), off + 5);
  buf.writeInt8(0, off + 6);
}
function isoDate17(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  if (!d) return Buffer.concat([Buffer.from('0000000000000000', 'latin1'), Buffer.from([0])]);
  return Buffer.concat([Buffer.from(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}00`, 'latin1'), Buffer.from([0])]);
}
function isoDirRecord(name, lba, size, isDir, d) {
  const nameBuf = Buffer.isBuffer(name) ? name : Buffer.from(name, 'latin1');
  let len = 33 + nameBuf.length;
  if (len % 2) len++;
  const r = Buffer.alloc(len);
  r.writeUInt8(len, 0);
  both32(r, 2, lba);
  both32(r, 10, size);
  isoDate7(r, 18, d);
  r.writeUInt8(isDir ? 2 : 0, 25);
  both16(r, 28, 1);
  r.writeUInt8(nameBuf.length, 32);
  nameBuf.copy(r, 33);
  return r;
}
const isoName = (n) => n.toUpperCase().replace(/[^A-Z0-9_.]/g, '_');

/* ------------------------------------------------------------------ DVD file order */
function dvdOrder(names) {
  const key = (n) => {
    const u = n.toUpperCase();
    let m;
    if (u === 'VIDEO_TS.IFO') return [0, 0, 0];
    if (u === 'VIDEO_TS.VOB') return [0, 1, 0];
    if (u === 'VIDEO_TS.BUP') return [0, 2, 0];
    if ((m = /^VTS_(\d\d)_0\.IFO$/.exec(u))) return [Number(m[1]), 0, 0];
    if ((m = /^VTS_(\d\d)_(\d)\.VOB$/.exec(u))) return [Number(m[1]), 1, Number(m[2])];
    if ((m = /^VTS_(\d\d)_0\.BUP$/.exec(u))) return [Number(m[1]), 2, 0];
    return [1000, 0, 0];
  };
  return [...names].sort((a, b) => {
    const ka = key(a); const kb = key(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ build */
/**
 * Plan the image for a DVD-Video folder (containing VIDEO_TS, optionally AUDIO_TS).
 * Returns a layout with every structure's sector and the ordered file list.
 */
function planDvdImage(srcDir, label) {
  const now = new Date();
  // ---------- gather the tree (root -> AUDIO_TS, VIDEO_TS [, other dirs/files]) ----------
  const readDir = (abs, name, depth) => {
    const node = { name, abs, dir: true, children: [] };
    const entries = fs.existsSync(abs) ? fs.readdirSync(abs, { withFileTypes: true }) : [];
    for (const e of entries) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) { if (depth < 6) node.children.push(readDir(p, e.name, depth + 1)); }
      else if (e.isFile()) node.children.push({ name: e.name, abs: p, dir: false, size: fs.statSync(p).size });
    }
    return node;
  };
  const root = readDir(srcDir, '', 0);
  if (!root.children.some((c) => c.dir && c.name.toUpperCase() === 'VIDEO_TS')) throw new Error('The disc folder has no VIDEO_TS folder.');
  if (!root.children.some((c) => c.dir && c.name.toUpperCase() === 'AUDIO_TS')) root.children.push({ name: 'AUDIO_TS', abs: null, dir: true, children: [] });
  for (const c of root.children) c.name = isoName(c.name);

  // directory list in breadth-first order (for path tables) and file list in DVD order
  const dirs = [];
  const files = [];
  const walk = (node, parent) => {
    node.parent = parent;
    dirs.push(node);
    node.children.forEach((c) => { c.name = isoName(c.name); });
    // ISO 9660 / UDF order is alphabetical; data order is the DVD order
    node.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };
  const queue = [[root, null]];
  while (queue.length) {
    const [n, p] = queue.shift();
    walk(n, p);
    for (const c of n.children) if (c.dir) queue.push([c, n]);
  }
  // file data: VIDEO_TS first in DVD order, then everything else
  const vts = root.children.find((c) => c.dir && c.name === 'VIDEO_TS');
  const vtsFiles = dvdOrder(vts.children.filter((c) => !c.dir).map((c) => c.name)).map((n) => vts.children.find((c) => c.name === n));
  for (const f of vtsFiles) { if (f.size % SECTOR) throw new Error(`${f.name} is not a whole number of DVD sectors; the disc folder looks damaged.`); files.push(f); }
  for (const d of dirs) for (const c of d.children) if (!c.dir && !files.includes(c)) files.push(c);

  // ---------- sector allocation ----------
  let next = PART_START;
  const fsdLba = next++;
  const fsdTermLba = next++;
  // ISO 9660 path tables
  const ptEntries = dirs.map((d) => 8 + (d === root ? 1 : d.name.length) + ((d === root ? 1 : d.name.length) % 2));
  const ptSize = ptEntries.reduce((a, b) => a + b, 0);
  const ptSectors = Math.ceil(ptSize / SECTOR);
  const ptL = next; next += ptSectors;
  const ptM = next; next += ptSectors;
  // ISO 9660 directories (records never cross a sector boundary)
  for (const d of dirs) {
    const sizes = [34, 34, ...d.children.map((c) => { const n = c.dir ? c.name : `${c.name};1`; const l = 33 + n.length; return l + (l % 2); })];
    let sectors = 1; let used = 0;
    for (const s of sizes) { if (used + s > SECTOR) { sectors++; used = 0; } used += s; }
    d.isoLba = next; d.isoSectors = sectors; next += sectors;
  }
  // UDF directories: FE + FID data
  const fidLen = (nameLen) => { const l = 38 + nameLen; return (l + 3) & ~3; };
  for (const d of dirs) {
    d.udfFe = next++;
    d.fidSize = fidLen(0) + d.children.reduce((a, c) => a + fidLen(c.name.length + 1), 0);
    d.udfData = next; next += Math.ceil(d.fidSize / SECTOR);
  }
  // UDF file entries
  for (const f of files) f.udfFe = next++;
  // file data, contiguous
  for (const f of files) { f.lba = next; next += Math.ceil(f.size / SECTOR); }
  const lastData = next;
  const total = lastData + 1; // + closing anchor (AVDP) in the final sector
  return { now, root, dirs, files, ptL, ptM, ptSize, ptSectors, fsdLba, fsdTermLba, total, label };
}

function buildMetadata(L) {
  const { now, root, dirs, files } = L;
  const vol = (L.label || 'DVD_VIDEO').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32) || 'DVD_VIDEO';
  const P = PART_START;
  const partLen = L.total - 1 - P;
  const blocks = new Map(); // lba -> Buffer(2048)
  const sec = (lba) => { if (!blocks.has(lba)) blocks.set(lba, Buffer.alloc(SECTOR)); return blocks.get(lba); };

  // ---------------- ISO 9660 volume descriptors ----------------
  {
    const b = sec(16);
    b.writeUInt8(1, 0); b.write('CD001', 1, 'latin1'); b.writeUInt8(1, 6);
    b.fill(0x20, 8, 40); b.fill(0x20, 40, 72); b.write(vol, 40, 'latin1');
    both32(b, 80, L.total);
    both16(b, 120, 1); both16(b, 124, 1); both16(b, 128, SECTOR);
    both32(b, 132, L.ptSize);
    b.writeUInt32LE(L.ptL, 140); b.writeUInt32BE(L.ptM, 148);
    isoDirRecord(Buffer.from([0]), root.isoLba, root.isoSectors * SECTOR, true, now).copy(b, 156);
    b.fill(0x20, 190, 813);
    b.write('DISCFORGE STUDIO', 574, 'latin1');
    isoDate17(now).copy(b, 813); isoDate17(now).copy(b, 830); isoDate17(null).copy(b, 847); isoDate17(null).copy(b, 864);
    b.writeUInt8(1, 881);
    const t = sec(17);
    t.writeUInt8(255, 0); t.write('CD001', 1, 'latin1'); t.writeUInt8(1, 6);
  }
  // ---------------- UDF volume recognition sequence ----------------
  for (const [lba, id] of [[18, 'BEA01'], [19, 'NSR02'], [20, 'TEA01']]) {
    const b = sec(lba); b.writeUInt8(0, 0); b.write(id, 1, 'latin1'); b.writeUInt8(1, 6);
  }
  // ---------------- ISO 9660 path tables ----------------
  {
    const dirNum = new Map(dirs.map((d, i) => [d, i + 1]));
    const lt = Buffer.alloc(L.ptSectors * SECTOR); const mt = Buffer.alloc(L.ptSectors * SECTOR);
    let o = 0;
    for (const d of dirs) {
      const id = d === root ? Buffer.from([0]) : Buffer.from(d.name, 'latin1');
      const parent = d === root ? 1 : dirNum.get(d.parent);
      lt.writeUInt8(id.length, o); mt.writeUInt8(id.length, o);
      lt.writeUInt32LE(d.isoLba, o + 2); mt.writeUInt32BE(d.isoLba, o + 2);
      lt.writeUInt16LE(parent, o + 6); mt.writeUInt16BE(parent, o + 6);
      id.copy(lt, o + 8); id.copy(mt, o + 8);
      o += 8 + id.length + (id.length % 2);
    }
    for (let i = 0; i < L.ptSectors; i++) { lt.copy(sec(L.ptL + i), 0, i * SECTOR, (i + 1) * SECTOR); mt.copy(sec(L.ptM + i), 0, i * SECTOR, (i + 1) * SECTOR); }
  }
  // ---------------- ISO 9660 directories ----------------
  for (const d of dirs) {
    const parent = d.parent || d;
    const recs = [
      isoDirRecord(Buffer.from([0]), d.isoLba, d.isoSectors * SECTOR, true, now),
      isoDirRecord(Buffer.from([1]), parent.isoLba, parent.isoSectors * SECTOR, true, now),
      ...d.children.map((c) => (c.dir ? isoDirRecord(c.name, c.isoLba, c.isoSectors * SECTOR, true, now) : isoDirRecord(`${c.name};1`, c.size ? c.lba : 0, c.size, false, now))),
    ];
    let s = 0; let used = 0;
    for (const r of recs) {
      if (used + r.length > SECTOR) { s++; used = 0; }
      r.copy(sec(d.isoLba + s), used); used += r.length;
    }
  }

  // ---------------- UDF volume descriptor sequences (main at 32, reserve at 48) ----------------
  const nFiles = files.length; const nDirs = dirs.length;
  const writeVds = (start) => {
    let seq = 1;
    // Primary Volume Descriptor
    let b = sec(start);
    b.writeUInt32LE(seq++, 16); b.writeUInt32LE(0, 20);
    dstring(b, 24, 32, vol);
    b.writeUInt16LE(1, 56); b.writeUInt16LE(1, 58); b.writeUInt16LE(2, 60); b.writeUInt16LE(2, 62);
    b.writeUInt32LE(1, 64); b.writeUInt32LE(1, 68);
    const vsid = `${(now.getTime() >>> 0).toString(16).padStart(8, '0').toUpperCase()}${vol}`.slice(0, 120);
    dstring(b, 72, 128, vsid);
    charspec(b, 200); charspec(b, 264);
    regid(b, 344, '', null);
    udfTimestamp(b, 376, now);
    regid(b, 388, IMPL_ID, implSuffix());
    udfTag(b, 1, start, 496);
    // Implementation Use Volume Descriptor (LV info)
    b = sec(start + 1);
    b.writeUInt32LE(seq++, 16);
    regid(b, 20, '*UDF LV Info', udfRevSuffix());
    charspec(b, 52); dstring(b, 116, 128, vol);
    regid(b, 52 + 64 + 128 + 108, IMPL_ID, implSuffix());
    udfTag(b, 4, start + 1, 496);
    // Partition Descriptor
    b = sec(start + 2);
    b.writeUInt32LE(seq++, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(0, 22);
    regid(b, 24, '+NSR02', null);
    b.writeUInt32LE(1, 184); // read-only
    b.writeUInt32LE(P, 188); b.writeUInt32LE(partLen, 192);
    regid(b, 196, IMPL_ID, implSuffix());
    udfTag(b, 5, start + 2, 496);
    // Logical Volume Descriptor
    b = sec(start + 3);
    b.writeUInt32LE(seq++, 16);
    charspec(b, 20); dstring(b, 84, 128, vol);
    b.writeUInt32LE(SECTOR, 212);
    regid(b, 216, '*OSTA UDF Compliant', udfRevSuffix());
    b.writeUInt32LE(SECTOR, 248); b.writeUInt32LE(L.fsdLba - P, 252); b.writeUInt16LE(0, 256); // FSD long_ad
    b.writeUInt32LE(6, 264); b.writeUInt32LE(1, 268);
    regid(b, 272, IMPL_ID, implSuffix());
    b.writeUInt32LE(2 * SECTOR, 432); b.writeUInt32LE(64, 436); // integrity sequence
    b.writeUInt8(1, 440); b.writeUInt8(6, 441); b.writeUInt16LE(1, 442); b.writeUInt16LE(0, 444);
    udfTag(b, 6, start + 3, 430);
    // Unallocated Space Descriptor
    b = sec(start + 4);
    b.writeUInt32LE(seq++, 16); b.writeUInt32LE(0, 20);
    udfTag(b, 7, start + 4, 8);
    // Terminating Descriptor
    b = sec(start + 5);
    udfTag(b, 8, start + 5, 496);
  };
  writeVds(32);
  writeVds(48);
  // Logical Volume Integrity Descriptor + terminator
  {
    const b = sec(64);
    udfTimestamp(b, 16, now);
    b.writeUInt32LE(1, 28); // closed
    b.writeBigUInt64LE(BigInt(16 + nFiles + nDirs), 40); // next unique id
    b.writeUInt32LE(1, 72); b.writeUInt32LE(46, 76);
    b.writeUInt32LE(0, 80); b.writeUInt32LE(partLen, 84);
    regid(b, 88, IMPL_ID, implSuffix());
    b.writeUInt32LE(nFiles, 120); b.writeUInt32LE(nDirs, 124);
    b.writeUInt16LE(0x102, 128); b.writeUInt16LE(0x102, 130); b.writeUInt16LE(0x102, 132);
    udfTag(b, 9, 64, 134 - 16);
    udfTag(sec(65), 8, 65, 496);
  }
  // Anchor Volume Descriptor Pointers (256 and last sector)
  for (const lba of [256, L.total - 1]) {
    const b = sec(lba);
    b.writeUInt32LE(16 * SECTOR, 16); b.writeUInt32LE(32, 20);
    b.writeUInt32LE(16 * SECTOR, 24); b.writeUInt32LE(48, 28);
    udfTag(b, 2, lba, 496);
  }

  // ---------------- UDF file set ----------------
  {
    const b = sec(L.fsdLba);
    udfTimestamp(b, 16, now);
    b.writeUInt16LE(3, 28); b.writeUInt16LE(3, 30); b.writeUInt32LE(1, 32); b.writeUInt32LE(1, 36);
    charspec(b, 48); dstring(b, 112, 128, vol);
    charspec(b, 240); dstring(b, 304, 32, vol);
    b.writeUInt32LE(SECTOR, 400); b.writeUInt32LE(root.udfFe - P, 404); b.writeUInt16LE(0, 408);
    regid(b, 416, '*OSTA UDF Compliant', udfRevSuffix());
    udfTag(b, 256, L.fsdLba - P, 496);
    udfTag(sec(L.fsdTermLba), 8, L.fsdTermLba - P, 496);
  }

  // ---------------- UDF file entries ----------------
  let uid = 16;
  for (const d of dirs) d.uid = d === root ? 0 : uid++;
  for (const f of files) f.uid = uid++;
  const fileEntry = (lba, node, isDir, infoLen, dataLba) => {
    const ads = isDir ? [{ len: infoLen, lbn: dataLba - P }] : shortAds(infoLen, infoLen ? dataLba - P : 0);
    const b = sec(lba);
    // ICB tag
    b.writeUInt16LE(4, 20); b.writeUInt16LE(1, 24); b.writeUInt8(isDir ? 4 : 5, 27);
    b.writeUInt16LE(0, 34); // short_ad allocation descriptors
    b.writeUInt32LE(0xffffffff, 36); b.writeUInt32LE(0xffffffff, 40);
    b.writeUInt32LE(isDir ? 0x14a5 : 0x1084, 44);
    b.writeUInt16LE(isDir ? 1 + node.children.filter((c) => c.dir).length : 1, 48);
    b.writeBigUInt64LE(BigInt(infoLen), 56);
    b.writeBigUInt64LE(BigInt(Math.ceil(infoLen / SECTOR)), 64);
    udfTimestamp(b, 72, now); udfTimestamp(b, 84, now); udfTimestamp(b, 96, now);
    b.writeUInt32LE(1, 108);
    regid(b, 128, IMPL_ID, implSuffix());
    b.writeBigUInt64LE(BigInt(node.uid), 160);
    b.writeUInt32LE(0, 168);
    b.writeUInt32LE(ads.length * 8, 172);
    ads.forEach((a, i) => { b.writeUInt32LE(a.len, 176 + i * 8); b.writeUInt32LE(a.lbn, 180 + i * 8); });
    if (176 + ads.length * 8 > SECTOR) throw new Error('File too large for this image layout.');
    udfTag(b, 261, lba - P, 176 + ads.length * 8 - 16);
  };
  for (const d of dirs) {
    fileEntry(d.udfFe, d, true, d.fidSize, d.udfData);
    // FIDs
    const data = Buffer.alloc(Math.ceil(d.fidSize / SECTOR) * SECTOR);
    let o = 0;
    const fid = (name, chars, target) => {
      const nameBuf = name ? Buffer.concat([Buffer.from([8]), Buffer.from(name, 'latin1')]) : Buffer.alloc(0);
      const len = (38 + nameBuf.length + 3) & ~3;
      const f = Buffer.alloc(len);
      f.writeUInt16LE(1, 16); f.writeUInt8(chars, 18); f.writeUInt8(nameBuf.length, 19);
      f.writeUInt32LE(SECTOR, 20); f.writeUInt32LE(target.udfFe - P, 24); f.writeUInt16LE(0, 28);
      f.writeUInt32LE(target.uid >>> 0, 32); // UDF unique id (low 32 bits) in impl use
      f.writeUInt16LE(0, 36);
      nameBuf.copy(f, 38);
      const blockLba = d.udfData + Math.floor(o / SECTOR);
      udfTag(f, 257, blockLba - P, len - 16);
      f.copy(data, o); o += len;
    };
    fid('', 0x0a, d.parent || d);
    for (const c of d.children) fid(c.name, c.dir ? 0x02 : 0x00, c);
    for (let i = 0; i < data.length / SECTOR; i++) data.copy(sec(d.udfData + i), 0, i * SECTOR, (i + 1) * SECTOR);
  }
  for (const f of files) fileEntry(f.udfFe, f, false, f.size, f.lba);
  return blocks;
}

/**
 * Write a DVD-Video ISO image from an authored folder. onProgress(fraction).
 * ctx (optional) supports cancellation via ctx.check().
 */
async function writeDvdIso(srcDir, isoPath, label, { onProgress = () => {}, ctx = null } = {}) {
  const L = planDvdImage(srcDir, label);
  const blocks = buildMetadata(L);
  const out = fs.openSync(isoPath, 'w');
  const totalBytes = L.total * SECTOR;
  let written = 0;
  try {
    const zero = Buffer.alloc(SECTOR);
    const writeAt = (buf, lba) => { fs.writeSync(out, buf, 0, buf.length, lba * SECTOR); };
    // metadata area 0 .. first file data
    const firstData = L.files.length ? L.files[0].lba : L.total - 1;
    for (let lba = 0; lba < firstData; lba++) writeAt(blocks.get(lba) || zero, lba);
    written = firstData * SECTOR;
    // file data, streamed
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (const f of L.files) {
      if (!f.size) continue;
      const fd = fs.openSync(f.abs, 'r');
      try {
        let pos = 0;
        while (pos < f.size) {
          if (ctx) ctx.check();
          const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, f.size - pos), pos);
          if (n <= 0) throw new Error(`Could not read ${f.abs}`);
          fs.writeSync(out, chunk, 0, n, f.lba * SECTOR + pos);
          pos += n; written += n;
          onProgress(written / totalBytes);
          await new Promise((r) => setImmediate(r));
        }
      } finally { fs.closeSync(fd); }
    }
    writeAt(blocks.get(L.total - 1), L.total - 1);
  } finally {
    fs.closeSync(out);
  }
  onProgress(1);
  return { sectors: L.total, files: L.files.map((f) => ({ name: f.name, lba: f.lba, size: f.size })) };
}

module.exports = { writeDvdIso, planDvdImage, dvdOrder };
