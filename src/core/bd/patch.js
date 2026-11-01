'use strict';
/**
 * Post-processing of tsMuxeR output to turn a multiplexed graphics (PG) track that
 * actually carries Interactive Graphics segments into a proper IG stream:
 *   - .m2ts : PID 0x12xx -> 0x14xx and PMT stream_type 0x90 -> 0x91 (CRC recomputed)
 *   - .clpi : ProgramInfo PID + coding type
 *   - .mpls : STN table PG entry -> IG entry (+ optional infinite still on the PlayItem)
 * The converted tracks must be the LAST PG tracks of the clip, so no STN entries move.
 */
const fs = require('fs');

/* ------------------------------------------------------------ MPEG CRC32 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32mpeg(buf, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/* -------------------------------------------------------------------- m2ts */
/**
 * pidMap: Map(oldPid -> newPid). Streams in pidMap get stream_type 0x91 in the PMT.
 * Processes the file in place in chunks so multi-GB clips are fine.
 */
function patchM2ts(file, pidMap, pmtPid = 0x100) {
  const fd = fs.openSync(file, 'r+');
  const PKT = 192;
  const CHUNK = PKT * 8192;
  const buf = Buffer.alloc(CHUNK);
  let pos = 0;
  let changedPackets = 0;
  let pmtPatched = 0;
  let removedPcs = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      let dirty = false;
      for (let off = 0; off + PKT <= n; off += PKT) {
        const ts = off + 4;
        if (buf[ts] !== 0x47) throw new Error(`Lost TS sync at byte ${pos + off} in ${file}`);
        const pid = ((buf[ts + 1] & 0x1f) << 8) | buf[ts + 2];
        if (pidMap.has(pid)) {
          if (isDetectionPcsPacket(buf, ts)) {
            // The single-packet PG composition we prepended only so tsMuxeR detects
            // the track: neutralise it as a null packet (PID 0x1FFF).
            buf[ts + 1] = 0x1f;
            buf[ts + 2] = 0xff;
            removedPcs++;
            dirty = true;
            continue;
          }
          const np = pidMap.get(pid);
          buf[ts + 1] = (buf[ts + 1] & 0xe0) | ((np >> 8) & 0x1f);
          buf[ts + 2] = np & 0xff;
          changedPackets++;
          dirty = true;
        } else if (pid === pmtPid && buf[ts + 1] & 0x40) {
          if (patchPmtPacket(buf, ts, pidMap)) { pmtPatched++; dirty = true; }
        }
      }
      if (dirty) fs.writeSync(fd, buf, 0, n, pos);
      pos += n;
      if (n < CHUNK) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { changedPackets, pmtPatched, removedPcs };
}

/** True when the TS packet holds a complete PES whose first segment is a PG composition (0x16). */
function isDetectionPcsPacket(buf, ts) {
  if (!(buf[ts + 1] & 0x40)) return false; // payload_unit_start
  const afc = (buf[ts + 3] >> 4) & 3;
  let p = ts + 4;
  if (afc === 2) return false;
  if (afc === 3) p += 1 + buf[p];
  if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) return false;
  const pesLen = buf.readUInt16BE(p + 4);
  const hdrLen = buf[p + 8];
  const payload = p + 9 + hdrLen;
  if (pesLen === 0 || p + 6 + pesLen > ts + 188) return false; // must fit in this packet
  return buf[payload] === 0x16;
}

function patchPmtPacket(buf, ts, pidMap) {
  // locate payload
  const afc = (buf[ts + 3] >> 4) & 3;
  let p = ts + 4;
  if (afc === 2) return false;
  if (afc === 3) p += 1 + buf[p];
  p += 1 + buf[p]; // pointer_field
  if (buf[p] !== 0x02) return false;
  const sectionLength = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
  const sectionEnd = p + 3 + sectionLength; // includes CRC
  if (sectionEnd > ts + 188) return false; // multi-packet PMT not expected from tsMuxeR
  const progInfoLen = ((buf[p + 10] & 0x0f) << 8) | buf[p + 11];
  let e = p + 12 + progInfoLen;
  let changed = false;
  while (e < sectionEnd - 4) {
    const pid = ((buf[e + 1] & 0x1f) << 8) | buf[e + 2];
    const esInfoLen = ((buf[e + 3] & 0x0f) << 8) | buf[e + 4];
    if (pidMap.has(pid)) {
      const np = pidMap.get(pid);
      buf[e] = 0x91;
      buf[e + 1] = (buf[e + 1] & 0xe0) | ((np >> 8) & 0x1f);
      buf[e + 2] = np & 0xff;
      changed = true;
    }
    e += 5 + esInfoLen;
  }
  if (changed) {
    const crc = crc32mpeg(buf, p, sectionEnd - 4);
    buf.writeUInt32BE(crc, sectionEnd - 4);
  }
  return changed;
}

/* -------------------------------------------------------------------- clpi */
function patchClpi(file, pidMap) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'HDMV') throw new Error(`${file}: not a CLPI file`);
  const progStart = b.readUInt32BE(12);
  let p = progStart + 4 + 1; // length, reserved
  const numProg = b[p++];
  let changed = 0;
  for (let i = 0; i < numProg; i++) {
    p += 4 + 2; // spn_program_sequence_start, program_map_pid
    const numStreams = b[p++];
    p += 1; // num_groups
    for (let s = 0; s < numStreams; s++) {
      const pid = b.readUInt16BE(p);
      const attrLen = b[p + 2];
      const coding = b[p + 3];
      if (pidMap.has(pid) && coding === 0x90) {
        b.writeUInt16BE(pidMap.get(pid), p);
        b[p + 3] = 0x91;
        changed++;
      }
      p += 2 + 1 + attrLen;
    }
  }
  fs.writeFileSync(file, b);
  return changed;
}

/* -------------------------------------------------------------------- mpls */
/**
 * Convert the last `igCount` PG entries of every PlayItem's STN table into IG entries.
 * opts.still: 'infinite' sets still_mode=2 on the last PlayItem (menu holds its last frame).
 */
function patchMpls(file, pidMap, opts = {}) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'MPLS') throw new Error(`${file}: not an MPLS file`);
  const plStart = b.readUInt32BE(8);
  let p = plStart + 4 + 2;
  const numItems = b.readUInt16BE(p);
  p += 2 + 2; // num_playitems, num_subpaths
  let converted = 0;
  for (let i = 0; i < numItems; i++) {
    const itemStart = p;
    const itemLen = b.readUInt16BE(p);
    const multiAngle = (b[p + 12] >> 4) & 1;
    if (opts.still === 'infinite' && i === numItems - 1) {
      b[itemStart + 31] = 2;
      b.writeUInt16BE(0, itemStart + 32);
    }
    let q = itemStart + 34;
    if (multiAngle) {
      const numAngles = b[q];
      q += 2 + (numAngles - 1) * 10;
    }
    // STN table
    const stn = q;
    const nVideo = b[stn + 4];
    const nAudio = b[stn + 5];
    const nPg = b[stn + 6];
    let e = stn + 16;
    const skipEntry = () => { e += 1 + b[e]; e += 1 + b[e]; };
    for (let k = 0; k < nVideo + nAudio; k++) skipEntry();
    const pgEntries = [];
    for (let k = 0; k < nPg; k++) { pgEntries.push(e); skipEntry(); }
    let toConvert = 0;
    for (let k = pgEntries.length - 1; k >= 0; k--) {
      const se = pgEntries[k];
      const type = b[se + 1];
      const pidOff = type === 1 ? se + 2 : type === 2 ? se + 4 : se + 3;
      const pid = b.readUInt16BE(pidOff);
      if (!pidMap.has(pid)) break;
      b.writeUInt16BE(pidMap.get(pid), pidOff);
      const attr = se + 1 + b[se];
      b[attr + 1] = 0x91;
      toConvert++;
    }
    b[stn + 6] = nPg - toConvert;
    b[stn + 7] = b[stn + 7] + toConvert;
    converted += toConvert;
    p = itemStart + 2 + itemLen;
  }
  fs.writeFileSync(file, b);
  return converted;
}

/** Read the playlist marks (chapters) count and IN/OUT times; used for verification and UI. */
function readMplsInfo(file) {
  const b = fs.readFileSync(file);
  const plStart = b.readUInt32BE(8);
  const markStart = b.readUInt32BE(12);
  const numItems = b.readUInt16BE(plStart + 6);
  const items = [];
  let p = plStart + 10;
  for (let i = 0; i < numItems; i++) {
    const len = b.readUInt16BE(p);
    items.push({ clip: b.toString('ascii', p + 2, p + 7), inTime: b.readUInt32BE(p + 14), outTime: b.readUInt32BE(p + 18) });
    p += 2 + len;
  }
  const numMarks = b.readUInt16BE(markStart + 4);
  return { items, numMarks };
}

module.exports = { patchM2ts, patchClpi, patchMpls, readMplsInfo, crc32mpeg };
