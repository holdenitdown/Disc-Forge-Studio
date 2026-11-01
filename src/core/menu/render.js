'use strict';
/**
 * Menu rendering with Skia (@napi-rs/canvas).
 * - background(page): full page artwork at the disc's storage resolution
 * - highlights(page): per-button selected/activated RGBA crops (Blu-ray IG)
 * - dvdMasks(page): full-frame 1-colour highlight/select masks (DVD spumux)
 */
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { seeded } = require('./themes');

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
let fontsLoaded = false;
function loadFonts() {
  if (fontsLoaded) return;
  fontsLoaded = true;
  const map = {
    'Inter-Regular.otf': 'Inter', 'Inter-Bold.otf': 'Inter', 'Inter-SemiBold.otf': 'Inter', 'Inter-Italic.otf': 'Inter',
    'Poppins-Regular.ttf': 'Poppins', 'Poppins-Bold.ttf': 'Poppins', 'Poppins-Medium.ttf': 'Poppins', 'Lora-Variable.ttf': 'Lora',
  };
  for (const [file, family] of Object.entries(map)) {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, family);
  }
}

const imageCache = new Map();
async function img(file) {
  if (!file) return null;
  if (!imageCache.has(file)) {
    try { imageCache.set(file, await loadImage(fs.readFileSync(file))); } catch (_) { imageCache.set(file, null); }
  }
  return imageCache.get(file);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function font(ctx, size, family, { bold = false, italic = false } = {}) {
  ctx.font = `${italic ? 'italic ' : ''}${bold ? '700' : '500'} ${Math.round(size)}px ${family}`;
}

function drawCover(ctx, image, W, H) {
  const s = Math.max(W / image.width, H / image.height);
  const w = image.width * s;
  const h = image.height * s;
  ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
}

function textWithShadow(ctx, text, x, y, color, dark) {
  ctx.save();
  if (dark !== false) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

class MenuRenderer {
  /**
   * layout: result of buildMenuPages; opts: { width, height, menu (project.menu), backgroundImage, transparentBackground }
   */
  constructor(layout, opts) {
    loadFonts();
    this.layout = layout;
    this.W = opts.width;
    this.H = opts.height;
    this.menu = opts.menu;
    this.opts = opts;
    this.sx = this.W / layout.VW;
    this.sy = this.H / layout.VH;
  }

  get theme() { return this.layout.theme; }

  hlColor() { return (this.menu.highlight && this.menu.highlight.color) || this.theme.colors.highlight; }

  begin(ctx) {
    ctx.save();
    ctx.scale(this.sx, this.sy);
  }

  async paintBackdrop(ctx) {
    const { VW, VH } = this.layout;
    const bg = this.menu.background || {};
    if (this.opts.transparentBackground) {
      // motion background: darken slightly for legibility, artwork is drawn over the video
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, 0, VW, VH);
      return;
    }
    const custom = bg.type === 'image' && bg.file ? await img(bg.file) : null;
    if (custom) {
      drawCover(ctx, custom, VW, VH);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(0, 0, VW, VH);
    } else {
      this.theme.paint(ctx, VW, VH, seeded(42));
    }
  }

  drawHeading(ctx, page) {
    const { VW, VH } = this.layout;
    const t = this.theme;
    const isTop = page.kind === 'top';
    const size = isTop ? VH * 0.085 : VH * 0.06;
    font(ctx, size, t.fonts.title, { bold: true });
    ctx.textBaseline = 'alphabetic';
    let x = VW * 0.075;
    ctx.textAlign = 'left';
    if (t.layout === 'center' || !isTop) { ctx.textAlign = 'center'; x = VW / 2; }
    if (t.layout === 'right' && isTop) { ctx.textAlign = 'left'; x = VW * 0.6; }
    const y = isTop ? (t.layout === 'center' ? VH * 0.3 : VH * 0.27) : VH * 0.14;
    const lines = String(page.heading || '').split('#');
    lines.forEach((ln, i) => textWithShadow(ctx, ln, x, y + i * size * 1.1, t.colors.title, t.colors.dark));
    if (isTop && t.layout !== 'center') {
      ctx.fillStyle = t.colors.accent;
      const w = VW * 0.06;
      const ax = ctx.textAlign === 'center' ? x - w / 2 : x;
      ctx.fillRect(ax, y + size * 0.35 + (lines.length - 1) * size * 1.1, w, VH * 0.006);
    }
  }

  async drawButtonNormal(ctx, b) {
    const t = this.theme;
    const r = b.rect;
    if (b.kind === 'thumb') {
      const tr = b.thumbRect;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 6;
      roundRect(ctx, tr.x, tr.y, tr.w, tr.h, tr.h * 0.06);
      ctx.fillStyle = '#111';
      ctx.fill();
      ctx.restore();
      const im = await img(b.thumb);
      ctx.save();
      roundRect(ctx, tr.x, tr.y, tr.w, tr.h, tr.h * 0.06);
      ctx.clip();
      if (im) this.drawImageInRect(ctx, im, tr);
      else { ctx.fillStyle = t.colors.panel; ctx.fillRect(tr.x, tr.y, tr.w, tr.h); }
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      roundRect(ctx, tr.x, tr.y, tr.w, tr.h, tr.h * 0.06);
      ctx.stroke();
      font(ctx, b.fontSize, t.fonts.body, { bold: true });
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = this.fit(ctx, b.label, r.w);
      textWithShadow(ctx, label, r.x + r.w / 2, tr.y + tr.h + b.fontSize * 0.35, t.colors.text, t.colors.dark);
      if (b.sublabel) {
        font(ctx, b.fontSize * 0.75, t.fonts.body);
        ctx.globalAlpha = 0.75;
        textWithShadow(ctx, b.sublabel, r.x + r.w / 2, tr.y + tr.h + b.fontSize * 1.45, t.colors.text, t.colors.dark);
        ctx.globalAlpha = 1;
      }
      return;
    }
    font(ctx, b.fontSize, t.fonts.body, { bold: !b.nav });
    ctx.textBaseline = 'middle';
    ctx.textAlign = b.align === 'center' ? 'center' : 'left';
    const tx = b.align === 'center' ? r.x + r.w / 2 : r.x + b.fontSize * 0.5;
    textWithShadow(ctx, this.fit(ctx, b.label, r.w - b.fontSize), tx, r.y + r.h / 2, t.colors.text, t.colors.dark);
  }

  drawImageInRect(ctx, im, r) {
    const s = Math.max(r.w / im.width, r.h / im.height);
    const w = im.width * s;
    const h = im.height * s;
    ctx.drawImage(im, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
    return true;
  }

  fit(ctx, text, maxW) {
    let s = String(text);
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
    return `${s}…`;
  }

  async drawElements(ctx, page) {
    const { VW, VH } = this.layout;
    for (const e of page.elements || []) {
      if (e.hidden) continue;
      const x = (e.x / 1000) * VW;
      const y = (e.y / 1000) * VH;
      if (e.type === 'image') {
        const im = await img(e.file);
        if (!im) continue;
        const w = ((e.w || 200) / 1000) * VW;
        const h = e.h ? (e.h / 1000) * VH : (w * im.height) / im.width;
        ctx.globalAlpha = e.opacity != null ? e.opacity : 1;
        ctx.drawImage(im, x, y, w, h);
        ctx.globalAlpha = 1;
      } else {
        const size = e.size || 48;
        font(ctx, size, e.font || this.theme.fonts.body, { bold: e.bold, italic: e.italic });
        ctx.textAlign = e.align || 'left';
        ctx.textBaseline = 'top';
        String(e.text || '').split('#').forEach((ln, i) => {
          const ly = y + i * size * 1.15;
          if (e.outline) { ctx.lineWidth = size * 0.08; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(ln, x, ly); }
          textWithShadow(ctx, ln, x, ly, e.color || this.theme.colors.text, !e.outline && this.theme.colors.dark);
          if (e.underline) {
            const w = ctx.measureText(ln).width;
            const ux = ctx.textAlign === 'center' ? x - w / 2 : ctx.textAlign === 'right' ? x - w : x;
            ctx.fillStyle = e.color || this.theme.colors.text;
            ctx.fillRect(ux, ly + size * 1.05, w, size * 0.06);
          }
        });
      }
    }
  }

  /** Full page artwork (normal state). Returns a PNG Buffer. */
  async background(page) {
    const c = createCanvas(this.W, this.H);
    const ctx = c.getContext('2d');
    this.begin(ctx);
    await this.paintBackdrop(ctx);
    this.drawHeading(ctx, page);
    for (const b of page.buttons) await this.drawButtonNormal(ctx, b);
    await this.drawElements(ctx, page);
    ctx.restore();
    return c.toBuffer('image/png');
  }

  /** Draw the highlight shape for one button into ctx (virtual coordinates). */
  drawHighlight(ctx, b, color, state) {
    const style = (this.menu.highlight && this.menu.highlight.style) || 'box';
    const r = b.kind === 'thumb' ? b.thumbRect : b.rect;
    const lw = Math.max(4, this.layout.VH * 0.005);
    ctx.save();
    if (b.kind === 'thumb') {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw * 1.6;
      roundRect(ctx, r.x - lw, r.y - lw, r.w + 2 * lw, r.h + 2 * lw, r.h * 0.07);
      ctx.stroke();
      if (state === 'activated') { ctx.globalAlpha = 0.3; ctx.fillStyle = color; ctx.fill(); }
      ctx.restore();
      return;
    }
    if (style === 'underline') {
      ctx.fillStyle = color;
      const w = Math.min(r.w, this.textWidth(b) + b.fontSize);
      const x = b.align === 'center' ? r.x + (r.w - w) / 2 : r.x;
      ctx.fillRect(x, r.y + r.h - lw * 1.4, w, lw * 1.4);
    } else if (style === 'pill') {
      ctx.globalAlpha = state === 'activated' ? 0.6 : 0.35;
      ctx.fillStyle = color;
      roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
      ctx.fill();
    } else if (style === 'arrow') {
      ctx.fillStyle = color;
      const s = r.h * 0.32;
      const ax = b.align === 'center' ? r.x + (r.w - this.textWidth(b)) / 2 - s * 1.6 : r.x - s * 0.6;
      ctx.beginPath(); ctx.moveTo(ax, r.y + r.h / 2 - s); ctx.lineTo(ax + s * 1.2, r.y + r.h / 2); ctx.lineTo(ax, r.y + r.h / 2 + s); ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      roundRect(ctx, r.x + lw / 2, r.y + lw / 2, r.w - lw, r.h - lw, r.h * 0.22);
      ctx.stroke();
      ctx.globalAlpha = state === 'activated' ? 0.4 : 0.18;
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
  }

  textWidth(b) {
    const c = createCanvas(4, 4).getContext('2d');
    font(c, b.fontSize, this.theme.fonts.body, { bold: !b.nav });
    return c.measureText(b.label).width;
  }

  /** Storage-space rectangle of a button's highlight (with margin), even-aligned. */
  hlRect(b) {
    const r = b.kind === 'thumb' ? b.thumbRect : b.rect;
    const m = this.layout.VH * 0.012 + (b.kind === 'thumb' ? this.layout.VH * 0.006 : 0);
    const arrowPad = (this.menu.highlight && this.menu.highlight.style === 'arrow') ? r.h * 0.9 : 0;
    let x0 = Math.floor((r.x - m - arrowPad) * this.sx);
    let y0 = Math.floor((r.y - m) * this.sy);
    let x1 = Math.ceil((r.x + r.w + m) * this.sx);
    let y1 = Math.ceil((r.y + r.h + m) * this.sy);
    x0 = Math.max(0, x0 - (x0 % 2)); y0 = Math.max(0, y0 - (y0 % 2));
    x1 = Math.min(this.W, x1 + (x1 % 2)); y1 = Math.min(this.H, y1 + (y1 % 2));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Per-button RGBA highlight crops for Blu-ray IG. */
  highlights(page) {
    const color = this.hlColor();
    const activated = this.menu.highlight && this.menu.highlight.activatedColor ? this.menu.highlight.activatedColor : '#ffffff';
    return page.buttons.map((b) => {
      const rect = this.hlRect(b);
      const make = (col, state) => {
        const c = createCanvas(rect.w, rect.h);
        const ctx = c.getContext('2d');
        ctx.translate(-rect.x, -rect.y);
        ctx.scale(this.sx, this.sy);
        this.drawHighlight(ctx, b, col, state);
        const d = ctx.getImageData(0, 0, rect.w, rect.h);
        return { data: d.data, width: rect.w, height: rect.h };
      };
      return { button: b, rect, selected: make(color, 'selected'), activated: make(activated, 'activated') };
    });
  }

  /**
   * Full-frame DVD masks (one opaque colour, everything else transparent) for spumux.
   * Returns { highlight: pngBuffer, select: pngBuffer, buttons: [{ name, x0,y0,x1,y1 }] }.
   */
  dvdMasks(page) {
    const mk = (col, state) => {
      const c = createCanvas(this.W, this.H);
      const ctx = c.getContext('2d');
      ctx.scale(this.sx, this.sy);
      for (const b of page.buttons) this.drawHighlight(ctx, b, col, state);
      // spumux needs hard-edged pixels: threshold alpha and force one exact colour
      const d = ctx.getImageData(0, 0, this.W, this.H);
      const [r, g, bl] = hexToRgb(col);
      for (let i = 0; i < d.data.length; i += 4) {
        if (d.data[i + 3] >= 96) { d.data[i] = r; d.data[i + 1] = g; d.data[i + 2] = bl; d.data[i + 3] = 255; } else { d.data[i] = d.data[i + 1] = d.data[i + 2] = d.data[i + 3] = 0; }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(d, 0, 0);
      return c.toBuffer('image/png');
    };
    const buttons = page.buttons.map((b) => {
      const rr = this.hlRect(b);
      // spumux requires even y0 and y1
      const even = (v) => Math.round(v) & ~1;
      return { id: b.id, name: `b${b.id}`, x0: Math.max(0, Math.round(rr.x)), y0: Math.max(0, even(rr.y)), x1: Math.min(this.W - 1, Math.round(rr.x + rr.w - 1)), y1: Math.min(this.H - 2, even(rr.y + rr.h + 1)), nav: b.navIds };
    });
    return { highlight: mk(this.hlColor(), 'selected'), select: mk('#ffffff', 'activated'), buttons };
  }

  /** UI preview: background + highlight on one button. */
  async preview(page, selectedId = 1) {
    const c = createCanvas(this.W, this.H);
    const ctx = c.getContext('2d');
    const bg = await loadImage(await this.background(page));
    ctx.drawImage(bg, 0, 0);
    const b = page.buttons.find((x) => x.id === selectedId);
    if (b) { ctx.save(); ctx.scale(this.sx, this.sy); this.drawHighlight(ctx, b, this.hlColor(), 'selected'); ctx.restore(); }
    return c.toBuffer('image/png');
  }
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

module.exports = { MenuRenderer, loadFonts, hexToRgb };
