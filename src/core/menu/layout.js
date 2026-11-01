'use strict';
/**
 * Menu page layout. Produces a resolution independent description of every menu page
 * in a virtual 1920x1080 (16:9) or 1440x1080 (4:3) space. The same description drives
 * the designer preview, the DVD (spumux) menus and the Blu-ray (IG) menus.
 *
 * discPlan = {
 *   titles: [{ number, name, duration, chapters:[sec], chapterThumbs:[png], thumb, bonus }],
 *   audio: [{ number, label }], subtitles: [{ number, label }]
 * }
 */
const { THEMES } = require('./themes');

const LANG_NAMES = { eng: 'English', fre: 'Français', fra: 'Français', ger: 'Deutsch', deu: 'Deutsch', spa: 'Español', ita: 'Italiano', jpn: '日本語', chi: '中文', zho: '中文', por: 'Português', rus: 'Русский', kor: '한국어', dut: 'Nederlands', nld: 'Nederlands', swe: 'Svenska', pol: 'Polski', und: 'Track' };

function langLabel(lang, i, prefix) {
  const n = LANG_NAMES[lang];
  return n && lang !== 'und' ? n : `${prefix} ${i + 1}`;
}

function gridFor(count) {
  if (count <= 1) return [1, 1];
  if (count <= 2) return [2, 1];
  if (count <= 4) return [2, 2];
  if (count <= 6) return [3, 2];
  if (count <= 8) return [4, 2];
  if (count <= 9) return [3, 3];
  return [4, 3];
}

function fmtTime(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Compute up/down/left/right neighbours spatially (with wrap-around). */
function computeNavigation(buttons) {
  const c = (b) => ({ x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2 });
  const pick = (b, dir) => {
    const p = c(b);
    let best = null;
    let bestScore = Infinity;
    for (const o of buttons) {
      if (o === b) continue;
      const q = c(o);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      let primary;
      let secondary;
      if (dir === 'up') { primary = -dy; secondary = Math.abs(dx); } else if (dir === 'down') { primary = dy; secondary = Math.abs(dx); } else if (dir === 'left') { primary = -dx; secondary = Math.abs(dy); } else { primary = dx; secondary = Math.abs(dy); }
      if (primary <= 4) continue;
      const score = primary + secondary * 2.5;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    if (best) return best;
    // wrap: farthest in the opposite direction on the same row/column
    let wrap = b;
    let wrapScore = -Infinity;
    for (const o of buttons) {
      if (o === b) continue;
      const q = c(o);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      // only wrap along the same row (left/right) or column (up/down)
      if ((dir === 'left' || dir === 'right') && Math.abs(dy) > b.rect.h * 0.6) continue;
      if ((dir === 'up' || dir === 'down') && Math.abs(dx) > b.rect.w * 0.6) continue;
      let s;
      if (dir === 'up') s = dy - Math.abs(dx) * 3; else if (dir === 'down') s = -dy - Math.abs(dx) * 3; else if (dir === 'left') s = dx - Math.abs(dy) * 3; else s = -dx - Math.abs(dy) * 3;
      if (s > wrapScore) { wrapScore = s; wrap = o; }
    }
    return wrap;
  };
  for (const b of buttons) b.nav = { up: pick(b, 'up').key, down: pick(b, 'down').key, left: pick(b, 'left').key, right: pick(b, 'right').key };
  return buttons;
}

class PageBuilder {
  constructor(menu, theme, VW, VH) {
    this.menu = menu;
    this.theme = theme;
    this.VW = VW;
    this.VH = VH;
    this.pages = [];
  }

  textButtons(labels, style) {
    const { VW, VH } = this;
    const layout = this.theme.layout;
    const fs = Math.round(VH * 0.046);
    const h = Math.round(fs * 1.7);
    const out = [];
    if (layout === 'bottom') {
      const n = labels.length;
      const gap = VW * 0.02;
      const widths = labels.map((l) => Math.max(VW * 0.1, l.label.length * fs * 0.62 + fs * 1.2));
      const total = widths.reduce((a, b) => a + b, 0) + gap * (n - 1);
      let x = (VW - total) / 2;
      labels.forEach((l, i) => { out.push({ ...l, rect: { x, y: VH * 0.8, w: widths[i], h }, fontSize: fs, align: 'center' }); x += widths[i] + gap; });
      return out;
    }
    const x0 = layout === 'left' ? VW * 0.075 : layout === 'right' ? VW * 0.6 : VW * 0.3;
    const w = layout === 'center' ? VW * 0.4 : VW * 0.33;
    const spacing = h * 1.18;
    const y0 = layout === 'center' ? Math.max(VH * 0.42, VH * 0.62 - (labels.length * spacing) / 2) : VH * 0.42;
    labels.forEach((l, i) => out.push({ ...l, rect: { x: x0, y: y0 + i * spacing, w, h }, fontSize: fs, align: layout === 'center' ? 'center' : 'left' }));
    return out;
  }

  /** Thumbnail grid buttons for scenes / titles / bonus pages. */
  gridButtons(entries, perPage) {
    const { VW, VH } = this;
    const [cols, rows] = gridFor(perPage);
    const areaX = VW * 0.08;
    const areaW = VW * 0.84;
    const areaY = VH * 0.22;
    const areaH = VH * 0.58;
    const cellW = areaW / cols;
    const cellH = areaH / rows;
    const labelH = VH * 0.05;
    let tw = cellW * 0.86;
    let th = (tw * 9) / 16;
    if (th + labelH > cellH * 0.92) { th = cellH * 0.92 - labelH; tw = th * 16 / 9; }
    return entries.map((e, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = areaX + col * cellW + (cellW - tw) / 2;
      const y = areaY + row * cellH + (cellH - th - labelH) / 2;
      return { ...e, kind: 'thumb', rect: { x, y, w: tw, h: th + labelH }, thumbRect: { x, y, w: tw, h: th }, fontSize: Math.round(VH * 0.03), align: 'center' };
    });
  }

  textListButtons(entries) {
    const { VW, VH } = this;
    const fs = Math.round(VH * 0.036);
    const h = fs * 1.6;
    const perCol = 7;
    const cols = Math.ceil(entries.length / perCol);
    const colW = Math.min(VW * 0.4, (VW * 0.84) / Math.max(1, cols));
    return entries.map((e, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      return { ...e, kind: 'text', rect: { x: VW * 0.08 + col * colW, y: VH * 0.22 + row * h * 1.12, w: colW * 0.95, h }, fontSize: fs, align: 'left' };
    });
  }

  navRow(prev, next, backLabel, nextPage, prevPage, backPage) {
    const { VH } = this;
    const items = [];
    if (prev) items.push({ key: 'prev', label: this.menu.labels.previous, action: { type: 'page', page: prevPage }, nav: true });
    items.push({ key: 'back', label: backLabel, action: { type: 'page', page: backPage }, nav: true });
    if (next) items.push({ key: 'next', label: this.menu.labels.next, action: { type: 'page', page: nextPage }, nav: true });
    const fs = Math.round(VH * 0.034);
    const h = fs * 1.6;
    const w = this.VW * 0.16;
    const gap = this.VW * 0.02;
    const total = items.length * w + (items.length - 1) * gap;
    let x = (this.VW - total) / 2;
    return items.map((it) => { const r = { ...it, kind: 'text', rect: { x, y: VH * 0.86, w, h }, fontSize: fs, align: 'center' }; x += w + gap; return r; });
  }

  add(page) {
    page.index = this.pages.length;
    this.pages.push(page);
    return page;
  }
}

/**
 * Build all pages. Returns { pages, VW, VH, theme }.
 * Each page: { key, kind, index, heading, buttons: [{ key, label, sublabel, kind, rect, thumb, action, nav }] }
 * actions: { type:'play', title, chapter } | { type:'page', page } | { type:'audio', track } | { type:'subtitle', track } | { type:'playAll' }
 */
function buildMenuPages(project, discPlan) {
  const menu = project.menu;
  const theme = THEMES[menu.theme] || THEMES.aurora;
  const fourThree = project.format === 'dvd' && project.dvd.aspect === '4:3';
  const VW = fourThree ? 1440 : 1920;
  const VH = 1080;
  const pb = new PageBuilder(menu, theme, VW, VH);
  const L = menu.labels;
  const mains = discPlan.titles.filter((t) => !t.bonus);
  const bonus = discPlan.titles.filter((t) => t.bonus);
  const perPage = Math.max(1, Math.min(12, menu.itemsPerPage || 6));

  // Scenes entries: chapters of every main title
  const sceneEntries = [];
  mains.forEach((t, ti) => {
    if (menu.excludeFirstFromScenes && ti === 0 && mains.length > 1) return;
    t.chapters.forEach((sec, ci) => {
      sceneEntries.push({
        key: `scene_${t.number}_${ci}`,
        label: mains.length > 1 ? `${t.name} · ${ci + 1}` : `Scene ${ci + 1}`,
        sublabel: fmtTime(sec),
        thumb: t.chapterThumbs ? t.chapterThumbs[ci] : null,
        action: { type: 'play', title: t.number, chapter: ci },
      });
    });
  });
  const titleEntries = mains.map((t) => ({ key: `title_${t.number}`, label: t.name, sublabel: fmtTime(t.duration), thumb: t.thumb, action: { type: 'play', title: t.number, chapter: 0 } }));
  const bonusEntries = bonus.map((t) => ({ key: `bonus_${t.number}`, label: t.name, sublabel: fmtTime(t.duration), thumb: t.thumb, action: { type: 'play', title: t.number, chapter: 0 } }));

  const showAudio = menu.showAudioMenu === 'always' || (menu.showAudioMenu === 'auto' && discPlan.audio.length > 1);
  const showSubs = menu.showSubtitleMenu === 'always' || (menu.showSubtitleMenu === 'auto' && discPlan.subtitles.length > 0);
  const showScenes = sceneEntries.length > 1;
  const showTitles = mains.length > 1;
  const showBonus = bonusEntries.length > 0;

  const top = pb.add({ key: 'top', kind: 'top', heading: menu.title, buttons: [] });
  const topLabels = [];
  topLabels.push({ key: 'play', label: mains.length > 1 ? `${L.play}` : L.play, action: { type: mains.length > 1 && project.titleMode !== 'merge' ? 'playAll' : 'play', title: mains[0] ? mains[0].number : 1, chapter: 0 } });
  if (showTitles) topLabels.push({ key: 'titles', label: L.titles, action: { type: 'page', page: 'titles_0' } });
  if (showScenes) topLabels.push({ key: 'scenes', label: L.scenes, action: { type: 'page', page: 'scenes_0' } });
  if (showAudio) topLabels.push({ key: 'audio', label: L.audio, action: { type: 'page', page: 'audio' } });
  if (showSubs) topLabels.push({ key: 'subtitles', label: L.subtitles, action: { type: 'page', page: 'subtitles' } });
  if (showBonus) topLabels.push({ key: 'bonus', label: L.bonus, action: { type: 'page', page: 'bonus_0' } });
  top.buttons = pb.textButtons(topLabels).map((b) => ({ ...b, kind: 'text' }));

  const paged = (entries, keyPrefix, heading, display) => {
    const n = Math.max(1, Math.ceil(entries.length / perPage));
    for (let p = 0; p < n; p++) {
      const slice = entries.slice(p * perPage, (p + 1) * perPage);
      const page = pb.add({ key: `${keyPrefix}_${p}`, kind: keyPrefix, heading: n > 1 ? `${heading}  ${p + 1}/${n}` : heading, buttons: [] });
      const body = display === 'text' ? pb.textListButtons(slice) : pb.gridButtons(slice, perPage);
      page.buttons = [...body, ...pb.navRow(p > 0, p < n - 1, L.back, `${keyPrefix}_${p + 1}`, `${keyPrefix}_${p - 1}`, 'top')];
    }
  };
  if (showTitles) paged(titleEntries, 'titles', L.titles, menu.fileDisplay);
  if (showScenes) paged(sceneEntries, 'scenes', L.scenes, menu.sceneDisplay);
  if (showBonus) paged(bonusEntries, 'bonus', L.bonus, menu.bonusDisplay);
  if (showAudio) {
    const page = pb.add({ key: 'audio', kind: 'audio', heading: L.audio, buttons: [] });
    const entries = discPlan.audio.map((a, i) => ({ key: `audio_${a.number}`, label: a.label || langLabel(a.lang, i, 'Audio'), action: { type: 'audio', track: a.number } }));
    page.buttons = [...pb.textListButtons(entries), ...pb.navRow(false, false, L.back, null, null, 'top')];
  }
  if (showSubs) {
    const page = pb.add({ key: 'subtitles', kind: 'subtitles', heading: L.subtitles, buttons: [] });
    const entries = [{ key: 'sub_off', label: L.off, action: { type: 'subtitle', track: 0 } },
      ...discPlan.subtitles.map((s, i) => ({ key: `sub_${s.number}`, label: s.label || langLabel(s.lang, i, 'Subtitle'), action: { type: 'subtitle', track: s.number } }))];
    page.buttons = [...pb.textListButtons(entries), ...pb.navRow(false, false, L.back, null, null, 'top')];
  }

  // apply user position overrides (designer drags), 0..1000 units
  const pos = menu.positions || {};
  for (const page of pb.pages) {
    const o = pos[page.kind] || {};
    for (const b of page.buttons) {
      const key = b.key.replace(/_\d+$/, '');
      const ov = o[b.key] || o[key];
      if (ov && b.kind === 'text') { b.rect.x = (ov.x / 1000) * VW; b.rect.y = (ov.y / 1000) * VH; }
    }
    page.elements = (menu.elements || []).filter((e) => e.page === page.kind || e.page === 'all');
    computeNavigation(page.buttons);
    page.buttons.forEach((b, i) => { b.id = i + 1; });
  }
  // resolve page keys to indexes for actions
  const byKey = Object.fromEntries(pb.pages.map((p) => [p.key, p.index]));
  for (const page of pb.pages) {
    for (const b of page.buttons) {
      if (b.action.type === 'page') b.action.pageIndex = byKey[b.action.page] != null ? byKey[b.action.page] : 0;
      const ids = Object.fromEntries(page.buttons.map((x) => [x.key, x.id]));
      b.navIds = { up: ids[b.nav.up], down: ids[b.nav.down], left: ids[b.nav.left], right: ids[b.nav.right] };
    }
  }
  return { pages: pb.pages, VW, VH, theme, themeId: menu.theme };
}

module.exports = { buildMenuPages, computeNavigation, langLabel, fmtTime, LANG_NAMES };
