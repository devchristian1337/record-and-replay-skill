#!/usr/bin/env node
/**
 * record-and-replay setup (cross-platform): playwright package + (Chromium only
 * when Chrome is missing) + self-tests. macOS / Windows / Linux.
 *
 * Usage: node setup.mjs [--skip-self-test]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
// npm/npx are .cmd shims on Windows and need a shell; everything else runs
// without one, so paths with spaces ("Nuova cartella") reach it intact. With a
// shell the command line is built here, quoted, as one string.
const SHELL_SHIMS = new Set(['npm', 'npx']);
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const sh = (cmd, args, opts = {}) => (IS_WIN && SHELL_SHIMS.has(cmd)
  ? spawnSync([cmd, ...args].map(quote).join(' '), { stdio: 'inherit', cwd: HERE, shell: true, ...opts })
  : spawnSync(cmd, args, { stdio: 'inherit', cwd: HERE, ...opts }));

console.log('→ npm install (playwright)…');
if (sh('npm', ['install', '--no-fund', '--no-audit']).status !== 0) process.exit(1);

function hasChrome() {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app',
      path.join(process.env.HOME || '', 'Applications', 'Google Chrome.app')]
      .some((p) => fs.existsSync(p));
  }
  if (IS_WIN) {
    return [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter(Boolean).some((base) =>
      fs.existsSync(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    );
  }
  return ['google-chrome', 'google-chrome-stable', 'chrome'].some(
    (c) => spawnSync('which', [c], { stdio: 'ignore' }).status === 0
  );
}

if (hasChrome()) {
  console.log('→ Google Chrome found; skipping browser download (recorder uses channel: chrome).');
} else {
  console.log('→ No Google Chrome; downloading Chromium…');
  if (sh('npx', ['playwright', 'install', 'chromium']).status !== 0) process.exit(1);
}

// Minimal Python venv for the desktop engine (requirements-desktop.txt:
// pynput+mss+pillow, plus comtypes on Windows; ~50 MB). Skipped without uv —
// browser mode works fine without Python. Re-running syncs an existing venv, so
// upgrades pick up new requirements (a no-op when nothing changed).
const VENV = path.join(HERE, '.venv-desktop');
const venvPython = path.join(VENV, IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python');
let desktopReady = fs.existsSync(venvPython);
let desktopFailed = false;
if (spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0) {
  console.log(desktopReady ? '→ Syncing desktop venv (.venv-desktop)…' : '→ Installing desktop recording venv…');
  if (desktopReady || sh('uv', ['venv', '--python', '3.12', VENV]).status === 0) {
    desktopReady = sh('uv', ['pip', 'install', '--python', venvPython, '-r', 'requirements-desktop.txt']).status === 0;
  }
  if (!desktopReady) {
    desktopFailed = true;
    console.log('→ ERROR: the desktop venv could not be created (see the uv output above); desktop mode is unavailable.');
  }
  if (desktopReady && IS_WIN) {
    // comtypes generates its UI Automation bindings on first use; do it now
    // rather than inside the first recording's click handler.
    const gen = spawnSync(venvPython, ['-c',
      "import comtypes.client as c; c.GetModule('UIAutomationCore.dll')"], { stdio: 'inherit' });
    if (gen.status !== 0) console.log('→ WARNING: UI Automation bindings could not be generated; clicks will lack semantic targets.');
  }
} else if (desktopReady) {
  console.log('→ Desktop venv present (.venv-desktop); install uv to keep it in sync with requirements-desktop.txt.');
} else {
  console.log('→ uv not found; for desktop mode install https://docs.astral.sh/uv/ and rerun `node setup.mjs` (browser mode is unaffected).');
}

if (!process.argv.includes('--skip-self-test')) {
  console.log('→ Running browser self-test…');
  if (sh('node', [path.join('scripts', 'recorder.mjs'), '--self-test']).status !== 0) process.exit(1);
  console.log('→ Running skill export self-test…');
  if (sh('node', [path.join('scripts', 'export-skill.mjs'), '--self-test']).status !== 0) process.exit(1);
  if (desktopReady) {
    console.log('→ Running desktop self-test…');
    if (sh(venvPython, [path.join('scripts', 'desktop-selftest.py')]).status !== 0) process.exit(1);
  }
}

if (desktopReady && process.platform === 'darwin') {
  // Desktop capture silently records nothing without TCC permission, so report
  // it here rather than letting the first real recording come back empty.
  const r = spawnSync(venvPython, [path.join(HERE, 'scripts', 'desktop-permissions.py')], { encoding: 'utf8' });
  try {
    const perms = JSON.parse((r.stdout || '{}').trim());
    if (perms.inputMonitoring === false || perms.screenRecording === false) {
      console.log('→ macOS permissions still missing for desktop mode. Grant them with:');
      console.log('    node scripts/desktop-record.mjs permissions');
    }
  } catch { /* ignore */ }
}

if (desktopFailed) {
  console.log('✗ Setup incomplete: browser mode is ready, desktop mode is not (see the error above).');
  process.exit(1);
}
console.log('✓ Setup complete. If you cloned with git, link into agent directories with: node install.mjs (not needed after npx skills add).');
