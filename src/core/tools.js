'use strict';
/**
 * Locates the external tools DiscForge drives and can install missing ones from
 * their official release locations into the per-user tools folder.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run } = require('./util');

const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? `${n}.exe` : n);

const TOOLS = {
  ffmpeg: { names: ['ffmpeg'], required: true, purpose: 'Decoding, encoding and analysis of all media' },
  ffprobe: { names: ['ffprobe'], required: true, purpose: 'Reading media information' },
  tsmuxer: { names: ['tsMuxeR', 'tsmuxer'], required: true, purpose: 'Blu-ray / 4K UHD multiplexing' },
  dvdauthor: { names: ['dvdauthor'], required: false, purpose: 'DVD-Video authoring' },
  spumux: { names: ['spumux'], required: false, purpose: 'DVD menu highlights and subtitles' },
  dovi_tool: { names: ['dovi_tool'], required: false, purpose: 'Dolby Vision metadata (4K UHD)' },
  hdr10plus_tool: { names: ['hdr10plus_tool'], required: false, purpose: 'HDR10+ metadata (4K UHD)' },
};

const DOWNLOADS = {
  ffmpeg: { kind: 'url', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', provides: ['ffmpeg', 'ffprobe'], source: 'gyan.dev (official Windows builds linked from ffmpeg.org)' },
  tsmuxer: { kind: 'github', repo: 'justdan96/tsMuxer', asset: /^tsMuxer-[\d.]+-win64\.zip$/i, fallback: 'https://github.com/justdan96/tsMuxer/releases/download/2.7.0/tsMuxer-2.7.0-win64.zip', provides: ['tsmuxer'], source: 'github.com/justdan96/tsMuxer' },
  dovi_tool: { kind: 'github', repo: 'quietvoid/dovi_tool', asset: /x86_64-pc-windows-msvc\.zip$/i, fallback: 'https://github.com/quietvoid/dovi_tool/releases/download/2.3.4/dovi_tool-2.3.4-x86_64-pc-windows-msvc.zip', provides: ['dovi_tool'], source: 'github.com/quietvoid/dovi_tool' },
  hdr10plus_tool: { kind: 'github', repo: 'quietvoid/hdr10plus_tool', asset: /x86_64-pc-windows-msvc\.zip$/i, fallback: 'https://github.com/quietvoid/hdr10plus_tool/releases/download/1.7.2/hdr10plus_tool-1.7.2-x86_64-pc-windows-msvc.zip', provides: ['hdr10plus_tool'], source: 'github.com/quietvoid/hdr10plus_tool' },
};

function userToolsDir() {
  const base = isWin ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'DiscForge', 'tools');
}

function candidateDirs(extraDirs = []) {
  const dirs = [...extraDirs];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'tools'));
  dirs.push(path.join(__dirname, '..', '..', 'tools'));
  dirs.push(userToolsDir());
  if (isWin) {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    for (const p of pf) {
      dirs.push(path.join(p, 'DVDStyler', 'bin'));
      dirs.push(path.join(p, 'tsMuxeR'));
      dirs.push(path.join(p, 'ffmpeg', 'bin'));
    }
  }
  for (const p of (process.env.PATH || '').split(path.delimiter)) if (p) dirs.push(p);
  return dirs;
}

function findInDir(dir, names, depth = 3) {
  if (!dir || !fs.existsSync(dir)) return null;
  for (const n of names) {
    const p = path.join(dir, exe(n));
    if (fs.existsSync(p)) return p;
  }
  if (depth <= 0) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      const hit = findInDir(path.join(dir, e.name), names, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Resolve every tool path. overrides: { toolId: '/path/to/exe' } from settings. */
function locateTools(overrides = {}) {
  const found = {};
  const dirs = candidateDirs();
  const ownDirs = new Set([userToolsDir(), path.join(__dirname, '..', '..', 'tools'), process.resourcesPath && path.join(process.resourcesPath, 'tools')].filter(Boolean));
  for (const [id, info] of Object.entries(TOOLS)) {
    if (overrides[id] && fs.existsSync(overrides[id])) { found[id] = overrides[id]; continue; }
    let hit = null;
    for (const d of dirs) {
      // DVDStyler ships an old FFmpeg; only borrow its DVD tools
      if (/DVDStyler/i.test(d) && !['dvdauthor', 'spumux'].includes(id)) continue;
      hit = findInDir(d, info.names, ownDirs.has(d) ? 3 : 0);
      if (hit) break;
    }
    found[id] = hit;
  }
  return found;
}

async function toolVersions(paths) {
  const out = {};
  const probe = async (id, args, re) => {
    if (!paths[id]) return;
    try {
      const r = await run(null, paths[id], args, { allowFail: true });
      const m = re.exec(r.stdout + r.stderr);
      out[id] = m ? m[1] : 'found';
    } catch (_) { out[id] = 'error'; }
  };
  await Promise.all([
    probe('ffmpeg', ['-hide_banner', '-version'], /ffmpeg version (\S+)/),
    probe('tsmuxer', [], /tsMuxeR version (\S+)/),
    probe('dvdauthor', ['-h'], /DVDAuthor::dvdauthor, version (\S+)/),
    probe('dovi_tool', ['--version'], /dovi_tool (\S+)/),
    probe('hdr10plus_tool', ['--version'], /hdr10plus_tool (\S+)/),
  ]);
  return out;
}

/** Which hardware encoders does this ffmpeg build expose (and actually initialise)? */
async function detectEncoders(ffmpegPath) {
  const res = { h264: ['libx264'], hevc: ['libx265'], available: {} };
  if (!ffmpegPath) return res;
  const r = await run(null, ffmpegPath, ['-hide_banner', '-encoders'], { allowFail: true });
  const list = r.stdout;
  for (const enc of ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf', 'libx264', 'libx265']) {
    res.available[enc] = new RegExp(`\\b${enc}\\b`).test(list);
  }
  // A listed hardware encoder may still fail without the GPU; try a 1-frame encode.
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    if (!res.available[enc]) continue;
    const t = await run(null, ffmpegPath, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1', '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'], { allowFail: true });
    if (t.code !== 0) { res.available[enc] = false; res.available[enc.replace('h264', 'hevc')] = false; }
  }
  return res;
}

async function githubAsset(repo, pattern) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: { 'User-Agent': 'DiscForge-Studio' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for ${repo}`);
  for (const rel of await r.json()) {
    const a = (rel.assets || []).find((x) => pattern.test(x.name));
    if (a) return { url: a.browser_download_url, name: a.name, version: rel.tag_name };
  }
  throw new Error(`No Windows build found in ${repo} releases`);
}

/** Download and unpack a tool into the user tools folder. onProgress(fraction, message). */
async function installTool(id, onProgress = () => {}) {
  const spec = DOWNLOADS[id];
  if (!spec) throw new Error(`${id} cannot be installed automatically`);
  const dest = path.join(userToolsDir(), id);
  fs.mkdirSync(dest, { recursive: true });
  let url = spec.url;
  let name = path.basename(url);
  if (spec.kind === 'github') {
    try {
      const a = await githubAsset(spec.repo, spec.asset);
      url = a.url; name = a.name;
    } catch (_) {
      url = spec.fallback; name = path.basename(spec.fallback);
    }
  }
  onProgress(0, `Downloading ${name} from ${spec.source}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'DiscForge-Studio' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const zipPath = path.join(dest, name);
  const file = fs.createWriteStream(zipPath);
  let got = 0;
  for await (const chunk of res.body) {
    file.write(chunk);
    got += chunk.length;
    if (total) onProgress(got / total * 0.9, `Downloading ${name}`);
  }
  await new Promise((r) => file.end(r));
  onProgress(0.92, 'Extracting');
  // Windows 10+ ships bsdtar, which understands .zip.
  await run(null, isWin ? 'tar' : 'unzip', isWin ? ['-xf', zipPath, '-C', dest] : ['-o', zipPath, '-d', dest]);
  fs.unlinkSync(zipPath);
  onProgress(1, 'Installed');
  return locateTools();
}

module.exports = { TOOLS, DOWNLOADS, locateTools, toolVersions, detectEncoders, installTool, userToolsDir };
