'use strict';
/**
 * ISO images and disc burning.
 * Windows: built-in IMAPI2 driven by our native helper tools/dfburn.exe (live progress),
 * falling back to PowerShell or ImgBurn. Elsewhere (tests): genisoimage for DVD images.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { run } = require('./util');
const { writeDvdIso } = require('./dvdiso');

const isWin = process.platform === 'win32';

const PS_HELPERS = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class DFStream {
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateStreamOnFileEx(string file, uint mode, uint attrs, bool create, IntPtr template, out IStream stream);
  public static IStream OpenRead(string file) { IStream s; SHCreateStreamOnFileEx(file, 0x20 /*STGM_SHARE_DENY_WRITE*/, 0, false, IntPtr.Zero, out s); return s; }
  public static void Save(object comStream, string file, long totalBlocks) {
    IStream s = (IStream)comStream;
    byte[] buf = new byte[2048 * 512];
    IntPtr pRead = Marshal.AllocHGlobal(sizeof(int));
    long written = 0; int lastPct = -1;
    using (FileStream fs = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20)) {
      while (true) {
        s.Read(buf, buf.Length, pRead);
        int n = Marshal.ReadInt32(pRead);
        if (n <= 0) break;
        fs.Write(buf, 0, n);
        written += n;
        int pct = totalBlocks > 0 ? (int)(written * 100 / (totalBlocks * 2048)) : 0;
        if (pct != lastPct) { Console.WriteLine("PROGRESS " + pct); lastPct = pct; }
      }
    }
    Marshal.FreeHGlobal(pRead);
  }
}
"@
`;

function findImgBurn() {
  if (!isWin) return null;
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (!base) continue;
    const p = path.join(base, 'ImgBurn', 'ImgBurn.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function powershell(ctx, script, onLine) {
  const file = path.join(os.tmpdir(), `discforge_${process.pid}_${Date.now()}.ps1`);
  fs.writeFileSync(file, `$ErrorActionPreference = 'Stop'\n${script}`, 'utf8');
  try {
    return await run(ctx, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { onLine });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Create an ISO from an authored folder.
 * kind: 'dvd' (ISO9660 + UDF 1.02) or 'bd' (UDF 2.50)
 */
async function makeIso(ctx, srcDir, isoPath, label, kind, onProgress = () => {}) {
  fs.mkdirSync(path.dirname(isoPath), { recursive: true });
  const vol = label.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32) || 'DISC';
  if (kind === 'dvd') {
    // Our own DVD-Video layout (ISO 9660 + UDF 1.02, IFO/VOB/BUP contiguous) so that
    // standalone players can follow the sector offsets stored in the IFO files.
    if (ctx) ctx.log(`Building DVD-Video image (ISO 9660 + UDF 1.02): ${isoPath}`);
    const r = await writeDvdIso(srcDir, isoPath, vol, { onProgress, ctx });
    if (ctx) ctx.log(`DVD image layout: ${r.files.map((f) => `${f.name}@${f.lba}`).join(', ')} (${r.sectors} sectors)`);
    return isoPath;
  }
  if (!isWin) {
    if (kind !== 'dvd') throw new Error('Blu-ray ISO creation needs Windows (IMAPI2) or ImgBurn.');
    await run(ctx, 'genisoimage', ['-quiet', '-dvd-video', '-udf', '-V', vol, '-o', isoPath, srcDir]);
    onProgress(1);
    return isoPath;
  }
  const imgburn = findImgBurn();
  if (imgburn) {
    const fsArg = kind === 'dvd' ? ['/FILESYSTEM', 'ISO9660 + UDF', '/UDFREVISION', '1.02'] : ['/FILESYSTEM', 'UDF', '/UDFREVISION', '2.50'];
    await run(ctx, imgburn, ['/MODE', 'BUILD', '/BUILDMODE', 'IMAGEFILE', '/SRC', `${srcDir}\\`, '/DEST', isoPath, ...fsArg, '/VOLUMELABEL', vol, '/ROOTFOLDER', 'YES', '/NOIMAGEDETAILS', '/START', '/CLOSESUCCESS', '/NOSAVESETTINGS']);
    onProgress(1);
    return isoPath;
  }
  const script = `${PS_HELPERS}
$img = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$img.FileSystemsToCreate = ${kind === 'dvd' ? 5 : 4}
$img.UDFRevision = ${kind === 'dvd' ? '0x102' : '0x250'}
$img.VolumeName = ${psq(vol)}
$img.FreeMediaBlocks = 0
$img.Root.AddTree(${psq(srcDir)}, $false)
$res = $img.CreateResultImage()
[DFStream]::Save($res.ImageStream, ${psq(isoPath)}, $res.TotalBlocks)
Write-Output 'DONE'
`;
  await powershell(ctx, script, (l) => { const m = /^PROGRESS (\d+)/.exec(l); if (m) onProgress(Number(m[1]) / 100); });
  return isoPath;
}

/** List optical drives with their capabilities. */
async function listBurnersPS() {
  if (!isWin) return [];
  const script = `
$dm = New-Object -ComObject IMAPI2.MsftDiscMaster2
$out = @()
for ($i = 0; $i -lt $dm.Count; $i++) {
  $rec = New-Object -ComObject IMAPI2.MsftDiscRecorder2
  $rec.InitializeDiscRecorder($dm.Item($i))
  $media = ''
  $free = 0
  try {
    $fmt = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
    $fmt.Recorder = $rec
    if ($fmt.IsCurrentMediaSupported($rec)) { $media = [int]$fmt.CurrentPhysicalMediaType; $free = [long]$fmt.FreeSectorsOnMedia * 2048 }
  } catch { }
  $out += [pscustomobject]@{ index = $i; id = $dm.Item($i); name = ($rec.VendorId.Trim() + ' ' + $rec.ProductId.Trim()); letter = ($rec.VolumePathNames -join ','); media = $media; free = $free; profiles = @($rec.SupportedProfiles) }
}
$out | ConvertTo-Json -Compress -Depth 4
`;
  try {
    const r = await powershell(null, script);
    const txt = r.stdout.trim();
    if (!txt) return [];
    const j = JSON.parse(txt);
    return (Array.isArray(j) ? j : [j]).map((d) => ({ ...d, mediaName: MEDIA[d.media] || (d.media === '' ? 'No disc' : 'Unknown disc') }));
  } catch (_) {
    return [];
  }
}

const MEDIA = { 0: 'Unknown', 1: 'CD-ROM', 2: 'CD-R', 3: 'CD-RW', 4: 'DVD-ROM', 5: 'DVD-RAM', 6: 'DVD+R', 7: 'DVD+RW', 8: 'DVD+R DL', 9: 'DVD-R', 10: 'DVD-RW', 11: 'DVD-R DL', 12: 'Disk', 13: 'DVD+RW DL', 14: 'HD DVD-ROM', 15: 'HD DVD-R', 16: 'HD DVD-RAM', 17: 'BD-ROM', 18: 'BD-R', 19: 'BD-RE' };

/** Burn an ISO image to the disc in the given recorder. */
async function burnIsoLegacy(ctx, isoPath, burner, { verify = false } = {}, onProgress = () => {}) {
  if (!isWin) throw new Error('Burning is only available on Windows.');
  const imgburn = findImgBurn();
  if (imgburn) {
    const dest = burner.letter ? burner.letter.split(',')[0].replace(/\\$/, '') : String(burner.index);
    await run(ctx, imgburn, ['/MODE', 'WRITE', '/SRC', isoPath, '/DEST', dest, '/START', '/CLOSESUCCESS', '/EJECT', 'YES', '/VERIFY', verify ? 'YES' : 'NO', '/NOSAVESETTINGS']);
    onProgress(1);
    return;
  }
  const size = fs.statSync(isoPath).size;
  const script = `${PS_HELPERS}
$rec = New-Object -ComObject IMAPI2.MsftDiscRecorder2
$rec.InitializeDiscRecorder(${psq(burner.id)})
$fmt = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
$fmt.Recorder = $rec
$fmt.ClientName = 'DiscForge Studio'
if (-not $fmt.IsCurrentMediaSupported($rec)) { throw 'The disc in the drive cannot be written by this burner.' }
if (-not $fmt.MediaHeuristicallyBlank) { throw 'The disc is not blank. Erase it first or insert a blank disc.' }
if ([long]$fmt.FreeSectorsOnMedia * 2048 -lt ${size}) { throw 'The image is larger than the free space on the disc.' }
$fmt.ForceMediaToBeClosed = $true
Write-Output 'BURNING'
try {
  $stream = [DFStream]::OpenRead(${psq(isoPath)})
  $fmt.Write($stream)
} catch {
  if (${size} -gt 4000000000) { throw }
  Write-Output ('Retrying with ADODB stream: ' + $_.Exception.Message)
  $ado = New-Object -ComObject ADODB.Stream
  $ado.Type = 1
  $ado.Open()
  $ado.LoadFromFile(${psq(isoPath)})
  $fmt.Write($ado)
  $ado.Close()
}
try { $rec.EjectMedia() } catch { }
Write-Output 'DONE'
`;
  // IMAPI progress events are not reachable from PowerShell; estimate from typical write speeds.
  const bytesPerSec = size > 9e9 ? 18e6 : 8e6;
  const expected = size / bytesPerSec + 60;
  let started = null;
  const timer = setInterval(() => { if (started) onProgress(Math.min(0.95, (Date.now() - started) / 1000 / expected)); }, 2000);
  try {
    await powershell(ctx, script, (l) => { if (/^BURNING/.test(l)) started = Date.now(); else if (l.trim()) ctx.log(l); });
  } finally {
    clearInterval(timer);
  }
  onProgress(1);
}

async function eraseDiscPS(ctx, burner, quick = true) {
  if (!isWin) throw new Error('Erasing is only available on Windows.');
  const script = `
$rec = New-Object -ComObject IMAPI2.MsftDiscRecorder2
$rec.InitializeDiscRecorder(${psq(burner.id)})
$er = New-Object -ComObject IMAPI2.MsftDiscFormat2Erase
$er.Recorder = $rec
$er.ClientName = 'DiscForge Studio'
$er.FullErase = ${quick ? '$false' : '$true'}
$er.EraseMedia()
Write-Output 'DONE'
`;
  await powershell(ctx, script);
}

/* ------------------------------------------------------------------ dfburn.exe helper */
function findDfburn() {
  if (!isWin) return null;
  const dirs = [path.join(__dirname, '..', '..', 'tools'), process.resourcesPath && path.join(process.resourcesPath, 'tools')].filter(Boolean);
  for (const d of dirs) { const p = path.join(d, 'dfburn.exe'); if (fs.existsSync(p)) return p; }
  return null;
}

/** Run dfburn.exe; onEvent receives each JSON line. Resolves with the events, rejects with the helper's error. */
function dfburn(ctx, args, onEvent = () => {}, { timeoutMs = 0 } = {}) {
  const exe = findDfburn();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    let error = null; let buf = ''; let errText = '';
    child.gracefulCancel = () => {
      // Ask IMAPI2 to stop cleanly; force-kill only if it does not respond.
      try { child.stdin.write('cancel\n'); } catch (_) { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, 30000).unref();
    };
    if (ctx) ctx.children.add(child);
    const timer = timeoutMs ? setTimeout(() => { error = new Error('The disc burner did not respond.'); try { child.kill(); } catch (_) { /* ignore */ } }, timeoutMs) : null;
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch (_) { if (ctx) ctx.log(line); continue; }
        events.push(ev);
        if (ev.type === 'error') error = Object.assign(new Error(ev.message), { code: ev.code });
        else if (ev.type === 'log' && ctx) ctx.log(ev.message);
        try { onEvent(ev); } catch (_) { /* ignore */ }
      }
    });
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); if (ctx) ctx.children.delete(child); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (ctx) ctx.children.delete(child);
      if (error) {
        if (ctx && ctx.cancelled) error.cancelled = true;
        return reject(error);
      }
      if (ctx && ctx.cancelled) return reject(Object.assign(new Error('Cancelled by user.'), { cancelled: true }));
      if (code !== 0) return reject(new Error(`The burning helper stopped unexpectedly (exit code ${code}). ${errText.trim()}`));
      resolve(events);
    });
  });
}

/** List disc burners and the disc in each. */
async function listBurners() {
  if (!isWin) return [];
  if (findDfburn()) {
    try {
      const ev = await dfburn(null, ['list'], () => {}, { timeoutMs: 45000 });
      const b = ev.find((e) => e.type === 'burners');
      if (b) return b.burners.map((d) => ({ ...d, speeds: speedOptions(d.media, d.speeds || []) }));
    } catch (_) { /* fall back */ }
  }
  return listBurnersPS();
}

/** Sectors-per-second at 1x for the media type (IMAPI_SECTORS_PER_SECOND_AT_1X_*). */
function oneXSectors(media) { return media >= 17 ? 2195 : media >= 4 ? 676.5 : 75; }
/** Turn the drive's supported write speeds (sectors/s) into [{ sectors, x, label }], slowest first. */
function speedOptions(media, list) {
  const one = oneXSectors(media);
  const seen = new Set();
  return [...new Set(list.map(Number).filter((n) => n > 0))].sort((a, b) => a - b).map((sectors) => {
    const raw = sectors / one;
    const x = raw >= 10 ? Math.round(raw) : Math.round(raw * 10) / 10;
    return { sectors, x, label: `${x}×  (${((sectors * 2048) / 1e6).toFixed(1)} MB/s)` };
  }).filter((o) => (seen.has(o.x) ? false : seen.add(o.x)));
}

const PHASES = {
  preparing: 'Preparing', validating: 'Checking the disc', formatting: 'Formatting the disc', initializing: 'Getting the burner ready',
  calibrating: 'Calibrating laser power', writing: 'Writing data', finalizing: 'Finalizing the disc', completed: 'Completed',
  verifying: 'Verifying', erasing: 'Erasing the disc',
};

/** Burn an ISO image to the disc in the given recorder. */
async function burnIso(ctx, isoPath, burner, opts = {}, onProgress = () => {}) {
  if (!isWin) throw new Error('Burning is only available on Windows.');
  if (!findDfburn()) {
    if (ctx) ctx.log('dfburn.exe was not found; using the fallback burning method (no live progress).');
    return burnIsoLegacy(ctx, isoPath, burner, opts, onProgress);
  }
  const size = fs.statSync(isoPath).size;
  const args = ['burn', isoPath, burner.id || String(burner.index || 0)];
  // opts.speed: 0/undefined = drive maximum; >= 50 = sectors per second; otherwise a multiple of 1x
  if (opts.speed >= 50) args.push('--speed-sectors', String(Math.round(opts.speed)));
  else if (opts.speed > 0) args.push('--speed', String(opts.speed));
  ctx.log(`Write speed: ${opts.speed ? (opts.speed >= 50 ? `${opts.speed} sectors/s` : `${opts.speed}x`) : 'drive maximum'}`);
  if (opts.eject === false) args.push('--no-eject');
  let media = null; let lastLogged = '';
  let writeStart = null;
  const oneX = () => (media && media.media >= 17 ? 4.5e6 : media && media.media >= 4 ? 1.385e6 : 153600);
  ctx.log(`Burning with dfburn.exe: ${isoPath} (${(size / 1e9).toFixed(2)} GB)`);
  await dfburn(ctx, args, (ev) => {
    if (ev.type === 'speed') {
      const one = oneXSectors(media ? media.media : 9);
      ctx.log(`Burner set to ${(ev.current / one).toFixed(1)}x (asked for ${(ev.requested / one).toFixed(1)}x)`);
    }
    if (ev.type === 'media') {
      media = ev;
      ctx.log(`Disc in drive: ${ev.mediaName}, ${(ev.free / 1e9).toFixed(2)} GB free, blank: ${ev.blank}`);
    }
    if (ev.type !== 'progress') return;
    const phase = ev.phase || 'working';
    if (phase !== lastLogged) { ctx.log(`Burn phase: ${PHASES[phase] || phase}`); lastLogged = phase; }
    if (phase === 'writing' && !writeStart) writeStart = { t: Date.now(), bytes: ev.bytesDone || 0 };
    let speed = null;
    if (phase === 'writing' && writeStart && ev.bytesDone > writeStart.bytes) {
      const secs = (Date.now() - writeStart.t) / 1000;
      if (secs > 2) speed = (ev.bytesDone - writeStart.bytes) / secs;
    }
    // Writing is ~97% of the work; lead-in and finalizing take the rest.
    const f = phase === 'writing' ? 0.02 + 0.95 * (ev.fraction || 0) : phase === 'finalizing' ? 0.98 : phase === 'completed' ? 1 : 0.01;
    onProgress(f);
    ctx.detail({
      kind: 'burn',
      phase,
      phaseLabel: PHASES[phase] || phase,
      media: media ? media.mediaName : null,
      bytesDone: ev.bytesDone || 0,
      bytes: ev.bytes || size,
      speed,
      speedX: speed ? speed / oneX() : null,
      remaining: phase === 'writing' && ev.remaining > 0 ? ev.remaining : null,
      buffer: ev.buffer >= 0 ? ev.buffer : null,
    });
  });
  ctx.log('Disc burned successfully.');
  onProgress(1);
}

async function eraseDisc(ctx, burner, quick = true, onProgress = () => {}) {
  if (!isWin) throw new Error('Erasing is only available on Windows.');
  if (!findDfburn()) return eraseDiscPS(ctx, burner, quick);
  const args = ['erase', burner.id || String(burner.index || 0)];
  if (!quick) args.push('--full');
  await dfburn(ctx, args, (ev) => {
    if (ev.type !== 'progress') return;
    onProgress(ev.fraction || 0);
    if (ctx.detail) ctx.detail({ kind: 'burn', phase: ev.phase, phaseLabel: PHASES[ev.phase] || ev.phase, remaining: ev.remaining || null });
  });
  onProgress(1);
}

async function shutdownComputer(delaySec = 60) {
  if (isWin) await run(null, 'shutdown', ['/s', '/t', String(delaySec), '/c', 'DiscForge Studio finished authoring.']);
}

async function cancelShutdown() {
  if (isWin) await run(null, 'shutdown', ['/a'], { allowFail: true });
}

module.exports = { speedOptions, makeIso, listBurners, burnIso, eraseDisc, shutdownComputer, cancelShutdown, findImgBurn, findDfburn };
