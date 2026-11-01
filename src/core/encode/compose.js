'use strict';
/**
 * Builds intermediate videos for slideshows and music albums so they can flow
 * through the normal title encoder.
 */
const fs = require('fs');
const path = require('path');
const { run, ffmpegProgress, ffFilterPath } = require('../util');
const { probe } = require('../probe');

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');

/** Friendly transition names (shown in the UI) -> ffmpeg xfade transitions. */
const TRANSITIONS = {
  none: null,
  fade: 'fade',
  dissolve: 'dissolve',
  'fade to black': 'fadeblack',
  'fade to white': 'fadewhite',
  'wipe left': 'wipeleft',
  'wipe right': 'wiperight',
  'wipe up': 'wipeup',
  'wipe down': 'wipedown',
  'slide left': 'slideleft',
  'slide right': 'slideright',
  'slide up': 'slideup',
  'slide down': 'slidedown',
  'circle open': 'circleopen',
  'circle close': 'circleclose',
  'rectangle crop': 'rectcrop',
  'diagonal top-left': 'diagtl',
  'diagonal bottom-right': 'diagbr',
  radial: 'radial',
  'zoom in': 'zoomin',
  pixelize: 'pixelize',
  'squeeze horizontal': 'squeezeh',
  'squeeze vertical': 'squeezev',
  'smooth left': 'smoothleft',
  'horizontal blinds': 'hlslice',
  random: 'random',
};
const RANDOM_POOL = Object.values(TRANSITIONS).filter((v) => v && v !== 'random');

function intermediateFormat(project) {
  if (project.format === 'dvd') {
    const ntsc = project.dvd.standard === 'ntsc';
    return { width: 1280, height: 720, fps: ntsc ? 29.97 : 25, fpsExpr: ntsc ? '30000/1001' : '25' };
  }
  if (project.format === 'uhd') return { width: 3840, height: 2160, fps: 23.976, fpsExpr: '24000/1001' };
  if (project.bd.resolution === '720') return { width: 1280, height: 720, fps: 59.94, fpsExpr: '60000/1001' };
  return { width: 1920, height: 1080, fps: 23.976, fpsExpr: '24000/1001' };
}

const MEZZ = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p'];

/** Fill the frame: blurred cover background + fitted picture. */
function fitFilter(W, H) {
  return `split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:2,eq=brightness=-0.08[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

async function renderSlideshow(ctx, tools, project, item, outDir, onProgress) {
  const ss = item.slideshow;
  const fmt = intermediateFormat(project);
  const { width: W, height: H, fps, fpsExpr } = fmt;
  const xf = TRANSITIONS[ss.transition] === undefined ? 'fade' : TRANSITIONS[ss.transition];
  const td = xf ? Math.max(0.2, Math.min(ss.transitionDuration, ss.slideDuration / 2)) : 0;
  const BATCH = 24;
  const batches = [];
  for (let i = 0; i < ss.images.length; i += BATCH) batches.push(ss.images.slice(i, i + BATCH));
  const batchFiles = [];
  let doneFrames = 0;
  const totalSec = ss.images.reduce((s, im) => s + (im.duration || ss.slideDuration), 0);

  for (const [bi, batch] of batches.entries()) {
    const args = ['-y', '-hide_banner'];
    const filters = [];
    batch.forEach((im, i) => {
      const d = im.duration || ss.slideDuration;
      const frames = Math.round(d * fps);
      args.push('-i', im.file);
      let chain = `[${i}:v]format=rgb24,${fitFilter(W, H)}`;
      if (ss.kenBurns) {
        const zin = (bi * BATCH + i) % 2 === 0;
        const z = zin ? `min(1+0.10*on/${frames},1.10)` : `max(1.10-0.10*on/${frames},1.0)`;
        chain += `,scale=${W * 2}:${H * 2}:flags=bicubic,zoompan=z='${z}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fpsExpr}`;
      } else {
        chain += `,loop=loop=${frames - 1}:size=1:start=0,fps=${fpsExpr}`;
      }
      chain += `,trim=duration=${d},setpts=PTS-STARTPTS,fps=${fpsExpr},settb=1/90000,format=yuv420p[v${i}]`;
      filters.push(chain);
    });
    let last = 'v0';
    let offset = (batch[0].duration || ss.slideDuration) - td;
    for (let i = 1; i < batch.length; i++) {
      const out = `x${i}`;
      if (xf) {
        const name = xf === 'random' ? RANDOM_POOL[(bi * BATCH + i) % RANDOM_POOL.length] : xf;
        filters.push(`[${last}][v${i}]xfade=transition=${name}:duration=${td}:offset=${offset.toFixed(3)}[${out}]`);
        offset += (batch[i].duration || ss.slideDuration) - td;
      } else {
        filters.push(`[${last}][v${i}]concat=n=2:v=1:a=0[${out}]`);
        offset += batch[i].duration || ss.slideDuration;
      }
      last = out;
    }
    const outFile = path.join(outDir, `${item.id}_ss${bi}.mkv`);
    args.push('-filter_complex', filters.join(';'), '-map', `[${last}]`, ...MEZZ, '-r', fpsExpr, outFile);
    const batchSec = batch.reduce((s, im) => s + (im.duration || ss.slideDuration), 0);
    const before = doneFrames;
    await run(ctx, tools.ffmpeg, args, { onLine: ffmpegProgress(batchSec, (f) => onProgress(Math.min(0.9, (before + f * batchSec) / totalSec * 0.9))) });
    doneFrames += batchSec;
    batchFiles.push(outFile);
  }

  // Join batches and add music
  const joined = path.join(outDir, `${item.id}_slideshow.mkv`);
  const args = ['-y', '-hide_banner'];
  batchFiles.forEach((f) => args.push('-i', f));
  const filters = [];
  let vlabel = '0:v';
  if (batchFiles.length > 1) {
    filters.push(`${batchFiles.map((_, i) => `[${i}:v]`).join('')}concat=n=${batchFiles.length}:v=1:a=0[v]`);
    vlabel = 'v';
  }
  const videoDuration = totalSec - Math.max(0, ss.images.length - batches.length) * td;
  const musicIdx = batchFiles.length;
  if (ss.music && ss.music.length) {
    ss.music.forEach((m) => args.push(...(ss.loopMusic ? ['-stream_loop', '-1'] : []), '-i', m.file));
    const parts = ss.music.map((_, i) => `[${musicIdx + i}:a]aresample=48000,aformat=channel_layouts=stereo[m${i}]`);
    filters.push(...parts);
    filters.push(`${ss.music.map((_, i) => `[m${i}]`).join('')}concat=n=${ss.music.length}:v=0:a=1,atrim=duration=${videoDuration},volume=${(ss.musicVolume || 100) / 100}${ss.fadeIn ? ',afade=t=in:d=2' : ''}${ss.fadeOut ? `,afade=t=out:st=${Math.max(0, videoDuration - 3)}:d=3` : ''}[a]`);
  } else {
    args.push('-f', 'lavfi', '-t', String(videoDuration), '-i', 'anullsrc=r=48000:cl=stereo');
    filters.push(`[${musicIdx}:a]anull[a]`);
  }
  args.push('-filter_complex', filters.join(';'), '-map', vlabel.includes(':') ? vlabel : `[${vlabel}]`, '-map', '[a]');
  args.push('-c:v', batchFiles.length > 1 ? 'libx264' : 'copy', ...(batchFiles.length > 1 ? ['-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p'] : []), '-c:a', 'pcm_s16le', '-t', String(videoDuration), joined);
  await run(ctx, tools.ffmpeg, args);
  for (const f of batchFiles) fs.rmSync(f, { force: true });
  onProgress(1);
  return finishIntermediate(tools, item, joined);
}

async function finishIntermediate(tools, item, file) {
  const info = await probe(tools, file);
  return {
    id: item.id, file, info, title: item.title, trim: { start: 0, end: null },
    audioTracks: info.audio.map((a) => ({ index: a.index, lang: 'und', enabled: true })),
    subtitles: [], volume: 100, chapters: item.chapters, generated: true,
  };
}

function drawTextArg(text, opts) {
  const font = ffFilterPath(path.join(FONT_DIR, opts.font || 'Inter-SemiBold.otf'));
  const esc = String(text).replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%');
  return `drawtext=fontfile='${font}':text='${esc}':fontsize=${opts.size}:fontcolor=${opts.color || 'white'}:x=${opts.x}:y=${opts.y}${opts.shadow !== false ? ':shadowcolor=black@0.5:shadowx=2:shadowy=2' : ''}`;
}

/** Render the album's text layer (and a gradient background when there is no cover) with Skia. */
function albumLayers(W, H, { title, subtitle, textX, titleY, needBackground }) {
  const { createCanvas } = require('@napi-rs/canvas');
  const { loadFonts } = require('../menu/render');
  loadFonts();
  const s = H / 1080;
  const text = createCanvas(W, H);
  const ctx = text.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10 * s;
  ctx.shadowOffsetY = 3 * s;
  const centered = textX === 'center';
  ctx.textAlign = centered ? 'center' : 'left';
  const x = centered ? W / 2 : textX;
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(64 * s)}px Poppins`;
  let t = String(title);
  const maxW = centered ? W * 0.85 : W - x - W * 0.06;
  while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
  if (t !== String(title)) t = `${t.slice(0, -1)}\u2026`;
  ctx.fillText(t, x, titleY);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `500 ${Math.round(34 * s)}px Inter`;
  ctx.fillText(subtitle, x, titleY + 95 * s);
  let bg = null;
  if (needBackground) {
    const b = createCanvas(W, H);
    const g = b.getContext('2d');
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#0f1a35');
    grad.addColorStop(1, '#3a1c5c');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W * 0.7, H * 0.3, 0, W * 0.7, H * 0.3, H * 0.8);
    glow.addColorStop(0, 'rgba(255,170,90,0.25)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
    bg = b.toBuffer('image/png');
  }
  return { text: text.toBuffer('image/png'), bg };
}

/** Music album: one segment per track with cover art, titles and an audio visualizer. */
async function renderMusicAlbum(ctx, tools, project, item, outDir, onProgress) {
  const mu = item.music;
  const { width: W, height: H, fpsExpr } = intermediateFormat(project);
  const segs = [];
  const total = mu.tracks.reduce((s, t) => s + ((t.info && t.info.duration) || 0), 0) || 1;
  let done = 0;
  const s = H / 1080;
  for (const [i, tr] of mu.tracks.entries()) {
    const d = (tr.end != null ? Math.min(tr.end, tr.info.duration) : tr.info.duration) - (tr.start || 0);
    const seg = path.join(outDir, `${item.id}_mu${i}.mkv`);
    const cover = tr.cover || mu.cover;
    const half = cover && mu.display === 'half';
    const layers = albumLayers(W, H, {
      title: tr.title,
      subtitle: `${item.title}  \u2022  Track ${i + 1} of ${mu.tracks.length}`,
      textX: half ? Math.round(W * 0.1 + H * 0.6) : 'center',
      titleY: half ? Math.round(H * 0.38) : Math.round(H * 0.36),
      needBackground: !cover,
    });
    const textPng = path.join(outDir, `${item.id}_mu${i}_text.png`);
    fs.writeFileSync(textPng, layers.text);
    let bgFile = cover;
    if (!cover) { bgFile = path.join(outDir, `${item.id}_mu${i}_bg.png`); fs.writeFileSync(bgFile, layers.bg); }
    const args = ['-y', '-hide_banner',
      '-loop', '1', '-framerate', fpsExpr, '-t', String(d), '-i', bgFile,
      '-loop', '1', '-framerate', fpsExpr, '-t', String(d), '-i', textPng,
      '-ss', String(tr.start || 0), '-t', String(d), '-i', tr.file];
    const f = [];
    if (mu.display === 'full' && cover) {
      f.push(`[0:v]format=rgb24,${fitFilter(W, H)}[bg]`);
    } else if (half) {
      f.push(`[0:v]format=rgb24,split[c1][c2];[c1]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:2,eq=brightness=-0.25[blur];[c2]scale=${Math.round(H * 0.55)}:${Math.round(H * 0.55)}:force_original_aspect_ratio=decrease[art];[blur][art]overlay=${Math.round(W * 0.1)}:(H-h)/2-${Math.round(60 * s)}[bg]`);
    } else {
      f.push(`[0:v]format=rgb24,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[bg]`);
    }
    f.push(`[bg][1:v]overlay=0:0[txt]`);
    f.push(`[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(tr.volume || 100) / 100},asplit[aout][avis]`);
    const visH = Math.round(H * 0.12);
    if (mu.visualizer) {
      f.push(`[avis]showwaves=s=${Math.round(W * 0.8)}x${visH}:mode=cline:colors=white@0.85:rate=${fpsExpr}:scale=sqrt,format=rgba[wave]`);
      f.push(`[txt][wave]overlay=(W-w)/2:H-h-${Math.round(90 * s)}:shortest=1,fps=${fpsExpr},format=yuv420p[v]`);
    } else {
      f.push('[avis]anullsink');
      f.push(`[txt]fps=${fpsExpr},format=yuv420p[v]`);
    }
    args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', '[aout]', ...MEZZ, '-r', fpsExpr, '-c:a', 'pcm_s16le', '-t', String(d), seg);
    const before = done;
    await run(ctx, tools.ffmpeg, args, { onLine: ffmpegProgress(d, (x) => onProgress(Math.min(0.95, (before + x * d) / total))) });
    done += d;
    segs.push(seg);
  }
  const list = path.join(outDir, `${item.id}_music.txt`);
  fs.writeFileSync(list, segs.map((x) => `file '${x.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const joined = path.join(outDir, `${item.id}_music.mkv`);
  await run(ctx, tools.ffmpeg, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  for (const x of segs) fs.rmSync(x, { force: true });
  onProgress(1);
  return finishIntermediate(tools, item, joined);
}

module.exports = { renderSlideshow, renderMusicAlbum, TRANSITIONS, intermediateFormat, FONT_DIR };
