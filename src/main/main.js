'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { locateTools, toolVersions, detectEncoders, installTool, TOOLS, DOWNLOADS } = require('../core/tools');
const { probe, grabFrame } = require('../core/probe');
const P = require('../core/project');
const { JobContext } = require('../core/util');
const { authorProject, outputPaths } = require('../core/pipeline');
const { buildMenuPages, langLabel } = require('../core/menu/layout');
const { MenuRenderer } = require('../core/menu/render');
const { THEMES } = require('../core/menu/themes');
const { TRANSITIONS } = require('../core/encode/compose');
const disc = require('../core/disc');

let win;
let settings = {};
let tools = {};
let caps = { available: {} };
let job = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const cacheDir = () => { const d = path.join(app.getPath('userData'), 'cache'); fs.mkdirSync(d, { recursive: true }); return d; };

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (_) { settings = {}; }
  settings = { toolPaths: {}, outputFolder: path.join(app.getPath('videos'), 'DiscForge'), recent: [], ...settings };
}
function saveSettings() { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }

async function refreshTools() {
  tools = locateTools(settings.toolPaths);
  caps = await detectEncoders(tools.ffmpeg).catch(() => ({ available: {} }));
  return { tools, versions: await toolVersions(tools), caps, catalog: TOOLS, downloadable: Object.keys(DOWNLOADS) };
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0d1017',
    title: 'DiscForge Studio',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32' ? { color: '#0d1017', symbolColor: '#c9d1e3', height: 44 } : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (job) {
      e.preventDefault();
      dialog.showMessageBox(win, { type: 'warning', message: 'A task is currently in progress. Cancel it before closing the application.', buttons: ['OK'] });
    }
  });
}

// Matches the appId used by the installer's shortcuts so Windows groups the taskbar icon correctly.
if (process.platform === 'win32') app.setAppUserModelId('io.github.discforge.studio');
// One window at a time: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});

app.whenReady().then(async () => {
  loadSettings();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

/* ------------------------------------------------------------------ IPC */
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  themes: Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name, layout: t.layout, colors: t.colors })),
  transitions: Object.keys(TRANSITIONS),
  defaults: P.defaultProject(),
  capacity: P.CAPACITY,
  settings,
}));

ipcMain.handle('tools:status', () => refreshTools());
ipcMain.handle('tools:install', async (_e, id) => {
  await installTool(id, (f, msg) => send('tools:installProgress', { id, f, msg }));
  return refreshTools();
});
ipcMain.handle('tools:setPath', async (_e, id, p) => {
  settings.toolPaths[id] = p;
  saveSettings();
  return refreshTools();
});

ipcMain.handle('settings:set', (_e, patch) => { settings = { ...settings, ...patch }; saveSettings(); return settings; });

ipcMain.handle('dialog:open', async (_e, opts) => {
  const r = await dialog.showOpenDialog(win, opts);
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:save', async (_e, opts) => {
  const r = await dialog.showSaveDialog(win, opts);
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('media:probe', async (_e, files) => {
  if (!tools.ffprobe) await refreshTools();
  const out = [];
  for (const f of files) {
    try { out.push(await probe(tools, f)); } catch (e) { out.push({ file: f, error: e.message.split('\n')[0] }); }
  }
  return out;
});

async function thumbFor(file, at, hdr, width = 480) {
  const key = crypto.createHash('sha1').update(`${file}|${fs.statSync(file).mtimeMs}|${Math.round(at * 10)}|${width}`).digest('hex');
  const png = path.join(cacheDir(), `${key}.png`);
  if (!fs.existsSync(png)) {
    if (/\.(jpe?g|png|bmp|webp|gif|tiff?)$/i.test(file)) {
      await grabFrame(tools, file, 0, png, { width });
    } else {
      await grabFrame(tools, file, at, png, { width, hdr });
    }
  }
  return png;
}

ipcMain.handle('media:thumb', async (_e, file, at = 0, hdr = false) => {
  try {
    const png = await thumbFor(file, at, hdr);
    return `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`;
  } catch (_) { return null; }
});

/* --------------------------------------------------- menu designer preview */
async function previewPlan(project) {
  const items = project.items.length ? project.items : [];
  const titles = [];
  let n = 1;
  const mains = items.filter((i) => !i.bonus);
  const pushTitle = (name, its, bonus) => {
    let offset = 0;
    const chapters = [];
    const thumbs = [];
    return (async () => {
      for (const it of its) {
        const ch = P.chapterTimes(it);
        for (const c of ch) {
          chapters.push(offset + c);
          thumbs.push(await itemThumb(it, c));
        }
        offset += P.itemDuration(it);
      }
      titles.push({ number: n++, name, duration: offset, chapters, chapterThumbs: thumbs, thumb: thumbs[0] || null, bonus });
    })();
  };
  if (project.titleMode === 'merge' && mains.length > 1) await pushTitle(project.menu.title, mains, false);
  else for (const it of mains) await pushTitle(it.title, [it], false);
  for (const it of items.filter((i) => i.bonus)) await pushTitle(it.title, [it], true);
  if (!titles.length) titles.push({ number: 1, name: 'Main Title', duration: 3600, chapters: [0, 600, 1200, 1800], chapterThumbs: [], bonus: false });
  const first = mains[0];
  const audio = first && first.audioTracks ? first.audioTracks.filter((a) => a.enabled).map((a, i) => ({ number: i + 1, lang: a.lang, label: langLabel(a.lang, i, 'Audio') })) : [];
  const subs = first && first.subtitles ? first.subtitles.filter((s) => s.enabled).map((s, i) => ({ number: i + 1, lang: s.lang, label: langLabel(s.lang, i, 'Subtitle') })) : [];
  return { titles, audio, subtitles: subs };
}

async function itemThumb(it, at) {
  try {
    if (it.type === 'video') return await thumbFor(it.file, (it.trim.start || 0) + at + 2, it.info.video && it.info.video.hdr !== 'sdr');
    if (it.type === 'slideshow') {
      const ss = it.slideshow;
      let t = 0;
      for (const im of ss.images) { const d = im.duration || ss.slideDuration; if (at < t + d) return await thumbFor(im.file, 0, false); t += d; }
      return ss.images[0] ? await thumbFor(ss.images[0].file, 0, false) : null;
    }
    if (it.type === 'music') return it.music.cover ? await thumbFor(it.music.cover, 0, false) : null;
  } catch (_) { /* ignore */ }
  return null;
}

ipcMain.handle('menu:preview', async (_e, project, pageKey, selectedId, width = 1280) => {
  const plan = await previewPlan(project);
  const layout = buildMenuPages(project, plan);
  const page = layout.pages.find((p) => p.key === pageKey) || layout.pages[0];
  const height = Math.round((width * layout.VH) / layout.VW);
  let bgFrame = null;
  if (project.menu.background.type === 'video' && project.menu.background.file) {
    bgFrame = await thumbFor(project.menu.background.file, project.menu.background.start || 0, false, 1280).catch(() => null);
  }
  const menu = bgFrame ? { ...project.menu, background: { type: 'image', file: bgFrame } } : project.menu;
  const r = new MenuRenderer(layout, { width, height, menu });
  const png = await r.preview(page, selectedId || 1);
  return {
    image: `data:image/png;base64,${png.toString('base64')}`,
    VW: layout.VW,
    VH: layout.VH,
    pages: layout.pages.map((p) => ({ key: p.key, kind: p.kind, heading: p.heading, buttons: p.buttons.map((b) => ({ id: b.id, key: b.key, label: b.label, kind: b.kind, rect: b.rect, navIds: b.navIds, action: b.action })) })),
    current: page.key,
  };
});

ipcMain.handle('menu:themeThumb', async (_e, project, themeId) => {
  const p = { ...project, menu: { ...project.menu, theme: themeId, background: { type: 'theme' } } };
  const plan = { titles: [{ number: 1, name: 'Main', duration: 60, chapters: [0], bonus: false }], audio: [], subtitles: [] };
  const layout = buildMenuPages(p, plan);
  const r = new MenuRenderer(layout, { width: 320, height: Math.round((320 * layout.VH) / layout.VW), menu: p.menu });
  return `data:image/png;base64,${(await r.background(layout.pages[0])).toString('base64')}`;
});

/* -------------------------------------------------------------- projects */
ipcMain.handle('project:save', async (_e, project, file) => {
  let target = file;
  if (!target) {
    target = (await dialog.showSaveDialog(win, { title: 'Save Project', defaultPath: `${project.name || 'My Disc'}.dfproj`, filters: [{ name: 'DiscForge Project', extensions: ['dfproj'] }] })).filePath;
  }
  if (!target) return null;
  fs.writeFileSync(target, JSON.stringify(project, null, 2));
  settings.recent = [target, ...(settings.recent || []).filter((r) => r !== target)].slice(0, 8);
  saveSettings();
  return target;
});
ipcMain.handle('project:open', async (_e, file) => {
  let target = file;
  if (!target) {
    const r = await dialog.showOpenDialog(win, { title: 'Open Project', filters: [{ name: 'DiscForge Project', extensions: ['dfproj'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    target = r.filePaths[0];
  }
  try {
    const proj = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!proj || proj.version !== 1 || !Array.isArray(proj.items)) throw new Error('invalid');
    const defs = P.defaultProject();
    return { file: target, project: { ...defs, ...proj, menu: { ...defs.menu, ...proj.menu, labels: { ...defs.menu.labels, ...(proj.menu || {}).labels } }, output: { ...defs.output, ...proj.output }, encoding: { ...defs.encoding, ...proj.encoding } } };
  } catch (_) {
    return { error: 'Failed to open the project. The project file is invalid.' };
  }
});

ipcMain.handle('project:new', (_e, kind) => {
  if (kind === 'video') return P.newVideoItem;
  return null;
});

ipcMain.handle('project:estimate', (_e, project) => ({
  size: P.estimateSize(project),
  bitrate: P.planBitrate(project),
  validation: P.validate(project),
  paths: outputPaths(project),
}));

ipcMain.handle('items:create', (_e, kind, payload) => {
  if (kind === 'video') return P.newVideoItem(payload);
  if (kind === 'slideshow') return P.newSlideshowItem(payload);
  if (kind === 'music') return P.newMusicItem(payload);
  return null;
});

/* --------------------------------------------------------------- authoring */
ipcMain.handle('author:start', async (_e, project) => {
  if (job) return { error: 'A task is already running.' };
  job = true; // claim immediately: refreshTools() awaits
  await refreshTools();
  const ctx = new JobContext({
    onProgress: (p) => send('author:progress', p),
    onLog: (l) => send('author:log', l),
  });
  ctx.waitForDisc = async (copy) => {
    const r = await dialog.showMessageBox(win, { type: 'info', message: `Insert a blank disc for copy ${copy}.`, buttons: ['Continue', 'Stop'] });
    if (r.response === 1) ctx.cancel();
  };
  job = ctx;
  powerBlock = require('electron').powerSaveBlocker.start('prevent-app-suspension');
  try {
    const res = await authorProject(project, { tools, caps, ctx });
    send('author:done', res);
    if (project.output.afterCompletion === 'shutdown') {
      await disc.shutdownComputer(60);
      send('author:shutdown', { seconds: 60 });
    }
    return res;
  } catch (e) {
    send('author:failed', { message: e.cancelled ? 'Cancelled' : e.message, cancelled: !!e.cancelled, log: outputPaths(project).log });
    return { error: e.message };
  } finally {
    job = null;
    require('electron').powerSaveBlocker.stop(powerBlock);
  }
});
let powerBlock = null;
ipcMain.handle('author:cancel', () => { if (job && job.cancel) job.cancel(); return true; });
ipcMain.handle('author:cancelShutdown', () => disc.cancelShutdown());

ipcMain.handle('disc:burners', () => disc.listBurners());
ipcMain.handle('disc:burnIso', async (_e, isoPath, burnerId, speed = 0) => {
  if (job) return { error: 'A task is already running.' };
  const ctx = new JobContext({ onProgress: (p) => send('author:progress', p), onLog: (l) => send('author:log', l) });
  job = ctx;
  powerBlock = require('electron').powerSaveBlocker.start('prevent-app-suspension');
  const log = path.join(path.dirname(isoPath), `${path.basename(isoPath, path.extname(isoPath))}_burn.log`);
  ctx.logFile = log;
  try {
    ctx.log(`DiscForge Studio ${app.getVersion()} - burn ${isoPath}`);
    ctx.plan([{ id: 'burn', label: 'Looking for disc burners', weight: 1 }]);
    ctx.beginStep('burn');
    ctx.detail({ kind: 'burn', phase: 'preparing', phaseLabel: 'Looking for disc burners' });
    const burners = await disc.listBurners();
    const burner = burners.find((b) => b.id === burnerId) || burners[0];
    if (!burner) throw new Error('No disc burner was found.');
    ctx.log(`Burners found: ${burners.map((b) => `${b.name} [${b.letter || '?'}] ${b.mediaName}`).join('; ')}`);
    ctx.log(`Burning engine: ${disc.findDfburn() ? 'dfburn.exe (IMAPI2)' : 'PowerShell IMAPI2 fallback'}`);
    ctx.plan([{ id: 'burn', label: `Burning ${path.basename(isoPath)} on ${burner.name}`, weight: 1 }]);
    ctx.beginStep('burn');
    ctx.log(`Burning ${isoPath} to ${burner.name} (${burner.mediaName})`);
    await disc.burnIso(ctx, isoPath, burner, { speed }, (f) => ctx.stepProgress(f));
    ctx.log('Burn complete.');
    const res = { folder: null, iso: null, log, size: fs.statSync(isoPath).size };
    send('author:done', res);
    return res;
  } catch (e) {
    ctx.log(`FAILED: ${e.message}`);
    send('author:failed', { message: e.message, cancelled: !!e.cancelled, log });
    return { error: e.message };
  } finally {
    job = null;
    require('electron').powerSaveBlocker.stop(powerBlock);
  }
});
ipcMain.handle('disc:erase', async (_e, burnerId) => {
  if (job) return { error: 'A task is already running.' };
  const ctx = new JobContext({ onProgress: (p) => send('author:progress', p), onLog: (l) => send('author:log', l) });
  job = ctx;
  try {
    const burners = await disc.listBurners();
    const burner = burners.find((b) => b.id === (burnerId && burnerId.id ? burnerId.id : burnerId)) || burners[0];
    if (!burner) throw new Error('No disc burner was found.');
    ctx.plan([{ id: 'erase', label: `Erasing the disc in ${burner.name}`, weight: 1 }]);
    ctx.beginStep('erase');
    await disc.eraseDisc(ctx, burner, true, (f) => ctx.stepProgress(f));
    const res = { folder: null, iso: null, log: null, size: 0, message: 'The disc was erased and is ready to burn.' };
    send('author:done', res);
    return res;
  } catch (e) {
    ctx.log(`FAILED: ${e.message}`);
    send('author:failed', { message: e.message, cancelled: !!e.cancelled, log: null });
    return { error: e.message };
  } finally {
    job = null;
  }
});

ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:external', (_e, url) => shell.openExternal(url));
