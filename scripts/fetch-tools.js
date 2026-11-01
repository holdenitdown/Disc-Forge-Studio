'use strict';
/**
 * Collects the external programs DiscForge Studio drives into vendor/tools, which the
 * installer bundles (they end up in <install dir>/resources/tools).
 *
 *   ffmpeg/ffprobe   downloaded  (gyan.dev "release essentials" Windows build, GPL)
 *   tsMuxeR          downloaded  (github.com/justdan96/tsMuxer, Apache-2.0)
 *   dovi_tool        downloaded  (github.com/quietvoid/dovi_tool, MIT)
 *   hdr10plus_tool   downloaded  (github.com/quietvoid/hdr10plus_tool, MIT)
 *   dvdauthor/spumux copied from an installed DVDStyler (GPL) - set DVDSTYLER_DIR to override
 *   dfburn           this project's IMAPI2 burning helper (native/dfburn), prebuilt copy
 *
 * Downloads are cached in vendor/cache, so running this again is quick.
 * Usage: node scripts/fetch-tools.js [--force]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'tools');
const CACHE = path.join(ROOT, 'vendor', 'cache');
const force = process.argv.includes('--force');
const isWin = process.platform === 'win32';

const DOWNLOADS = [
  {
    id: 'ffmpeg',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    keep: [/\/bin\/ffmpeg\.exe$/i, /\/bin\/ffprobe\.exe$/i, /\/LICENSE(\.txt)?$/i, /\/README\.txt$/i],
    check: ['ffmpeg.exe', 'ffprobe.exe'],
  },
  {
    id: 'tsmuxer',
    url: 'https://github.com/justdan96/tsMuxer/releases/download/2.7.0/tsMuxer-2.7.0-win64.zip',
    keep: [/tsMuxeR\.exe$/i, /LICENSE/i],
    check: ['tsMuxeR.exe'],
  },
  {
    id: 'dovi_tool',
    url: 'https://github.com/quietvoid/dovi_tool/releases/download/2.3.4/dovi_tool-2.3.4-x86_64-pc-windows-msvc.zip',
    keep: [/dovi_tool\.exe$/i],
    check: ['dovi_tool.exe'],
  },
  {
    id: 'hdr10plus_tool',
    url: 'https://github.com/quietvoid/hdr10plus_tool/releases/download/1.7.2/hdr10plus_tool-1.7.2-x86_64-pc-windows-msvc.zip',
    keep: [/hdr10plus_tool\.exe$/i],
    check: ['hdr10plus_tool.exe'],
  },
];

// dvdauthor + spumux and the DLLs they load (checked with objdump against DVDStyler 3.2.x).
const DVD_FILES = [
  'dvdauthor.exe', 'spumux.exe',
  'libxml2-2.dll', 'libiconv-2.dll', 'liblzma-5.dll', 'zlib1.dll',
  'libfontconfig-1.dll', 'libfreetype-6.dll', 'libfribidi-0.dll', 'libpng14-14.dll',
  'fonts.conf',
];

const log = (...a) => console.log(...a);
const exists = (p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

async function download(url, dest) {
  if (!force && exists(dest) && fs.statSync(dest).size > 0) { log(`    cached ${path.basename(dest)}`); return; }
  const res = await fetch(url, { headers: { 'User-Agent': 'DiscForge-Studio-build' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  const file = fs.createWriteStream(tmp);
  let got = 0; let lastPct = -10;
  for await (const chunk of res.body) {
    if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (total && pct >= lastPct + 10) { process.stdout.write(`${pct}% `); lastPct = pct; }
  }
  await new Promise((r) => file.end(r));
  fs.renameSync(tmp, dest);
  if (total) process.stdout.write('\n');
  log(`    downloaded ${(got / 1e6).toFixed(1)} MB`);
}

function unzip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Windows 10+ ships bsdtar, which reads .zip files; elsewhere use unzip.
  if (isWin) execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { stdio: 'inherit' });
  else execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
}

async function fetchTool(spec) {
  const dest = path.join(OUT, spec.id);
  if (!force && spec.check.every((f) => exists(path.join(dest, f)))) { log(`  ${spec.id}: already present`); return; }
  log(`  ${spec.id}: ${spec.url}`);
  const zip = path.join(CACHE, `${spec.id}-${path.basename(new URL(spec.url).pathname)}`);
  await download(spec.url, zip);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `df-${spec.id}-`));
  try {
    unzip(zip, tmp);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const f of walk(tmp)) {
      const rel = f.slice(tmp.length).replace(/\\/g, '/');
      if (spec.keep.some((re) => re.test(rel))) fs.copyFileSync(f, path.join(dest, path.basename(f)));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const f of spec.check) if (!exists(path.join(dest, f))) throw new Error(`${spec.id}: ${f} was not found in the download`);
  if (spec.id === 'ffmpeg') {
    try {
      const v = execFileSync(path.join(dest, 'ffmpeg.exe'), ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0];
      fs.writeFileSync(path.join(dest, 'VERSION.txt'), `${v}\nSource: ${spec.url}\n`);
    } catch (_) { fs.writeFileSync(path.join(dest, 'VERSION.txt'), `Source: ${spec.url}\n`); }
  }
}

function findDvdStyler() {
  const cands = [process.env.DVDSTYLER_DIR];
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']) {
    if (base) cands.push(path.join(base, 'DVDStyler', 'bin'), path.join(base, 'DVDStyler'));
  }
  return cands.filter(Boolean).find((d) => exists(path.join(d, 'dvdauthor.exe')) && exists(path.join(d, 'spumux.exe')));
}

function copyDvdTools() {
  const dest = path.join(OUT, 'dvdauthor');
  if (!force && exists(path.join(dest, 'dvdauthor.exe')) && exists(path.join(dest, 'spumux.exe'))) { log('  dvdauthor/spumux: already present'); return true; }
  const src = findDvdStyler();
  if (!src) {
    log('  dvdauthor/spumux: NOT FOUND. Install DVDStyler (https://www.dvdstyler.org) or set DVDSTYLER_DIR to its bin folder.');
    return false;
  }
  log(`  dvdauthor/spumux: copying from ${src}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of DVD_FILES) {
    const p = path.join(src, f);
    if (exists(p)) fs.copyFileSync(p, path.join(dest, f));
    else log(`    warning: ${f} not found in ${src}`);
  }
  fs.writeFileSync(path.join(dest, 'SOURCE.txt'),
    'dvdauthor and spumux (GPL-2.0-or-later), from the DVDStyler Windows build.\n' +
    'dvdauthor source: https://github.com/ldo/dvdauthor\n' +
    'DVDStyler source: https://sourceforge.net/projects/dvdstyler/files/dvdstyler/\n');
  return true;
}

function copyDfburn() {
  const dest = path.join(OUT, 'dfburn.exe');
  const built = path.join(ROOT, 'native', 'build', 'dfburn.exe');
  const prebuilt = path.join(ROOT, 'native', 'prebuilt', 'dfburn.exe');
  const src = exists(built) ? built : prebuilt;
  fs.copyFileSync(src, dest);
  log(`  dfburn: ${path.relative(ROOT, src)}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });
  log('Collecting tools into vendor/tools');
  for (const spec of DOWNLOADS) await fetchTool(spec);
  const dvdOk = copyDvdTools();
  copyDfburn();
  if (!dvdOk && process.env.REQUIRE_DVD_TOOLS !== '0') {
    console.error('\nDVD authoring tools are missing; the installer would not be able to make DVDs.\n' +
      'Install DVDStyler, or run with REQUIRE_DVD_TOOLS=0 to build without them.');
    process.exit(1);
  }
  log('Done.');
})().catch((e) => { console.error(`\nfetch-tools failed: ${e.message}`); process.exit(1); });
