'use strict';
/**
 * Blu-ray pop-up menu (shown over the movie with the remote's POP-UP key).
 * Page 0: main bar  [Restart] [Chapters] [Audio] [Subtitles] [Main Menu]
 * Page 1: chapter picker, Page 2: audio picker, Page 3: subtitle picker.
 * Every button carries its own normal/selected/activated graphics because
 * there is no menu background video behind a pop-up.
 */
const { createCanvas } = require('@napi-rs/canvas');
const { loadFonts } = require('./render');
const { THEMES } = require('./themes');
const { langLabel } = require('./layout');

function makePopup(project, discPlan, igWidth, igHeight) {
  loadFonts();
  const theme = THEMES[project.menu.theme] || THEMES.aurora;
  const hl = (project.menu.highlight && project.menu.highlight.color) || theme.colors.highlight;
  const s = igHeight / 1080;
  const L = project.menu.labels;

  const drawBtn = (w, h, label, state) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    const r = h / 2;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath();
    ctx.fillStyle = state === 'normal' ? 'rgba(12,16,28,0.78)' : state === 'selected' ? hl : '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = state === 'normal' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
    ctx.stroke();
    ctx.fillStyle = state === 'normal' ? '#ffffff' : '#10131c';
    ctx.font = `600 ${Math.round(h * 0.42)}px Inter`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w / 2, h / 2 + 1);
    const d = ctx.getImageData(0, 0, w, h);
    return { data: d.data, width: w, height: h };
  };

  const row = (labels, y, maxW = 300) => {
    const h = Math.round(64 * s) & ~1;
    const gap = Math.round(18 * s);
    const widths = labels.map((l) => Math.min(maxW * s, Math.max(120 * s, l.length * 22 * s + 60 * s)) & ~1);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (labels.length - 1);
    let x = Math.round((igWidth - total) / 2) & ~1;
    return labels.map((l, i) => { const r = { x, y: Math.round(y) & ~1, w: widths[i], h }; x += widths[i] + gap; return r; });
  };

  const grid = (count, cols, y0, w, h) => {
    const gap = Math.round(14 * s);
    const rowsW = Math.min(count, cols) * w + (Math.min(count, cols) - 1) * gap;
    const x0 = Math.round((igWidth - rowsW) / 2) & ~1;
    return Array.from({ length: count }, (_, i) => ({ x: x0 + (i % cols) * (w + gap), y: (Math.round(y0 + Math.floor(i / cols) * (h + gap)) & ~1), w, h }));
  };

  const linear = (ids, rects, wrapCols) => ids.map((id, i) => {
    const cols = wrapCols || ids.length;
    const left = i % cols === 0 ? ids[Math.min(ids.length - 1, i + cols - 1)] : ids[i - 1];
    const right = i % cols === cols - 1 || i === ids.length - 1 ? ids[i - (i % cols)] : ids[i + 1];
    const up = i - cols >= 0 ? ids[i - cols] : ids[i];
    const down = i + cols < ids.length ? ids[i + cols] : ids[i];
    return { id, rect: rects[i], left, right, up, down };
  });

  return {
    build(title, { commands, nAudio, nSubs }) {
      const pages = [];
      const barY = igHeight - 150 * s;
      const mainLabels = [L.play === 'Play' ? 'Restart' : L.play, L.scenes, L.audio, L.subtitles, L.main];
      const mainActs = [commands.restart, commands.page(1), commands.page(2), commands.page(3), commands.topMenu];
      const keep = [true, title.chapters.length > 1, nAudio > 1, nSubs > 0, true];
      const labels = mainLabels.filter((_, i) => keep[i]);
      const acts = mainActs.filter((_, i) => keep[i]);
      const rects = row(labels, barY);
      const ids = labels.map((_, i) => i + 1);
      pages.push({
        id: 0, defaultButton: 1,
        buttons: linear(ids, rects).map((b, i) => ({
          ...b, x: b.rect.x, y: b.rect.y, commands: acts[i],
          normal: drawBtn(b.rect.w, b.rect.h, labels[i], 'normal'), selected: drawBtn(b.rect.w, b.rect.h, labels[i], 'selected'), activated: drawBtn(b.rect.w, b.rect.h, labels[i], 'activated'),
        })),
      });
      const pickerPage = (pid, items) => {
        const cols = Math.min(10, items.length);
        const w = Math.round(items.some((x) => x.label.length > 4) ? 240 * s : 110 * s) & ~1;
        const h = Math.round(58 * s) & ~1;
        const rowsN = Math.ceil(items.length / cols);
        const rr = grid(items.length, cols, igHeight - (120 + rowsN * 72) * s, w, h);
        const pids = items.map((_, i) => i + 1);
        return {
          id: pid, defaultButton: 1,
          buttons: linear(pids, rr, cols).map((b, i) => ({
            ...b, x: b.rect.x, y: b.rect.y, commands: items[i].commands,
            normal: drawBtn(b.rect.w, b.rect.h, items[i].label, 'normal'), selected: drawBtn(b.rect.w, b.rect.h, items[i].label, 'selected'), activated: drawBtn(b.rect.w, b.rect.h, items[i].label, 'activated'),
          })),
        };
      };
      const chapters = title.chapters.slice(0, 40).map((_, i) => ({ label: String(i + 1), commands: commands.chapter(i) }));
      pages.push(pickerPage(1, chapters.length ? chapters : [{ label: '1', commands: commands.restart }]));
      const audio = (discPlan.audio.length ? discPlan.audio : [{ number: 1, lang: 'und' }]).slice(0, nAudio).map((a, i) => ({ label: langLabel(a.lang, i, 'Audio'), commands: commands.audio(a.number) }));
      pages.push(pickerPage(2, audio));
      const subs = [{ label: L.off, commands: commands.subtitle(0) }, ...discPlan.subtitles.slice(0, nSubs).map((x, i) => ({ label: langLabel(x.lang, i, 'Subtitle'), commands: commands.subtitle(x.number) }))];
      pages.push(pickerPage(3, subs));
      return pages;
    },
  };
}

module.exports = { makePopup };
