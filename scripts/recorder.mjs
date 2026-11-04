#!/usr/bin/env node
/**
 * record-and-replay — Playwright-based user action recorder.
 *
 * Launches a headed browser (system Chrome if available, bundled Chromium otherwise),
 * captures every user action (clicks, typing, navigation, downloads, dialogs, selection)
 * into events.jsonl, and saves a full Playwright trace (DOM snapshots + screenshots).
 *
 * Usage:
 *   node recorder.mjs [--url <startUrl>] [--minutes 30] [--name <session-name>]
 *                     [--out <dir>] [--browser chrome|chromium] [--panel] [--self-test]
 *
 * Stop conditions (whichever comes first):
 *   - user clicks the floating "Stop" button in the browser
 *   - user closes all browser windows
 *   - `touch <outDir>/STOP` (lets the agent stop the recording programmatically)
 *   - time limit (default 30 minutes)
 *   - SIGINT / SIGTERM
 *
 * Outputs in <outDir>:
 *   session.json   — status, timing, endReason, paths (written at start, updated at end)
 *   events.jsonl   — one JSON event per line (primary evidence)
 *   trace-NNN.zip  — Playwright trace chunks (60s checkpoints; Cmd+Q loses at most
 *                    the last chunk); open with `npx playwright show-trace trace-*.zip`
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(flag, fallback = null) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const hasFlag = (flag) => args.includes(flag);

const SELF_TEST = hasFlag('--self-test');
const START_URL = argValue('--url');
const minutesRaw = argValue('--minutes', SELF_TEST ? '1' : '30');
const minutesNum = Number(minutesRaw);
if (!Number.isFinite(minutesNum) || minutesNum <= 0) {
  console.error(JSON.stringify({ error: 'invalid_minutes', message: `--minutes must be a positive number, got: ${minutesRaw}` }));
  process.exit(2);
}
const MINUTES = Math.min(minutesNum, 240);
const BROWSER_PREF = argValue('--browser', 'chrome'); // chrome | chromium
// Trace mode: light (default — DOM snapshots, NO continuous screenshots; CPU friendly),
// full (with screenshots, heavy), off (events.jsonl only).
const TRACE_MODE = ['light', 'full', 'off'].includes(argValue('--trace', 'light'))
  ? argValue('--trace', 'light') : 'light';
// Keep controls on the recorded page by default. --badge remains accepted for
// existing callers; --panel explicitly opts into the separate control window.
const USE_BADGE = !hasFlag('--panel');
let selfTestControlsOk = false;
const SESSION_NAME =
  argValue('--name') || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const RECORDINGS_ROOT = path.join(os.homedir(), '.agents', 'recordings');
const OUT_DIR_IS_TEMP = SELF_TEST && !argValue('--out');
const OUT_DIR = path.resolve(
  argValue('--out') ||
    (OUT_DIR_IS_TEMP
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'rr-selftest-out-'))
      : path.join(RECORDINGS_ROOT, SESSION_NAME))
);
// Self-test never touches the shared profile: a throwaway profile keeps logins clean.
const PROFILE_DIR = SELF_TEST
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'rr-selftest-'))
  : path.join(RECORDINGS_ROOT, '.browser-profile');
const LOCK_PATH = path.join(RECORDINGS_ROOT, '.lock');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const SESSION_PATH = path.join(OUT_DIR, 'session.json');
const EVENTS_PATH = path.join(OUT_DIR, 'events.jsonl');
const STOP_PATH = path.join(OUT_DIR, 'STOP');
const PAUSE_PATH = path.join(OUT_DIR, 'PAUSE');

// ---------------------------------------------------------------------------
// Single active recording lock
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (!SELF_TEST && fs.existsSync(LOCK_PATH)) {
  try {
    const other = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (other.pid && pidAlive(other.pid)) {
      console.error(
        JSON.stringify({
          error: 'recording_already_active',
          message: `Another recording is already running (pid ${other.pid}, outDir ${other.outDir}). Stop it first (touch ${other.outDir}/STOP) or wait for it to finish.`,
        })
      );
      process.exit(2);
    }
  } catch {
    /* stale/corrupt lock — overwrite below */
  }
}
if (!SELF_TEST) {
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, outDir: OUT_DIR }));
}

// ---------------------------------------------------------------------------
// Event sink
// ---------------------------------------------------------------------------
// Stale STOP/PAUSE files from a previous run must not affect this session.
try { fs.rmSync(STOP_PATH, { force: true }); } catch {}
try { fs.rmSync(PAUSE_PATH, { force: true }); } catch {}
// A second recording with the same --name must not append to the old one: back it up.
if (fs.existsSync(EVENTS_PATH)) {
  const stamp = new Date(fs.statSync(EVENTS_PATH).mtimeMs).toISOString().replace(/[:.]/g, '-');
  fs.renameSync(EVENTS_PATH, path.join(OUT_DIR, `events-${stamp}.jsonl.bak`));
}
const eventsStream = fs.createWriteStream(EVENTS_PATH, { flags: 'w' });
let seq = 0;
const startedAt = Date.now();

// Guards against malicious/buggy page JS filling the disk: per-second and total
// event caps. Real user actions stay far below these limits.
const MAX_EVENTS_TOTAL = 100_000;
const MAX_EVENTS_PER_SEC = 200;
let rateWindowStart = Date.now();
let rateWindowCount = 0;
let rateLimitedNoted = false;

function emit(evt) {
  // While paused, user/page events are dropped; session markers still pass through.
  if (paused && evt.kind !== 'session') return;
  if (seq >= MAX_EVENTS_TOTAL) {
    requestStop('event_limit');
    return;
  }
  const now = Date.now();
  if (now - rateWindowStart >= 1000) {
    rateWindowStart = now;
    rateWindowCount = 0;
    rateLimitedNoted = false;
  }
  rateWindowCount += 1;
  if (rateWindowCount > MAX_EVENTS_PER_SEC) {
    if (!rateLimitedNoted) {
      rateLimitedNoted = true;
      seq += 1;
      eventsStream.write(JSON.stringify({ seq, t: now - startedAt, kind: 'session', type: 'rate_limited' }) + '\n');
    }
    return;
  }
  seq += 1;
  let line = JSON.stringify({ seq, t: now - startedAt, ...evt });
  if (line.length > 10_000) line = JSON.stringify({ seq, t: now - startedAt, kind: 'session', type: 'oversized_event_dropped', originalType: evt.type });
  eventsStream.write(line + '\n');
}

function writeSession(extra) {
  const base = {
    schema: 'record-and-replay-playwright/1',
    pid: process.pid,
    name: SESSION_NAME,
    startedAt: new Date(startedAt).toISOString(),
    timeLimitMinutes: MINUTES,
    traceMode: TRACE_MODE,
    controls: USE_BADGE ? 'badge' : 'panel',
    eventsPath: EVENTS_PATH,
    outDir: OUT_DIR,
  };
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ ...base, ...extra }, null, 2));
}
writeSession({ status: 'recording' });

// ---------------------------------------------------------------------------
// In-page recorder (injected into every frame)
// ---------------------------------------------------------------------------
const NONCE = crypto.randomUUID();

const INIT_SCRIPT = `(() => {
  if (window.__rrInstalled) return;
  // The control panel window is NOT a recording surface: attach no listeners.
  if (location.href.indexOf('__rr_control_panel__') !== -1) return;
  window.__rrInstalled = true;

  // Capture the binding in a closure and delete it from window so page JS cannot inject events.
  const __emit = window.__rrEmit;
  try { delete window.__rrEmit; } catch {}

  // English + Turkish sensitive-field keywords (the probe is tested accent-folded).
  const SENSITIVE = /passw|otp|one-?time|cvv|cvc|card|secret|token|pin\\b|ssn|tckn|iban|auth|parola|sifre|gizli|kart|kimlik|guvenlik|dogrulama|hesap ?no/i;
  const MASK = '***MASKED***';

  function foldTurkish(s) {
    return String(s).toLowerCase().normalize('NFD')
      .replace(/[\\u0300-\\u036f\\u0327]/g, '')
      .replace(/\\u0131/g, 'i'); // dotless i does not decompose under NFD
  }

  function isSensitive(el) {
    if (!el || !el.getAttribute) return false;
    if (el.type === 'password') return true;
    const autocomplete = el.getAttribute('autocomplete') || '';
    if (/^cc-/.test(autocomplete) || autocomplete === 'one-time-code') return true;
    const probe = foldTurkish([
      el.name, el.id, autocomplete,
      el.getAttribute('placeholder'), el.getAttribute('aria-label'),
    ].filter(Boolean).join(' '));
    return SENSITIVE.test(probe);
  }

  // Shape-based secret detection for visible/copied text (OTP, API key, JWT…).
  function looksLikeSecret(s) {
    const t = String(s || '').trim();
    if (/^\\d{6,8}$/.test(t)) return true;
    if (/^(sk-|ghp_|gho_|xox|AKIA|eyJ|-----BEGIN)/.test(t)) return true;
    if (/^\\S{16,}$/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\\d/.test(t)) return true;
    return false;
  }

  function truncate(s, n) {
    if (typeof s !== 'string') return s;
    s = s.replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  const ROLE_MAP = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button' };
  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit') return t === 'submit' ? 'button' : t;
      return 'textbox';
    }
    return ROLE_MAP[tag] || null;
  }

  function accessibleName(el) {
    if (!el || !el.getAttribute) return null;
    const aria = el.getAttribute('aria-label');
    if (aria) return truncate(aria, 80);
    if (el.labels && el.labels.length) return truncate(el.labels[0].textContent, 80);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy.split(/\\s+/)[0]);
      if (ref) return truncate(ref.textContent, 80);
    }
    if (el.placeholder) return truncate(el.placeholder, 80);
    if (['BUTTON', 'A', 'SUMMARY', 'LABEL'].includes(el.tagName)) return truncate(el.textContent, 80);
    if (el.value && el.type === 'submit') return truncate(el.value, 80);
    const title = el.getAttribute('title');
    if (title) return truncate(title, 80);
    return null;
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\\w-]{0,63}$/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  // Emit several selector candidates; skill generation picks the most robust one.
  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const d = {
      tag: el.tagName.toLowerCase(),
      selectors: {},
    };
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) { d.selectors.testId = v; break; }
    }
    if (el.id && /^[A-Za-z][\\w-]{0,63}$/.test(el.id)) d.selectors.id = el.id;
    const role = roleOf(el);
    const name = accessibleName(el);
    if (role) d.selectors.role = name ? { role, name } : { role };
    if (el.name) d.selectors.nameAttr = el.name;
    const text = truncate(el.textContent || '', 60);
    if (text && ['button', 'a', 'summary', 'label', 'span', 'div', 'li', 'td', 'th', 'h1', 'h2', 'h3'].includes(d.tag)) {
      d.selectors.text = text;
    }
    d.selectors.css = cssPath(el);
    if (el.type) d.inputType = el.type;
    if (el.placeholder) d.placeholder = truncate(el.placeholder, 60);
    if (el.href && d.tag === 'a') d.href = truncate(el.getAttribute('href') || '', 200);
    return d;
  }

  function targetOf(e) {
    const p = e.composedPath ? e.composedPath() : [e.target];
    return p[0] && p[0].nodeType === 1 ? p[0] : e.target;
  }

  function isOurUi(e) {
    const p = e.composedPath ? e.composedPath() : [e.target];
    return p.some((n) => n && n.id === '__rr-badge-host');
  }

  function send(payload) {
    try {
      if (__emit) __emit({ nonce: '${NONCE}', frameUrl: location.href, ...payload });
    } catch { /* drop silently if the binding is not ready yet */ }
  }

  // --- click / dblclick / contextmenu -------------------------------------
  for (const type of ['click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, (e) => {
      if (!e.isTrusted || isOurUi(e)) return;
      const el = targetOf(e);
      // Find the clickable ancestor: target the button/a rather than an inner span.
      const clickable = el && el.closest
        ? el.closest('button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], input, select, textarea, summary, label, [onclick]') || el
        : el;
      send({ type, target: describe(clickable), x: Math.round(e.pageX), y: Math.round(e.pageY) });
    }, { capture: true, passive: true });
  }

  // --- input (debounced, final value per element) --------------------------
  const inputTimers = new WeakMap();
  function flushInput(el) {
    const timer = inputTimers.get(el);
    if (timer) { clearTimeout(timer.id); inputTimers.delete(el); }
    const masked = isSensitive(el);
    let value = el.isContentEditable ? el.textContent : el.value;
    value = masked ? MASK : truncate(String(value ?? ''), 200);
    send({ type: 'input', target: describe(el), value, masked });
  }
  window.addEventListener('input', (e) => {
    if (!e.isTrusted && !window.__rrSelfTest) return;
    const el = targetOf(e);
    if (!el || (!('value' in el) && !el.isContentEditable)) return;
    const existing = inputTimers.get(el);
    if (existing) clearTimeout(existing.id);
    inputTimers.set(el, { id: setTimeout(() => flushInput(el), 800) });
  }, { capture: true, passive: true });
  window.addEventListener('blur', (e) => {
    const el = targetOf(e);
    if (el && inputTimers.has(el)) flushInput(el);
  }, { capture: true, passive: true });

  // --- change (select / checkbox / radio / file + text before Enter-submit) ----
  window.addEventListener('change', (e) => {
    if (!e.isTrusted && !window.__rrSelfTest) return;
    const el = targetOf(e);
    if (!el) return;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'select') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      send({ type: 'select', target: describe(el), value: isSensitive(el) ? MASK : truncate(el.value, 100), label: opt ? truncate(opt.textContent, 100) : null });
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      send({ type: 'toggle', target: describe(el), checked: el.checked });
    } else if (el.type === 'file') {
      const names = Array.from(el.files || []).map((f) => f.name);
      send({ type: 'file_chosen', target: describe(el), files: names });
    } else if (inputTimers.has(el)) {
      // Record the value before Enter-submit navigation kills the debounce timer.
      flushInput(el);
    }
  }, { capture: true, passive: true });

  // --- keydown: special keys and shortcuts only (plain characters arrive via input)
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || isOurUi(e)) return;
    // A held key (arrows/Backspace) fires ~30 events/s; repeats bloat the stream
    // and trip the rate limit — the first press carries the whole meaning.
    if (e.repeat) return;
    const special = e.key && e.key.length > 1 && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key);
    const combo = (e.metaKey || e.ctrlKey || e.altKey) && e.key && e.key.length === 1;
    if (!special && !combo) return;
    const el = targetOf(e);
    // Enter can trigger a form submit; flush the pending input value first.
    if (e.key === 'Enter' && el && inputTimers.has(el)) flushInput(el);
    if (combo && isSensitive(el)) return;
    send({
      type: 'key',
      key: e.key,
      modifiers: [e.metaKey && 'Meta', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean),
      target: describe(el),
    });
  }, { capture: true, passive: true });

  // --- submit: flush every pending input in the form first -------------------
  window.addEventListener('submit', (e) => {
    const form = targetOf(e);
    if (form && form.elements) {
      for (const fel of form.elements) {
        if (inputTimers.has(fel)) flushInput(fel);
      }
    }
    send({ type: 'submit', target: describe(form) });
  }, { capture: true, passive: true });

  // --- text selection (sampled on mouseup; secret-looking text is masked) -----
  window.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = String(window.getSelection ? window.getSelection() : '');
      if (sel && sel.trim().length > 2) {
        const masked = looksLikeSecret(sel) || isSensitive(document.activeElement);
        send({ type: 'selection', text: masked ? MASK : truncate(sel, 200), length: sel.length });
      }
    }, 0);
  }, { capture: true, passive: true });

  // --- copy (secret-looking content is masked) -------------------------------
  window.addEventListener('copy', () => {
    const sel = String(window.getSelection ? window.getSelection() : '');
    const masked = looksLikeSecret(sel) || isSensitive(document.activeElement);
    send({ type: 'copy', text: masked ? MASK : truncate(sel, 200), length: sel.length });
  }, { capture: true, passive: true });

  // --- paste: content is NEVER logged (password-manager leak risk). The final
  // pasted value already shows up in the input event for non-sensitive fields.
  window.addEventListener('paste', (e) => {
    const el = targetOf(e);
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    send({
      type: 'paste',
      target: describe(el),
      length: text.length,
      words: text ? text.trim().split(/\\s+/).length : 0,
    });
  }, { capture: true, passive: true });

  // --- scroll (1s debounce, coarse position) ---------------------------------
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const se = document.scrollingElement || document.documentElement;
      send({ type: 'scroll', y: Math.round(se.scrollTop), maxY: Math.round(se.scrollHeight - se.clientHeight) });
    }, 1000);
  }, { capture: true, passive: true });

  // --- REC badge (default; --panel opts into the separate control window)
  if (window === window.top && ${USE_BADGE}) {
    // Node owns the authoritative pause state; button clicks go to Node, which
    // broadcasts the new state to every page via __rrSetPaused.
    let rrPaused = ${JSON.stringify(false)};
    let badgeUpdate = null;
    window.__rrSetPaused = (p) => { rrPaused = !!p; if (badgeUpdate) badgeUpdate(); };

    function mountBadge() {
      if (document.getElementById('__rr-badge-host')) return;
      const host = document.createElement('div');
      host.id = '__rr-badge-host';
      host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;background:#111;color:#fff;' +
        'border-radius:999px;padding:6px 12px;font:12px -apple-system,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4);opacity:.92">' +
        '<span id="dot" style="width:8px;height:8px;border-radius:50%;background:#f43;animation:__rrp 1.2s infinite"></span>' +
        '<span id="t">REC 00:00</span>' +
        '<button id="pause" style="background:#666;color:#fff;border:0;border-radius:999px;padding:3px 10px;font:600 11px -apple-system,sans-serif;cursor:pointer">Pause</button>' +
        '<button id="stop" style="background:#f43;color:#fff;border:0;border-radius:999px;padding:3px 10px;font:600 11px -apple-system,sans-serif;cursor:pointer">Stop</button>' +
        '</div><style>@keyframes __rrp{50%{opacity:.3}}</style>';
      root.getElementById('stop').addEventListener('click', () => {
        send({ type: 'rr_stop_clicked' });
      });
      root.getElementById('pause').addEventListener('click', () => {
        send({ type: 'rr_pause_clicked' });
      });
      // Paused time is excluded from the counter; the badge shows PAUSED.
      let acc = 0;
      let last = Date.now();
      badgeUpdate = () => {
        const dot = root.getElementById('dot');
        const btn = root.getElementById('pause');
        const t = root.getElementById('t');
        if (dot) { dot.style.background = rrPaused ? '#fa0' : '#f43'; dot.style.animationPlayState = rrPaused ? 'paused' : 'running'; }
        if (btn) { btn.textContent = rrPaused ? 'Resume' : 'Pause'; btn.style.background = rrPaused ? '#2a7' : '#666'; }
        if (t) {
          const s = Math.floor(acc / 1000);
          t.textContent = (rrPaused ? 'PAUSED ' : 'REC ') + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
        }
      };
      setInterval(() => {
        const now = Date.now();
        if (!rrPaused) acc += now - last;
        last = now;
        badgeUpdate();
      }, 1000);
      badgeUpdate();
      (document.body || document.documentElement).appendChild(host);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountBadge);
    } else {
      mountBadge();
    }
  }
})();`;

const START_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8"><title>Recording…</title>
<body style="font:16px -apple-system,sans-serif;display:grid;place-items:center;height:96vh;background:#fafafa;color:#333">
<div style="max-width:460px;text-align:center">
<div style="font-size:40px">⏺</div>
<h2 style="margin:8px 0">Recording started</h2>
<p>Navigate anywhere and perform the workflow you want to demonstrate.
Everything you do in this browser window is being recorded.</p>
<p style="color:#888;font-size:13px">Click <b>Stop</b> in the bottom-right badge or close the window when you are done.<br>
Avoid quitting the browser entirely (Cmd+Q) — the last minute of visual trace may be lost.</p>
</div></body>`)}`;

// ---------------------------------------------------------------------------
// Control panel: a separate small browser window (the counterpart of Codex's
// native Recording Controls NSPanel). It lives outside the recording surface:
// the init script attaches no listeners there and its events never enter the log.
// ---------------------------------------------------------------------------
const PANEL_MARKER = '__rr_control_panel__';
const PANEL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Recording</title></head>
<body data-rr="${PANEL_MARKER}" style="margin:0;background:#111;color:#fff;font:13px -apple-system,Segoe UI,sans-serif;overflow:hidden;user-select:none">
<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;height:100vh;box-sizing:border-box">
  <span id="dot" style="width:10px;height:10px;border-radius:50%;background:#f43;flex:none;animation:p 1.2s infinite"></span>
  <span id="t" style="font-variant-numeric:tabular-nums;min-width:86px">REC 00:00</span>
  <button id="pause" style="background:#555;color:#fff;border:0;border-radius:999px;padding:5px 12px;font:600 12px inherit;cursor:pointer">Pause</button>
  <button id="stop" style="background:#f43;color:#fff;border:0;border-radius:999px;padding:5px 12px;font:600 12px inherit;cursor:pointer">Stop</button>
  <button id="discard" title="Discard recording" style="background:transparent;color:#999;border:1px solid #444;border-radius:999px;padding:5px 10px;font:600 12px inherit;cursor:pointer">🗑</button>
</div>
<style>@keyframes p{50%{opacity:.3}}</style>
<script>
  const NONCE = ${JSON.stringify('%NONCE%')};
  let paused = false, acc = 0, last = Date.now(), armed = false, armTimer = null;
  const $ = (id) => document.getElementById(id);
  function send(type) { try { window.__rrEmit({ nonce: NONCE, type }); } catch {} }
  window.__rrSetPaused = (p) => { paused = !!p; render(); };
  $('pause').onclick = () => send('rr_pause_clicked');
  $('stop').onclick = () => send('rr_stop_clicked');
  $('discard').onclick = () => {
    if (!armed) {
      armed = true; render();
      armTimer = setTimeout(() => { armed = false; render(); }, 4000);
    } else {
      clearTimeout(armTimer);
      send('rr_discard_clicked');
    }
  };
  function render() {
    $('dot').style.background = paused ? '#fa0' : '#f43';
    $('dot').style.animationPlayState = paused ? 'paused' : 'running';
    $('pause').textContent = paused ? 'Resume' : 'Pause';
    $('pause').style.background = paused ? '#2a7' : '#555';
    $('discard').textContent = armed ? 'Sure?' : '🗑';
    $('discard').style.color = armed ? '#f43' : '#999';
    $('discard').style.borderColor = armed ? '#f43' : '#444';
    const s = Math.floor(acc / 1000);
    $('t').textContent = (paused ? 'PAUSED ' : 'REC ') +
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  setInterval(() => { const n = Date.now(); if (!paused) acc += n - last; last = n; render(); }, 1000);
  render();
</script></body></html>`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const { chromium } = await import('playwright');

let context = null;
let stopping = false;
let paused = false;
let controlPage = null;
let discarding = false;
let timeLimitTimer = null;
let stopFileTimer = null;
let traceTimer = null;
let traceChunks = [];
let chunkIndex = 0;
let chunkBusy = false;

// Pause stops the event stream AND the trace (screenshots/DOM snapshots) together —
// paused moments enter no recording at all (privacy guarantee).
async function setPaused(next) {
  if (stopping || !context || paused === next) return;
  if (next) {
    // Marker first, then the flag: everything arriving afterwards is dropped.
    emit({ kind: 'session', type: 'paused' });
    paused = true;
  } else {
    paused = false;
    emit({ kind: 'session', type: 'resumed' });
  }
  writeSession({ status: 'recording', paused });
  // The PAUSE file mirrors the state (an agent may watch the file instead of
  // `status`); the watcher is edge-triggered, so this creates no feedback loop.
  try {
    if (paused) fs.writeFileSync(PAUSE_PATH, 'paused\n');
    else fs.rmSync(PAUSE_PATH, { force: true });
  } catch {}
  for (const p of context.pages()) {
    p.evaluate(`window.__rrSetPaused && window.__rrSetPaused(${paused})`).catch(() => {});
  }
  if (TRACE_MODE === 'off') return;
  for (let i = 0; chunkBusy && i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  chunkBusy = true;
  try {
    if (next) {
      chunkIndex += 1;
      const chunkPath = path.join(OUT_DIR, `trace-${String(chunkIndex).padStart(3, '0')}.zip`);
      await context.tracing.stopChunk({ path: chunkPath });
      traceChunks.push(chunkPath);
    } else {
      await context.tracing.startChunk();
    }
  } catch (e) {
    emit({ kind: 'session', type: 'trace_chunk_error', message: String(e && e.message) });
  } finally {
    chunkBusy = false;
  }
}

// Periodic trace checkpoint: on Cmd+Q or last-window close, at most the current
// chunk is lost; earlier chunks stay on disk.
async function rotateTraceChunk() {
  if (chunkBusy || stopping || paused || !context) return;
  chunkBusy = true;
  chunkIndex += 1;
  const chunkPath = path.join(OUT_DIR, `trace-${String(chunkIndex).padStart(3, '0')}.zip`);
  try {
    await context.tracing.stopChunk({ path: chunkPath });
    traceChunks.push(chunkPath);
    await context.tracing.startChunk();
  } catch (e) {
    emit({ kind: 'session', type: 'trace_chunk_error', message: String(e && e.message) });
  } finally {
    chunkBusy = false;
  }
}

async function requestStop(reason) {
  if (stopping) return;
  stopping = true;

  try { clearTimeout(timeLimitTimer); } catch {}
  try { clearInterval(stopFileTimer); } catch {}
  try { clearInterval(traceTimer); } catch {}

  emit({ kind: 'session', type: 'stopping', reason });

  // Wait for an in-flight chunk rotation to finish (5 s max).
  for (let i = 0; chunkBusy && i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (context) {
    if (TRACE_MODE !== 'off' && !paused) {
      // While paused there is no active chunk; only take a final one if still recording.
      chunkIndex += 1;
      const finalChunk = path.join(OUT_DIR, `trace-${String(chunkIndex).padStart(3, '0')}.zip`);
      try {
        await context.tracing.stopChunk({ path: finalChunk });
        traceChunks.push(finalChunk);
      } catch (e) {
        // If the browser died (Cmd+Q) the last chunk is lost; earlier ones survive.
        emit({ kind: 'session', type: 'trace_error', message: String(e && e.message) });
      }
    }
    try { await context.tracing.stop(); } catch {}
    try { await context.close(); } catch {}
  }

  await new Promise((resolve) => eventsStream.end(resolve));

  // Discard (Codex's "Discard Recording"): delete the evidence, mark the session.
  if (discarding) {
    try { fs.rmSync(EVENTS_PATH, { force: true }); } catch {}
    for (const c of traceChunks) { try { fs.rmSync(c, { force: true }); } catch {} }
    traceChunks = [];
  }

  const summary = {
    status: discarding ? 'discarded' : 'completed',
    endReason: reason,
    endedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    eventCount: discarding ? 0 : seq,
    traceMode: TRACE_MODE,
    traceChunks,
    tracePath: traceChunks.length ? traceChunks[traceChunks.length - 1] : null,
  };
  writeSession(summary);
  if (!SELF_TEST) { try { fs.unlinkSync(LOCK_PATH); } catch {} }
  try { fs.unlinkSync(STOP_PATH); } catch {}
  try { fs.unlinkSync(PAUSE_PATH); } catch {}
  if (SELF_TEST) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {} }

  console.log(JSON.stringify({ ...summary, sessionPath: SESSION_PATH, eventsPath: EVENTS_PATH, outDir: OUT_DIR }, null, 2));

  if (SELF_TEST) {
    const lines = fs.readFileSync(EVENTS_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const domEvents = lines.filter((l) => l.kind === 'dom');
    const maskedInput = domEvents.find((l) => l.type === 'input' && l.masked);
    const plainInput = domEvents.find((l) => l.type === 'input' && !l.masked && l.value === 'hello world');
    const enterFlushed = domEvents.find((l) => l.type === 'input' && l.value === 'kargo takip');
    const submitted = domEvents.some((l) => l.type === 'submit');
    const pausedMark = lines.some((l) => l.kind === 'session' && l.type === 'paused');
    const resumedSeq = lines.find((l) => l.kind === 'session' && l.type === 'resumed')?.seq ?? Infinity;
    // #btn2 was clicked once while paused (must drop) and once after resume → exactly one record, after resume.
    const btn2Clicks = domEvents.filter((l) => l.type === 'click' && l.target?.selectors?.id === 'btn2');
    const pauseFilterOk = btn2Clicks.length === 1 && btn2Clicks[0].seq > resumedSeq;
    const controlsNotRecorded = !domEvents.some((l) => ['pause', 'stop'].includes(l.target?.selectors?.id));
    const ok = domEvents.some((l) => l.type === 'click') && plainInput && maskedInput && enterFlushed && submitted
      && pausedMark && pauseFilterOk && traceChunks.length >= 2
      && selfTestControlsOk && controlsNotRecorded && reason === 'user_stopped';
    if (!ok) {
      console.log(JSON.stringify({ pausedMark, resumedSeq, btn2Clicks: btn2Clicks.length, chunks: traceChunks.length, plainInput: !!plainInput, maskedInput: !!maskedInput, enterFlushed: !!enterFlushed, submitted, selfTestControlsOk, controlsNotRecorded, reason }));
    }
    console.log(ok ? 'SELF-TEST PASS' : 'SELF-TEST FAIL');
    if (OUT_DIR_IS_TEMP && ok) { try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch {} }
    process.exit(ok ? 0 : 1);
  }
  process.exit(0);
}

const launchOpts = {
  headless: SELF_TEST,
  viewport: null,
  // --test-type: the switch chromedriver uses to stop Chrome from showing the
  // "unsupported command-line flag" bar for automation flags like the one before it.
  args: ['--disable-blink-features=AutomationControlled', '--hide-crash-restore-bubble', '--test-type'],
};

// Sandbox on by default (Playwright otherwise passes --no-sandbox, which real Chrome
// flags with a warning bar and which weakens the browser the user browses in).
// Containers without user namespaces cannot start a sandboxed Chrome: fall back.
const attempts = [
  ...(BROWSER_PREF === 'chrome' ? [{ channel: 'chrome', chromiumSandbox: true }, { channel: 'chrome', chromiumSandbox: false }] : []),
  { chromiumSandbox: true },
  { chromiumSandbox: false },
];
try {
  let lastError = null;
  for (const extra of attempts) {
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, { ...launchOpts, ...extra });
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!context) throw lastError;
} catch (e) {
  writeSession({ status: 'failed', error: String(e && e.message) });
  if (!SELF_TEST) { try { fs.unlinkSync(LOCK_PATH); } catch {} }
  console.error(JSON.stringify({ error: 'launch_failed', message: String(e && e.message) }));
  process.exit(1);
}

if (TRACE_MODE !== 'off') {
  // light: DOM snapshots on, continuous screencast OFF — the CPU-friendly default.
  await context.tracing.start({
    screenshots: TRACE_MODE === 'full',
    snapshots: true,
    title: `record-and-replay ${SESSION_NAME}`,
  });
  await context.tracing.startChunk();
  traceTimer = setInterval(rotateTraceChunk, 60_000);
}

// The Stop button and DOM events arrive through this binding. The nonce rejects
// forged calls made from outside the init script's closure (i.e. page JS).
await context.exposeBinding('__rrEmit', (source, payload) => {
  if (!payload || payload.nonce !== NONCE) return;
  const { nonce, ...rest } = payload;
  let url = '';
  let srcPage = null;
  try { srcPage = source.page; url = srcPage.url(); } catch {}
  if (rest.type === 'rr_stop_clicked') {
    emit({ kind: 'session', type: 'stop_button', url });
    requestStop('user_stopped');
    return;
  }
  if (rest.type === 'rr_pause_clicked') {
    setPaused(!paused).catch(() => {});
    return;
  }
  if (rest.type === 'rr_discard_clicked') {
    discarding = true;
    requestStop('user_discarded');
    return;
  }
  // Nothing but controls comes from the panel page (it has no listeners anyway).
  if (srcPage && srcPage === controlPage) return;
  emit({ kind: 'dom', url, ...rest });
});
await context.addInitScript(INIT_SCRIPT);

let openPages = 0;
const attachedPages = new WeakSet();
const isPanel = (page) => page === controlPage || page.url().includes(PANEL_MARKER);
function attachPage(page) {
  if (isPanel(page)) return; // the panel window is not a recording surface
  attachedPages.add(page);
  openPages += 1;
  emit({ kind: 'page', type: 'page_opened', url: page.url() });
  page.on('framenavigated', (frame) => {
    if (isPanel(page)) return;
    if (frame === page.mainFrame()) {
      emit({ kind: 'page', type: 'navigated', url: frame.url() });
      // A fresh document's badge defaults to "recording"; resync it when paused.
      if (paused) page.evaluate('window.__rrSetPaused && window.__rrSetPaused(true)').catch(() => {});
    }
  });
  page.on('download', (dl) => {
    emit({ kind: 'page', type: 'download', url: dl.url(), filename: dl.suggestedFilename() });
  });
  // The listener is registered but never accepts/dismisses: the native dialog stays
  // on screen for the user to answer; we only record it.
  page.on('dialog', (dialog) => {
    emit({ kind: 'page', type: 'dialog', dialogType: dialog.type(), message: dialog.message().slice(0, 300) });
  });
  page.on('close', () => {
    if (isPanel(page)) return;
    openPages -= 1;
    emit({ kind: 'page', type: 'page_closed' });
    if (openPages <= 0 && !stopping) {
      // Small delay: the user may be closing one tab and opening another.
      setTimeout(() => { if (openPages <= 0) requestStop('browser_closed'); }, 1500);
    }
  });
}
context.on('page', attachPage);
for (const page of context.pages()) attachPage(page);

// --- Open the control panel only when --panel was requested
const PANEL_URL = 'data:text/html,' + encodeURIComponent(PANEL_HTML.replace('%NONCE%', NONCE));
const PANEL_BLANK_URL = `about:blank#${PANEL_MARKER}`;

// Once per session: the recording window spans the screen width and leaves a
// strip at the bottom for the control panel, which Chrome cannot keep on top.
// It also undoes stale geometry: the persistent profile restores the size of the
// last window closed, which can be a tiny one.
let mainLaidOut = false;
async function layoutMainWindow(page, geom, reserve) {
  if (mainLaidOut || SELF_TEST) return;
  mainLaidOut = true;
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: geom.l, top: geom.t, width: geom.w, height: Math.max(480, geom.h - reserve) },
    });
    await cdp.detach().catch(() => {});
  } catch { /* geometry is cosmetic; never fail the recording over it */ }
}
async function openControlPanel() {
  if (stopping || USE_BADGE) return;
  if (controlPage && !controlPage.isClosed()) return;
  const opener = context.pages().find((p) => !p.isClosed() && !isPanel(p));
  if (!opener) return;
  try {
    // Position bottom-right (defaults are fine under headless).
    const geom = await opener.evaluate(() => ({
      w: screen.availWidth || 1280,
      h: screen.availHeight || 800,
      l: screen.availLeft || 0,
      t: screen.availTop || 0,
    })).catch(() => ({ w: 1280, h: 800, l: 0, t: 0 }));
    const W = 340; const H = 64;
    // A popup's frame (title bar + URL strip) adds ~110 px on Windows; Chrome also
    // enforces a minimum content height of ~100 px.
    const PANEL_OUTER_H = H + 130;
    const left = geom.l + Math.max(0, geom.w - W - 40);
    const top = geom.t + Math.max(0, geom.h - PANEL_OUTER_H);
    await layoutMainWindow(opener, geom, PANEL_OUTER_H + 10);

    // Primary path: a popup window (no tab strip, no toolbar — just a title bar),
    // so a 340×64 content area really shows the buttons. A normal window of that
    // size (CDP Target.createTarget) is all tabs and address bar on Windows.
    // Chrome refuses a page-initiated data: URL in a new top-level window, so the
    // popup opens on about:blank#marker and Playwright then navigates it
    // (browser-initiated, allowed) — a real navigation is also what installs the
    // __rrEmit binding the buttons need. Playwright launches Chrome with the popup
    // blocker disabled, so no user gesture is needed.
    let panel = null;
    const popupPromise = context.waitForEvent('page', { timeout: 8000 });
    const opened = await opener.evaluate(([url, l, t2, w2, h2]) => Boolean(
      window.open(url, '__rr_panel', `popup=yes,width=${w2},height=${h2},left=${l},top=${t2}`)
    ), [PANEL_BLANK_URL, left, top, W, H]).catch(() => false);
    if (opened) {
      panel = await popupPromise.catch(() => null);
    }
    if (panel) {
      // attachPage may have counted this page; undo that before anything that can
      // time out, or the recording could no longer stop when the last tab closes.
      if (attachedPages.has(panel)) { attachedPages.delete(panel); openPages -= 1; }
      controlPage = panel;
      await panel.goto(PANEL_URL, { timeout: 8000 });
    } else {
      // Fallback: a separate normal window via CDP (immune to popup blockers).
      const browser = context.browser();
      if (!browser) throw new Error('control panel popup did not open');
      const pagePromise = context.waitForEvent('page', { timeout: 8000 });
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Target.createTarget', { url: PANEL_URL, newWindow: true, width: W, height: H, left, top });
      await cdp.detach().catch(() => {});
      panel = await pagePromise;
      if (attachedPages.has(panel)) { attachedPages.delete(panel); openPages -= 1; }
      controlPage = panel;
    }
    await panel.waitForURL((u) => String(u).includes(PANEL_MARKER), { timeout: 8000 });
    if (paused) panel.evaluate('window.__rrSetPaused && window.__rrSetPaused(true)').catch(() => {});
    panel.on('close', () => {
      controlPage = null;
      // Reopen if the user closed the panel by accident (while still recording).
      if (!stopping) setTimeout(() => { openControlPanel().catch(() => {}); }, 800);
    });
    emit({ kind: 'session', type: 'control_panel_opened' });
  } catch (e) {
    emit({ kind: 'session', type: 'control_panel_failed', message: String(e && e.message) });
  }
}

emit({
  kind: 'session',
  type: 'started',
  name: SESSION_NAME,
  platform: process.platform,
  timeLimitMinutes: MINUTES,
});

// First page
let firstPage = context.pages()[0] || (await context.newPage());
if (SELF_TEST) {
  await firstPage.addInitScript('window.__rrSelfTest = true;');
}
await firstPage.goto(START_URL || START_PAGE).catch(() => {});
await openControlPanel();

// Startup confirmation: an agent that launched us in the background reads this line.
console.log(JSON.stringify({ status: 'recording', controls: USE_BADGE ? 'badge' : 'panel', outDir: OUT_DIR, sessionPath: SESSION_PATH, pid: process.pid, timeLimitMinutes: MINUTES }));

// Time limit + STOP/PAUSE file watcher. An agent can also pause via the file:
// `touch <outDir>/PAUSE` → pause, delete it → resume. Edge-triggered: only the
// appearance/removal TRANSITION acts, so button-driven changes are not overwritten.
timeLimitTimer = setTimeout(() => requestStop('time_limit'), MINUTES * 60 * 1000);
let lastPauseFileState = false;
stopFileTimer = setInterval(() => {
  if (fs.existsSync(STOP_PATH)) { requestStop('stop_file'); return; }
  const pauseFile = fs.existsSync(PAUSE_PATH);
  if (pauseFile !== lastPauseFileState) {
    lastPauseFileState = pauseFile;
    setPaused(pauseFile).catch(() => {});
  }
}, 2000);
process.on('SIGINT', () => requestStop('signal'));
process.on('SIGTERM', () => requestStop('signal'));

// ---------------------------------------------------------------------------
// Self-test: end-to-end verification with synthetic but trusted (CDP Input) events
// ---------------------------------------------------------------------------
if (SELF_TEST) {
  const page = firstPage;
  await page.goto(
    'data:text/html,' +
      encodeURIComponent(
        '<button id="btn" data-testid="do-it">Do it</button>' +
          '<input id="name" placeholder="Your name">' +
          '<input id="pw" type="password" placeholder="Password">' +
          '<form action="#"><input id="q" placeholder="Search"></form>'
      )
  );
  await page.click('#btn');
  await page.click('#name');
  await page.keyboard.type('hello world');
  await page.click('#pw');
  await page.keyboard.type('s3cret');
  await page.click('#q'); // blur → password field flushes masked
  await page.keyboard.type('kargo takip');
  await page.keyboard.press('Enter'); // Enter-submit before the debounce fires: flush is mandatory
  await page.waitForTimeout(1500);
  // Exercise the actual buttons in both the default badge and opt-in panel.
  await page.goto('data:text/html,' + encodeURIComponent('<button id="btn2">Second</button>'));
  if (!USE_BADGE) {
    for (let i = 0; i < 40 && (!controlPage || controlPage.isClosed()); i += 1) {
      await page.waitForTimeout(250);
    }
    if (!controlPage) {
      console.log(JSON.stringify({ selfTestError: 'control_panel_missing' }));
      await requestStop('self_test_done');
    }
  }
  const controls = USE_BADGE ? page.locator('#__rr-badge-host') : controlPage;
  await controls.locator('#pause').waitFor({ state: 'visible' });
  selfTestControlsOk = USE_BADGE
    ? !context.pages().some(isPanel)
    : await page.locator('#__rr-badge-host').count() === 0;
  await controls.locator('#pause').click();
  await page.waitForTimeout(800);
  await page.click('#btn2'); // paused — must be dropped
  await page.waitForTimeout(400);
  await controls.locator('#pause').click(); // resume
  await page.waitForTimeout(800);
  await page.click('#btn2'); // resumed — must be recorded
  await page.waitForTimeout(600);
  try {
    await controls.locator('#stop').click(); // real Stop button → user_stopped
    await page.waitForTimeout(10000);
  } catch { /* stop closes the context; expected */ }
  await requestStop('self_test_done'); // safety net — a no-op if stop already ran
}
