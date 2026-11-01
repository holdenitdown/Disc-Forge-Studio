'use strict';
/* global api */
/* DiscForge Studio — renderer */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const fmtGB = (b) => `${(b / 1e9).toFixed(b > 1e10 ? 0 : 1)} GB`;
const parseTime = (s) => { const p = String(s).trim().split(':').map(Number); return p.some(isNaN) ? NaN : p.reduce((a, v) => a * 60 + v, 0); };
const baseName = (f) => String(f).split(/[\\/]/).pop();

const ICON = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="5" width="14" height="14" rx="2"/><path d="m16.5 10 5-3v10l-5-3"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  sub: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 14h4M13 14h4M7 10.5h10"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  disc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  iso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h9l4 4v14H6z"/><circle cx="12" cy="14" r="3.5"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3s5 4.5 5 9.5a5 5 0 0 1-10 0C7 9 9 7 9 7s.5 3 2.5 3.5C11 7 12 3 12 3z"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 6h14M12 6v13"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>',
};

const LANGS = [['und', 'Undetermined'], ['eng', 'English'], ['fre', 'French'], ['ger', 'German'], ['spa', 'Spanish'], ['ita', 'Italian'], ['por', 'Portuguese'], ['dut', 'Dutch'], ['swe', 'Swedish'], ['pol', 'Polish'], ['rus', 'Russian'], ['jpn', 'Japanese'], ['chi', 'Chinese'], ['kor', 'Korean']];
const langOptions = (cur) => LANGS.map(([c, n]) => `<option value="${c}"${c === cur ? ' selected' : ''}>${n}</option>`).join('');

const S = {
  info: null,
  project: null,
  file: null,
  dirty: false,
  view: 'media',
  selected: null,
  thumbs: new Map(),
  toolsStatus: null,
  preview: { page: 'top', sel: 1, data: null, busy: false, selEl: null },
  themeThumbs: new Map(),
  burners: [],
  estimate: null,
  running: false,
};

/* ================================================================ boot */
(async function init() {
  S.info = await api.info();
  S.project = clone(S.info.defaults);
  if (S.info.settings.outputFolder) S.project.output.folder = S.info.settings.outputFolder;
  bindChrome();
  renderAll();
  S.toolsStatus = await api.tools.status();
  const missing = Object.entries(S.toolsStatus.catalog).filter(([id, t]) => t.required && !S.toolsStatus.tools[id]);
  if (missing.length) openSettings('tools');
  api.author.onProgress(onProgress);
  api.author.onLog(onLog);
  api.author.onDone(onDone);
  api.author.onFailed(onFailed);
  api.author.onShutdown(onShutdown);
})();

function markDirty() { S.dirty = true; refreshEstimate(); }

function bindChrome() {
  $('#projectName').addEventListener('input', (e) => { S.project.name = e.target.value; markDirty(); });
  $('#formatSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.project.format = b.dataset.fmt;
    markDirty();
    renderAll();
  });
  $('#rail').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.action === 'settings') return openSettings();
    S.view = b.dataset.view;
    renderAll();
  });
  $('#btnNew').onclick = async () => {
    if (S.dirty && !confirm('Discard changes to the current project?')) return;
    S.project = clone(S.info.defaults);
    S.project.output.folder = S.info.settings.outputFolder || '';
    S.file = null; S.dirty = false; S.selected = null;
    renderAll();
  };
  $('#btnOpen').onclick = openProject;
  $('#btnSave').onclick = () => saveProject();
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); }
    if (S.view === 'menu' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) menuKey(e);
    if (e.key === 'Delete' && S.view === 'menu' && S.preview.selEl && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      S.project.menu.elements = S.project.menu.elements.filter((x) => x.id !== S.preview.selEl);
      S.preview.selEl = null; markDirty(); renderMenu(); requestPreview();
    }
  });
  // drag & drop from Explorer
  const main = $('#main');
  main.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); $('#app').classList.add('dragover'); } });
  main.addEventListener('dragleave', (e) => { if (e.target === main || !main.contains(e.relatedTarget)) $('#app').classList.remove('dragover'); });
  main.addEventListener('drop', async (e) => {
    $('#app').classList.remove('dragover');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    await addFiles(files);
  });
}

async function openProject() {
  const r = await api.project.open();
  if (!r) return;
  if (r.error) return alert(r.error);
  S.project = r.project; S.file = r.file; S.dirty = false; S.selected = null;
  renderAll();
  toast('Project opened');
}

async function saveProject(as) {
  const f = await api.project.save(S.project, as ? null : S.file);
  if (f) { S.file = f; S.dirty = false; toast('Project saved'); }
}

function toast(msg, ms = 2200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function renderAll() {
  $('#projectName').value = S.project.name;
  $$('#formatSwitch button').forEach((b) => b.classList.toggle('on', b.dataset.fmt === S.project.format));
  $$('#rail button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${S.view}`));
  if (S.view === 'media') renderMedia();
  if (S.view === 'menu') { renderMenu(); requestPreview(); }
  if (S.view === 'create') renderCreate();
  if (S.view !== 'media') closeDrawer();
  refreshEstimate();
}

/* ================================================================ media */
async function addFiles(files) {
  const infos = await api.media.probe(files);
  const videos = [], images = [], audios = [], subs = [];
  for (const i of infos) {
    if (i.error) { toast(`Failed to add the file: ${baseName(i.file)}`); continue; }
    if (i.kind === 'image') images.push(i.file);
    else if (i.kind === 'audio') audios.push(i);
    else if (i.kind === 'subtitle') subs.push(i.file);
    else if (i.video) videos.push(i);
  }
  if (!S.project.items.length && videos[0] && videos[0].video) {
    // match DVD settings to the first video (PAL for 25/50 fps, 4:3 for narrow sources)
    const fv = videos[0].video;
    S.project.dvd.standard = Math.abs(fv.fps - 25) < 0.5 || Math.abs(fv.fps - 50) < 0.5 ? 'pal' : 'ntsc';
    S.project.dvd.aspect = fv.dar && fv.dar < 1.5 ? '4:3' : '16:9';
  }
  for (const v of videos) {
    const item = await api.items.create('video', v);
    if (S.project.format === 'dvd') item.audioTracks.forEach((a, n) => { a.enabled = n < 8; });
    S.project.items.push(item);
    if (S.project.items.length === 1 && S.project.menu.title === 'My Disc') S.project.menu.title = item.title;
  }
  if (images.length) S.project.items.push(await api.items.create('slideshow', images));
  if (audios.length) S.project.items.push(await api.items.create('music', audios));
  if (subs.length) {
    const target = S.project.items.find((i) => i.id === S.selected && i.type === 'video') || S.project.items.find((i) => i.type === 'video');
    if (target) subs.forEach((f) => target.subtitles.push({ source: 'external', file: f, lang: guessLang(f), enabled: true, codec: /\.sup$/i.test(f) ? 'hdmv_pgs_subtitle' : 'subrip' }));
    else toast('Add a video before adding subtitles.');
  }
  markDirty();
  renderMedia();
}

function guessLang(f) {
  const m = /[._-](en|eng|fr|fre|fra|de|ger|deu|es|spa|it|ita|ja|jpn|pt|por|nl|dut)[._-]/i.exec(baseName(f));
  if (!m) return 'und';
  const map = { en: 'eng', fr: 'fre', fra: 'fre', de: 'ger', deu: 'ger', es: 'spa', it: 'ita', ja: 'jpn', pt: 'por', nl: 'dut' };
  const k = m[1].toLowerCase();
  return map[k] || k;
}

async function pick(kind) {
  const filters = {
    video: [{ name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'avi', 'm2ts', 'mts', 'ts', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'vob', 'flv', '3gp', 'mxf'] }, { name: 'All Files', extensions: ['*'] }],
    image: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'tif', 'tiff'] }],
    audio: [{ name: 'Audio files', extensions: ['mp3', 'aac', 'ac3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'ape', 'dts', 'mka'] }],
    subtitle: [{ name: 'Subtitles', extensions: ['srt', 'ass', 'ssa', 'sup', 'vtt'] }],
  }[kind];
  return api.dialog.open({ properties: ['openFile', 'multiSelections'], filters });
}

function itemThumbKey(it) {
  if (it.type === 'video') return [it.file, it.thumbnailAt || 0, it.info.video && it.info.video.hdr !== 'sdr'];
  if (it.type === 'slideshow' && it.slideshow.images[0]) return [it.slideshow.images[0].file, 0, false];
  if (it.type === 'music' && it.music.cover) return [it.music.cover, 0, false];
  return null;
}

function loadThumb(key, el) {
  if (!key) return;
  const k = key.join('|');
  if (S.thumbs.has(k)) { el.style.backgroundImage = `url("${S.thumbs.get(k)}")`; return; }
  api.media.thumb(...key).then((url) => { if (url) { S.thumbs.set(k, url); el.style.backgroundImage = `url("${url}")`; } });
}

function itemFacts(it) {
  const chips = [];
  const P = S.project;
  if (it.type === 'video') {
    const v = it.info.video || {};
    chips.push(`<span class="chip">${v.width}×${v.height}${v.interlaced ? 'i' : 'p'}</span>`, `<span class="chip">${v.fps} fps</span>`, `<span class="chip">${(v.codec || '').toUpperCase()}</span>`);
    if (v.hdr && v.hdr !== 'sdr') chips.push(`<span class="chip hdr">${v.dolbyVision ? 'Dolby Vision' : v.hdr.toUpperCase()}</span>`);
    const na = it.audioTracks.filter((a) => a.enabled).length;
    chips.push(`<span class="chip">${na} audio</span>`);
    const ns = it.subtitles.filter((s) => s.enabled).length;
    if (ns) chips.push(`<span class="chip">${ns} subtitle${ns > 1 ? 's' : ''}</span>`);
    if (P.format !== 'dvd' && P.processing === 'passthrough') chips.push(`<span class="chip ${passthroughOk(it) ? 'ok' : 'warn'}">${passthroughOk(it) ? 'passthrough' : 'will re-encode'}</span>`);
  } else if (it.type === 'slideshow') {
    chips.push(`<span class="chip kind">Slideshow</span>`, `<span class="chip">${it.slideshow.images.length} pictures</span>`, `<span class="chip">${esc(it.slideshow.transition)}</span>`);
    if (it.slideshow.music.length) chips.push(`<span class="chip">${it.slideshow.music.length} music</span>`);
  } else {
    chips.push(`<span class="chip kind">Music album</span>`, `<span class="chip">${it.music.tracks.length} tracks</span>`);
  }
  const nch = chapterCount(it);
  if (nch > 1) chips.push(`<span class="chip">${nch} chapters</span>`);
  if (it.trim && (it.trim.start || it.trim.end != null)) chips.push('<span class="chip">trimmed</span>');
  return chips.join('');
}

function passthroughOk(it) {
  const v = it.info && it.info.video;
  if (!v) return false;
  if (S.project.format === 'uhd') return v.codec === 'hevc' && v.width <= 3840 && [23.976, 24, 25, 50, 59.94].includes(v.fps);
  return ['h264', 'vc1'].includes(v.codec) && ((v.width === 1920 && v.height === 1080) || (v.width === 1280 && v.height === 720)) && (v.interlaced ? [25, 29.97] : v.height === 720 ? [23.976, 24, 50, 59.94] : [23.976, 24]).includes(v.fps);
}

function itemDuration(it) {
  if (it.type === 'video') { const d = it.info.duration || 0; const e = it.trim.end != null ? Math.min(it.trim.end, d) : d; return Math.max(0, e - (it.trim.start || 0)); }
  if (it.type === 'slideshow') { const ss = it.slideshow; return ss.images.reduce((a, im) => a + (im.duration || ss.slideDuration), 0) - Math.max(0, ss.images.length - 1) * (ss.transition === 'none' ? 0 : ss.transitionDuration); }
  return it.music.tracks.reduce((a, t) => a + Math.max(0, (t.end != null ? Math.min(t.end, t.info.duration) : t.info.duration) - (t.start || 0)), 0);
}

function chapterCount(it) {
  const d = itemDuration(it);
  const c = it.chapters || {};
  if (it.type === 'music') return it.music.tracks.length;
  if (c.mode === 'interval' && c.interval > 0) return Math.max(1, Math.ceil((d - 1) / c.interval));
  if (c.mode === 'custom') return (c.list || []).length || 1;
  return 1;
}

function renderMedia() {
  const v = $('#view-media');
  const items = S.project.items;
  const toolbar = `<div class="toolbar">
    <h2>Media</h2>
    <button class="btn" data-add="video">${ICON.video}Add Video</button>
    <button class="btn" data-add="image">${ICON.photo}Add Slideshow</button>
    <button class="btn" data-add="audio">${ICON.music}Add Music</button>
    <button class="btn" data-add="subtitle" ${items.some((i) => i.type === 'video') ? '' : 'disabled'}>${ICON.sub}Add Subtitle</button>
    <div style="flex:1"></div>
    ${items.length ? `<button class="btn ghost danger" data-act="clear">${ICON.trash}Delete All</button><button class="btn primary" data-goto="menu">Next: Menu →</button>` : ''}
  </div>`;
  let body;
  if (!items.length) {
    body = `<div class="media-list"><div class="dropzone">
      <div class="big-icon">${ICON.disc}</div>
      <h3>Drop videos, pictures or music here</h3>
      <div>Videos become titles, pictures become a slideshow, music becomes an album with its own chapters.</div>
      <div class="row" style="flex:none;gap:8px;margin-top:6px"><button class="btn primary" data-add="video">${ICON.video}Add Video</button><button class="btn" data-add="image">${ICON.photo}Add Pictures</button><button class="btn" data-add="audio">${ICON.music}Add Music</button></div>
    </div></div>`;
  } else {
    const card = (it) => `<div class="item ${S.selected === it.id ? 'selected' : ''}" draggable="true" data-id="${it.id}">
        <div class="grip">${ICON.grip}</div>
        <div class="thumb" data-thumb="${it.id}"><span class="dur">${fmtDur(itemDuration(it))}</span></div>
        <div class="meta">
          <input class="title-input" data-title="${it.id}" value="${esc(it.title)}" spellcheck="false">
          <div class="facts">${itemFacts(it)}</div>
        </div>
        <div class="actions">
          <label class="toggle" title="Show in the Bonus menu"><input type="checkbox" data-bonus="${it.id}" ${it.bonus ? 'checked' : ''}><span class="sw"></span>Bonus</label>
          <button class="icon-btn" data-move="up" data-id="${it.id}" title="Move up">${ICON.up}</button>
          <button class="icon-btn" data-move="down" data-id="${it.id}" title="Move down">${ICON.down}</button>
          <button class="icon-btn" data-edit="${it.id}" title="Edit">${ICON.edit}</button>
          <button class="icon-btn" data-del="${it.id}" title="Delete">${ICON.trash}</button>
        </div>
      </div>`;
    const mains = items.filter((i) => !i.bonus);
    const bonus = items.filter((i) => i.bonus);
    body = `<div class="media-list" id="mediaList">
      <div class="section-label">Titles · ${mains.length} ${S.project.titleMode === 'merge' && mains.length > 1 ? '(merged into one title)' : ''}</div>
      ${mains.map(card).join('') || '<div class="empty-note">Mark at least one item as a main title.</div>'}
      ${bonus.length ? `<div class="section-label">Bonus · ${bonus.length}</div>${bonus.map(card).join('')}` : ''}
    </div>`;
  }
  v.innerHTML = `<div class="media-layout">${toolbar}${body}</div>`;
  $$('[data-thumb]', v).forEach((el) => { const it = items.find((i) => i.id === el.dataset.thumb); loadThumb(itemThumbKey(it), el); });
  v.onclick = async (e) => {
    const t = e.target.closest('button, .item');
    if (!t) return;
    if (t.dataset.add) {
      const files = await pick(t.dataset.add);
      if (files.length) await addFiles(files);
      return;
    }
    if (t.dataset.goto) { S.view = t.dataset.goto; return renderAll(); }
    if (t.dataset.act === 'clear') { if (confirm('Delete all media items?')) { S.project.items = []; markDirty(); renderMedia(); } return; }
    if (t.dataset.del) { S.project.items = S.project.items.filter((i) => i.id !== t.dataset.del); if (S.selected === t.dataset.del) closeDrawer(); markDirty(); renderMedia(); return; }
    if (t.dataset.move) {
      const arr = S.project.items;
      const i = arr.findIndex((x) => x.id === t.dataset.id);
      const j = t.dataset.move === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]]; markDirty(); renderMedia(); }
      return;
    }
    if (t.dataset.edit) { openEditor(t.dataset.edit); return; }
    if (t.classList.contains('item') && !e.target.closest('input,label')) { S.selected = t.dataset.id; renderMedia(); }
  };
  v.oninput = (e) => {
    if (e.target.dataset.title) { const it = S.project.items.find((i) => i.id === e.target.dataset.title); it.title = e.target.value; S.dirty = true; }
  };
  v.onchange = (e) => {
    if (e.target.dataset.bonus) { const it = S.project.items.find((i) => i.id === e.target.dataset.bonus); it.bonus = e.target.checked; markDirty(); renderMedia(); }
  };
  // reorder by drag
  let dragId = null;
  $$('.item', v).forEach((el) => {
    el.addEventListener('dragstart', (e) => { dragId = el.dataset.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      if (!dragId || dragId === el.dataset.id) return;
      e.preventDefault(); e.stopPropagation();
      const arr = S.project.items;
      const from = arr.findIndex((x) => x.id === dragId);
      const [m] = arr.splice(from, 1);
      const to = arr.findIndex((x) => x.id === el.dataset.id);
      arr.splice(to, 0, m);
      m.bonus = arr[to + 1] ? arr[to + 1].bonus : m.bonus;
      dragId = null; markDirty(); renderMedia();
    });
  });
}

/* ================================================================ editor drawer */
function closeDrawer() { $('#drawer').classList.remove('open'); }

function openEditor(id) {
  S.selected = id;
  const it = S.project.items.find((i) => i.id === id);
  const d = $('#drawer');
  const kindLabel = { video: 'Video', slideshow: 'Slideshow', music: 'Music Album' }[it.type];
  d.innerHTML = `<header><h3>${kindLabel} Settings</h3><button class="icon-btn" id="drawerClose">${ICON.close}</button></header><div class="body" id="drawerBody"></div>`;
  $('#drawerClose').onclick = () => { closeDrawer(); renderMedia(); };
  ({ video: editVideo, slideshow: editSlideshow, music: editMusic })[it.type](it, $('#drawerBody'));
  d.classList.add('open');
  renderMedia();
}

function chapterEditor(it) {
  const c = it.chapters;
  return `<div class="field"><label>Chapters</label>
    <select class="input" data-k="chapters.mode">
      <option value="none"${c.mode === 'none' ? ' selected' : ''}>No chapters</option>
      <option value="interval"${c.mode === 'interval' ? ' selected' : ''}>Add a chapter every…</option>
      <option value="custom"${c.mode === 'custom' ? ' selected' : ''}>Custom chapter list${it.info && it.info.chapters && it.info.chapters.length > 1 ? ' (from file)' : ''}</option>
    </select></div>
    ${c.mode === 'interval' ? `<div class="field"><label>Interval (minutes)</label><input class="input" type="number" min="0.1" step="0.5" data-k="chapters.interval" data-scale="60" value="${(c.interval / 60).toFixed(1)}"></div>` : ''}
    ${c.mode === 'custom' ? `<div class="field"><label>Chapter start times (hh:mm:ss, one per line)</label><textarea class="input" rows="5" data-k="chapters.list" data-list="1">${(c.list || []).map((t) => fmtDur(t)).join('\n')}</textarea></div>` : ''}`;
}

function bindEditor(root, it, rerender) {
  root.oninput = root.onchange = (e) => {
    const el = e.target;
    const k = el.dataset.k;
    if (!k) return;
    let val = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || el.type === 'range') val = Number(val) * (Number(el.dataset.scale) || 1);
    if (el.dataset.time) { const t = el.value.trim() === '' ? null : parseTime(el.value); if (Number.isNaN(t)) return; val = t; }
    if (el.dataset.list) val = el.value.split(/\n|,/).map((x) => parseTime(x)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    setPath(it, k, val);
    markDirty();
    if (e.type === 'change' && el.tagName === 'SELECT') rerender();
    const card = $(`.item[data-id="${it.id}"] .facts`);
    if (card) card.innerHTML = itemFacts(it);
  };
}

function setPath(obj, keyPath, val) {
  const keys = keyPath.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = val;
}

function editVideo(it, root) {
  const info = it.info;
  const v = info.video || {};
  const fmtDvd = S.project.format === 'dvd';
  const render = () => {
    const enabledAudio = it.audioTracks.filter((a) => a.enabled).length;
    root.innerHTML = `
      <div class="field"><label>Title</label><input class="input" data-k="title" value="${esc(it.title)}"></div>
      <div class="hint" style="margin-top:-6px">${esc(info.name)} · ${v.width}×${v.height} · ${v.fps} fps · ${fmtDur(info.duration)}${v.hdr !== 'sdr' ? ` · ${v.hdr.toUpperCase()}` : ''}</div>
      <div class="row field">
        <div><label class="field-label">Start time</label><input class="input" data-k="trim.start" data-time="1" value="${fmtDur(it.trim.start || 0)}"></div>
        <div><label class="field-label">End time</label><input class="input" data-k="trim.end" data-time="1" placeholder="${fmtDur(info.duration)}" value="${it.trim.end != null ? fmtDur(it.trim.end) : ''}"></div>
      </div>
      <div class="field"><label>Menu thumbnail at (seconds)</label><input class="input" type="number" min="0" data-k="thumbnailAt" value="${it.thumbnailAt || 0}"></div>
      ${chapterEditor(it)}
      <div class="field"><label>Volume ${it.volume || 100}%</label><input type="range" min="0" max="200" step="5" data-k="volume" value="${it.volume || 100}"></div>
      <div class="field-label" style="margin-top:18px">Audio tracks${fmtDvd && enabledAudio > 8 ? ' <span class="chip warn">DVD supports a maximum of 8 audio tracks</span>' : ''}</div>
      ${it.audioTracks.map((a, i) => { const s = info.audio.find((x) => x.index === a.index) || {}; return `<div class="track">
        <label class="toggle"><input type="checkbox" data-k="audioTracks.${i}.enabled" ${a.enabled ? 'checked' : ''}><span class="sw"></span></label>
        <div><div class="name">${esc(a.title || `Track ${i + 1}`)}</div><div class="sub">${esc((s.codec || '').toUpperCase())} · ${s.channels || 2}ch · ${s.sampleRate ? `${s.sampleRate / 1000} kHz` : ''}</div></div>
        <select class="input" data-k="audioTracks.${i}.lang">${langOptions(a.lang)}</select></div>`; }).join('') || '<div class="empty-note">No audio tracks — silence will be used.</div>'}
      <div class="row" style="margin-top:18px"><div class="field-label" style="margin:0">Subtitles</div><button class="btn" style="flex:none" id="addSub">${ICON.plus}Add External Subtitle</button></div>
      <div style="margin-top:8px">${it.subtitles.map((s, i) => `<div class="track">
        <label class="toggle"><input type="checkbox" data-k="subtitles.${i}.enabled" ${s.enabled ? 'checked' : ''}><span class="sw"></span></label>
        <div><div class="name">${esc(s.source === 'external' ? baseName(s.file) : `Embedded #${i + 1}`)}</div><div class="sub">${esc(s.codec === 'hdmv_pgs_subtitle' ? 'PGS (bitmap)' : 'Text')}${fmtDvd && s.codec === 'hdmv_pgs_subtitle' ? ' · not available on DVD' : ''}</div></div>
        <select class="input" data-k="subtitles.${i}.lang">${langOptions(s.lang)}</select></div>`).join('') || '<div class="empty-note">No subtitles.</div>'}</div>`;
    $('#addSub', root).onclick = async () => {
      const files = await pick('subtitle');
      files.forEach((f) => it.subtitles.push({ source: 'external', file: f, lang: guessLang(f), enabled: true, codec: /\.sup$/i.test(f) ? 'hdmv_pgs_subtitle' : 'subrip' }));
      markDirty(); render();
    };
  };
  bindEditor(root, it, render);
  render();
}

function editSlideshow(it, root) {
  const ss = it.slideshow;
  const render = () => {
    root.innerHTML = `
      <div class="field"><label>Title</label><input class="input" data-k="title" value="${esc(it.title)}"></div>
      <div class="row" style="margin-top:14px"><div class="field-label" style="margin:0">${ss.images.length} pictures</div><button class="btn" style="flex:none" id="addPics">${ICON.plus}Add Pictures</button></div>
      <div class="thumbs-grid" style="margin-top:8px">${ss.images.map((im, i) => `<div class="t" draggable="true" data-i="${i}" title="${esc(baseName(im.file))}"><button data-rm="${i}">×</button></div>`).join('')}</div>
      <div class="row field">
        <div><label class="field-label">Slide duration (s)</label><input class="input" type="number" min="1" step="0.5" data-k="slideshow.slideDuration" value="${ss.slideDuration}"></div>
        <div><label class="field-label">Transition (s)</label><input class="input" type="number" min="0.2" step="0.1" data-k="slideshow.transitionDuration" value="${ss.transitionDuration}"></div>
      </div>
      <div class="field"><label>Transition effect</label><select class="input" data-k="slideshow.transition">${S.info.transitions.map((t) => `<option${t === ss.transition ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label class="toggle"><input type="checkbox" data-k="slideshow.kenBurns" ${ss.kenBurns ? 'checked' : ''}><span class="sw"></span>Gentle zoom motion (Ken Burns)</label></div>
      <div class="row" style="margin-top:18px"><div class="field-label" style="margin:0">Background music</div><button class="btn" style="flex:none" id="addMusic">${ICON.plus}Add Music</button></div>
      <div style="margin-top:8px">${ss.music.map((m, i) => `<div class="track" style="grid-template-columns:1fr auto"><div class="name">${esc(baseName(m.file))}</div><button class="icon-btn" data-rmm="${i}">${ICON.trash}</button></div>`).join('') || '<div class="empty-note">No music.</div>'}</div>
      <div class="field"><label>Music volume ${ss.musicVolume}%</label><input type="range" min="0" max="150" data-k="slideshow.musicVolume" value="${ss.musicVolume}"></div>
      <div class="row field">
        <label class="toggle"><input type="checkbox" data-k="slideshow.fadeIn" ${ss.fadeIn ? 'checked' : ''}><span class="sw"></span>Fade in</label>
        <label class="toggle"><input type="checkbox" data-k="slideshow.fadeOut" ${ss.fadeOut ? 'checked' : ''}><span class="sw"></span>Fade out</label>
        <label class="toggle"><input type="checkbox" data-k="slideshow.loopMusic" ${ss.loopMusic ? 'checked' : ''}><span class="sw"></span>Loop</label>
      </div>
      ${chapterEditor(it)}`;
    $$('.thumbs-grid .t', root).forEach((el) => loadThumb([ss.images[Number(el.dataset.i)].file, 0, false], el));
    $('#addPics', root).onclick = async () => { const f = await pick('image'); f.forEach((x) => ss.images.push({ file: x, duration: null })); markDirty(); render(); };
    $('#addMusic', root).onclick = async () => { const f = await pick('audio'); f.forEach((x) => ss.music.push({ file: x })); markDirty(); render(); };
    root.onclick = (e) => {
      if (e.target.dataset.rm) { ss.images.splice(Number(e.target.dataset.rm), 1); markDirty(); render(); }
      const rmm = e.target.closest('[data-rmm]');
      if (rmm) { ss.music.splice(Number(rmm.dataset.rmm), 1); markDirty(); render(); }
    };
    let from = null;
    $$('.thumbs-grid .t', root).forEach((el) => {
      el.ondragstart = () => { from = Number(el.dataset.i); };
      el.ondragover = (e) => e.preventDefault();
      el.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); const to = Number(el.dataset.i); if (from == null || from === to) return; const [m] = ss.images.splice(from, 1); ss.images.splice(to, 0, m); from = null; markDirty(); render(); };
    });
  };
  bindEditor(root, it, render);
  render();
}

function editMusic(it, root) {
  const mu = it.music;
  const render = () => {
    root.innerHTML = `
      <div class="field"><label>Album title</label><input class="input" data-k="title" value="${esc(it.title)}"></div>
      <div class="field"><label>Cover image</label><div class="file-pick"><div class="fname">${mu.cover ? esc(baseName(mu.cover)) : 'None — a gradient background is used'}</div><button class="btn" id="pickCover">Browse…</button>${mu.cover ? '<button class="btn ghost" id="clearCover">Clear</button>' : ''}</div></div>
      <div class="field"><label>Display</label><select class="input" data-k="music.display">
        <option value="half"${mu.display === 'half' ? ' selected' : ''}>Half-screen cover with titles</option>
        <option value="full"${mu.display === 'full' ? ' selected' : ''}>Full-screen cover</option>
        <option value="none"${mu.display === 'none' ? ' selected' : ''}>Titles only</option></select></div>
      <div class="field"><label class="toggle"><input type="checkbox" data-k="music.visualizer" ${mu.visualizer ? 'checked' : ''}><span class="sw"></span>Animated audio waveform</label></div>
      <div class="field-label" style="margin-top:16px">Tracks (each becomes a chapter)</div>
      ${mu.tracks.map((t, i) => `<div class="track" style="grid-template-columns:1fr 84px 84px auto">
        <input class="input" data-k="music.tracks.${i}.title" value="${esc(t.title)}">
        <input class="input" data-k="music.tracks.${i}.start" data-time="1" value="${fmtDur(t.start || 0)}" title="Start">
        <input class="input" data-k="music.tracks.${i}.end" data-time="1" placeholder="${fmtDur(t.info.duration)}" value="${t.end != null ? fmtDur(t.end) : ''}" title="End">
        <button class="icon-btn" data-rmt="${i}">${ICON.trash}</button></div>`).join('')}
      <button class="btn" id="addTracks" style="margin-top:6px">${ICON.plus}Add Tracks</button>`;
    $('#pickCover', root).onclick = async () => { const f = await pick('image'); if (f[0]) { mu.cover = f[0]; markDirty(); render(); renderMedia(); } };
    const cc = $('#clearCover', root); if (cc) cc.onclick = () => { mu.cover = null; markDirty(); render(); renderMedia(); };
    $('#addTracks', root).onclick = async () => {
      const f = await pick('audio');
      const infos = await api.media.probe(f);
      infos.filter((x) => !x.error).forEach((i) => mu.tracks.push({ file: i.file, info: i, title: i.title || i.name.replace(/\.[^.]+$/, ''), start: 0, end: null, volume: 100 }));
      markDirty(); render();
    };
    root.onclick = (e) => { const b = e.target.closest('[data-rmt]'); if (b) { mu.tracks.splice(Number(b.dataset.rmt), 1); markDirty(); render(); } };
  };
  bindEditor(root, it, render);
  render();
}

/* ================================================================ menu designer */
const requestPreview = debounce(async () => {
  if (S.view !== 'menu') return;
  S.preview.busy = true;
  const busy = $('#stageBusy'); if (busy) busy.style.display = '';
  try {
    const data = await api.menu.preview(S.project, S.preview.page, S.preview.sel, 1280);
    S.preview.data = data;
    if (!data.pages.find((p) => p.key === S.preview.page)) S.preview.page = data.current;
    renderStage();
  } finally {
    S.preview.busy = false;
    const b2 = $('#stageBusy'); if (b2) b2.style.display = 'none';
  }
}, 180);

function renderMenu() {
  const m = S.project.menu;
  const fmt = S.project.format;
  const v = $('#view-menu');
  const sel = (k, opts, cur) => `<select class="input" data-m="${k}">${opts.map(([val, lab]) => `<option value="${val}"${String(val) === String(cur) ? ' selected' : ''}>${lab}</option>`).join('')}</select>`;
  v.innerHTML = `<div class="menu-layout">
    <div class="menu-side">
      <div class="field" style="margin-top:16px"><label class="toggle"><input type="checkbox" data-m="enabled" ${m.enabled ? 'checked' : ''}><span class="sw"></span>Create disc menus</label></div>
      <details class="group" open><summary>Theme</summary><div class="theme-grid">${S.info.themes.map((t) => `<div class="theme-card ${t.id === m.theme ? 'on' : ''}" data-theme="${t.id}"><img data-tthumb="${t.id}" alt=""><span>${esc(t.name)}</span></div>`).join('')}</div></details>
      <details class="group" open><summary>Title & text</summary>
        <div class="field"><label>Disc title (# starts a new line)</label><input class="input" data-m="title" value="${esc(m.title)}"></div>
        <div class="grid2">${['play', 'scenes', 'titles', 'audio', 'subtitles', 'bonus', 'back', 'next'].map((k) => `<div class="field"><label>${k[0].toUpperCase() + k.slice(1)} button</label><input class="input" data-m="labels.${k}" value="${esc(m.labels[k])}"></div>`).join('')}</div>
        <div class="row"><button class="btn" id="addText">${ICON.text}Add Text</button><button class="btn" id="addImage">${ICON.photo}Add Image</button></div>
      </details>
      <details class="group"><summary>Highlight</summary>
        <div class="row field"><div>${sel('highlight.style', [['box', 'Box'], ['pill', 'Filled pill'], ['underline', 'Underline'], ['arrow', 'Arrow']], m.highlight.style)}</div><input type="color" data-m="highlight.color" value="${m.highlight.color}" style="flex:none"></div>
      </details>
      <details class="group"><summary>Background & music</summary>
        <div class="field"><label>Background</label>${sel('background.type', [['theme', 'Theme artwork'], ['image', 'Custom image'], ['video', 'Custom video (motion menu)']], m.background.type)}</div>
        ${m.background.type !== 'theme' ? `<div class="field file-pick"><div class="fname">${m.background.file ? esc(baseName(m.background.file)) : 'No file selected'}</div><button class="btn" id="pickBg">Browse…</button></div>` : ''}
        ${m.background.type === 'video' ? `<div class="row field"><div><label class="field-label">Start (s)</label><input class="input" type="number" min="0" data-m="background.start" value="${m.background.start || 0}"></div><div><label class="field-label">Max duration (s)</label><input class="input" type="number" min="5" max="600" data-m="background.maxDuration" value="${m.background.maxDuration || 60}"></div></div>` : ''}
        <div class="field"><label>Background music</label><div class="file-pick"><div class="fname">${m.music.file ? esc(baseName(m.music.file)) : 'None'}</div><button class="btn" id="pickMusic">Browse…</button>${m.music.file ? '<button class="btn ghost" id="clearMusic">Clear</button>' : ''}</div></div>
        ${m.music.file ? `<div class="field"><label>Volume ${m.music.volume}%</label><input type="range" min="0" max="150" data-m="music.volume" value="${m.music.volume}"></div>
        <div class="row field"><label class="toggle"><input type="checkbox" data-m="music.fadeIn" ${m.music.fadeIn ? 'checked' : ''}><span class="sw"></span>Fade in</label><label class="toggle"><input type="checkbox" data-m="music.fadeOut" ${m.music.fadeOut ? 'checked' : ''}><span class="sw"></span>Fade out</label></div>
        <div class="field"><label>Menu loop length (s)</label><input class="input" type="number" min="5" max="600" data-m="background.maxDuration" value="${m.background.maxDuration || 60}"></div>` : ''}
      </details>
      <details class="group"><summary>Pages & buttons</summary>
        <div class="field"><label>Scenes menu</label>${sel('sceneDisplay', [['icon', 'Chapter thumbnails'], ['text', 'Chapter list (text)']], m.sceneDisplay)}</div>
        <div class="field"><label>Titles menu</label>${sel('fileDisplay', [['icon', 'Title thumbnails'], ['text', 'Title list (text)']], m.fileDisplay)}</div>
        <div class="field"><label>Bonus menu</label>${sel('bonusDisplay', [['icon', 'Thumbnails'], ['text', 'Text list']], m.bonusDisplay)}</div>
        <div class="field"><label>Items per page</label>${sel('itemsPerPage', [[4, '4'], [6, '6'], [8, '8'], [9, '9'], [12, '12']], m.itemsPerPage)}</div>
        <div class="field"><label>Audio menu</label>${sel('showAudioMenu', [['auto', 'When there are several audio tracks'], ['always', 'Always'], ['never', 'Never']], m.showAudioMenu)}</div>
        <div class="field"><label>Subtitles menu</label>${sel('showSubtitleMenu', [['auto', 'When subtitles exist'], ['always', 'Always'], ['never', 'Never']], m.showSubtitleMenu)}</div>
        <div class="field"><label class="toggle"><input type="checkbox" data-m="excludeFirstFromScenes" ${m.excludeFirstFromScenes ? 'checked' : ''}><span class="sw"></span>Exclude the first video from the Scenes menu</label></div>
      </details>
      <details class="group"><summary>Playback</summary>
        <div class="field"><label>First-play video (intro before the menu)</label><div class="file-pick"><div class="fname">${m.firstPlay && m.firstPlay.file ? esc(baseName(m.firstPlay.file)) : 'None'}</div><button class="btn" id="pickIntro">Browse…</button>${m.firstPlay ? '<button class="btn ghost" id="clearIntro">Clear</button>' : ''}</div></div>
        <div class="field"><label class="toggle"><input type="checkbox" data-m="skipMenu" ${m.skipMenu ? 'checked' : ''}><span class="sw"></span>Skip menu at startup (play the movie first)</label></div>
        ${fmt !== 'dvd' ? `<div class="field"><label class="toggle"><input type="checkbox" data-m="popup" ${m.popup ? 'checked' : ''}><span class="sw"></span>Enable pop-up menu during playback</label><div class="hint">The remote's POP-UP key shows chapters, audio, subtitles and Main Menu over the movie.</div></div>` : ''}
      </details>
    </div>
    <div class="menu-stage">
      <div class="page-tabs" id="pageTabs"></div>
      <div class="stage-wrap"><div class="stage ${S.project.format === 'dvd' && S.project.dvd.aspect === '4:3' ? 'four3' : ''}" id="stage" tabindex="0"><img id="stageImg" alt=""><div class="busy" id="stageBusy">Rendering…</div></div></div>
      <div class="stage-help">Preview like a remote: <span class="kbd">←</span> <span class="kbd">↑</span> <span class="kbd">→</span> <span class="kbd">↓</span> move, <span class="kbd">Enter</span> opens pages. Drag text buttons and your own text/images to reposition; double-click your text to edit; <span class="kbd">Delete</span> removes it.</div>
    </div></div>`;
  $$('[data-tthumb]', v).forEach(async (img) => {
    const id = img.dataset.tthumb;
    if (!S.themeThumbs.has(id)) S.themeThumbs.set(id, await api.menu.themeThumb(S.project, id));
    img.src = S.themeThumbs.get(id);
  });
  v.onclick = async (e) => {
    const card = e.target.closest('[data-theme]');
    if (card) { m.theme = card.dataset.theme; const t = S.info.themes.find((x) => x.id === m.theme); if (t) m.highlight.color = t.colors.highlight; markDirty(); renderMenu(); requestPreview(); return; }
    const id = e.target.closest('button') && e.target.closest('button').id;
    if (id === 'pickBg') { const f = await pick(m.background.type === 'video' ? 'video' : 'image'); if (f[0]) { m.background.file = f[0]; markDirty(); renderMenu(); requestPreview(); } }
    if (id === 'pickMusic') { const f = await pick('audio'); if (f[0]) { m.music.file = f[0]; markDirty(); renderMenu(); } }
    if (id === 'clearMusic') { m.music.file = null; markDirty(); renderMenu(); }
    if (id === 'pickIntro') { const f = await pick('video'); if (f[0]) { const [info] = await api.media.probe([f[0]]); m.firstPlay = { file: f[0], info }; markDirty(); renderMenu(); } }
    if (id === 'clearIntro') { m.firstPlay = null; markDirty(); renderMenu(); }
    if (id === 'addText') { addElement({ type: 'text', text: 'New text', size: 48 }); }
    if (id === 'addImage') { const f = await pick('image'); if (f[0]) addElement({ type: 'image', file: f[0], w: 200 }); }
  };
  v.oninput = v.onchange = (e) => {
    const k = e.target.dataset.m;
    if (!k) return;
    let val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'number' || e.target.type === 'range' || k === 'itemsPerPage') val = Number(val);
    setPath(m, k, val);
    markDirty();
    if (e.type === 'change' && (e.target.tagName === 'SELECT' || e.target.type === 'checkbox')) renderMenu();
    requestPreview();
  };
  renderStage();
}

function addElement(el) {
  const page = (S.preview.data && S.preview.data.pages.find((p) => p.key === S.preview.page)) || { kind: 'top' };
  const e = { id: Math.random().toString(36).slice(2, 9), page: page.kind, x: 420, y: 80, color: '#ffffff', font: 'Inter', bold: false, italic: false, underline: false, outline: false, align: 'left', ...el };
  S.project.menu.elements.push(e);
  S.preview.selEl = e.id;
  markDirty();
  requestPreview();
  if (el.type === 'text') setTimeout(() => editTextElement(e), 50);
}

function renderStage() {
  const data = S.preview.data;
  const tabs = $('#pageTabs');
  const stage = $('#stage');
  if (!tabs || !stage) return;
  if (!S.project.menu.enabled) {
    tabs.innerHTML = '<span class="empty-note">Menus are turned off — the disc will start playing the first title.</span>';
  }
  if (!data) return;
  if (S.project.menu.enabled) {
    tabs.innerHTML = data.pages.map((p) => `<button data-page="${p.key}" class="${p.key === S.preview.page ? 'on' : ''}">${esc(p.kind === 'top' ? 'Main' : p.heading.replace(/\s+\d+\/\d+$/, (x) => ` ${x.trim()}`))}</button>`).join('');
    tabs.onclick = (e) => { const b = e.target.closest('[data-page]'); if (b) { S.preview.page = b.dataset.page; S.preview.sel = 1; requestPreview(); } };
  }
  $('#stageImg').src = data.image;
  $$('.hit, .el', stage).forEach((x) => x.remove());
  const page = data.pages.find((p) => p.key === S.preview.page) || data.pages[0];
  const pct = (v, total) => `${(v / total) * 100}%`;
  for (const b of page.buttons) {
    const d = document.createElement('div');
    d.className = 'hit';
    Object.assign(d.style, { left: pct(b.rect.x, data.VW), top: pct(b.rect.y, data.VH), width: pct(b.rect.w, data.VW), height: pct(b.rect.h, data.VH) });
    d.title = b.label;
    d.onclick = () => { S.preview.sel = b.id; requestPreview(); };
    d.ondblclick = () => activate(b);
    if (b.kind === 'text') makeDraggable(d, data, (x, y) => {
      const pos = S.project.menu.positions || (S.project.menu.positions = {});
      (pos[page.kind] || (pos[page.kind] = {}))[b.key] = { x: Math.round((x / data.VW) * 1000), y: Math.round((y / data.VH) * 1000) };
      markDirty(); requestPreview();
    }, b.rect);
    stage.appendChild(d);
  }
  for (const el of S.project.menu.elements.filter((x) => x.page === page.kind || x.page === 'all')) {
    const d = document.createElement('div');
    d.className = `el${S.preview.selEl === el.id ? ' sel' : ''}`;
    const w = el.type === 'image' ? (el.w || 200) / 1000 * 100 : null;
    Object.assign(d.style, { left: `${el.x / 10}%`, top: `${el.y / 10}%`, width: w ? `${w}%` : 'auto', height: el.type === 'image' ? `${w * 0.5}%` : `${((el.size || 48) * 1.2 / data.VH) * 100 * String(el.text || '').split('#').length}%`, minWidth: '40px' });
    if (el.type === 'text') d.style.width = `${Math.min(90, (String(el.text).length * (el.size || 48) * 0.55 / data.VW) * 100)}%`;
    d.onmousedown = () => { S.preview.selEl = el.id; $$('.el', stage).forEach((x) => x.classList.remove('sel')); d.classList.add('sel'); };
    d.ondblclick = () => (el.type === 'text' ? editTextElement(el) : null);
    makeDraggable(d, data, (x, y) => { el.x = Math.round((x / data.VW) * 1000); el.y = Math.round((y / data.VH) * 1000); markDirty(); requestPreview(); }, { x: (el.x / 1000) * data.VW, y: (el.y / 1000) * data.VH });
    stage.appendChild(d);
  }
}

function makeDraggable(div, data, onDrop, start) {
  div.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const stage = $('#stage');
    const r = stage.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const ox = parseFloat(div.style.left), oy = parseFloat(div.style.top);
    let moved = false;
    const mm = (ev) => {
      const dx = ((ev.clientX - sx) / r.width) * 100;
      const dy = ((ev.clientY - sy) / r.height) * 100;
      if (Math.abs(dx) + Math.abs(dy) > 0.4) moved = true;
      div.style.left = `${ox + dx}%`; div.style.top = `${oy + dy}%`;
    };
    const mu = () => {
      window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu);
      if (moved) onDrop((parseFloat(div.style.left) / 100) * data.VW, (parseFloat(div.style.top) / 100) * data.VH);
    };
    window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu);
  });
}

function menuKey(e) {
  const data = S.preview.data;
  if (!data) return;
  const page = data.pages.find((p) => p.key === S.preview.page);
  if (!page) return;
  const b = page.buttons.find((x) => x.id === S.preview.sel) || page.buttons[0];
  const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
  if (dir) { e.preventDefault(); S.preview.sel = b.navIds[dir] || b.id; requestPreview(); }
  if (e.key === 'Enter') { e.preventDefault(); activate(b); }
}

function activate(b) {
  if (b.action.type === 'page') { S.preview.page = b.action.page; S.preview.sel = 1; requestPreview(); return; }
  if (b.action.type === 'audio' || b.action.type === 'subtitle') { S.preview.page = 'top'; S.preview.sel = 1; requestPreview(); toast(`${b.action.type === 'audio' ? 'Audio' : 'Subtitles'}: ${b.label}`); return; }
  toast(`▶ ${b.label} — plays on the finished disc`);
}

function editTextElement(el) {
  openModal('Text Settings', `
    <div class="field"><label>Text (# inserts a new line)</label><input class="input" id="tText" value="${esc(el.text)}"></div>
    <div class="row field"><div><label class="field-label">Font</label><select class="input" id="tFont">${['Inter', 'Poppins', 'Lora', 'Segoe UI', 'Arial', 'Georgia', 'Impact'].map((f) => `<option${f === el.font ? ' selected' : ''}>${f}</option>`).join('')}</select></div>
      <div><label class="field-label">Size</label><input class="input" type="number" id="tSize" min="10" max="300" value="${el.size}"></div>
      <div style="flex:none"><label class="field-label">Color</label><input type="color" id="tColor" value="${el.color}"></div></div>
    <div class="row field">${['bold', 'italic', 'underline', 'outline'].map((k) => `<label class="toggle"><input type="checkbox" id="t_${k}" ${el[k] ? 'checked' : ''}><span class="sw"></span>${k[0].toUpperCase() + k.slice(1)}</label>`).join('')}</div>
    <div class="row field"><div><label class="field-label">Alignment</label><select class="input" id="tAlign">${['left', 'center', 'right'].map((a) => `<option${a === el.align ? ' selected' : ''}>${a}</option>`).join('')}</select></div>
      <div><label class="field-label">Show on</label><select class="input" id="tPage"><option value="${el.page}">This page</option><option value="all"${el.page === 'all' ? ' selected' : ''}>All pages</option></select></div></div>
    <div class="field"><label class="toggle"><input type="checkbox" id="tHidden" ${el.hidden ? 'checked' : ''}><span class="sw"></span>Hide text on the authored disc</label></div>`,
  [{ label: 'Delete', cls: 'ghost danger', fn: () => { S.project.menu.elements = S.project.menu.elements.filter((x) => x.id !== el.id); markDirty(); requestPreview(); } },
    { label: 'OK', cls: 'primary', fn: () => {
      Object.assign(el, { text: $('#tText').value, font: $('#tFont').value, size: Number($('#tSize').value), color: $('#tColor').value, align: $('#tAlign').value, page: $('#tPage').value, hidden: $('#tHidden').checked });
      ['bold', 'italic', 'underline', 'outline'].forEach((k) => { el[k] = $(`#t_${k}`).checked; });
      markDirty(); requestPreview();
    } }]);
}

/* ================================================================ create */
async function renderCreate() {
  const P = S.project;
  const o = P.output;
  const fmt = P.format;
  const v = $('#view-create');
  const capOpts = fmt === 'dvd' ? [['dvd5', 'DVD-5 (4.7 GB)'], ['dvd9', 'DVD-9 (8.5 GB)']] : fmt === 'bd' ? [['bd25', 'BD-25 (25 GB)'], ['bd50', 'BD-50 (50 GB)']] : [['bd50', 'BD-50 (50 GB)'], ['bd66', 'BD-66 (66 GB)'], ['bd100', 'BD-100 (100 GB)']];
  const sel = (k, opts, cur, attrs = '') => `<select class="input" data-o="${k}" ${attrs}>${opts.map(([val, lab]) => `<option value="${val}"${String(val) === String(cur) ? ' selected' : ''}>${lab}</option>`).join('')}</select>`;
  const encOpts = [['auto', 'Automatic (GPU when available)'], ['software', 'Software (best quality)']];
  const caps = (S.toolsStatus && S.toolsStatus.caps && S.toolsStatus.caps.available) || {};
  if (caps.h264_nvenc) encOpts.push(['nvidia', 'NVIDIA GPU (NVENC)']);
  if (caps.h264_qsv) encOpts.push(['intel', 'Intel GPU (Quick Sync)']);
  if (caps.h264_amf) encOpts.push(['amd', 'AMD GPU (AMF)']);
  const firstVideo = P.items.find((i) => i.type === 'video' && !i.bonus);
  const audioCount = firstVideo ? firstVideo.audioTracks.filter((a) => a.enabled).length : 1;
  const subCount = firstVideo ? firstVideo.subtitles.filter((s) => s.enabled).length : 0;
  const srcDar = firstVideo && firstVideo.info && firstVideo.info.video && firstVideo.info.video.dar;
  const discDar = fmt === 'dvd' && P.dvd.aspect === '4:3' ? 4 / 3 : 16 / 9;
  let fitHint = '';
  if (srcDar && Math.abs(srcDar - discDar) > 0.08) {
    const shape = (d) => (Math.abs(d - 4 / 3) < 0.08 ? '4:3' : Math.abs(d - 16 / 9) < 0.08 ? '16:9' : `${d.toFixed(2)}:1`);
    const src = shape(srcDar); const disc = discDar > 1.5 ? '16:9' : '4:3';
    const fit = P.encoding.fit || 'fit';
    const bars = srcDar < discDar ? 'black bars at the left and right' : 'black bars at the top and bottom';
    const crop = srcDar < discDar ? 'top and bottom' : 'left and right sides';
    fitHint = `“${esc(firstVideo.title || 'Your video')}” is <b>${src}</b> and the disc is <b>${disc}</b>. ` + (
      fit === 'fit' ? `It will keep its shape with ${bars}, so it will look ${src} on the TV. Choose <b>Zoom</b> or <b>Stretch</b> to fill the whole screen.`
      : fit === 'zoom' ? `It will be enlarged to fill the screen; part of the ${crop} is cut off.`
      : 'It will be stretched to fill the screen; people and objects will look wider than normal.');
  }
  const curBurner = S.burners.find((b) => b.id === o.burner) || S.burners[0];
  const speeds = (curBurner && curBurner.speeds) || [];
  const ws = Number(o.writeSpeed) || 0;
  const speedOpts = [[0, 'Maximum (fastest the drive allows)'], ...[...speeds].reverse().map((sp) => [sp.sectors, sp.label])];
  if (ws && !speeds.some((sp) => sp.sectors === ws)) speedOpts.push([ws, `Saved setting (${(ws / (curBurner && curBurner.media >= 17 ? 2195 : 676.5)).toFixed(1)}×) — the nearest speed the disc supports will be used`]);
  const speedSelect = sel('output.writeSpeed', speedOpts, ws);
  const speedHint = !curBurner ? 'Connect a disc burner to choose a write speed.'
    : !curBurner.mediaPresent ? 'Insert a blank disc and click <b>Refresh</b> to see the speeds it supports.'
    : speeds.length ? `Speeds supported by the ${esc(curBurner.mediaName.replace(/ \(.*\)$/, ''))} in the drive. Slower speeds (about 4×–8×) usually give discs that play more reliably on older players.`
    : 'The drive did not report its speeds for this disc; it will burn at its maximum.';
  v.innerHTML = `<div class="create-layout">
    <div class="create-main">
      <div class="section-label" style="margin-top:22px">Output</div>
      <div class="cards">
        <div class="opt-card ${o.makeFolder ? 'on' : ''}" data-card="makeFolder"><div class="check"></div>${ICON.folder}<h4>Disc folder</h4><p>${fmt === 'dvd' ? 'VIDEO_TS' : 'BDMV'} folder you can play or burn later.</p></div>
        <div class="opt-card ${o.makeIso ? 'on' : ''}" data-card="makeIso"><div class="check"></div>${ICON.iso}<h4>ISO image</h4><p>A single file for burning, mounting or archiving.</p></div>
        <div class="opt-card ${o.burn ? 'on' : ''}" data-card="burn"><div class="check"></div>${ICON.flame}<h4>Burn to disc</h4><p>Write straight to a blank ${fmt === 'dvd' ? 'DVD' : 'BD-R'}.</p></div>
      </div>
      <div class="grid2" style="margin-top:6px">
        <div class="field"><label>Disc label</label><input class="input" data-o="output.label" maxlength="32" value="${esc(o.label)}"></div>
        <div class="field"><label>Save to</label><div class="file-pick"><div class="fname">${esc(o.folder || 'Choose a folder…')}</div><button class="btn" id="pickOut">Browse…</button></div></div>
      </div>
      <div class="section-label">Disc burner</div>
      <div class="grid2">
        <div class="field"><label>Burner</label><div class="row"><select class="input" data-o="output.burner" id="burnerSel">${S.burners.length ? S.burners.map((b) => `<option value="${esc(b.id)}"${b.id === o.burner ? ' selected' : ''}>${esc(b.name)}${b.letter ? ` (${esc(b.letter.split(',')[0].replace(/\\$/, ''))})` : ''} — ${esc(b.mediaName)}</option>`).join('') : `<option value="">${S.burnersLoaded ? 'No disc burner was found' : 'Looking for disc burners…'}</option>`}</select><button class="btn" style="flex:none" id="refreshBurners" title="Check the drive again after changing the disc">Refresh</button></div></div>
        <div class="field"><label>Write speed</label>${speedSelect}</div>
        ${o.burn ? `<div class="field"><label>Copies</label><input class="input" type="number" min="1" max="50" data-o="output.copies" value="${o.copies || 1}"></div>` : ''}
      </div>
      <div class="hint" style="margin:-4px 0 4px">${speedHint}</div>
      <div class="disc-tools"><div><h4>${ICON.flame} Already have a disc image?</h4><p>Burn any .iso file (for example the one DiscForge made earlier) straight to a blank disc.</p></div>
        <div class="row" style="flex:none;gap:8px"><button class="btn primary" id="burnExisting" style="flex:none">Burn an existing ISO…</button><button class="btn ghost" id="eraseDisc" style="flex:none">Erase rewritable disc…</button></div></div>

      <div class="section-label">Video</div>
      <div class="grid2">
        ${fmt === 'dvd' ? `
          <div class="field"><label>TV standard</label>${sel('dvd.standard', [['ntsc', 'NTSC (720×480, Americas/Japan)'], ['pal', 'PAL (720×576, Europe/Asia)']], P.dvd.standard)}</div>
          <div class="field"><label>Aspect ratio</label>${sel('dvd.aspect', [['16:9', '16:9 widescreen'], ['4:3', '4:3 standard']], P.dvd.aspect)}</div>` : ''}
        ${fmt === 'bd' ? `<div class="field"><label>Resolution</label>${sel('bd.resolution', [['1080', '1080p / 1080i (Full HD)'], ['720', '720p']], P.bd.resolution)}</div>` : ''}
        ${fmt === 'uhd' ? `<div class="field"><label>Dynamic range</label>${sel('uhd.dynamicRange', [['auto', 'Same as source (HDR10 / HDR10+ / Dolby Vision kept)'], ['hdr10', 'HDR10'], ['sdr', 'SDR (tone-map HDR sources)']], P.uhd.dynamicRange)}</div>` : ''}
        <div class="field"><label>Processing</label>${sel('processing', [['transcode', `Re-encode everything to ${fmt === 'dvd' ? 'DVD' : fmt === 'bd' ? 'Blu-ray' : '4K UHD'} format`], ['passthrough', fmt === 'dvd' ? 'Copy video that is already DVD MPEG-2 (fastest)' : 'Passthrough when possible (no quality loss, fastest)']], P.processing)}</div>
        <div class="field"><label>Encoder</label>${sel('encoding.encoder', encOpts, P.encoding.encoder)}</div>
        <div class="field"><label>Quality</label>${sel('encoding.quality', [['high', 'High (slower)'], ['standard', 'Standard (faster)']], P.encoding.quality)}</div>
        <div class="field"><label>Titles</label>${sel('titleMode', [['separate', 'Separate into multiple titles'], ['merge', 'Merge into a single title']], P.titleMode)}</div>
        <div class="field"><label>Picture fit</label>${sel('encoding.fit', [['fit', 'Keep original shape (black bars if needed)'], ['zoom', 'Zoom to fill the screen (crops the edges)'], ['stretch', 'Stretch to fill the screen']], P.encoding.fit || 'fit')}</div>
        ${fitHint ? `<div class="field" style="grid-column:1/-1"><div class="msg info" style="margin:0">${fitHint}</div></div>` : ''}
      </div>

      <div class="section-label">Audio & subtitles</div>
      <div class="grid2">
        <div class="field"><label>Audio</label>${sel('audioMode', [['encode', 'Encode audio'], ['copy', 'Copy compatible audio streams (AC3, DTS, TrueHD…)']], P.audioMode)}</div>
        ${fmt !== 'dvd' ? `<div class="field"><label>Encoded audio format</label>${sel('audioCodec', [['ac3', 'Dolby Digital (AC3)'], ['lpcm', 'Uncompressed LPCM']], P.audioCodec)}</div>` : '<div></div>'}
        <div class="field"><label>Default audio</label>${sel('output.defaultAudio', Array.from({ length: Math.max(1, audioCount) }, (_, i) => [i + 1, `Track ${i + 1}${firstVideo && firstVideo.audioTracks.filter((a) => a.enabled)[i] ? ` (${firstVideo.audioTracks.filter((a) => a.enabled)[i].lang})` : ''}`]), o.defaultAudio)}</div>
        <div class="field"><label>Default subtitle</label>${sel('output.defaultSubtitle', [[0, 'Off'], ...Array.from({ length: subCount }, (_, i) => [i + 1, `Subtitle ${i + 1}`])], o.defaultSubtitle)}</div>
        ${fmt !== 'dvd' ? `<div class="field"><label>Text subtitle color</label>${sel('encoding.textSubtitleColor', [['white', 'White'], ['yellow', 'Yellow'], ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple']], P.encoding.textSubtitleColor)}</div>` : ''}
        <div class="field"><label class="toggle" style="margin-top:22px"><input type="checkbox" data-o="encoding.loopWithoutMenu" ${P.encoding.loopWithoutMenu ? 'checked' : ''}><span class="sw"></span>Loop playback when there is no menu</label></div>
      </div>

      <div class="section-label">When finished</div>
      <div class="grid2">
        <div class="field"><label>After completion</label>${sel('output.afterCompletion', [['nothing', 'Do nothing'], ['shutdown', 'Shut down the computer']], o.afterCompletion)}</div>
        <div class="field"><label class="toggle" style="margin-top:22px"><input type="checkbox" data-o="output.testMode" ${o.testMode ? 'checked' : ''}><span class="sw"></span>Test run: first 5 minutes of each title only</label></div>
      </div>
    </div>
    <div class="create-side" id="createSide"></div>
  </div>`;
  v.onclick = async (e) => {
    const card = e.target.closest('[data-card]');
    if (card) {
      o[card.dataset.card] = !o[card.dataset.card];
      if (card.dataset.card === 'burn' && o.burn) { S.burners = await api.disc.burners(); if (S.burners[0] && !o.burner) o.burner = S.burners[0].id; }
      markDirty(); renderCreate(); return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'pickOut') { const r = await api.dialog.open({ properties: ['openDirectory', 'createDirectory'] }); if (r[0]) { o.folder = r[0]; api.settings.set({ outputFolder: r[0] }); markDirty(); renderCreate(); } }
    if (b.id === 'refreshBurners') { b.disabled = true; b.textContent = 'Checking…'; S.burners = await api.disc.burners(); S.burnersLoaded = true; if (S.burners[0] && !S.burners.some((x) => x.id === o.burner)) o.burner = S.burners[0].id; renderCreate(); toast(S.burners.length ? 'Burner list updated' : 'No disc burner was found'); }
    if (b.id === 'burnExisting') {
      const f = await api.dialog.open({ properties: ['openFile'], filters: [{ name: 'Disc images', extensions: ['iso'] }] });
      if (!f[0]) return;
      if (!S.burners.length) { toast('Looking for disc burners…'); S.burners = await api.disc.burners(); }
      if (!S.burners.length) return alert('No disc burner was found. Check that the drive is connected and has a blank disc in it.');
      const burner = S.burners.find((x) => x.id === o.burner) || S.burners[0];
      if (!confirm(`Burn ${baseName(f[0])} to the disc in ${burner.name} (${burner.mediaName})?`)) return;
      showProgress('Burning disc');
      api.disc.burnIso(f[0], burner.id, Number(o.writeSpeed) || 0);
      return;
    }
    if (b.id === 'eraseDisc') {
      if (!S.burners.length) { toast('Looking for disc burners…'); S.burners = await api.disc.burners(); }
      const burner = S.burners.find((x) => x.id === o.burner) || S.burners[0];
      if (!burner) return alert('No disc burner was found.');
      if (!confirm(`Erase the disc in ${burner.name}? Everything on it will be lost.`)) return;
      showProgress('Erasing disc');
      api.disc.erase(burner.id);
    }
  };
  v.oninput = v.onchange = (e) => {
    const k = e.target.dataset.o;
    if (!k) return;
    let val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'number' || /default(Audio|Subtitle)|writeSpeed/.test(k)) val = Number(val);
    setPath(P, k, val);
    if (k === 'output.label') o.label = String(val).replace(/[^A-Za-z0-9_ -]/g, '').toUpperCase().replace(/ /g, '_');
    markDirty();
    if (e.type === 'change' && e.target.tagName === 'SELECT') renderCreate();
    else renderSummary();
  };
  if (!S.burnersLoaded && !S.burnersLoading) {
    S.burnersLoading = true;
    api.disc.burners().then((b) => {
      S.burners = b || []; S.burnersLoaded = true; S.burnersLoading = false;
      if (S.burners[0] && !S.burners.some((x) => x.id === o.burner)) o.burner = S.burners[0].id;
      if ($('#view-create') && $('#view-create').offsetParent) renderCreate();
    }).catch(() => { S.burnersLoaded = true; S.burnersLoading = false; });
  }
  renderSummary();
}

async function renderSummary() {
  const side = $('#createSide');
  if (!side) return;
  const est = await api.project.estimate(S.project);
  S.estimate = est;
  const P = S.project;
  const fmtName = { dvd: 'DVD', bd: 'Blu-ray', uhd: '4K UHD Blu-ray' }[P.format];
  const total = P.items.reduce((a, i) => a + itemDuration(i), 0);
  const { errors, warnings } = est.validation;
  side.innerHTML = `
    <div class="summary"><h3>${esc(P.name)}</h3><dl>
      <dt>Format</dt><dd>${fmtName}${P.format === 'dvd' ? ` · ${P.dvd.standard.toUpperCase()} ${P.dvd.aspect}` : P.format === 'bd' ? ` · ${P.bd.resolution}` : ''}</dd>
      <dt>Titles</dt><dd>${P.items.filter((i) => !i.bonus).length}${P.items.some((i) => i.bonus) ? ` + ${P.items.filter((i) => i.bonus).length} bonus` : ''}</dd>
      <dt>Running time</dt><dd>${fmtDur(total)}</dd>
      <dt>Menus</dt><dd>${P.menu.enabled ? esc((S.info.themes.find((t) => t.id === P.menu.theme) || {}).name || P.menu.theme) : 'Off'}</dd>
      <dt>Video bitrate</dt><dd>${(est.bitrate / 1e6).toFixed(1)} Mbit/s</dd>
      <dt>Estimated size</dt><dd>${fmtGB(est.size)}</dd>
      <dt>Output</dt><dd>${[P.output.makeFolder && 'Folder', P.output.makeIso && 'ISO', P.output.burn && 'Disc'].filter(Boolean).join(' + ') || '—'}</dd>
    </dl></div>
    ${errors.map((e) => `<div class="msg err">${esc(e)}</div>`).join('')}
    ${warnings.map((w) => `<div class="msg warn">${esc(w)}</div>`).join('')}
    ${!P.output.folder ? '<div class="msg warn">Choose where to save the disc.</div>' : ''}
    <div style="flex:1"></div>
    <button class="btn primary big" id="startBtn" ${errors.length || !P.output.folder ? 'disabled' : ''}>${ICON.disc}${P.output.testMode ? 'Create Test Disc' : 'Start Authoring'}</button>`;
  const sb = side.querySelector('#startBtn'); if (sb) sb.onclick = startAuthoring;
}

/* ================================================================ footer */
const refreshEstimate = debounce(async () => {
  const P = S.project;
  const est = await api.project.estimate(P);
  S.estimate = est;
  const capKey = P.format === 'dvd' ? P.dvd.capacity : P.format === 'bd' ? P.bd.capacity : P.uhd.capacity;
  const cap = S.info.capacity[capKey];
  const total = P.items.reduce((a, i) => a + itemDuration(i), 0);
  const pct = Math.min(100, (est.size / cap) * 100);
  const capOpts = P.format === 'dvd' ? [['dvd5', 'DVD-5 · 4.7 GB'], ['dvd9', 'DVD-9 · 8.5 GB']] : P.format === 'bd' ? [['bd25', 'BD-25 · 25 GB'], ['bd50', 'BD-50 · 50 GB']] : [['bd50', 'BD-50 · 50 GB'], ['bd66', 'BD-66 · 66 GB'], ['bd100', 'BD-100 · 100 GB']];
  const key = P.format === 'dvd' ? 'dvd' : P.format === 'bd' ? 'bd' : 'uhd';
  if (!capOpts.some(([k]) => k === capKey)) { P[key].capacity = capOpts[0][0]; return refreshEstimate(); }
  $('#footer').innerHTML = `<div class="cap">
      <select class="input" id="capSel">${capOpts.map(([k, l]) => `<option value="${k}"${k === capKey ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <div class="bar"><i class="${est.size > cap ? 'over' : ''}" style="width:${pct}%"></i></div>
      <span class="txt">${P.items.length ? `${fmtGB(est.size)} of ${fmtGB(cap)} · ${fmtDur(total)} · ${(est.bitrate / 1e6).toFixed(1)} Mbit/s video` : 'No media added yet'}</span>
    </div>
    ${S.view !== 'create' ? `<button class="btn primary" id="footNext">${S.view === 'media' ? 'Next: Menu →' : 'Next: Create →'}</button>` : ''}`;
  $('#capSel').onchange = (e) => { P[key].capacity = e.target.value; markDirty(); if (S.view === 'create') renderSummary(); };
  const fn = $('#footNext'); if (fn) fn.onclick = () => { S.view = S.view === 'media' ? 'menu' : 'create'; renderAll(); };
}, 120);

/* ================================================================ modals */
function openModal(title, html, buttons = [{ label: 'Close', cls: 'primary' }], opts = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal" style="${opts.width ? `width:${opts.width}` : ''}"><header><h3>${esc(title)}</h3><button class="icon-btn" data-close>${ICON.close}</button></header><div class="body">${html}</div><footer>${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}</footer></div>`;
  m.classList.add('open');
  m.onclick = (e) => {
    if (e.target === m || e.target.closest('[data-close]')) { m.classList.remove('open'); return; }
    const b = e.target.closest('[data-b]');
    if (b) { const btn = buttons[Number(b.dataset.b)]; if (!btn.fn || btn.fn() !== false) m.classList.remove('open'); }
  };
  return m;
}

async function openSettings(tab) {
  const st = S.toolsStatus || await api.tools.status();
  S.toolsStatus = st;
  const rows = Object.entries(st.catalog).map(([id, t]) => {
    const found = st.tools[id];
    const canDl = st.downloadable.includes(id) || (id === 'ffprobe');
    return `<div class="tool-row">
      <div class="dot ${found ? 'ok' : t.required ? '' : 'opt'}"></div>
      <div><div class="t-name">${id} ${st.versions[id] ? `<span class="chip">${esc(st.versions[id])}</span>` : ''} ${t.required ? '' : '<span class="chip">optional</span>'}</div>
        <div class="t-desc" title="${esc(found || '')}">${esc(found || t.purpose)}</div></div>
      <div class="row" style="flex:none;gap:6px">
        ${!found && canDl && id !== 'ffprobe' ? `<button class="btn primary" data-install="${id}">Install</button>` : ''}
        ${!found && (id === 'dvdauthor' || id === 'spumux') ? '<button class="btn" data-link="https://www.dvdstyler.org/en/downloads">Get DVDStyler</button>' : ''}
        <button class="btn ghost" data-browse="${id}">Browse…</button>
      </div></div>`;
  }).join('');
  const gpu = Object.entries(st.caps.available || {}).filter(([k, v]) => v && /nvenc|qsv|amf/.test(k)).map(([k]) => k).join(', ') || 'none detected (software encoding)';
  openModal('Settings', `
    <div class="section-label">External tools</div>
    <div class="hint">DiscForge drives these free tools. Missing ones can be installed from their official download pages. dvdauthor and spumux are found automatically if DVDStyler is installed.</div>
    <div id="toolRows">${rows}</div>
    <div id="installMsg" class="hint"></div>
    <div class="section-label">Hardware acceleration</div>
    <div class="hint">GPU encoders available: ${esc(gpu)}</div>
    <div class="section-label">About</div>
    <div class="hint">DiscForge Studio ${esc(S.info.version)} · DVD, Blu-ray and 4K UHD authoring with interactive menus.</div>`, [{ label: 'Close', cls: 'primary' }], { width: 'min(820px, 94vw)' });
  const m = $('#modal');
  const off = api.tools.onInstallProgress((p) => { const el = $('#installMsg'); if (el) el.textContent = `${p.msg} ${Math.round(p.f * 100)}%`; });
  m.addEventListener('click', async (e) => {
    const ins = e.target.closest('[data-install]');
    const br = e.target.closest('[data-browse]');
    const link = e.target.closest('[data-link]');
    if (link) api.shell.external(link.dataset.link);
    if (ins) {
      ins.disabled = true; ins.textContent = 'Installing…';
      try { S.toolsStatus = await api.tools.install(ins.dataset.install); openSettings(); } catch (err) { $('#installMsg').textContent = `Install failed: ${err.message}`; ins.disabled = false; ins.textContent = 'Retry'; }
    }
    if (br) {
      const f = await api.dialog.open({ properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe', '*'] }] });
      if (f[0]) { S.toolsStatus = await api.tools.setPath(br.dataset.browse, f[0]); openSettings(); }
    }
  });
  m.addEventListener('transitionend', off, { once: true });
}

/* ================================================================ authoring */
let logLines = [];
async function startAuthoring() {
  const P = S.project;
  if (S.running) return;
  if (!P.output.folder) return toast('Choose where to save the disc.');
  showProgress(P.output.testMode ? 'Creating test disc' : `Creating ${({ dvd: 'DVD', bd: 'Blu-ray', uhd: '4K UHD' })[P.format]}`);
  await api.author.start(P);
}

function showProgress(title) {
  logLines = [];
  S.running = true;
  const pg = $('#progress');
  pg.innerHTML = `<div class="progress-card">
    <div class="disc-spin"></div>
    <h3>${esc(title)}</h3>
    <div class="step" id="pStep">Preparing…</div>
    <div class="plabel"><span>Current task</span><span id="pStepPct">0%</span></div>
    <div class="pbar thin"><i id="pStepBar" style="width:0%"></i></div>
    <div class="plabel"><span>Overall progress</span><span id="pAllPct">0%</span></div>
    <div class="pbar"><i id="pAllBar" style="width:0%"></i></div>
    <div class="burn-panel" id="pBurn" hidden>
      <div class="burn-phases" id="pBurnPhases"></div>
      <div class="burn-stats">
        <div><span>Written</span><b id="pBurnWritten">—</b></div>
        <div><span>Speed</span><b id="pBurnSpeed">—</b></div>
        <div><span>Buffer</span><b id="pBurnBuffer">—</b></div>
        <div><span>Time left</span><b id="pBurnLeft">—</b></div>
      </div>
      <div class="hint" id="pBurnMedia"></div>
    </div>
    <details><summary class="hint" style="cursor:pointer">Details</summary><div class="logbox" id="pLog"></div></details>
    <div class="row" style="justify-content:flex-end;margin-top:16px" id="pButtons"><button class="btn" style="flex:none" id="pCancel">Cancel</button></div>
  </div>`;
  pg.classList.add('open');
  S.progressTitle = title;
  $('#pCancel').onclick = () => { if (confirm('Do you want to cancel this task?')) api.author.cancel(); };
  S.startedAt = Date.now();
}

function onProgress(p) {
  if (!$('#pStep')) return;
  $('#pStep').textContent = `${p.step}  ·  step ${p.stepIndex + 1} of ${p.stepCount}`;
  $('#pStepBar').style.width = `${(p.stepFraction * 100).toFixed(1)}%`;
  $('#pStepPct').textContent = `${Math.round(p.stepFraction * 100)}%`;
  $('#pAllBar').style.width = `${(p.overall * 100).toFixed(1)}%`;
  const el = (Date.now() - S.startedAt) / 1000;
  const eta = p.info && p.info.kind === 'burn' ? (p.info.remaining || null) : p.overall > 0.03 && el > 5 ? el / p.overall - el : null;
  $('#pAllPct').textContent = `${Math.round(p.overall * 100)}%${eta ? ` · about ${fmtDur(eta)} left` : ''}`;
  renderBurnInfo(p.info);
}

const BURN_STEPS = [['initializing', 'Prepare'], ['writing', 'Write'], ['finalizing', 'Finalize'], ['completed', 'Done']];
function renderBurnInfo(info) {
  const panel = $('#pBurn');
  if (!panel) return;
  if (!info || info.kind !== 'burn') { panel.hidden = true; return; }
  panel.hidden = false;
  const order = { preparing: 0, validating: 0, formatting: 0, initializing: 0, calibrating: 0, writing: 1, finalizing: 2, verifying: 2, completed: 3 };
  const cur = info.phase === 'erasing' ? -1 : (order[info.phase] ?? 0);
  $('#pBurnPhases').innerHTML = info.phase === 'erasing'
    ? `<div class="bp on">${esc(info.phaseLabel)}</div>`
    : BURN_STEPS.map(([, lab], i) => `<div class="bp ${i < cur ? 'done' : i === cur ? 'on' : ''}">${i < cur ? '✓ ' : ''}${lab}</div>`).join('');
  $('#pStep').textContent = info.phaseLabel || 'Burning';
  const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
  $('#pBurnWritten').textContent = info.bytes ? `${mb(info.bytesDone || 0)} of ${mb(info.bytes)}` : '—';
  $('#pBurnSpeed').textContent = info.speed ? `${(info.speed / 1e6).toFixed(1)} MB/s${info.speedX ? ` (${info.speedX.toFixed(1)}×)` : ''}` : '—';
  $('#pBurnBuffer').textContent = info.buffer != null ? `${info.buffer}%` : '—';
  $('#pBurnLeft').textContent = info.remaining ? fmtDur(info.remaining) : info.phase === 'finalizing' ? 'a minute or two' : '—';
  $('#pBurnMedia').textContent = info.media ? `Disc: ${info.media}${info.phase === 'finalizing' ? ' · Finalizing can take a couple of minutes; do not eject the disc.' : ''}` : '';
}

function onLog(line) {
  logLines.push(line);
  if (logLines.length > 400) logLines.shift();
  const box = $('#pLog');
  if (box && box.offsetParent) { box.textContent = logLines.join('\n'); box.scrollTop = box.scrollHeight; }
}

function finishButtons(html) { const b = $('#pButtons'); if (b) b.innerHTML = html; }

function onDone(res) {
  S.running = false;
  $('.disc-spin') && ($('.disc-spin').style.animation = 'none');
  $('#pStep').textContent = res.message || `Finished in ${fmtDur((Date.now() - S.startedAt) / 1000)}${res.size ? ` · ${fmtGB(res.size)}` : ''}`;
  $('#pAllBar').style.width = '100%';
  $('#pAllPct').textContent = '100%';
  finishButtons(`${res.folder ? '<button class="btn" style="flex:none" id="pOpenFolder">Open Output Folder</button>' : ''}${res.iso ? '<button class="btn" style="flex:none" id="pShowIso">Show ISO</button>' : ''}${res.log ? '<button class="btn ghost" style="flex:none" id="pLogBtn">Open Log</button>' : ''}<button class="btn primary" style="flex:none" id="pClose">Finish</button>`);
  const f = $('#pOpenFolder'); if (f) f.onclick = () => api.shell.open(res.folder);
  const i = $('#pShowIso'); if (i) i.onclick = () => api.shell.show(res.iso);
  if ($('#pLogBtn')) $('#pLogBtn').onclick = () => api.shell.open(res.log);
  $('#pClose').onclick = () => $('#progress').classList.remove('open');
}

function onFailed(err) {
  S.running = false;
  if ($('.disc-spin')) $('.disc-spin').style.animation = 'none';
  $('#pStep').innerHTML = `<span style="color:var(--err)">${err.cancelled ? 'Cancelled.' : `${/burn|eras/i.test(S.progressTitle || '') ? (S.progressTitle || 'Task').replace(/ing\b.*/, 'ing') : 'Authoring'} failed.`}</span>`;
  if (!err.cancelled) {
    const card = $('.progress-card');
    const m = document.createElement('div');
    m.className = 'msg err';
    m.style.whiteSpace = 'pre-wrap';
    m.style.userSelect = 'text';
    m.textContent = err.message;
    card.insertBefore(m, $('#pButtons'));
  }
  finishButtons(`${err.log ? '<button class="btn ghost" style="flex:none" id="pLogBtn">Open Log</button>' : ''}<button class="btn primary" style="flex:none" id="pClose">Close</button>`);
  if ($('#pLogBtn')) $('#pLogBtn').onclick = () => api.shell.open(err.log);
  $('#pClose').onclick = () => $('#progress').classList.remove('open');
}

function onShutdown({ seconds }) {
  finishButtons(`<span class="hint" style="flex:1">Authoring is complete. The computer will shut down in ${seconds} seconds.</span><button class="btn primary" style="flex:none" id="pAbort">Cancel shutdown</button>`);
  $('#pAbort').onclick = async () => { await api.author.cancelShutdown(); toast('Shutdown cancelled'); $('#progress').classList.remove('open'); };
}
