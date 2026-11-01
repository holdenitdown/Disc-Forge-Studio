'use strict';
const path = require('path');
const { run } = require('./util');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff', '.heic']);
const AUDIO_EXT = new Set(['.aac', '.ac3', '.aif', '.aiff', '.amr', '.wav', '.flac', '.mka', '.mp2', '.mp3', '.m4a', '.ogg', '.opus', '.wma', '.ape', '.dts', '.mlp', '.thd', '.eac3']);
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.sup', '.vtt', '.smi', '.idx']);

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (SUB_EXT.has(ext)) return 'subtitle';
  return 'video';
}

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
}

/** Normalise near-standard frame rates (23.976 etc.) */
function normFps(fps) {
  const std = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60];
  for (const s of std) if (Math.abs(fps - s) < 0.02) return s;
  return Math.round(fps * 1000) / 1000;
}

async function probe(tools, file) {
  const r = await run(null, tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '-show_entries', 'stream_side_data', file]);
  const j = JSON.parse(r.stdout);
  const fmt = j.format || {};
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const info = {
    file,
    name: path.basename(file),
    kind: kindOf(file),
    container: fmt.format_name,
    duration: Number(fmt.duration) || 0,
    size: Number(fmt.size) || 0,
    bitrate: Number(fmt.bit_rate) || 0,
    title: (fmt.tags && (fmt.tags.title || fmt.tags.TITLE)) || null,
    video: null,
    audio: [],
    subtitles: [],
    chapters: (j.chapters || []).map((c) => ({ start: Number(c.start_time), title: c.tags && c.tags.title })),
  };
  if (v) {
    const fps = normFps(parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate));
    const sideData = v.side_data_list || [];
    const dovi = sideData.find((s) => /dovi|dolby vision/i.test(s.side_data_type || ''));
    const transfer = v.color_transfer || '';
    const sar = v.sample_aspect_ratio && v.sample_aspect_ratio !== '0:1' ? v.sample_aspect_ratio.split(':').map(Number) : [1, 1];
    const dar = v.display_aspect_ratio && v.display_aspect_ratio !== '0:1'
      ? v.display_aspect_ratio.split(':').map(Number).reduce((a, b) => a / b)
      : (v.width * sar[0]) / (v.height * sar[1]);
    info.video = {
      index: v.index,
      codec: v.codec_name,
      profile: v.profile,
      width: v.width,
      height: v.height,
      dar,
      fps,
      pixFmt: v.pix_fmt,
      bitDepth: /10|12/.test(v.pix_fmt || '') ? (/12/.test(v.pix_fmt) ? 12 : 10) : 8,
      interlaced: ['tt', 'bb', 'tb', 'bt'].includes(v.field_order),
      fieldOrder: v.field_order,
      colorPrimaries: v.color_primaries,
      colorTransfer: transfer,
      colorSpace: v.color_space,
      hdr: transfer === 'smpte2084' ? 'hdr10' : transfer === 'arib-std-b67' ? 'hlg' : 'sdr',
      dolbyVision: dovi ? { profile: dovi.dv_profile, level: dovi.dv_level, blCompat: dovi.dv_bl_signal_compatibility_id } : null,
      mastering: sideData.find((s) => /mastering display/i.test(s.side_data_type || '')) || null,
      contentLight: sideData.find((s) => /content light/i.test(s.side_data_type || '')) || null,
      level: v.level,
    };
  }
  for (const s of streams) {
    const lang = (s.tags && (s.tags.language || s.tags.LANGUAGE)) || 'und';
    const title = s.tags && (s.tags.title || s.tags.handler_name);
    if (s.codec_type === 'audio') {
      info.audio.push({
        index: s.index, codec: s.codec_name, profile: s.profile, channels: s.channels, layout: s.channel_layout,
        sampleRate: Number(s.sample_rate), bitrate: Number(s.bit_rate) || 0, lang, title,
        default: !!(s.disposition && s.disposition.default),
      });
    } else if (s.codec_type === 'subtitle') {
      info.subtitles.push({ index: s.index, codec: s.codec_name, lang, title, forced: !!(s.disposition && s.disposition.forced) });
    }
  }
  if (info.kind === 'video' && !info.video && info.audio.length) info.kind = 'audio';
  if (info.kind === 'image' && v) info.video = { ...info.video, fps: 0 };
  return info;
}

/** Extract a single frame (for thumbnails / menu scene images). */
async function grabFrame(tools, file, atSec, outPng, { width = 480, hdr = false } = {}) {
  const tonemap = hdr ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,' : '';
  const seek = kindOf(file) === 'image' || atSec <= 0 ? [] : ['-ss', String(atSec)];
  const args = ['-y', '-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-vf', `${tonemap}scale=${width}:-2:flags=lanczos,format=rgb24`, '-update', '1', outPng];
  try {
    await run(null, tools.ffmpeg, args);
  } catch (e) {
    if (!hdr) throw e;
    // Builds without zimg: fall back to a plain scale.
    await run(null, tools.ffmpeg, ['-y', '-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2,format=rgb24`, '-update', '1', outPng]);
  }
  return outPng;
}

module.exports = { probe, grabFrame, kindOf, normFps, parseRate };
