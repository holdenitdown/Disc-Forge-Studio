'use strict';
/**
 * The authoring pipeline: from a project to a disc folder, ISO and/or burned disc.
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, dirSize, freeSpace } = require('./util');
const { probe, grabFrame } = require('./probe');
const P = require('./project');
const { transcodeTitle, passthroughCheck } = require('./encode/video');
const { renderSlideshow, renderMusicAlbum } = require('./encode/compose');
const { buildMenuPages, langLabel } = require('./menu/layout');
const { MenuRenderer } = require('./menu/render');
const { makePopup } = require('./menu/popup');
const dvd = require('./dvd/author');
const bd = require('./bd/author');
const disc = require('./disc');

function safeName(s) {
  return String(s || 'DISC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'DISC';
}

function outputPaths(project) {
  const o = project.output;
  const label = safeName(o.label || project.name);
  const root = o.folder || path.join(require('os').homedir(), 'Videos', 'DiscForge');
  const test = o.testMode ? '_TEST' : '';
  return {
    root,
    label,
    folder: path.join(root, `${label}${test}`),
    iso: o.isoPath || path.join(root, `${label}${test}.iso`),
    work: path.join(root, `.${label}${test}_work`),
    log: path.join(root, `${label}${test}.log`),
  };
}

async function authorProject(project, env) {
  const out = outputPaths(project);
  ensureDir(out.root);
  env.ctx.logFile = out.log;
  fs.writeFileSync(out.log, '');
  try {
    return await authorProjectInner(project, env, out);
  } catch (e) {
    env.ctx.log(e.cancelled ? 'Cancelled by user.' : `FAILED: ${e.message}`);
    throw e;
  }
}

async function authorProjectInner(project, { tools, caps, ctx }, out) {
  const fmt = project.format;
  const testMode = !!project.output.testMode;
  ctx.log(`DiscForge Studio — authoring "${project.name}" as ${fmt.toUpperCase()}${testMode ? ' (test: first 5 minutes)' : ''}`);
  ctx.log(`Tools: ${Object.entries(tools).map(([k, v]) => `${k}=${v || 'missing'}`).join(', ')}`);
  if (fmt === 'dvd') ctx.log(`DVD: ${project.dvd.standard.toUpperCase()} ${project.dvd.aspect}, ${project.dvd.capacity}, ${project.processing === 'passthrough' ? 'copy compliant video' : 're-encode'}`);
  if (fs.existsSync(out.folder) && project.output.makeFolder && !project.output.overwrite) {
    throw new Error(`An output folder named "${path.basename(out.folder)}" already exists in ${out.root}. Change the disc label or delete the folder.`);
  }
  // leftovers of an earlier failed run would mix with this one
  fs.rmSync(out.work, { recursive: true, force: true });
  ensureDir(out.work);
  const { errors, warnings } = P.validate(project);
  if (errors.length) throw new Error(errors.join('\n'));
  warnings.forEach((w) => ctx.log(`Warning: ${w}`));
  if (fmt === 'dvd' && (!tools.dvdauthor || !tools.spumux)) throw new Error('dvdauthor/spumux were not found. Install DVDStyler (free) or point DiscForge at dvdauthor in Settings > Tools.');
  if (fmt !== 'dvd' && !tools.tsmuxer) throw new Error('tsMuxeR was not found. Install it from Settings > Tools.');
  const free = freeSpace(out.root);
  const need = P.estimateSize(project) * (project.output.makeIso ? 2.2 : 1.2);
  if (free != null && free < need && !testMode) throw new Error(`Not enough disk space in ${out.root}: ${(need / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free.`);

  const items = project.items;
  const durOf = (it) => (testMode ? Math.min(300, P.itemDuration(it)) : P.itemDuration(it));
  const steps = [{ id: 'prepare', label: 'Preparing', weight: 1 }];
  items.filter((i) => i.type !== 'video').forEach((i) => steps.push({ id: `render_${i.id}`, label: `Creating ${i.type === 'slideshow' ? 'slideshow' : 'music album'} "${i.title}"`, weight: Math.max(1, durOf(i) / 30) }));
  if (project.menu.firstPlay) steps.push({ id: 'encode_intro', label: 'Creating first-play video', weight: 2 });
  items.forEach((i) => steps.push({ id: `encode_${i.id}`, label: `Converting "${i.title}"`, weight: Math.max(1, durOf(i) / (fmt === 'uhd' ? 4 : 10)) }));
  if (project.menu.enabled) steps.push({ id: 'menus', label: 'Creating menus', weight: 4 });
  steps.push({ id: 'author', label: fmt === 'dvd' ? 'Creating DVD' : fmt === 'uhd' ? 'Creating 4K UHD' : 'Creating Blu-ray', weight: 6 });
  if (project.output.makeIso || project.output.burn) steps.push({ id: 'iso', label: 'Creating ISO', weight: 4 });
  if (project.output.burn) steps.push({ id: 'burn', label: 'Burning disc', weight: 12 });
  ctx.plan(steps);
  ctx.beginStep('prepare');

  // ---------- sources
  const sources = new Map();
  for (const it of items) {
    if (it.type === 'video') { sources.set(it.id, it); continue; }
    ctx.beginStep(`render_${it.id}`);
    const src = it.type === 'slideshow'
      ? await renderSlideshow(ctx, tools, project, it, out.work, (f) => ctx.stepProgress(f))
      : await renderMusicAlbum(ctx, tools, project, it, out.work, (f) => ctx.stepProgress(f));
    src.bonus = it.bonus;
    src.chapters = it.type === 'music' ? { mode: 'custom', list: P.chapterTimes(it) } : it.chapters;
    sources.set(it.id, src);
  }

  // ---------- title list
  const mainItems = items.filter((i) => !i.bonus);
  const bonusItems = items.filter((i) => i.bonus);
  const titles = [];
  if (project.titleMode === 'merge' && mainItems.length > 1) {
    titles.push({ name: project.menu.title || project.name, segments: mainItems.map((i) => sources.get(i.id)), items: mainItems, bonus: false });
  } else {
    for (const it of mainItems) titles.push({ name: it.title, segments: [sources.get(it.id)], items: [it], bonus: false });
  }
  for (const it of bonusItems) titles.push({ name: it.title, segments: [sources.get(it.id)], items: [it], bonus: true });
  if (project.menu.firstPlay && project.menu.firstPlay.file) {
    const info = project.menu.firstPlay.info || await probe(tools, project.menu.firstPlay.file);
    const introItem = { ...P.newVideoItem(info), id: 'intro', title: 'Intro' };
    introItem.chapters = { mode: 'none', list: [] };
    introItem.subtitles = [];
    introItem.audioTracks = introItem.audioTracks.slice(0, 1);
    titles.push({ name: 'Intro', segments: [introItem], items: [introItem], bonus: false, intro: true });
  }
  titles.forEach((t, i) => { t.number = i + 1; });

  // ---------- encode
  const bitrate = P.planBitrate(project, { testMode });
  ctx.log(`Planned video bitrate: ${(bitrate / 1e6).toFixed(2)} Mbit/s`);
  for (const t of titles) {
    t.results = [];
    for (const seg of t.segments) {
      ctx.beginStep(t.intro ? 'encode_intro' : `encode_${seg.id === 'intro' ? 'intro' : t.items[t.segments.indexOf(seg)].id}`);
      let passthrough = false;
      if (project.processing === 'passthrough' && fmt !== 'dvd' && !seg.generated) {
        const chk = passthroughCheck(project, seg.info);
        passthrough = chk.ok;
        if (!chk.ok) ctx.log(`"${seg.title}" will be re-encoded: ${chk.reason}.`);
      }
      const res = await transcodeTitle(ctx, tools, caps, project, seg, {
        outDir: out.work, bitrate, testMode, passthrough, onProgress: (f) => ctx.stepProgress(f),
      });
      res.source = seg;
      t.results.push(res);
    }
    // chapters (absolute within the title)
    let offset = 0;
    t.chapters = [];
    t.results.forEach((r, i) => {
      const it = t.segments[i].generated ? t.items[i] : t.segments[i];
      const ch = P.chapterTimes(t.segments[i].generated && t.items[i].type === 'music' ? t.items[i] : it, r.duration).filter((c) => c < r.duration - 0.5);
      (ch.length ? ch : [0]).forEach((c) => t.chapters.push(Math.round((offset + c) * 1000) / 1000));
      offset += r.duration;
    });
    t.chapters = [...new Set(t.chapters)].sort((a, b) => a - b);
    t.duration = offset;
  }

  // ---------- disc plan for menus
  const first = titles.find((t) => !t.bonus && !t.intro) || titles[0];
  const firstRes = first.results[0];
  const discPlan = {
    titles: titles.filter((t) => !t.intro).map((t) => ({ number: t.number, name: t.name, duration: t.duration, chapters: t.chapters, bonus: t.bonus })),
    audio: firstRes.audio.map((a, i) => ({ number: i + 1, lang: a.lang, label: langLabel(a.lang, i, 'Audio') })),
    subtitles: firstRes.subs.map((s, i) => ({ number: i + 1, lang: s.lang, label: langLabel(s.lang, i, 'Subtitle') })),
  };

  // ---------- menus
  const menuPages = [];
  let layout = null;
  let menuOpts = null;
  if (project.menu.enabled) {
    ctx.beginStep('menus');
    const thumbDir = ensureDir(path.join(out.work, 'thumbs'));
    for (const [ti, t] of titles.entries()) {
      if (t.intro) continue;
      const pt = discPlan.titles.find((x) => x.number === t.number);
      pt.chapterThumbs = [];
      for (const [ci, c] of t.chapters.entries()) {
        // locate the segment containing this chapter
        let acc = 0;
        let seg = 0;
        while (seg < t.results.length - 1 && c >= acc + t.results[seg].duration) { acc += t.results[seg].duration; seg++; }
        const r = t.results[seg];
        const at = (r.start || 0) + (c - acc) + Math.min(3, r.duration * 0.05);
        const png = path.join(thumbDir, `t${t.number}_c${ci}.png`);
        try {
          await grabFrame(tools, r.source.file, at, png, { width: 640, hdr: r.source.info.video && r.source.info.video.hdr !== 'sdr' });
          pt.chapterThumbs.push(png);
        } catch (_) { pt.chapterThumbs.push(null); }
        ctx.stepProgress(0.3 * (ti + ci / t.chapters.length) / titles.length);
      }
      const it0 = t.items[0];
      if (it0 && it0.thumbnailAt != null && it0.type === 'video') {
        const png = path.join(thumbDir, `t${t.number}.png`);
        try { await grabFrame(tools, t.results[0].source.file, (t.results[0].start || 0) + it0.thumbnailAt, png, { width: 640, hdr: it0.info.video && it0.info.video.hdr !== 'sdr' }); pt.thumb = png; } catch (_) { pt.thumb = pt.chapterThumbs[0]; }
      } else pt.thumb = pt.chapterThumbs[0];
    }
    layout = buildMenuPages(project, discPlan);
    const m = project.menu;
    const motion = m.background.type === 'video' && m.background.file ? m.background : null;
    const music = m.music && m.music.file ? m.music : null;
    let duration = 2;
    if (motion || music) {
      const lens = [];
      if (motion) { const mi = await probe(tools, motion.file); lens.push(Math.max(1, (motion.end || mi.duration) - (motion.start || 0))); }
      if (music) { const mi = await probe(tools, music.file); lens.push(Math.max(1, (music.end || mi.duration) - (music.start || 0))); }
      duration = Math.max(4, Math.min(m.background.maxDuration || 60, ...lens));
      if (testMode) duration = Math.min(duration, 30);
    }
    menuOpts = { duration, music: music && music.file, musicStart: music && music.start, volume: music && music.volume, fadeIn: music && music.fadeIn, fadeOut: music && music.fadeOut, motionVideo: motion && motion.file, motionStart: motion && motion.start };
    const still = !motion && !music;
    if (fmt === 'dvd') {
      const ntsc = project.dvd.standard === 'ntsc';
      const r = new MenuRenderer(layout, { width: 720, height: ntsc ? 480 : 576, menu: m, transparentBackground: !!motion });
      for (const [i, page] of layout.pages.entries()) {
        ctx.check();
        const bgPng = path.join(out.work, `menu_${i}.png`);
        fs.writeFileSync(bgPng, await r.background(page));
        const masks = r.dvdMasks(page);
        const hl = path.join(out.work, `menu_${i}_hl.png`);
        const sel = path.join(out.work, `menu_${i}_sel.png`);
        fs.writeFileSync(hl, masks.highlight);
        fs.writeFileSync(sel, masks.select);
        const raw = await dvd.encodeMenuPage(ctx, tools, project, bgPng, path.join(out.work, `menu_${i}_raw.mpg`), { ...menuOpts, duration: still ? 1.5 : duration });
        const xml = path.join(out.work, `menu_${i}.xml`);
        fs.writeFileSync(xml, dvd.spumuxMenuXml(project, masks, hl, sel));
        const mpg = path.join(out.work, `menu_${i}.mpg`);
        await dvd.spumux(ctx, tools, xml, raw, mpg, 0);
        menuPages.push({ page, mpg, still });
        ctx.stepProgress(0.3 + 0.7 * (i + 1) / layout.pages.length);
      }
    } else {
      const spec = bd.menuVideoSpec(project);
      const bgR = new MenuRenderer(layout, { width: spec.width, height: spec.height, menu: m, transparentBackground: !!motion });
      const hlR = new MenuRenderer(layout, { width: spec.igWidth, height: spec.igHeight, menu: m });
      for (const [i, page] of layout.pages.entries()) {
        ctx.check();
        const bgPng = path.join(out.work, `menu_${i}.png`);
        fs.writeFileSync(bgPng, await bgR.background(page));
        menuPages.push({ page, bgPng, highlights: hlR.highlights(page), still });
        ctx.stepProgress(0.3 + 0.7 * (i + 1) / layout.pages.length);
      }
    }
  }

  // ---------- author
  ctx.beginStep('author');
  const authorDir = project.output.makeFolder ? out.folder : path.join(out.work, 'disc');
  if (fmt === 'dvd') {
    const blank = await dvd.makeBlank(ctx, tools, project, path.join(out.work, 'blank.mpg'));
    const dvdTitles = [];
    for (const t of titles) {
      // DVD subtitles (text) are rendered into the program stream by spumux
      const mpgs = [];
      for (const r of t.results) {
        const textSubs = r.subs.filter((s) => s.kind === 'text');
        mpgs.push(textSubs.length ? await dvd.addTextSubtitles(ctx, tools, project, r.mpg, textSubs, out.work) : r.mpg);
      }
      dvdTitles.push({ number: t.number, mpg: mpgs[0], mpgs, chapters: t.chapters, audio: t.results[0].audio, subs: t.results[0].subs.filter((s) => s.kind === 'text'), bonus: t.bonus, intro: t.intro });
    }
    // merged DVD titles: concatenate program streams (same encoding parameters)
    for (const t of dvdTitles) {
      if (t.mpgs.length > 1) {
        const joined = path.join(out.work, `title_${t.number}_joined.mpg`);
        const ws = fs.createWriteStream(joined);
        for (const f of t.mpgs) await new Promise((res, rej) => fs.createReadStream(f).on('error', rej).on('end', res).pipe(ws, { end: false }));
        await new Promise((r) => ws.end(r));
        t.mpg = joined;
      }
    }
    const intro = dvdTitles.find((t) => t.intro);
    await dvd.authorDvd(ctx, tools, project, { titles: dvdTitles, menuPages, blankMpg: blank, firstPlayTitle: intro ? intro.number : null }, authorDir);
  } else {
    const spec = bd.menuVideoSpec(project);
    const bdTitles = titles.map((t) => ({
      number: t.number,
      video: t.results.length > 1 ? t.results.map((r) => r.video) : t.results[0].video,
      videoCodec: t.results[0].videoCodec,
      fps: t.results[0].target.fps,
      audio: t.results[0].audio.map((a, ai) => ({ ...a, file: t.results.length > 1 ? t.results.map((r) => (r.audio[ai] || r.audio[0]).file) : a.file })),
      subs: t.results.length > 1 ? [] : t.results[0].subs,
      chapters: t.chapters,
      duration: t.duration,
      bonus: t.bonus,
      intro: t.intro,
    }));
    if (titles.some((t) => t.results.length > 1 && t.results.some((r) => r.subs.length))) ctx.log('Note: subtitles are not carried over when several videos are merged into one title.');
    const popup = project.menu.enabled && project.menu.popup ? makePopup(project, discPlan, spec.igWidth, spec.igHeight) : null;
    await bd.authorBluray(ctx, tools, project, { titles: bdTitles, menuPages, menuOpts, popup }, authorDir, out.work, (f) => ctx.stepProgress(f));
  }
  const discSize = dirSize(authorDir);
  ctx.log(`Disc structure created: ${(discSize / 1e9).toFixed(2)} GB in ${authorDir}`);

  // ---------- ISO / burn
  let isoPath = null;
  if (project.output.makeIso || project.output.burn) {
    ctx.beginStep('iso');
    isoPath = project.output.makeIso ? out.iso : path.join(out.work, 'burn.iso');
    await disc.makeIso(ctx, authorDir, isoPath, out.label, fmt === 'dvd' ? 'dvd' : 'bd', (f) => ctx.stepProgress(f));
    ctx.log(`ISO created: ${isoPath}`);
  }
  if (project.output.burn) {
    ctx.beginStep('burn');
    const burners = await disc.listBurners();
    const burner = burners.find((b) => b.id === project.output.burner) || burners[0];
    if (!burner) throw new Error('No disc burner was found.');
    for (let copy = 0; copy < Math.max(1, project.output.copies || 1); copy++) {
      if (copy > 0 && ctx.waitForDisc) await ctx.waitForDisc(copy + 1);
      await disc.burnIso(ctx, isoPath, burner, { label: out.label, speed: project.output.writeSpeed || 0 }, (f) => ctx.stepProgress(f));
    }
  }

  // ---------- cleanup
  if (!project.keepWorkFiles) {
    for (const e of fs.readdirSync(out.work)) {
      const p = path.join(out.work, e);
      if (isoPath && p === isoPath && project.output.makeIso) continue;
      fs.rmSync(p, { recursive: true, force: true });
    }
    fs.rmSync(out.work, { recursive: true, force: true });
  }
  ctx.stepProgress(1);
  return { folder: project.output.makeFolder ? authorDir : null, iso: project.output.makeIso ? isoPath : null, log: out.log, size: discSize };
}

module.exports = { authorProject, outputPaths };
