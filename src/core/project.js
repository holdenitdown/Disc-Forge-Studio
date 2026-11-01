'use strict';
const crypto = require('crypto');

const CAPACITY = {
  dvd5: 4.37 * 1024 ** 3, // 4.7 GB (decimal) usable
  dvd9: 7.95 * 1024 ** 3,
  bd25: 23.0 * 1024 ** 3,
  bd50: 46.0 * 1024 ** 3,
  bd66: 61.0 * 1024 ** 3,
  bd100: 92.0 * 1024 ** 3,
};

const FORMAT_LIMITS = {
  // maximum video bitrates we allow ourselves (well inside the specs)
  dvd: { maxVideo: 8.0e6, minVideo: 2.0e6, defaultCapacity: 'dvd5' },
  bd: { maxVideo: 35e6, minVideo: 6e6, defaultCapacity: 'bd25' },
  uhd: { maxVideo: 80e6, minVideo: 20e6, defaultCapacity: 'bd66' },
};

const uid = () => crypto.randomBytes(6).toString('hex');

function defaultProject() {
  return {
    version: 1,
    name: 'My Disc',
    format: 'bd', // dvd | bd | uhd
    dvd: { standard: 'ntsc', aspect: '16:9', capacity: 'dvd5' },
    bd: { resolution: '1080', capacity: 'bd25' },
    uhd: { dynamicRange: 'auto', capacity: 'bd66' },
    processing: 'transcode', // transcode | passthrough
    audioMode: 'encode', // encode | copy
    audioCodec: 'ac3', // ac3 | lpcm
    titleMode: 'separate', // separate | merge
    items: [],
    menu: defaultMenu(),
    output: {
      label: 'MY_DISC',
      folder: '',
      makeFolder: true,
      makeIso: false,
      burn: false,
      burner: null,
      testMode: false,
      afterCompletion: 'nothing',
      defaultAudio: 1,
      defaultSubtitle: 0,
      copies: 1,
      writeSpeed: 0, // sectors per second; 0 = drive maximum
    },
    encoding: { encoder: 'auto', quality: 'high', fit: 'fit', loopWithoutMenu: false, textSubtitleColor: 'white', importTitles: true },
  };
}

function defaultMenu() {
  return {
    enabled: true,
    theme: 'aurora',
    title: 'My Disc',
    skipMenu: false,
    firstPlay: null, // { file, info }
    background: { type: 'theme', file: null, start: 0, end: null, maxDuration: 60 },
    music: { file: null, volume: 80, fadeIn: true, fadeOut: true, start: 0, end: null },
    sceneDisplay: 'icon', // icon | text
    fileDisplay: 'icon', // icon | text (title selection page)
    itemsPerPage: 6,
    excludeFirstFromScenes: false,
    scenesOnly: false,
    bonusDisplay: 'icon',
    highlight: { style: 'box', color: '#ffc83d' },
    labels: { play: 'Play', scenes: 'Scenes', titles: 'Titles', audio: 'Audio', subtitles: 'Subtitles', bonus: 'Bonus', back: 'Back', next: 'Next', previous: 'Previous', off: 'Off', main: 'Main Menu' },
    showAudioMenu: 'auto', // auto | always | never
    showSubtitleMenu: 'auto',
    popup: true,
    elements: [], // custom user text / image elements: { id, page, type, text|file, x, y, w, h, font, size, color, bold, italic, underline, outline, align, hidden }
  };
}

function newVideoItem(info) {
  return {
    id: uid(),
    type: 'video',
    file: info.file,
    info,
    title: info.title || info.name.replace(/\.[^.]+$/, ''),
    bonus: false,
    trim: { start: 0, end: null },
    chapters: info.chapters && info.chapters.length > 1
      ? { mode: 'custom', interval: 300, list: info.chapters.map((c) => c.start) }
      : { mode: 'interval', interval: 300, list: [] },
    audioTracks: info.audio.map((a, i) => ({ index: a.index, lang: a.lang || 'und', enabled: i < 8, title: a.title || null })),
    subtitles: info.subtitles
      .filter((s) => ['subrip', 'ass', 'ssa', 'hdmv_pgs_subtitle', 'mov_text', 'webvtt'].includes(s.codec))
      .map((s) => ({ source: 'embedded', index: s.index, codec: s.codec, lang: s.lang || 'und', enabled: true, forced: s.forced })),
    thumbnailAt: Math.min(30, (info.duration || 10) * 0.1),
    volume: 100,
  };
}

function newSlideshowItem(files) {
  return {
    id: uid(),
    type: 'slideshow',
    title: 'Slideshow',
    bonus: false,
    slideshow: {
      images: files.map((f) => ({ file: f, duration: null })),
      slideDuration: 5,
      transition: 'fade',
      transitionDuration: 1,
      kenBurns: true,
      music: [],
      musicVolume: 90,
      fadeIn: true,
      fadeOut: true,
      loopMusic: true,
      chapters: { mode: 'none', interval: 60 },
    },
    chapters: { mode: 'none', interval: 60, list: [] },
    audioTracks: [],
    subtitles: [],
    thumbnailAt: 0,
  };
}

function newMusicItem(infos) {
  return {
    id: uid(),
    type: 'music',
    title: 'Music',
    bonus: false,
    music: {
      tracks: infos.map((i) => ({ file: i.file, info: i, title: i.title || i.name.replace(/\.[^.]+$/, ''), start: 0, end: null, volume: 100 })),
      cover: null,
      display: 'half', // full | half | none
      visualizer: true,
    },
    chapters: { mode: 'tracks', list: [] },
    audioTracks: [],
    subtitles: [],
    thumbnailAt: 0,
  };
}

/** Effective playback duration of an item in seconds. */
function itemDuration(item) {
  if (item.type === 'video') {
    const d = item.info.duration || 0;
    const s = item.trim.start || 0;
    const e = item.trim.end != null ? Math.min(item.trim.end, d) : d;
    return Math.max(0, e - s);
  }
  if (item.type === 'slideshow') {
    const ss = item.slideshow;
    const n = ss.images.length;
    const total = ss.images.reduce((acc, im) => acc + (im.duration || ss.slideDuration), 0);
    return Math.max(1, total - Math.max(0, n - 1) * (ss.transition === 'none' ? 0 : ss.transitionDuration));
  }
  if (item.type === 'music') {
    return item.music.tracks.reduce((acc, t) => {
      const d = (t.info && t.info.duration) || 0;
      const e = t.end != null ? Math.min(t.end, d) : d;
      return acc + Math.max(0, e - (t.start || 0));
    }, 0);
  }
  return 0;
}

/** Chapter start times (seconds, relative to item start). */
function chapterTimes(item, overrideDuration) {
  const dur = overrideDuration || itemDuration(item);
  const ch = item.chapters || { mode: 'none' };
  let list = [0];
  if (item.type === 'music') {
    let t = 0;
    list = item.music.tracks.map((tr) => {
      const at = t;
      const d = (tr.info && tr.info.duration) || 0;
      t += Math.max(0, (tr.end != null ? Math.min(tr.end, d) : d) - (tr.start || 0));
      return at;
    });
  } else if (ch.mode === 'interval' && ch.interval > 0) {
    for (let t = ch.interval; t < dur - 1; t += ch.interval) list.push(t);
  } else if (ch.mode === 'custom' && ch.list && ch.list.length) {
    const off = item.trim ? item.trim.start || 0 : 0;
    list = [0, ...ch.list.map((t) => t - off).filter((t) => t > 0.5 && t < dur - 0.5)];
  }
  return [...new Set(list.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

/**
 * Plan the video bitrate for transcoding so everything fits on the chosen media.
 * Returns bits per second.
 */
function planBitrate(project, { menuSeconds = 120, testMode = false } = {}) {
  const fmt = project.format;
  const lim = FORMAT_LIMITS[fmt];
  const capKey = fmt === 'dvd' ? project.dvd.capacity : fmt === 'bd' ? project.bd.capacity : project.uhd.capacity;
  const capacity = CAPACITY[capKey] || CAPACITY[lim.defaultCapacity];
  const items = project.items;
  const total = items.reduce((s, it) => s + (testMode ? Math.min(300, itemDuration(it)) : itemDuration(it)), 0) || 1;
  const audioTracks = items.reduce((m, it) => Math.max(m, (it.audioTracks || []).filter((a) => a.enabled).length || 1), 1);
  const audioRate = fmt === 'dvd' ? 224e3 : 640e3;
  const muxOverhead = fmt === 'dvd' ? 0.03 : 0.06;
  const budgetBits = capacity * 8 * (1 - muxOverhead) - menuSeconds * 4e6;
  let video = budgetBits / total - audioRate * audioTracks;
  video = Math.max(lim.minVideo, Math.min(lim.maxVideo, video));
  return Math.round(video);
}

/** Estimated output size in bytes. */
function estimateSize(project) {
  const fmt = project.format;
  const vbr = planBitrate(project);
  const total = project.items.reduce((s, it) => s + itemDuration(it), 0);
  const audio = fmt === 'dvd' ? 224e3 : 640e3;
  if (project.processing === 'passthrough' && fmt !== 'dvd') {
    return project.items.reduce((s, it) => s + (it.info ? it.info.size || 0 : 0), 0) * 1.03;
  }
  return Math.round(((vbr + audio) * total) / 8 * 1.05 + 50e6);
}

function validate(project) {
  const errors = [];
  const warnings = [];
  if (!project.items.length) errors.push('Add at least one video, slideshow or music album.');
  const main = project.items.filter((i) => !i.bonus);
  if (!main.length && project.items.length) errors.push('At least one item must be a main title (not bonus).');
  if (project.format === 'dvd') {
    for (const it of project.items) {
      if ((it.audioTracks || []).filter((a) => a.enabled).length > 8) errors.push(`"${it.title}": DVD supports a maximum of 8 audio tracks.`);
      if ((it.subtitles || []).filter((s) => s.enabled).length > 32) errors.push(`"${it.title}": DVD supports a maximum of 32 subtitle tracks.`);
    }
  }
  if (project.titleMode === 'merge') {
    const counts = new Set(project.items.filter((i) => i.type === 'video').map((i) => (i.audioTracks || []).filter((a) => a.enabled).length));
    if (counts.size > 1) errors.push('When merging into a single title, every video must have the same number of audio tracks.');
  }
  for (const it of project.items) {
    if (it.type === 'video' && it.trim.end != null && it.trim.end <= it.trim.start) errors.push(`"${it.title}": the end time must be later than the start time.`);
    if (it.type === 'slideshow' && !it.slideshow.images.length) errors.push(`"${it.title}": the slideshow has no pictures.`);
  }
  const fmt = project.format;
  const capKey = fmt === 'dvd' ? project.dvd.capacity : fmt === 'bd' ? project.bd.capacity : project.uhd.capacity;
  const est = estimateSize(project);
  if (est > CAPACITY[capKey]) warnings.push(`Estimated size ${(est / 1e9).toFixed(1)} GB is larger than the selected disc; quality will be reduced or choose a larger disc.`);
  if (!project.output.makeFolder && !project.output.makeIso && !project.output.burn) errors.push('Select at least one output option.');
  return { errors, warnings };
}

module.exports = { defaultProject, defaultMenu, newVideoItem, newSlideshowItem, newMusicItem, itemDuration, chapterTimes, planBitrate, estimateSize, validate, CAPACITY, FORMAT_LIMITS, uid };
