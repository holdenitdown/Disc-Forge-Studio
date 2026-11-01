'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class CancelledError extends Error {
  constructor() { super('Cancelled'); this.cancelled = true; }
}

/**
 * A job context shared by every step of an authoring run: logging, progress,
 * cancellation and child process tracking.
 */
class JobContext {
  constructor({ onProgress, onLog, logFile } = {}) {
    this.onProgress = onProgress || (() => {});
    this.onLog = onLog || (() => {});
    this.logFile = logFile;
    this.children = new Set();
    this.cancelled = false;
    this.steps = [];
    this.stepIndex = -1;
  }

  log(line) {
    const msg = `[${new Date().toISOString()}] ${line}`;
    this.onLog(msg);
    if (this.logFile) fs.appendFileSync(this.logFile, msg + os.EOL);
  }

  /** Declare the list of steps (each with a weight) so overall progress can be computed. */
  plan(steps) {
    this.steps = steps.map((s) => ({ weight: 1, ...s }));
    this.stepIndex = -1;
  }

  beginStep(id) {
    const idx = this.steps.findIndex((s) => s.id === id);
    this.stepIndex = idx >= 0 ? idx : this.stepIndex + 1;
    this.stepFraction = 0;
    this.info = null;
    this.emit();
  }

  stepProgress(fraction) {
    this.stepFraction = Math.max(0, Math.min(1, fraction));
    this.emit();
  }

  /** Extra live details for the current step (e.g. disc burning status). */
  detail(info) {
    this.info = info;
    this.emit();
  }

  emit() {
    const total = this.steps.reduce((s, x) => s + x.weight, 0) || 1;
    let done = 0;
    for (let i = 0; i < this.stepIndex; i++) done += this.steps[i].weight;
    const cur = this.steps[this.stepIndex];
    if (cur) done += cur.weight * (this.stepFraction || 0);
    this.onProgress({
      step: cur ? cur.label : '',
      stepIndex: this.stepIndex,
      stepCount: this.steps.length,
      stepFraction: this.stepFraction || 0,
      overall: done / total,
      info: this.info || null,
    });
  }

  check() {
    if (this.cancelled) throw new CancelledError();
  }

  cancel() {
    this.cancelled = true;
    for (const child of this.children) {
      if (child.gracefulCancel) { try { child.gracefulCancel(); } catch (_) { /* ignore */ } continue; }
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
        else child.kill('SIGKILL');
      } catch (_) { /* already gone */ }
    }
  }
}

/**
 * Run a process. opts.onLine receives stdout/stderr lines (used for progress parsing).
 * Resolves { code, stdout, stderr }; rejects on non-zero exit unless opts.allowFail.
 */
function run(ctx, cmd, args, opts = {}) {
  if (ctx) ctx.check();
  return new Promise((resolve, reject) => {
    if (ctx) ctx.log(`$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true });
    if (ctx) ctx.children.add(child);
    let stdout = '';
    let stderr = '';
    const tail = [];
    const feed = (chunk, which) => {
      const s = chunk.toString();
      if (which === 'out' && opts.captureStdout !== false) stdout += s;
      if (which === 'err') stderr += s.length > 200000 ? '' : s;
      for (const line of s.split(/\r|\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (opts.onLine) opts.onLine(line);
      }
    };
    child.stdout.on('data', (c) => feed(c, 'out'));
    child.stderr.on('data', (c) => feed(c, 'err'));
    if (opts.input) { child.stdin.write(opts.input); child.stdin.end(); }
    child.on('error', (err) => {
      if (ctx) ctx.children.delete(child);
      reject(new Error(`Could not start ${path.basename(cmd)}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (ctx) ctx.children.delete(child);
      if (ctx && ctx.cancelled) return reject(new CancelledError());
      if (code !== 0 && !opts.allowFail) {
        if (ctx) ctx.log(tail.join('\n'));
        return reject(new Error(`${path.basename(cmd)} failed (exit ${code}):\n${tail.slice(-12).join('\n')}`));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Parse ffmpeg "time=HH:MM:SS.xx" progress lines. */
function ffmpegProgress(totalSec, cb) {
  return (line) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m && totalSec > 0) cb(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / totalSec));
  };
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

function tempDir(base, name) {
  return ensureDir(path.join(base, name));
}

function secToTimestamp(sec, sep = '.') {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

function parseTimestamp(str) {
  if (typeof str === 'number') return str;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function freeSpace(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (_) {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape a path for use inside an ffmpeg filter argument. */
function ffFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

module.exports = { JobContext, CancelledError, run, ffmpegProgress, ensureDir, tempDir, secToTimestamp, parseTimestamp, freeSpace, dirSize, escapeXml, ffFilterPath };
