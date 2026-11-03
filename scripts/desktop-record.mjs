#!/usr/bin/env node
/**
 * record-and-replay — desktop recording driver (cross-platform).
 *
 * Usage:
 *   node desktop-record.mjs start  <slug> [minutes] [--privacy <file>]  # start in the background (default 30)
 *   node desktop-record.mjs pause  <slug>             # pause (closes the current segment)
 *   node desktop-record.mjs resume <slug> [minutes]   # resume (opens a new segment, same privacy rules)
 *   node desktop-record.mjs stop   <slug>             # stop the recording
 *   node desktop-record.mjs status <slug>             # state + counts (JSON)
 *   node desktop-record.mjs permissions               # check/request macOS permissions
 *   node desktop-record.mjs selftest [--no-live]      # engine self-test (no permissions needed)
 *
 * Engine: desktop-lite-recorder.py — single process, pynput based (Codex parity:
 * no video, no continuous screen reading). Input event stream + window changes
 * + a half-resolution JPEG and the semantic target (macOS AX / Windows UI
 * Automation) at each click + typed text with password fields masked →
 * desktop-events.jsonl + screens/. ~0-3% CPU. macOS / Windows / Linux(X11).
 *
 * Privacy rules: ~/.agents/recordings/privacy.json when present, or --privacy
 * <file> (excluded windows/processes, redaction regexes — see
 * privacy.example.json). Password fields are masked regardless.
 *
 * Python environment: .venv-desktop at the skill root (requirements-desktop.txt,
 * created by `node setup.mjs`). Stopping is signal-free: the recorder watches
 * <outDir>/STOP and finalizes cleanly on every platform.
 *
 * Pause is segment-based: suspending the process (SIGSTOP) can silently kill the
 * macOS event tap, so pause closes a segment and resume opens a new one.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ROOT = path.join(os.homedir(), '.agents', 'recordings');
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPTS_DIR);
const LITE_RUNNER = path.join(SCRIPTS_DIR, 'desktop-lite-recorder.py');
const PERMISSION_HELPER = path.join(SCRIPTS_DIR, 'desktop-permissions.py');

const rawArgs = process.argv.slice(2);
// --privacy takes a value; pull it out before the positional parse.
let PRIVACY_ARG = null;
const privacyAt = rawArgs.indexOf('--privacy');
if (privacyAt !== -1) {
  PRIVACY_ARG = rawArgs[privacyAt + 1] || null;
  rawArgs.splice(privacyAt, 2);
}
const [CMD, SLUG, MINUTES_RAW] = rawArgs.filter((a) => !a.startsWith('--'));
const NO_SLUG = new Set(['permissions', 'selftest']);
if (!CMD || (!SLUG && !NO_SLUG.has(CMD))) {
  console.error('usage: desktop-record.mjs start|pause|resume|stop|status <slug> [minutes] [--privacy <file>] | permissions | selftest');
  process.exit(2);
}
const MINUTES = Math.min(Math.max(Number(MINUTES_RAW || 30) || 30, 1), 240);

// `permissions` takes no slug; the per-recording paths below stay unused for it.
const OUT_DIR = path.join(ROOT, SLUG || '.no-session');
const PID_FILE = path.join(OUT_DIR, 'desktop.pid');
const LOG_FILE = path.join(OUT_DIR, 'recorder.log');
const EVENTS_FILE = path.join(OUT_DIR, 'desktop-events.jsonl');
const SCREENS_DIR = path.join(OUT_DIR, 'screens');
const STOP_FILE = path.join(OUT_DIR, 'STOP');
const PAUSED_FILE = path.join(OUT_DIR, 'PAUSED');
const OPTIONS_FILE = path.join(OUT_DIR, 'desktop-options.json');
const LOCK_FILE = path.join(ROOT, '.desktop-lock');
const SELFTEST = path.join(SCRIPTS_DIR, 'desktop-selftest.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readNum(file) {
  try { return parseInt(fs.readFileSync(file, 'utf8').trim(), 10); } catch { return null; }
}

function fail(obj, code = 1) {
  console.error(JSON.stringify(obj));
  process.exit(code);
}

// Python for the lite engine: the minimal venv at the skill root (node setup.mjs).
function findVenvPython() {
  const p = path.join(SKILL_DIR, '.venv-desktop', IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python');
  return fs.existsSync(p) ? p : null;
}

// The background recorder on Windows runs under pythonw.exe: a detached
// python.exe gets a console of its own, which Windows Terminal shows as a new
// window that steals focus (and lands in the recording).
function recorderPython() {
  const python = findVenvPython();
  if (!python || !IS_WIN) return python;
  const windowless = path.join(path.dirname(python), 'pythonw.exe');
  return fs.existsSync(windowless) ? windowless : python;
}

// --- counts (desktop-events*.jsonl + screens/) -------------------------------
function jsonlCount(file, kind) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let n = 0;
  for (const needle of [`"kind": "${kind}"`, `"kind":"${kind}"`]) {
    let i = 0;
    while ((i = data.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
  }
  return n;
}

function totalCount(kind) {
  let total = 0;
  if (fs.existsSync(OUT_DIR)) {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (/^desktop-events(-part\d+)?\.jsonl$/.test(f)) {
        total += jsonlCount(path.join(OUT_DIR, f), kind);
      }
    }
  }
  return total;
}

// Masked text blocks (password fields, unverifiable fields) across all segments.
function maskedCount() {
  let total = 0;
  if (!fs.existsSync(OUT_DIR)) return 0;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!/^desktop-events(-part\d+)?\.jsonl$/.test(f)) continue;
    const data = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
    total += (data.match(/"masked": ?true/g) || []).length;
  }
  return total;
}

// Privacy rules follow the recording across pause/resume.
function privacyFile() {
  if (PRIVACY_ARG) return path.resolve(PRIVACY_ARG);
  try { return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8')).privacy || null; } catch { return null; }
}

function screenshotCount() {
  if (!fs.existsSync(SCREENS_DIR)) return 0;
  return fs.readdirSync(SCREENS_DIR).filter((f) => f.endsWith('.jpg')).length;
}

// --- recorder lifecycle --------------------------------------------------------
function launchRecorder(minutes) {
  const python = recorderPython();
  if (!python) {
    fail({ error: 'desktop_env_missing', fix: 'cd ' + SKILL_DIR + ' && node setup.mjs' });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(STOP_FILE, { force: true }); // a stale STOP must not stop us instantly
  // The log accumulates across segments; note its size before spawning so this
  // run's READY is not confused with a previous one.
  let logOffset = 0;
  try { logOffset = fs.statSync(LOG_FILE).size; } catch {}
  const logFd = fs.openSync(LOG_FILE, 'a');
  const privacy = privacyFile();
  if (privacy && !fs.existsSync(privacy)) {
    fs.closeSync(logFd);
    fail({ error: 'privacy_file_missing', privacy });
  }
  fs.writeFileSync(OPTIONS_FILE, JSON.stringify({ privacy }));
  const child = spawn(python, [LITE_RUNNER, OUT_DIR, SLUG, String(minutes),
    ...(privacy ? ['--privacy', privacy] : [])], {
    // Detached on Windows too: a non-detached child shares this process's console
    // and dies with it — under an agent's short-lived shell that ended the
    // recording right after READY. windowsHide keeps the new console invisible.
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(PID_FILE, String(child.pid));
  fs.writeFileSync(LOCK_FILE, String(child.pid));
  return { pid: child.pid, logOffset };
}

// Re-recording under the same slug: keep old segments and screenshots out of the
// new recording (the summarizer merges partN files in order).
function archivePreviousRun() {
  if (!fs.existsSync(OUT_DIR)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (/^desktop-events(-part\d+)?\.jsonl$/.test(f)) {
      fs.renameSync(path.join(OUT_DIR, f), path.join(OUT_DIR, `${f}.${stamp}.bak`));
    }
  }
  if (fs.existsSync(SCREENS_DIR) && fs.readdirSync(SCREENS_DIR).length) {
    fs.renameSync(SCREENS_DIR, path.join(OUT_DIR, `screens.${stamp}.bak`));
  }
}

// Startup verification: only the READY line counts. The events file is opened
// before pynput loads, so "file exists" does not mean "capture is live" — on a
// cold start that gap was a ~10 s blind window.
async function verifyStarted({ pid, logOffset }) {
  for (let i = 0; i < 240; i += 1) {
    let tail = '';
    try { tail = fs.readFileSync(LOG_FILE, 'utf8').slice(logOffset); } catch {}
    const ready = tail.split('\n').find((l) => l.startsWith('READY'));
    if (ready) {
      try { return JSON.parse(ready.slice(6).trim() || '{}'); } catch { return {}; }
    }
    if (!pidAlive(pid)) return null;
    await sleep(250);
  }
  return null;
}

// Without permission the recording yields 0 events; never report that as a plain "recording".
function permissionWarning(perms) {
  if (!perms) return null;
  const missing = [];
  if (perms.inputMonitoring === false) missing.push('Input Monitoring / Accessibility');
  if (perms.screenRecording === false) missing.push('Screen Recording');
  if (!missing.length) return null;
  // The grant binds to the .app bundle in the process tree, not to python; name it.
  const app = perms.grantTo ? `"${perms.grantTo}"` : 'the app running the agent';
  return `Missing macOS permission: ${missing.join(' + ')} — grant it to ${app} in System Settings › Privacy & Security, then restart that app (a TCC change does not apply to a running process) and start the recording again.`;
}

// Missing permission means a silently empty recording, so ask the OS for it
// instead of printing advice: this pops the native dialog and opens the exact
// Settings pane. Skipped with --no-permission-prompt.
function requestPermissions() {
  const python = findVenvPython();
  if (!python || process.platform !== 'darwin' || rawArgs.includes('--no-permission-prompt')) return null;
  const r = spawnSync(python, [PERMISSION_HELPER, '--request'], { encoding: 'utf8', timeout: 20_000 });
  try { return JSON.parse((r.stdout || '').trim()); } catch { return null; }
}

function lastReportedPermissions() {
  let log = '';
  try { log = fs.readFileSync(LOG_FILE, 'utf8'); } catch { return null; }
  const ready = log.split('\n').filter((l) => l.startsWith('READY')).pop();
  if (!ready) return null;
  try { return JSON.parse(ready.slice(6).trim() || '{}'); } catch { return null; }
}

// Graceful stop: STOP file → the recorder finalizes itself (signal-free).
async function gracefulStop(pid) {
  fs.writeFileSync(STOP_FILE, 'stop\n');
  for (let i = 0; i < 30 && pidAlive(pid); i += 1) await sleep(1000);
  if (pidAlive(pid)) {
    // Last resort — kill the group on POSIX so no orphan thread/process remains.
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try { process.kill(-pid, 'SIGKILL'); }
      catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    await sleep(1000);
    return false;
  }
  return true;
}

async function abortLaunch(pid) {
  if (pid && pidAlive(pid)) await gracefulStop(pid);
  fs.rmSync(PID_FILE, { force: true });
  fs.rmSync(STOP_FILE, { force: true });
}

function nextPartNumber() {
  let n = 1;
  while (fs.existsSync(path.join(OUT_DIR, `desktop-events-part${n}.jsonl`))) n += 1;
  return n;
}

// --- commands ------------------------------------------------------------------
const main = {
  async start() {
    if (fs.existsSync(LOCK_FILE)) {
      const val = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      if (val === 'paused') fail({ error: 'recording_already_active', state: 'paused', hint: 'use resume or stop' }, 2);
      const pid = parseInt(val, 10);
      if (pid && pidAlive(pid)) fail({ error: 'recording_already_active', pid }, 2);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.rmSync(PAUSED_FILE, { force: true });
    archivePreviousRun();
    const launch = launchRecorder(MINUTES);
    const perms = await verifyStarted(launch);
    if (perms) {
      const warning = permissionWarning(perms);
      const prompted = warning ? requestPermissions() : null;
      console.log(JSON.stringify({
        status: 'recording', pid: launch.pid, outDir: OUT_DIR, timeLimitMinutes: MINUTES,
        capture: 'event stream + window context + click screenshots (~0-3% CPU)',
        ...(Object.keys(perms).length ? { permissions: perms } : {}),
        ...(warning ? { warning } : {}),
        ...(prompted ? { permissionPrompt: prompted } : {}),
      }));
    } else {
      await abortLaunch(launch.pid);
      fs.rmSync(LOCK_FILE, { force: true });
      let tail = '';
      try { tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-5).join('\n'); } catch {}
      fail({ error: 'start_failed', log: LOG_FILE, tail });
    }
  },

  async pause() {
    const pid = readNum(PID_FILE);
    if (!pid) fail({ error: 'no_active_recording' });
    if (!pidAlive(pid)) fail({ error: 'recorder_not_running' });
    const clean = await gracefulStop(pid);
    fs.rmSync(PID_FILE, { force: true });
    fs.rmSync(STOP_FILE, { force: true });
    const n = nextPartNumber();
    if (fs.existsSync(EVENTS_FILE)) fs.renameSync(EVENTS_FILE, path.join(OUT_DIR, `desktop-events-part${n}.jsonl`));
    fs.writeFileSync(PAUSED_FILE, 'paused\n');
    fs.writeFileSync(LOCK_FILE, 'paused');
    console.log(JSON.stringify({ status: 'paused', parts: n, cleanStop: clean, outDir: OUT_DIR }));
  },

  async resume() {
    if (!fs.existsSync(PAUSED_FILE)) fail({ error: 'not_paused' });
    fs.rmSync(PAUSED_FILE, { force: true });
    const launch = launchRecorder(MINUTES);
    const perms = await verifyStarted(launch);
    if (perms) {
      const warning = permissionWarning(perms);
      console.log(JSON.stringify({
        status: 'recording', pid: launch.pid, outDir: OUT_DIR, timeLimitMinutes: MINUTES,
        ...(warning ? { warning } : {}),
      }));
    } else {
      await abortLaunch(launch.pid);
      fs.writeFileSync(PAUSED_FILE, 'paused\n');
      fs.writeFileSync(LOCK_FILE, 'paused');
      fail({ error: 'resume_failed', log: LOG_FILE });
    }
  },

  async stop() {
    const pid = readNum(PID_FILE);
    let clean = true;
    if (pid && pidAlive(pid)) clean = await gracefulStop(pid);
    else if (!pid && !fs.existsSync(PAUSED_FILE)) fail({ error: 'no_active_recording' });
    fs.rmSync(LOCK_FILE, { force: true });
    fs.rmSync(PID_FILE, { force: true });
    fs.rmSync(PAUSED_FILE, { force: true });
    fs.rmSync(STOP_FILE, { force: true });
    console.log(JSON.stringify({
      status: 'completed', outDir: OUT_DIR, cleanStop: clean,
      actionEvents: totalCount('input'),
      screenshots: screenshotCount(),
    }));
  },

  async status() {
    const pid = readNum(PID_FILE);
    const perms = lastReportedPermissions();
    const warning = permissionWarning(perms);
    console.log(JSON.stringify({
      recording: Boolean(pid && pidAlive(pid)),
      paused: fs.existsSync(PAUSED_FILE),
      actionEvents: totalCount('input'),
      windowEvents: totalCount('window'),
      semanticTargets: totalCount('target'),
      maskedTexts: maskedCount(),
      screenshots: screenshotCount(),
      ...(perms && Object.keys(perms).length ? { permissions: perms } : {}),
      ...(warning ? { warning } : {}),
      outDir: OUT_DIR,
    }));
  },

  async permissions() {
    const python = findVenvPython();
    if (!python) fail({ error: 'desktop_env_missing', fix: `cd ${SKILL_DIR} && node setup.mjs` });
    const r = spawnSync(python, [PERMISSION_HELPER, '--request'], { encoding: 'utf8', timeout: 20_000 });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) process.exit(r.status ?? 1);
  },

  // Cross-platform entry point (npm scripts cannot pick .venv-desktop/bin vs Scripts).
  async selftest() {
    const python = findVenvPython();
    if (!python) fail({ error: 'desktop_env_missing', fix: `cd ${SKILL_DIR} && node setup.mjs` });
    const r = spawnSync(python, [SELFTEST, ...rawArgs.filter((a) => a === '--no-live')], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  },
};

if (!main[CMD]) {
  console.error('usage: desktop-record.mjs start|pause|resume|stop|status <slug> [minutes] [--privacy <file>] | permissions | selftest');
  process.exit(2);
}
await main[CMD]();
