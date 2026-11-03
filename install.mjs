#!/usr/bin/env node
/**
 * Links the canonical skill into agent skill directories (cross-platform).
 * macOS/Linux: symlink; Windows: directory junction (no admin required).
 *
 * If the canonical location is not ~/.agents/skills/record-and-replay (e.g. the
 * repo was cloned elsewhere), it is linked there first, then into agent dirs.
 *
 * Usage: node install.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();
const NAME = 'record-and-replay';
const CANONICAL = path.join(HOME, '.agents', 'skills', NAME);

// The skills subdirectory is created when the agent root exists; otherwise skipped.
const TARGETS = [
  { root: path.join(HOME, '.claude'), skills: path.join(HOME, '.claude', 'skills'), agent: 'Claude Code' },
  { root: path.join(HOME, '.codex'), skills: path.join(HOME, '.codex', 'skills'), agent: 'Codex CLI' },
  { root: path.join(HOME, '.config', 'opencode'), skills: path.join(HOME, '.config', 'opencode', 'skills'), agent: 'opencode' },
];

function link(target, linkPath) {
  const type = IS_WIN ? 'junction' : 'dir';
  if (fs.existsSync(linkPath) || isLink(linkPath)) {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() || isJunction(linkPath)) {
      // Broken link: realpathSync throws — just replace it.
      let current = null;
      try { current = fs.realpathSync(linkPath); } catch {}
      if (current && current === fs.realpathSync(target)) {
        console.log(`already linked: ${linkPath}`);
        return;
      }
      fs.rmSync(linkPath, { recursive: false, force: true });
      fs.symlinkSync(target, linkPath, type);
      console.log(`relinked: ${linkPath} → ${target}`);
      return;
    }
    console.log(`WARNING: ${linkPath} exists and is not a link — merge it manually.`);
    return;
  }
  fs.symlinkSync(target, linkPath, type);
  console.log(`linked: ${linkPath} → ${target}`);
}

function isLink(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}
function isJunction(p) {
  try { const st = fs.lstatSync(p); return st.isSymbolicLink(); } catch { return false; }
}

// 1. Link the repo into the canonical location if it lives elsewhere.
const realHere = fs.realpathSync(HERE);
if (realHere !== (fs.existsSync(CANONICAL) ? fs.realpathSync(CANONICAL) : CANONICAL)) {
  fs.mkdirSync(path.dirname(CANONICAL), { recursive: true });
  link(realHere, CANONICAL);
}

// 2. Link into each installed agent's skill directory.
for (const t of TARGETS) {
  if (!fs.existsSync(t.root)) {
    console.log(`skipped (${t.agent} not installed): ${t.root}`);
    continue;
  }
  fs.mkdirSync(t.skills, { recursive: true });
  link(fs.existsSync(CANONICAL) ? CANONICAL : realHere, path.join(t.skills, NAME));
}

console.log('Note: for any other agent that supports the SKILL.md format, drop the same link into its skill directory.');
