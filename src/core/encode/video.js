'use strict';
/**
 * Transcoding of one title into disc-compliant elementary streams.
 *
 * DVD  : MPEG-2 program stream (.mpg) ready for dvdauthor, AC3/LPCM audio inside.
 * BD   : H.264 Annex-B (.h264) + AC3/LPCM/copied audio + subtitles, muxed later by tsMuxeR.
 * UHD  : HEVC Main10 (.hevc) with HDR10 / HDR10+ / Dolby Vision metadata where possible.
 */
const fs = require('fs');
const path = require('path');
const { run, ffmpegProgress } = require('../util');

const BD_FPS_1080 = [23.976, 24];
const BD_FPS_1080I = [25, 29.97];
const BD_FPS_720 = [23.976, 24, 50, 59.94];
const UHD_FPS = [23.976, 24, 25, 50, 59.94];
const FPS_EXPR = { 23.976: '24000/1001', 24: '24', 25: '25', 29.97: '30000/1001', 50: '50', 59.94: '60000/1001', 30: '30', 60: '60' };

/** Decide the output geometry / frame rate / scan type for a target. */
function videoTarget(project, info) {
  const fmt = project.format;
  const src = info.video || { fps: 25, width: 1920, height: 1080, interlaced: false };
  const sfps = src.fps || 25;
  if (fmt === 'dvd') {
    const ntsc = project.dvd.standard === 'ntsc';
    const t = { width: 720, height: ntsc ? 480 : 576, fps: ntsc ? 29.97 : 25, interlaced: true, dar: project.dvd.aspect === '4:3' ? 4 / 3 : 16 / 9 };
    t.telecine = ntsc && Math.abs(sfps - 23.976) < 0.01;
    return t;
  }
  if (fmt === 'uhd') {
    let fps = UHD_FPS.find((f) => Math.abs(f - sfps) < 0.01);
    let doubleFrames = false;
    if (!fps) {
      if (Math.abs(sfps - 29.97) < 0.01) { fps = 59.94; doubleFrames = true; } else if (Math.abs(sfps - 30) < 0.01) { fps = 59.94; } else if (sfps > 50.5) fps = 59.94; else fps = sfps > 24.5 ? 25 : 23.976;
    }
    return { width: 3840, height: 2160, fps, interlaced: false, dar: 16 / 9, doubleFrames };
  }
  // Blu-ray
  if (project.bd.resolution === '720') {
    let fps = BD_FPS_720.find((f) => Math.abs(f - sfps) < 0.01);
    if (!fps) fps = Math.abs(sfps - 25) < 0.6 ? 50 : sfps > 26 ? 59.94 : 23.976;
    return { width: 1280, height: 720, fps, interlaced: false, dar: 16 / 9 };
  }
  let fps = BD_FPS_1080.find((f) => Math.abs(f - sfps) < 0.01);
  if (fps) return { width: 1920, height: 1080, fps, interlaced: false, dar: 16 / 9 };
  // real interlacing is only kept for native 1080i sources; everything else is deinterlaced -> PsF
  const native1080i = src.interlaced && src.height === 1080;
  fps = BD_FPS_1080I.find((f) => Math.abs(f - sfps) < 0.01);
  if (fps) return { width: 1920, height: 1080, fps, interlaced: native1080i, fakeInterlaced: !native1080i, dar: 16 / 9 };
  if (Math.abs(sfps - 50) < 0.1) return { width: 1920, height: 1080, fps: 25, interlaced: false, fakeInterlaced: true, dar: 16 / 9 };
  if (sfps > 58) return { width: 1920, height: 1080, fps: 29.97, fakeInterlaced: true, dar: 16 / 9 };
  if (Math.abs(sfps - 30) < 0.1) return { width: 1920, height: 1080, fps: 29.97, fakeInterlaced: true, dar: 16 / 9 };
  return { width: 1920, height: 1080, fps: 23.976, interlaced: false, dar: 16 / 9 };
}

/**
 * Fit the source picture into the target frame.
 *  fit     - keep the shape, add black bars (letterbox / pillarbox)
 *  zoom    - keep the shape, fill the screen by cropping the overflow
 *  stretch - fill the screen by stretching (no bars, no cropping)
 */
function geometryFilter(src, t, mode = 'fit') {
  const srcDar = (src && src.dar) || 16 / 9;
  const darExpr = t.dar === 4 / 3 ? '4/3' : '16/9';
  const tail = `setsar=1,setdar=${darExpr}`;
  if (mode === 'stretch') return `scale=${t.width}:${t.height}:flags=lanczos,${tail}`;
  // storage size that gives the target DAR (DVD is anamorphic)
  const pixelAspect = t.dar / (t.width / t.height);
  let w = t.width;
  let h = Math.round((t.width * pixelAspect) / srcDar);
  if (mode === 'zoom') {
    if (h < t.height) { h = t.height; w = Math.round((t.height * srcDar) / pixelAspect); }
    w += w % 2; h += h % 2;
    return `scale=${w}:${h}:flags=lanczos,crop=${t.width}:${t.height}:${Math.floor((w - t.width) / 4) * 2}:${Math.floor((h - t.height) / 4) * 2},${tail}`;
  }
  if (h > t.height) { h = t.height; w = Math.round((t.height * srcDar) / pixelAspect); }
  w -= w % 2; h -= h % 2;
  const x = Math.floor((t.width - w) / 4) * 2;
  const y = Math.floor((t.height - h) / 4) * 2;
  return `scale=${w}:${h}:flags=lanczos,pad=${t.width}:${t.height}:${x}:${y}:black,${tail}`;
}

function tonemapFilter() {
  return 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
}

function masterDisplayString(md) {
  if (!md) return null;
  const f = (v, mul) => { const [a, b] = String(v).split('/').map(Number); return Math.round((b ? a / b : a) * mul); };
  try {
    return `G(${f(md.green_x, 50000)},${f(md.green_y, 50000)})B(${f(md.blue_x, 50000)},${f(md.blue_y, 50000)})R(${f(md.red_x, 50000)},${f(md.red_y, 50000)})WP(${f(md.white_point_x, 50000)},${f(md.white_point_y, 50000)})L(${f(md.max_luminance, 10000)},${f(md.min_luminance, 10000)})`;
  } catch (_) { return null; }
}

/** Pick the actual encoder implementation from the preference and capabilities. */
function chooseEncoder(pref, codec, caps, constraints = {}) {
  const want = { nvidia: `${codec}_nvenc`, intel: `${codec}_qsv`, amd: `${codec}_amf` };
  const sw = codec === 'h264' ? 'libx264' : 'libx265';
  if (constraints.forceSoftware) return sw;
  if (pref && want[pref] && caps.available[want[pref]]) return want[pref];
  if (pref === 'auto') for (const k of ['nvidia', 'intel', 'amd']) if (caps.available[want[k]]) return want[k];
  return sw;
}

function videoCodecArgs(project, t, enc, bitrate, info, extras = {}) {
  const fmt = project.format;
  const kbps = Math.round(bitrate / 1000);
  const hq = project.encoding.quality === 'high';
  const fpsInt = Math.round(t.fps);
  if (fmt === 'dvd') {
    return ['-c:v', 'mpeg2video', '-b:v', `${kbps}k`, '-maxrate', '9000k', '-minrate', '0', '-bufsize', '1835k', '-g', t.fps > 26 ? '18' : '15', '-bf', '2',
      '-flags', '+ilme+ildct', '-alternate_scan', '1', '-qmin', '1', '-mbd', 'rd', '-trellis', hq ? '2' : '0', '-cmp', '2', '-subcmp', '2',
      '-color_primaries', t.height === 480 ? 'smpte170m' : 'bt470bg', '-color_trc', t.height === 480 ? 'smpte170m' : 'gamma28', '-colorspace', t.height === 480 ? 'smpte170m' : 'bt470bg'];
  }
  const gop = Math.max(1, Math.round(t.fps) <= 30 ? fpsInt : Math.round(fpsInt / 2) * 1);
  if (enc === 'libx264') {
    const x = [
      'bluray-compat=1', `keyint=${Math.min(gop, t.fakeInterlaced || t.interlaced ? Math.round(t.fps) : gop)}`, 'min-keyint=1', 'open-gop=0',
      'vbv-maxrate=40000', 'vbv-bufsize=30000', 'nal-hrd=vbr', 'slices=4', 'b-pyramid=strict', 'aud=1', 'colorprim=bt709', 'transfer=bt709', 'colormatrix=bt709',
    ];
    if (t.fakeInterlaced) x.push('fake-interlaced=1', 'pic-struct=1');
    if (t.interlaced) x.push('tff=1');
    return ['-c:v', 'libx264', '-preset', hq ? 'slow' : 'medium', '-profile:v', 'high', '-level', '4.1', '-b:v', `${kbps}k`, '-x264-params', x.join(':'), '-pix_fmt', 'yuv420p'];
  }
  if (enc === 'libx265') {
    const x = ['uhd-bd=1', `keyint=${gop}`, 'min-keyint=1', 'no-open-gop=1', 'vbv-maxrate=98000', 'vbv-bufsize=98000', 'repeat-headers=1', 'aud=1', 'hrd=1'];
    if (extras.hdr) {
      x.push('hdr10=1', 'hdr10-opt=1', 'colorprim=bt2020', 'transfer=smpte2084', 'colormatrix=bt2020nc', 'range=limited');
      const md = masterDisplayString(info.video && info.video.mastering);
      x.push(`master-display=${md || 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)'}`);
      const cl = info.video && info.video.contentLight;
      x.push(`max-cll=${cl ? `${cl.max_content || 1000},${cl.max_average || 400}` : '1000,400'}`);
      if (extras.hdr10plusJson) x.push(`dhdr10-info=${extras.hdr10plusJson.replace(/\\/g, '/').replace(/:/g, '\\:')}`);
      if (extras.doviRpu) x.push(`dolby-vision-profile=8.1`, `dolby-vision-rpu=${extras.doviRpu.replace(/\\/g, '/').replace(/:/g, '\\:')}`);
    } else {
      x.push('colorprim=bt709', 'transfer=bt709', 'colormatrix=bt709');
    }
    return ['-c:v', 'libx265', '-preset', hq ? 'slow' : 'medium', '-profile:v', 'main10', '-b:v', `${kbps}k`, '-x265-params', x.join(':'), '-pix_fmt', 'yuv420p10le'];
  }
  // Hardware encoders (constant GOP, VBV-limited VBR)
  const common = ['-b:v', `${kbps}k`, '-maxrate', fmt === 'uhd' ? '98M' : '40M', '-bufsize', fmt === 'uhd' ? '98M' : '30M', '-g', String(gop), '-bf', '3'];
  const h264 = enc.startsWith('h264');
  const pix = h264 ? 'yuv420p' : 'p010le';
  if (enc.endsWith('nvenc')) {
    return ['-c:v', enc, '-preset', hq ? 'p6' : 'p4', '-tune', 'hq', '-rc', 'vbr', '-profile:v', h264 ? 'high' : 'main10', ...(h264 ? ['-level', '4.1'] : []), ...common,
      '-spatial-aq', '1', '-aud', '1', '-b_ref_mode', '0', '-forced-idr', '1', '-pix_fmt', pix, '-color_primaries', extras.hdr ? 'bt2020' : 'bt709', '-color_trc', extras.hdr ? 'smpte2084' : 'bt709', '-colorspace', extras.hdr ? 'bt2020nc' : 'bt709'];
  }
  if (enc.endsWith('qsv')) {
    return ['-c:v', enc, '-preset', hq ? 'slower' : 'medium', '-profile:v', h264 ? 'high' : 'main10', ...(h264 ? ['-level', '41'] : []), ...common, '-pix_fmt', h264 ? 'nv12' : 'p010le'];
  }
  return ['-c:v', enc, '-quality', hq ? 'quality' : 'balanced', '-rc', 'vbr_peak', '-profile:v', h264 ? 'high' : 'main10', ...(h264 ? ['-level', '4.1'] : []), ...common, '-pix_fmt', pix];
}

/** ffmpeg -vf chain for the target. */
function videoFilters(project, info, t, { tonemap = false, burnSubs = null } = {}) {
  const f = [];
  const src = info.video || {};
  // Interlaced fields can only be kept when neither the frame rate nor the height changes.
  const keepFields = src.interlaced && t.interlaced && !t.telecine && Math.abs((src.fps || 0) - t.fps) < 0.01 && src.height === t.height;
  if (src.interlaced && !keepFields) f.push('bwdif=mode=send_frame:parity=auto:deint=interlaced');
  if (tonemap) f.push(tonemapFilter());
  if (burnSubs) f.push(burnSubs);
  const fit = (project.encoding && project.encoding.fit) || 'fit';
  if (t.telecine) {
    f.push(geometryFilter(src, t, fit), 'fps=24000/1001', 'telecine=first_field=top:pattern=23');
  } else {
    f.push(`fps=${FPS_EXPR[t.fps] || t.fps}`, geometryFilter(src, t, fit));
  }
  // Field order is carried on the frames (portable across FFmpeg versions, unlike -top).
  if (t.interlaced || t.telecine) f.push(`setfield=${keepFields && ['bb', 'tb'].includes(src.fieldOrder) ? 'bff' : 'tff'}`);
  if (project.format === 'uhd') f.push('format=yuv420p10le');
  return f.join(',');
}

function firstLine(e) {
  const lines = String((e && e.message) || e).split('\n');
  return lines.filter((l) => /error|invalid|not an|unrecognized|option/i.test(l)).slice(-1)[0] || lines[0];
}

/** Minimal H.264 / HEVC settings for the last-resort retry (keeps the disc-critical constraints). */
function basicVideoArgs(enc, t, bitrate, extras = {}) {
  const kbps = Math.round(bitrate / 1000);
  const gop = String(Math.round(t.fps) <= 30 ? Math.round(t.fps) : Math.round(t.fps / 2));
  if (enc === 'libx265') {
    const x = ['repeat-headers=1', 'aud=1'];
    if (extras.hdr) x.push('hdr10=1', 'colorprim=bt2020', 'transfer=smpte2084', 'colormatrix=bt2020nc');
    return ['-c:v', 'libx265', '-preset', 'medium', '-profile:v', 'main10', '-b:v', `${kbps}k`, '-g', gop, '-x265-params', x.join(':'), '-pix_fmt', 'yuv420p10le'];
  }
  const x = ['bluray-compat=1', 'vbv-maxrate=40000', 'vbv-bufsize=30000', 'slices=4', 'aud=1'];
  if (t.fakeInterlaced) x.push('fake-interlaced=1', 'pic-struct=1');
  if (t.interlaced) x.push('tff=1');
  return ['-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-level', '4.1', '-b:v', `${kbps}k`, '-g', gop, '-x264-params', x.join(':'), '-pix_fmt', 'yuv420p'];
}

/** Minimal MPEG-2 settings every FFmpeg version accepts. */
function basicMpeg2Args(t, bitrate) {
  const kbps = Math.round(bitrate / 1000);
  return ['-c:v', 'mpeg2video', '-b:v', `${kbps}k`, '-maxrate', '9000k', '-bufsize', '1835k', '-g', t.fps > 26 ? '18' : '15', '-bf', '2', '-flags', '+ilme+ildct', '-pix_fmt', 'yuv420p'];
}

/** DVD-compliant MPEG-2 source that can be copied without re-encoding? */
function dvdCopyable(project, info, t, start) {
  const v = info.video;
  if (!v || v.codec !== 'mpeg2video' || start > 0) return false;
  if (v.width !== 720 || v.height !== t.height || Math.abs(v.fps - t.fps) > 0.01) return false;
  const want = project.dvd.aspect === '4:3' ? 4 / 3 : 16 / 9;
  return Math.abs((v.dar || want) - want) < 0.06 && (info.bitrate || 0) < 9.8e6;
}

/** Audio tracks to produce for a title: returns [{ streamIndex, lang, copy, codec }]. */
function planAudio(project, item, info) {
  const enabled = (item.audioTracks || []).filter((a) => a.enabled);
  const fmt = project.format;
  const okCopy = fmt === 'dvd' ? ['ac3', 'mp2'] : ['ac3', 'eac3', 'dts', 'truehd', 'pcm_s16le', 'pcm_s24le', 'pcm_bluray'];
  return enabled.map((a) => {
    const src = info.audio.find((x) => x.index === a.index) || {};
    const copy = project.audioMode === 'copy' && okCopy.includes(src.codec) && (fmt !== 'dvd' || (src.sampleRate === 48000));
    return { streamIndex: a.index, lang: a.lang || 'und', copy, codec: copy ? src.codec : (project.audioCodec === 'lpcm' && fmt !== 'dvd' ? 'lpcm' : 'ac3'), channels: Math.min(src.channels || 2, 6), title: a.title };
  });
}

function langCode(l) {
  const m = { en: 'eng', fr: 'fre', de: 'ger', es: 'spa', it: 'ita', ja: 'jpn', zh: 'chi', pt: 'por', ru: 'rus', ko: 'kor', nl: 'dut', sv: 'swe', pl: 'pol' };
  if (!l || l === 'und') return 'und';
  return m[l] || l.slice(0, 3);
}

/**
 * Transcode one prepared source (video file, or an intermediate made from a slideshow
 * or music album) into the streams the authoring step needs.
 * Returns { video, audio:[{file,lang,codec}], subs:[{file,lang,kind}], target, duration }
 */
async function transcodeTitle(ctx, tools, caps, project, src, opts) {
  const { outDir, bitrate, testMode, onProgress } = opts;
  const info = src.info;
  const fmt = project.format;
  const t = videoTarget(project, info);
  const start = src.trim ? src.trim.start || 0 : 0;
  let end = src.trim && src.trim.end != null ? src.trim.end : info.duration;
  if (testMode) end = Math.min(end, start + 300);
  const duration = Math.max(0.1, end - start);
  const inputArgs = ['-ss', String(start), '-to', String(end), '-i', src.file];
  const isHdrSource = info.video && info.video.hdr !== 'sdr';
  const wantHdr = fmt === 'uhd' && isHdrSource && project.uhd.dynamicRange !== 'sdr';
  const tonemap = isHdrSource && !wantHdr;
  const audio = planAudio(project, src, info);
  const base = path.join(outDir, src.id);
  const result = { audio: [], subs: [], target: t, duration, start };

  if (fmt === 'dvd') {
    // One pass straight to a DVD-compliant MPEG-2 PS with all audio tracks.
    const out = `${base}.mpg`;
    const args = ['-y', '-hide_banner', ...inputArgs, '-map', '0:v:0'];
    const aArgs = [];
    audio.forEach((a, i) => {
      args.push('-map', `0:${a.streamIndex}`);
      if (a.copy) aArgs.push(`-c:a:${i}`, 'copy');
      else aArgs.push(`-c:a:${i}`, 'ac3', `-b:a:${i}`, a.channels > 2 ? '448k' : '192k', `-ar:a:${i}`, '48000', `-ac:a:${i}`, String(a.channels > 2 ? 6 : 2));
      aArgs.push(`-metadata:s:a:${i}`, `language=${langCode(a.lang)}`);
    });
    if (!audio.length) {
      args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo', '-map', '1:a:0');
      aArgs.push('-c:a', 'ac3', '-b:a', '192k');
    }
    const vol = src.volume != null && src.volume !== 100 ? ['-af', `volume=${src.volume / 100}`] : [];
    const copyVideo = project.processing === 'passthrough' && !tonemap && dvdCopyable(project, info, t, start);
    if (copyVideo) ctx.log(`"${src.title}" is already DVD-compliant MPEG-2: copying video without re-encoding.`);
    const vArgs = copyVideo ? ['-c:v', 'copy'] : ['-vf', videoFilters(project, info, t, { tonemap }), ...videoCodecArgs(project, t, 'mpeg2video', bitrate, info)];
    const tail = [...aArgs, ...vol, ...(copyVideo ? [] : ['-aspect', project.dvd.aspect]), '-f', 'dvd', '-muxrate', '10080000', '-packetsize', '2048', out];
    try {
      await run(ctx, tools.ffmpeg, [...args, ...vArgs, ...tail], { onLine: ffmpegProgress(duration, onProgress) });
    } catch (e) {
      if (ctx.cancelled || copyVideo) throw e;
      ctx.log(`MPEG-2 encode with tuned options failed (${firstLine(e)}); retrying with basic options.`);
      const basic = ['-vf', videoFilters(project, info, t, { tonemap }), ...basicMpeg2Args(t, bitrate)];
      await run(ctx, tools.ffmpeg, [...args, ...basic, ...tail], { onLine: ffmpegProgress(duration, onProgress) });
    }
    result.mpg = out;
    result.audio = audio.map((a) => ({ lang: langCode(a.lang), codec: a.copy ? a.codec : 'ac3' }));
    result.subs = await extractSubtitles(ctx, tools, project, src, { base, start, end, dvd: true });
    return result;
  }

  // ---- Blu-ray / UHD: elementary streams
  if (opts.passthrough) {
    const v = info.video;
    const pcodec = v.codec === 'hevc' ? 'hevc' : v.codec === 'mpeg2video' ? 'mpeg2' : 'h264';
    const ext = { hevc: 'hevc', h264: 'h264', mpeg2: 'm2v' }[pcodec];
    const vfile = `${base}.${ext}`;
    const bsf = pcodec === 'hevc' ? ['-bsf:v', 'hevc_mp4toannexb'] : pcodec === 'h264' ? ['-bsf:v', 'h264_mp4toannexb'] : [];
    await run(ctx, tools.ffmpeg, ['-y', '-hide_banner', ...inputArgs, '-map', '0:v:0', '-an', '-sn', '-c:v', 'copy', ...bsf, '-f', { hevc: 'hevc', h264: 'h264', mpeg2: 'mpeg2video' }[pcodec], vfile],
      { onLine: ffmpegProgress(duration, (f) => onProgress(f * 0.5)) });
    result.video = vfile;
    result.videoCodec = pcodec;
    result.target = { ...t, fps: v.fps, width: v.width, height: v.height };
  }
  if (!opts.passthrough) {
    const codec = fmt === 'uhd' ? 'hevc' : 'h264';
    let enc = chooseEncoder(project.encoding.encoder, codec, caps, { forceSoftware: (t.fakeInterlaced && codec === 'h264') || (wantHdr && project.encoding.encoder !== 'nvidia') });
    const extras = { hdr: wantHdr };
    if (wantHdr && tools.hdr10plus_tool && enc === 'libx265') extras.hdr10plusJson = await extractHdr10Plus(ctx, tools, src.file, base, start, end).catch(() => null);
    if (wantHdr && tools.dovi_tool && enc === 'libx265' && info.video.dolbyVision) extras.doviRpu = await extractDoviRpu(ctx, tools, src.file, base, start, end).catch(() => null);
    const vfile = `${base}.${codec === 'h264' ? 'h264' : 'hevc'}`;
    const vargs = ['-y', '-hide_banner', ...inputArgs, '-map', '0:v:0', '-an', '-sn', '-vf', videoFilters(project, info, t, { tonemap }), ...videoCodecArgs(project, t, enc, bitrate, info, extras), '-f', codec === 'h264' ? 'h264' : 'hevc', vfile];
    const prog = { onLine: ffmpegProgress(duration, (f) => onProgress(f * 0.85)) };
    const withCodec = (codecArgs) => ['-y', '-hide_banner', ...inputArgs, '-map', '0:v:0', '-an', '-sn', '-vf', videoFilters(project, info, t, { tonemap }), ...codecArgs, '-f', codec, vfile];
    try {
      await run(ctx, tools.ffmpeg, vargs, prog);
    } catch (e) {
      if (ctx.cancelled) throw e;
      if (!enc.startsWith('lib')) {
        ctx.log(`Hardware encoder ${enc} failed (${firstLine(e)}), retrying with the software encoder.`);
        enc = codec === 'h264' ? 'libx264' : 'libx265';
      } else {
        ctx.log(`${enc} with tuned options failed (${firstLine(e)}), retrying with basic options.`);
      }
      try {
        await run(ctx, tools.ffmpeg, withCodec(videoCodecArgs(project, t, enc, bitrate, info, extras)), prog);
      } catch (e2) {
        if (ctx.cancelled) throw e2;
        ctx.log(`Retrying ${enc} with basic options (${firstLine(e2)}).`);
        await run(ctx, tools.ffmpeg, withCodec(basicVideoArgs(enc, t, bitrate, extras)), prog);
      }
    }
    result.video = vfile;
    result.videoCodec = codec;
  }

  // audio
  for (const [i, a] of audio.entries()) {
    const ext = a.copy ? ({ ac3: 'ac3', eac3: 'eac3', dts: 'dts', truehd: 'thd' }[a.codec] || 'wav') : a.codec === 'lpcm' ? 'wav' : 'ac3';
    const afile = `${base}_a${i}.${ext}`;
    const aargs = ['-y', '-hide_banner', ...inputArgs, '-map', `0:${a.streamIndex}`, '-vn', '-sn'];
    if (a.copy && ext !== 'wav') aargs.push('-c:a', 'copy', '-f', { ac3: 'ac3', eac3: 'eac3', dts: 'dts', thd: 'truehd' }[ext]);
    else if (ext === 'wav') aargs.push('-c:a', 'pcm_s24le', '-ar', '48000', '-f', 'wav');
    else aargs.push('-c:a', 'ac3', '-b:a', a.channels > 2 ? '640k' : '256k', '-ar', '48000', '-ac', String(a.channels > 2 ? 6 : 2), '-f', 'ac3');
    if (!a.copy && src.volume != null && src.volume !== 100) aargs.push('-af', `volume=${src.volume / 100}`);
    aargs.push(afile);
    await run(ctx, tools.ffmpeg, aargs);
    result.audio.push({ file: afile, lang: langCode(a.lang), codec: a.copy ? a.codec : a.codec === 'lpcm' ? 'lpcm' : 'ac3' });
    onProgress(0.85 + (0.1 * (i + 1)) / Math.max(1, audio.length));
  }
  if (!audio.length) {
    const afile = `${base}_silence.ac3`;
    await run(ctx, tools.ffmpeg, ['-y', '-hide_banner', '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo', '-c:a', 'ac3', '-b:a', '192k', afile]);
    result.audio.push({ file: afile, lang: 'und', codec: 'ac3' });
  }
  result.subs = await extractSubtitles(ctx, tools, project, src, { base, start, end, dvd: false });
  onProgress(1);
  return result;
}

/** Subtitles: text -> .srt (re-timed to the trim), PGS -> .sup. */
async function extractSubtitles(ctx, tools, project, src, { base, start, end, dvd }) {
  const out = [];
  for (const [i, s] of (src.subtitles || []).filter((x) => x.enabled).entries()) {
    const isBitmap = s.codec === 'hdmv_pgs_subtitle' || (s.file && /\.sup$/i.test(s.file));
    if (isBitmap && dvd) { ctx.log(`Skipping bitmap subtitle track ${i + 1} (not convertible to DVD).`); continue; }
    const file = `${base}_s${i}.${isBitmap ? 'sup' : 'srt'}`;
    const input = s.source === 'external' ? ['-i', s.file] : ['-i', src.file];
    const map = s.source === 'external' ? ['-map', '0:s:0'] : ['-map', `0:${s.index}`];
    const seek = start > 0 || end ? ['-ss', String(start), '-to', String(end)] : [];
    try {
      await run(ctx, tools.ffmpeg, ['-y', '-hide_banner', ...seek, ...input, ...map, '-c:s', isBitmap ? 'copy' : 'srt', '-f', isBitmap ? 'sup' : 'srt', file]);
      if (fs.existsSync(file) && fs.statSync(file).size > 0) out.push({ file, lang: langCode(s.lang), kind: isBitmap ? 'pgs' : 'text', forced: !!s.forced });
    } catch (e) {
      ctx.log(`Subtitle track ${i + 1} could not be extracted: ${e.message.split('\n')[0]}`);
    }
  }
  return out;
}

async function extractHdr10Plus(ctx, tools, file, base, start, end) {
  const hevc = `${base}_src.hevc`;
  await run(ctx, tools.ffmpeg, ['-y', '-v', 'error', '-ss', String(start), '-to', String(end), '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', hevc]);
  const json = `${base}_hdr10plus.json`;
  await run(ctx, tools.hdr10plus_tool, ['extract', '-i', hevc, '-o', json]);
  fs.unlinkSync(hevc);
  return fs.existsSync(json) ? json : null;
}

async function extractDoviRpu(ctx, tools, file, base, start, end) {
  const hevc = `${base}_src.hevc`;
  await run(ctx, tools.ffmpeg, ['-y', '-v', 'error', '-ss', String(start), '-to', String(end), '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', hevc]);
  const rpu = `${base}_rpu.bin`;
  await run(ctx, tools.dovi_tool, ['-m', '2', 'extract-rpu', hevc, '-o', rpu]); // mode 2: convert to profile 8.1
  fs.unlinkSync(hevc);
  return fs.existsSync(rpu) ? rpu : null;
}

/** Can this file go to Blu-ray / UHD without re-encoding the video? */
function passthroughCheck(project, info) {
  const v = info.video;
  if (!v) return { ok: false, reason: 'no video' };
  const fit = (project.encoding && project.encoding.fit) || 'fit';
  if (fit !== 'fit' && v.dar && Math.abs(v.dar - 16 / 9) > 0.05) return { ok: false, reason: `the picture is reshaped to fill the screen (${fit})` };
  const fps = v.fps;
  if (project.format === 'uhd') {
    if (v.codec !== 'hevc') return { ok: false, reason: 'video is not HEVC' };
    if (v.width > 3840 || v.height > 2160) return { ok: false, reason: 'resolution above 3840x2160' };
    if (!UHD_FPS.some((f) => Math.abs(f - fps) < 0.01)) return { ok: false, reason: `frame rate ${fps} is not allowed on UHD Blu-ray` };
    return { ok: true };
  }
  if (project.format === 'bd') {
    if (!['h264', 'vc1', 'mpeg2video'].includes(v.codec)) return { ok: false, reason: `codec ${v.codec} is not allowed on Blu-ray` };
    const okSize = (v.width === 1920 && v.height === 1080) || (v.width === 1440 && v.height === 1080) || (v.width === 1280 && v.height === 720);
    if (!okSize) return { ok: false, reason: `resolution ${v.width}x${v.height} is not a Blu-ray size` };
    const allowed = v.height === 720 ? BD_FPS_720 : v.interlaced ? BD_FPS_1080I : BD_FPS_1080;
    if (!allowed.some((f) => Math.abs(f - fps) < 0.01)) return { ok: false, reason: `frame rate ${fps} is not allowed at ${v.height}${v.interlaced ? 'i' : 'p'}` };
    if (v.codec === 'h264' && v.level > 41) return { ok: false, reason: `H.264 level ${v.level / 10} exceeds 4.1` };
    return { ok: true };
  }
  return { ok: false, reason: 'DVD always requires MPEG-2 encoding' };
}

module.exports = { dvdCopyable, videoTarget, geometryFilter, videoFilters, videoCodecArgs, chooseEncoder, transcodeTitle, planAudio, passthroughCheck, masterDisplayString, langCode, FPS_EXPR };
