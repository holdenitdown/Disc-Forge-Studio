'use strict';
/**
 * Blu-ray Interactive Graphics (IG) stream encoder.
 *
 * Produces an HDMV IG display set (ICS + PDS + ODS... + END) and wraps it in the
 * ".sup" container (the "PG" framed format) so that tsMuxeR can multiplex it as a
 * graphics track. The track is converted from PG to IG afterwards (see patch.js).
 *
 * Model used by DiscForge: every menu page is its own clip whose background video
 * already contains the page artwork; the IG stream carries the buttons' selected
 * and activated highlight graphics plus the navigation commands.
 */

const SEG = { PDS: 0x14, ODS: 0x15, ICS: 0x18, END: 0x80 };
const TRANSPARENT = 0xff;
const FRAME_RATE_CODE = { 23.976: 1, 24: 2, 25: 3, 29.97: 4, 50: 6, 59.94: 7 };

function frameRateCode(fps) {
  let best = 2;
  let bestDiff = Infinity;
  for (const [k, v] of Object.entries(FRAME_RATE_CODE)) {
    const d = Math.abs(Number(k) - fps);
    if (d < bestDiff) { bestDiff = d; best = v; }
  }
  return best;
}

/* ------------------------------------------------------------------ palette */

function rgbToYCbCr(r, g, b, hd) {
  // Limited-range ("TV") YCbCr as expected by the HDMV graphics plane.
  const [kr, kb] = hd ? [0.2126, 0.0722] : [0.299, 0.114];
  const kg = 1 - kr - kb;
  const y = kr * r + kg * g + kb * b;
  const cb = (b - y) / (2 * (1 - kb));
  const cr = (r - y) / (2 * (1 - kr));
  const clamp = (v) => Math.max(16, Math.min(240, Math.round(v)));
  return { Y: clamp(16 + (219 * y) / 255), Cb: clamp(128 + (224 * cb) / 255), Cr: clamp(128 + (224 * cr) / 255) };
}

/**
 * Median-cut quantizer over RGBA. images: [{ data: Uint8ClampedArray(RGBA), width, height }]
 * Returns { palette: [{r,g,b,a}], indexed: [Uint8Array] } with index 0xFF reserved for transparency.
 */
function quantize(images, maxColors = 255) {
  const hist = new Map();
  for (const img of images) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      // 5 bits per channel keeps the histogram small without visible banding on menus.
      const key = ((d[i] >> 3) << 15) | ((d[i + 1] >> 3) << 10) | ((d[i + 2] >> 3) << 5) | (d[i + 3] >> 3);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  const colors = [];
  for (const [key, count] of hist) {
    colors.push({ r: ((key >> 15) & 31) * 8 + 4, g: ((key >> 10) & 31) * 8 + 4, b: ((key >> 5) & 31) * 8 + 4, a: (key & 31) * 8 + 4, count });
  }
  let palette;
  if (colors.length <= maxColors) {
    palette = colors.map(({ r, g, b, a }) => ({ r, g, b, a: Math.min(255, a) }));
  } else {
    let boxes = [colors];
    while (boxes.length < maxColors) {
      // split the box with the widest weighted range
      let bi = -1;
      let bestScore = -1;
      let bestCh = 'r';
      boxes.forEach((box, i) => {
        if (box.length < 2) return;
        for (const ch of ['r', 'g', 'b', 'a']) {
          let mn = 255;
          let mx = 0;
          let w = 0;
          for (const c of box) { if (c[ch] < mn) mn = c[ch]; if (c[ch] > mx) mx = c[ch]; w += c.count; }
          const score = (mx - mn) * Math.log2(w + 1);
          if (score > bestScore) { bestScore = score; bi = i; bestCh = ch; }
        }
      });
      if (bi < 0 || bestScore <= 0) break;
      const box = boxes[bi].sort((x, y) => x[bestCh] - y[bestCh]);
      const total = box.reduce((s, c) => s + c.count, 0);
      let acc = 0;
      let cut = 1;
      for (let i = 0; i < box.length - 1; i++) { acc += box[i].count; if (acc >= total / 2) { cut = i + 1; break; } }
      boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
    }
    palette = boxes.map((box) => {
      let r = 0, g = 0, b = 0, a = 0, w = 0;
      for (const c of box) { r += c.r * c.count; g += c.g * c.count; b += c.b * c.count; a += c.a * c.count; w += c.count; }
      return { r: Math.round(r / w), g: Math.round(g / w), b: Math.round(b / w), a: Math.min(255, Math.round(a / w)) };
    });
  }
  const cache = new Map();
  const nearest = (r, g, b, a) => {
    const key = (r << 24) ^ (g << 16) ^ (b << 8) ^ a;
    let idx = cache.get(key);
    if (idx !== undefined) return idx;
    let best = Infinity;
    idx = 0;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = p.r - r, dg = p.g - g, db = p.b - b, da = p.a - a;
      const dist = 2 * dr * dr + 4 * dg * dg + db * db + 3 * da * da;
      if (dist < best) { best = dist; idx = i; }
    }
    cache.set(key, idx);
    return idx;
  };
  const indexed = images.map((img) => {
    const out = new Uint8Array(img.width * img.height);
    const d = img.data;
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      out[p] = d[i + 3] < 8 ? TRANSPARENT : nearest(d[i], d[i + 1], d[i + 2], d[i + 3]);
    }
    return out;
  });
  return { palette, indexed };
}

/* ---------------------------------------------------------------------- RLE */

function rleEncode(indexed, width, height) {
  const out = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    const row = y * width;
    while (x < width) {
      const color = indexed[row + x];
      let run = 1;
      while (x + run < width && indexed[row + x + run] === color && run < 16383) run++;
      if (color !== 0 && run < 3) {
        for (let i = 0; i < run; i++) out.push(color);
      } else if (color === 0) {
        if (run < 64) out.push(0, run);
        else out.push(0, 0x40 | (run >> 8), run & 0xff);
      } else if (run < 64) {
        out.push(0, 0x80 | run, color);
      } else {
        out.push(0, 0xc0 | (run >> 8), run & 0xff, color);
      }
      x += run;
    }
    out.push(0, 0); // end of line
  }
  return Buffer.from(out);
}

/* ----------------------------------------------------------------- segments */

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u24 = (v) => Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
const pts33 = (v) => { // 7 reserved bits + 33-bit value in 5 bytes
  const b = Buffer.alloc(5);
  const hi = Math.floor(v / 2 ** 32) & 1;
  b[0] = hi;
  b.writeUInt32BE(v >>> 0, 1);
  return b;
};

function segment(type, payload) {
  return Buffer.concat([u8(type), u16(payload.length), payload]);
}

function buildPDS(palette, hd, paletteId = 0) {
  const parts = [u8(paletteId), u8(0)];
  palette.forEach((p, i) => {
    const { Y, Cb, Cr } = rgbToYCbCr(p.r, p.g, p.b, hd);
    parts.push(Buffer.from([i, Y, Cr, Cb, p.a]));
  });
  parts.push(Buffer.from([TRANSPARENT, 16, 128, 128, 0]));
  return [segment(SEG.PDS, Buffer.concat(parts))];
}

function buildODS(id, width, height, rle) {
  const MAX = 0xffff;
  const head = Buffer.concat([u16(id), u8(0)]);
  const full = Buffer.concat([u24(rle.length + 4), u16(width), u16(height), rle]);
  const segs = [];
  let off = 0;
  let first = true;
  while (off < full.length) {
    const room = MAX - head.length - 1;
    const chunk = full.subarray(off, off + room);
    off += chunk.length;
    const last = off >= full.length;
    const seq = (first ? 0x80 : 0) | (last ? 0x40 : 0);
    segs.push(segment(SEG.ODS, Buffer.concat([head, u8(seq), chunk])));
    first = false;
  }
  return segs;
}

function effectSequenceEmpty() {
  return Buffer.from([0, 0]);
}

function buildButton(btn) {
  const cmds = btn.commands || [];
  return Buffer.concat([
    u16(btn.id),
    u16(btn.numeric != null ? btn.numeric : 0xffff),
    u8(btn.autoAction ? 0x80 : 0),
    u16(btn.x), u16(btn.y),
    u16(btn.up), u16(btn.down), u16(btn.left), u16(btn.right),
    // normal state: start/end object ids, repeat flag
    u16(btn.normalObj != null ? btn.normalObj : 0xffff), u16(btn.normalObj != null ? btn.normalObj : 0xffff), u8(0),
    // selected state: sound id, objects, repeat flag
    u8(0xff), u16(btn.selectedObj), u16(btn.selectedObj), u8(0),
    // activated state: sound id, objects
    u8(0xff), u16(btn.activatedObj), u16(btn.activatedObj),
    u16(cmds.length),
    ...cmds,
  ]);
}

function buildICS({ width, height, fps, popup, pages }) {
  const pageBufs = pages.map((page) => {
    const bogs = page.buttons.map((b) => Buffer.concat([u16(b.id), u8(1), buildButton(b)]));
    return Buffer.concat([
      u8(page.id), u8(0),
      Buffer.alloc(8), // UO mask table: allow everything
      effectSequenceEmpty(), effectSequenceEmpty(),
      u8(0), // animation frame rate code
      u16(page.defaultButton != null ? page.defaultButton : page.buttons[0].id),
      u16(0xffff), // no default activated button
      u8(0), // palette id
      u8(bogs.length),
      ...bogs,
    ]);
  });
  const body = Buffer.concat([
    u8(popup ? 0x40 : 0x00), // stream_model=0 (multiplexed), ui_model
    pts33(0), pts33(0), // composition / selection timeout: none
    u24(0), // user timeout: none
    u8(pages.length),
    ...pageBufs,
  ]);
  const head = Buffer.concat([
    u16(width), u16(height), u8(frameRateCode(fps) << 4),
    u16(0), u8(0x80), // composition number 0, state = epoch start
  ]);
  const data = Buffer.concat([u24(body.length), body]);
  // Fragment if needed: each fragment repeats the descriptor fields with a sequence descriptor.
  const MAX = 0xffff - head.length - 1;
  const segs = [];
  for (let off = 0, first = true; off < data.length || first; first = false) {
    const chunk = data.subarray(off, off + MAX);
    off += chunk.length;
    const last = off >= data.length;
    segs.push(segment(SEG.ICS, Buffer.concat([head, u8((first ? 0x80 : 0) | (last ? 0x40 : 0)), chunk])));
  }
  return segs;
}

/**
 * Build an IG display set.
 * menu = { width, height, fps, popup, pages: [{ id, defaultButton, buttons: [{
 *   id, x, y, up, down, left, right, commands: [Buffer],
 *   selected: {data,width,height}, activated: {data,width,height}, normal?: {...} }] }] }
 * Returns { segments: [{ type, buf }], stats }.
 */
function buildDisplaySet(menu) {
  const hd = menu.height >= 720;
  const images = [];
  const ref = (img) => { images.push(img); return images.length - 1; };
  const pages = menu.pages.map((page) => ({
    ...page,
    buttons: page.buttons.map((b) => ({
      ...b,
      selectedObj: ref(b.selected),
      activatedObj: ref(b.activated || b.selected),
      normalObj: b.normal ? ref(b.normal) : null,
    })),
  }));
  const { palette, indexed } = quantize(images);
  const ics = buildICS({ ...menu, pages });
  const pds = buildPDS(palette, hd);
  const ods = [];
  let objectBytes = 0;
  images.forEach((img, id) => {
    const rle = rleEncode(indexed[id], img.width, img.height);
    objectBytes += rle.length;
    ods.push(...buildODS(id, img.width, img.height, rle));
  });
  const end = segment(SEG.END, Buffer.alloc(0));
  const detectionPcs = segment(0x16, Buffer.concat([
    u16(menu.width), u16(menu.height), u8(frameRateCode(menu.fps) << 4),
    u16(0), u8(0x00), // composition number, state normal
    u8(0), u8(0), // palette update flag, palette id
    u8(0), // no composition objects
  ]));
  return {
    ics, pds, ods, end, detectionPcs,
    stats: { objects: images.length, colors: palette.length, objectBytes, icsBytes: ics.reduce((s, b) => s + b.length, 0) },
  };
}

/**
 * Serialize to the .sup container accepted by tsMuxeR ("PG" + PTS + DTS + segment).
 * Timing: segments are delivered progressively from startPts so the IG decoder
 * buffer model is respected, and the composition is presented once all objects
 * are decoded.
 */
function toSup(ds, startSec = 0) {
  const CLOCK = 90000;
  const RATE = 2_000_000; // bytes per second budget for delivery (well below Rx = 16 Mbps)
  let t = startSec * CLOCK;
  const frames = [];
  const push = (seg, pts, dts) => {
    const h = Buffer.alloc(10);
    h.write('PG', 0, 'ascii');
    h.writeUInt32BE(Math.round(pts) >>> 0, 2);
    h.writeUInt32BE(Math.round(dts) >>> 0, 6);
    frames.push(h, seg);
  };
  // tsMuxeR only recognises a graphics track by a PG composition segment (0x16) that
  // carries the video descriptor. Emit a minimal one first; patch.js nulls it out.
  if (ds.detectionPcs) push(ds.detectionPcs, Math.max(1, t - 90), Math.max(1, t - 90));
  const icsDts = t;
  t += (ds.pds.reduce((s, b) => s + b.length, 0) / RATE) * CLOCK;
  const pdsTimes = ds.pds.map(() => t);
  const odsTimes = ds.ods.map((seg) => { const at = t; t += (seg.length / RATE) * CLOCK; return at; });
  const presentation = Math.max(t + 0.1 * CLOCK, startSec * CLOCK + 0.5 * CLOCK);
  ds.ics.forEach((seg) => push(seg, presentation, icsDts));
  ds.pds.forEach((seg, i) => push(seg, pdsTimes[i], pdsTimes[i]));
  ds.ods.forEach((seg, i) => push(seg, odsTimes[i], odsTimes[i]));
  push(ds.end, presentation, presentation);
  return { sup: Buffer.concat(frames), presentationSec: presentation / CLOCK };
}

module.exports = { buildDisplaySet, toSup, quantize, rleEncode, rgbToYCbCr, frameRateCode, SEG, TRANSPARENT };
