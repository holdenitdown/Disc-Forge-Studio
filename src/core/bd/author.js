'use strict';
/**
 * Blu-ray / 4K UHD authoring: menus (HDMV IG), titles, pop-up menu, navigation.
 *
 * General purpose registers:
 *   GPR0 : chapter mark to start the next title at
 *   GPR1 : "play all" flag
 *   GPR3 : selected primary audio stream (1-based)
 *   GPR4 : selected subtitle stream (1-based, 0 = off)
 */
const fs = require('fs');
const path = require('path');
const { run, ensureDir, secToTimestamp } = require('../util');
const { cmd, gpr } = require('./hdmv');
const ig = require('./ig');
const patch = require('./patch');
const nav = require('./navigation');
const { FPS_EXPR } = require('../encode/video');

const R = { CHAPTER: gpr(0), PLAYALL: gpr(1), AUDIO: gpr(3), SUB: gpr(4) };

function menuVideoSpec(project) {
  if (project.format === 'uhd') return { width: 3840, height: 2160, fps: 23.976, codec: 'hevc', igWidth: 1920, igHeight: 1080 };
  if (project.bd.resolution === '720') return { width: 1280, height: 720, fps: 59.94, codec: 'h264', igWidth: 1280, igHeight: 720 };
  return { width: 1920, height: 1080, fps: 23.976, codec: 'h264', igWidth: 1920, igHeight: 1080 };
}

/** Encode a menu page background into an elementary video + AC3 audio. */
async function encodeMenuClip(ctx, tools, project, bgPng, base, opts) {
  const spec = menuVideoSpec(project);
  const fps = FPS_EXPR[spec.fps];
  const duration = opts.duration;
  const vfile = `${base}.${spec.codec === 'hevc' ? 'hevc' : 'h264'}`;
  const afile = `${base}.ac3`;
  const vin = opts.motionVideo
    ? ['-ss', String(opts.motionStart || 0), '-t', String(duration), '-i', opts.motionVideo, '-i', bgPng]
    : ['-loop', '1', '-framerate', fps, '-t', String(duration), '-i', bgPng];
  const vf = opts.motionVideo
    ? `[0:v]scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase,crop=${spec.width}:${spec.height},fps=${fps},setsar=1[mv];[1:v]scale=${spec.width}:${spec.height}[art];[mv][art]overlay=0:0[v]`
    : `[0:v]scale=${spec.width}:${spec.height}:flags=lanczos,fps=${fps},setsar=1[v]`;
  const gop = Math.round(spec.fps);
  const venc = spec.codec === 'hevc'
    ? ['-c:v', 'libx265', '-preset', 'fast', '-b:v', '12000k', '-x265-params', `uhd-bd=1:keyint=${gop}:min-keyint=1:no-open-gop=1:repeat-headers=1:aud=1:hrd=1:vbv-maxrate=40000:vbv-bufsize=40000:colorprim=bt709:transfer=bt709:colormatrix=bt709`, '-pix_fmt', 'yuv420p10le', '-f', 'hevc']
    : ['-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-profile:v', 'high', '-level', '4.1', '-b:v', '8000k', '-x264-params', `bluray-compat=1:keyint=${gop}:min-keyint=1:open-gop=0:vbv-maxrate=30000:vbv-bufsize=30000:nal-hrd=vbr:slices=4:aud=1:colorprim=bt709:transfer=bt709:colormatrix=bt709`, '-pix_fmt', 'yuv420p', '-f', 'h264'];
  await run(ctx, tools.ffmpeg, ['-y', '-hide_banner', ...vin, '-filter_complex', vf, '-map', '[v]', ...venc, '-t', String(duration), vfile]);
  const ain = opts.music ? ['-ss', String(opts.musicStart || 0), '-t', String(duration), '-i', opts.music] : ['-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo'];
  const af = ['aresample=48000', 'aformat=channel_layouts=stereo'];
  if (opts.music && opts.volume != null) af.push(`volume=${opts.volume / 100}`);
  if (opts.music && opts.fadeIn) af.push('afade=t=in:d=1.5');
  if (opts.music && opts.fadeOut) af.push(`afade=t=out:st=${Math.max(0, duration - 2)}:d=2`);
  await run(ctx, tools.ffmpeg, ['-y', '-hide_banner', ...ain, '-af', af.join(','), '-c:a', 'ac3', '-b:a', '256k', '-t', String(duration), afile]);
  return { video: vfile, audio: afile, spec };
}

function videoTrackLine(file, codec, fps) {
  const tag = codec === 'hevc' ? 'V_MPEGH/ISO/HEVC' : codec === 'mpeg2' ? 'V_MPEG-2' : 'V_MPEG4/ISO/AVC';
  return `${tag}, ${file}, insertSEI, contSPS${fps ? `, fps=${fps}` : ''}`;
}

function audioTrackLine(a, file) {
  const tag = a.codec === 'lpcm' || /pcm/.test(a.codec) ? 'A_LPCM' : a.codec === 'dts' ? 'A_DTS' : 'A_AC3';
  return `${tag}, ${file}, lang=${a.lang || 'und'}`;
}

const q = (f) => `"${f}"`;
/** One file, or several joined with '+' (merged titles). */
const files = (x) => (Array.isArray(x) ? x.map(q).join('+') : q(x));

/** Run tsMuxeR for one clip/playlist number. */
async function muxClip(ctx, tools, outDir, workDir, num, lines, { chapters, label } = {}) {
  const opts = ['--no-pcr-on-video-pid', '--new-audio-pes', '--blu-ray', '--vbr', `--mplsOffset=${num}`, `--m2tsOffset=${num}`];
  if (chapters && chapters.length) opts.push(`--custom-chapters=${chapters.map((c) => secToTimestamp(c)).join(';')}`);
  else opts.push('--custom-chapters=00:00:00.000');
  if (label) opts.push(`--label="${label.replace(/"/g, '')}"`);
  const meta = path.join(workDir, `clip_${num}.meta`);
  fs.writeFileSync(meta, `MUXOPT ${opts.join(' ')}\n${lines.join('\n')}\n`);
  await run(ctx, tools.tsmuxer, [meta, outDir], {
    onLine: (l) => {
      const m = /([\d.]+)% complete/.exec(l);
      if (m && ctx.clipProgress) ctx.clipProgress(Number(m[1]) / 100);
    },
  });
  const id = String(num).padStart(5, '0');
  for (const f of [`BDMV/STREAM/${id}.m2ts`, `BDMV/CLIPINF/${id}.clpi`, `BDMV/PLAYLIST/${id}.mpls`]) {
    if (!fs.existsSync(path.join(outDir, f))) throw new Error(`tsMuxeR did not produce ${f}`);
  }
}

/** Convert the last PG track of a clip into an IG stream. */
function convertIgTrack(outDir, num, { still = false } = {}) {
  const id = String(num).padStart(5, '0');
  const clpi = path.join(outDir, 'BDMV', 'CLIPINF', `${id}.clpi`);
  // find the last PG PID in the clip info
  const b = fs.readFileSync(clpi);
  const progStart = b.readUInt32BE(12);
  let p = progStart + 6;
  const numProg = b[progStart + 5];
  let lastPg = null;
  for (let i = 0; i < numProg; i++) {
    p += 6;
    const n = b[p++];
    p++;
    for (let s = 0; s < n; s++) {
      const pid = b.readUInt16BE(p);
      const len = b[p + 2];
      if (b[p + 3] === 0x90) lastPg = pid;
      p += 3 + len;
    }
  }
  if (lastPg == null) throw new Error(`Clip ${id}: menu graphics track not found`);
  const pidMap = new Map([[lastPg, 0x1400]]);
  const stats = patch.patchM2ts(path.join(outDir, 'BDMV', 'STREAM', `${id}.m2ts`), pidMap);
  for (const sub of ['', 'BACKUP']) {
    const c = path.join(outDir, 'BDMV', sub, 'CLIPINF', `${id}.clpi`);
    const m = path.join(outDir, 'BDMV', sub, 'PLAYLIST', `${id}.mpls`);
    if (fs.existsSync(c)) patch.patchClpi(c, pidMap);
    if (fs.existsSync(m)) patch.patchMpls(m, pidMap, still ? { still: 'infinite' } : {});
  }
  return stats;
}

function setStreamChain(nAudio, nSubs) {
  const out = [];
  for (let a = 1; a <= nAudio; a++) out.push(cmd.eq(R.AUDIO, a), cmd.setStream({ audio: a }));
  out.push(cmd.eq(R.SUB, 0), cmd.setStream({ subtitle: 0 }));
  for (let s = 1; s <= nSubs; s++) out.push(cmd.eq(R.SUB, s), cmd.setStream({ subtitle: s }));
  return out;
}

/**
 * plan = {
 *   titles: [{ number, video, videoCodec, fps, audio:[{file,lang,codec}], subs:[{file,lang,kind}], chapters, bonus, intro }],
 *   menuPages: [{ page, bgPng, highlights:[{button, rect, selected, activated}], still, motion }],
 *   menuOpts: { duration, music, musicStart, volume, fadeIn, fadeOut, motionVideo, motionStart },
 *   popup: { layout pages + highlights } | null
 * }
 */
async function authorBluray(ctx, tools, project, plan, outDir, workDir, progress = () => {}) {
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  const menusOn = project.menu.enabled && plan.menuPages.length > 0;
  const titles = plan.titles;
  const mains = titles.filter((t) => !t.bonus && !t.intro);
  const intro = titles.find((t) => t.intro);
  const nAudio = Math.max(1, ...titles.map((t) => t.audio.length));
  const nSubs = Math.max(0, ...titles.map((t) => t.subs.length));
  const spec = menuVideoSpec(project);

  // numbering: menu pages 1..P, then titles (incl. intro)
  const pageNum = (i) => i + 1;
  const firstTitleNum = (menusOn ? plan.menuPages.length : 0) + 1;
  titles.forEach((t, i) => { t.clipNum = firstTitleNum + i; });
  // movie objects: 0 first play, 1..P menu pages, then one per title
  const objFirstPlay = 0;
  const objPage = (i) => 1 + i;
  const objTitleBase = 1 + (menusOn ? plan.menuPages.length : 0);
  const playable = titles.filter((t) => !t.intro);
  const indexTitleOf = (t) => playable.indexOf(t) + 1; // 1-based title number in index.bdmv
  const objTitle = (t) => objTitleBase + titles.indexOf(t);
  const topObj = menusOn ? objPage(0) : objTitle(mains[0] || titles[0]);
  const titleByNumber = Object.fromEntries(titles.map((t) => [t.number, t]));

  const buttonCommands = (action) => {
    switch (action.type) {
      case 'play': return [cmd.move(R.PLAYALL, 0), cmd.move(R.CHAPTER, action.chapter), cmd.jumpTitle(indexTitleOf(titleByNumber[action.title]))];
      case 'playAll': return [cmd.move(R.PLAYALL, 1), cmd.move(R.CHAPTER, 0), cmd.jumpTitle(indexTitleOf(titleByNumber[action.title]))];
      case 'page': return [cmd.jumpObject(objPage(action.pageIndex))];
      case 'audio': return [cmd.move(R.AUDIO, action.track), cmd.setStream({ audio: action.track }), cmd.jumpObject(objPage(0))];
      case 'subtitle': return [cmd.move(R.SUB, action.track), cmd.jumpObject(objPage(0))];
      default: return [cmd.jumpObject(objPage(0))];
    }
  };

  const totalSteps = (menusOn ? plan.menuPages.length : 0) + titles.length;
  let step = 0;
  const tick = (f = 0) => progress((step + f) / totalSteps);

  // ---- menu clips
  if (menusOn) {
    for (const [i, mp] of plan.menuPages.entries()) {
      ctx.check();
      const base = path.join(workDir, `menu_${i}`);
      const mo = plan.menuOpts;
      const clip = await encodeMenuClip(ctx, tools, project, mp.bgPng, base, {
        duration: mp.still ? 2 : mo.duration, music: mo.music, musicStart: mo.musicStart, volume: mo.volume, fadeIn: mo.fadeIn, fadeOut: mo.fadeOut,
        motionVideo: mo.motionVideo, motionStart: mo.motionStart,
      });
      const igPage = {
        id: 0,
        // 0xFFFF: keep the player's current selection (PSR10) so looping motion menus don't
        // jump back to the first button; the page's movie object sets PSR10 on entry.
        defaultButton: 0xffff,
        buttons: mp.highlights.map(({ button, rect, selected, activated }) => ({
          id: button.id, x: rect.x, y: rect.y,
          up: button.navIds.up, down: button.navIds.down, left: button.navIds.left, right: button.navIds.right,
          selected, activated, commands: buttonCommands(button.action),
        })),
      };
      const ds = ig.buildDisplaySet({ width: spec.igWidth, height: spec.igHeight, fps: spec.fps, popup: false, pages: [igPage] });
      ctx.log(`Menu page ${i + 1}: ${ds.stats.objects} graphics objects, ${ds.stats.colors} colours, ${(ds.stats.objectBytes / 1024).toFixed(0)} KB`);
      if (ds.stats.objectBytes > 900 * 1024) ctx.log('Warning: menu graphics exceed 900 KB; some players may not show all highlights.');
      const supFile = `${base}_ig.sup`;
      fs.writeFileSync(supFile, ig.toSup(ds, 0.02).sup);
      const fpsStr = String(spec.fps);
      await muxClip(ctx, tools, outDir, workDir, pageNum(i), [
        videoTrackLine(q(clip.video), spec.codec, fpsStr),
        `A_AC3, ${q(clip.audio)}, lang=und`,
        `S_HDMV/PGS, ${q(supFile)}, fps=${fpsStr}, lang=und`,
      ], { label: project.output.label });
      convertIgTrack(outDir, pageNum(i), { still: mp.still });
      step++; tick();
    }
  }

  // ---- title clips
  for (const t of titles) {
    ctx.check();
    const lines = [videoTrackLine(files(t.video), t.videoCodec, String(t.fps))];
    t.audio.forEach((a) => lines.push(audioTrackLine(a, files(a.file))));
    t.subs.forEach((s) => {
      if (s.kind === 'pgs') lines.push(`S_HDMV/PGS, ${q(s.file)}, fps=${t.fps}, lang=${s.lang}`);
      else lines.push(`S_TEXT/UTF8, ${q(s.file)}, font-name="${project.encoding.subtitleFont || (process.platform === 'win32' ? 'Arial' : 'DejaVu Sans')}", font-size=${project.format === 'uhd' ? 65 : 65}, font-color=${subColor(project.encoding.textSubtitleColor)}, bottom-offset=${Math.round(spec.igHeight * 0.05)}, font-border=4, text-align=center, video-width=${spec.igWidth}, video-height=${spec.igHeight}, fps=${t.fps}, lang=${s.lang}`);
    });
    let popupSup = null;
    if (menusOn && project.menu.popup && plan.popup && !t.intro) {
      popupSup = path.join(workDir, `popup_${t.number}.sup`);
      fs.writeFileSync(popupSup, buildPopupSup(plan.popup, t, { spec, buttonCommands, nAudio, nSubs, titleChapters: t.chapters, objTop: objPage(0) }));
      lines.push(`S_HDMV/PGS, ${q(popupSup)}, fps=${t.fps}, lang=und`);
    }
    ctx.clipProgress = (f) => tick(f);
    await muxClip(ctx, tools, outDir, workDir, t.clipNum, lines, { chapters: t.chapters, label: project.output.label });
    ctx.clipProgress = null;
    if (popupSup) convertIgTrack(outDir, t.clipNum);
    step++; tick();
  }

  // ---- navigation
  const objects = [];
  const fp = [cmd.move(R.AUDIO, Math.min(nAudio, Math.max(1, project.output.defaultAudio || 1))), cmd.move(R.SUB, Math.min(nSubs, Math.max(0, project.output.defaultSubtitle || 0))), cmd.move(R.CHAPTER, 0)];
  if (intro) fp.push(cmd.playPL(intro.clipNum));
  if (menusOn && !project.menu.skipMenu) fp.push(cmd.jumpObject(objPage(0)));
  else fp.push(cmd.move(R.PLAYALL, mains.length > 1 ? 1 : 0), cmd.jumpObject(objTitle(mains[0] || titles[0])));
  objects.push({ commands: fp, menuCallMask: true, titleSearchMask: true });
  if (menusOn) {
    plan.menuPages.forEach((mp, i) => objects.push({ commands: [cmd.setButtonPage({ button: 1 }), cmd.playPL(pageNum(i)), cmd.goto(1)], menuCallMask: false, titleSearchMask: false }));
  }
  for (const t of titles) {
    const c = [...setStreamChain(nAudio, nSubs), cmd.playPLatMK(t.clipNum, R.CHAPTER), cmd.move(R.CHAPTER, 0)];
    const idx = mains.indexOf(t);
    if (idx >= 0 && idx < mains.length - 1) c.push(cmd.eq(R.PLAYALL, 1), cmd.jumpObject(objTitle(mains[idx + 1])));
    if (menusOn) c.push(cmd.jumpObject(objPage(0)));
    else if (project.encoding.loopWithoutMenu && mains.length) c.push(cmd.jumpObject(objTitle(mains[(idx + 1) % mains.length])));
    // otherwise playback simply stops at the end of the last title
    objects.push({ commands: c, resume: true });
  }
  nav.writeNavigation(path.join(outDir, 'BDMV'), {
    firstPlayObject: objFirstPlay,
    topMenuObject: topObj,
    titleObjects: playable.map((t) => objTitle(t)),
  }, objects);
  return outDir;
}

function subColor(name) {
  return { white: '0xffffffff', yellow: '0xffffff00', red: '0xffff3030', green: '0xff30ff30', blue: '0xff3080ff', purple: '0xffb060ff' }[name] || '0xffffffff';
}

/** Pop-up menu IG stream for a title: repeated at every chapter so it survives seeking. */
function buildPopupSup(popup, title, { spec, nAudio, nSubs, objTop }) {
  const pages = popup.build(title, {
    commands: {
      restart: [cmd.popupOff(), cmd.linkMK(0)],
      chapter: (i) => [cmd.popupOff(), cmd.linkMK(i)],
      audio: (n) => [cmd.move(R.AUDIO, n), cmd.popupOff(), cmd.setStream({ audio: n })],
      subtitle: (n) => [cmd.move(R.SUB, n), cmd.popupOff(), cmd.setStream({ subtitle: n })],
      topMenu: [cmd.popupOff(), cmd.jumpObject(objTop)],
      page: (p) => [cmd.setButtonPage({ page: p, button: 1 })],
    },
    nAudio, nSubs,
  });
  const ds = ig.buildDisplaySet({ width: spec.igWidth, height: spec.igHeight, fps: title.fps, popup: true, pages });
  const times = popupRepeatTimes(title);
  const parts = times.map((t, i) => {
    if (i > 0) {
      // acquisition point: same composition, state = 01
      ds.ics = ds.ics.map((seg) => { const s = Buffer.from(seg); s[3 + 7] = 0x40; return s; });
      ds.detectionPcs = null;
    }
    return ig.toSup(ds, t).sup;
  });
  return Buffer.concat(parts);
}

module.exports = { authorBluray, menuVideoSpec, convertIgTrack, encodeMenuClip, muxClip };

/**
 * When to (re)send the pop-up display set. Hardware players need an acquisition point
 * after random access points; libbluray (VLC/Kodi) keeps the decoded menu across seeks but
 * re-initialises it on every repeat, so repeats are spaced out (env DISCFORGE_POPUP_REPEAT).
 */
function popupRepeatTimes(title) {
  const every = Number(process.env.DISCFORGE_POPUP_REPEAT || 60);
  if (!every) return [0.02];
  const times = [0.02];
  for (let t = every; t < (title.duration || 0) - 1; t += every) times.push(t);
  return times;
}
