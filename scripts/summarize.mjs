#!/usr/bin/env node
/**
 * record-and-replay — events.jsonl summarizer.
 *
 * Reduces the raw event stream to a compact markdown timeline suited to skill
 * generation: navigations become headings, consecutive noise (scroll, selection)
 * is suppressed, and each action is one line with its best selector candidate.
 *
 * Usage: node summarize.mjs <events.jsonl|sessionDir> [--full]
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const FULL = args.includes('--full');
let input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('Usage: node summarize.mjs <events.jsonl | session dir> [--full]');
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error(`Not found: ${input}`);
  process.exit(1);
}
if (fs.statSync(input).isDirectory()) input = path.join(input, 'events.jsonl');
if (!fs.existsSync(input)) {
  console.error(`No events.jsonl at ${input} — the recording may have been discarded or never started (check session.json).`);
  process.exit(1);
}

const lines = fs
  .readFileSync(input, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter(Boolean);

function ts(ms) {
  const s = Math.floor(ms / 1000);
  return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`;
}

function bestSelector(target) {
  if (!target || !target.selectors) return '?';
  const s = target.selectors;
  if (s.testId) return `testId=${s.testId}`;
  if (s.role && s.role.name) return `role=${s.role.role} "${s.role.name}"`;
  if (s.id) return `#${s.id}`;
  if (s.nameAttr) return `[name=${s.nameAttr}]`;
  if (s.text) return `text="${s.text}"`;
  if (s.role) return `role=${s.role.role}`;
  return s.css || '?';
}

function label(target) {
  if (!target) return '?';
  const sel = bestSelector(target);
  return `${target.tag || '?'}(${sel})`;
}

const out = [];
let currentUrl = null;
let lastLine = null;
let repeatCount = 1;

function push(line) {
  // Consecutive identical actions are collapsed with a counter, not dropped:
  // "click … (x3)". Genuinely repeated clicks (e.g. a quantity stepper) must survive.
  if (line === lastLine && !FULL) {
    repeatCount += 1;
    out[out.length - 1] = `${line} (x${repeatCount})`;
    return;
  }
  lastLine = line;
  repeatCount = 1;
  out.push(line);
}

function urlHeading(url) {
  if (!url || url === currentUrl) return;
  currentUrl = url;
  lastLine = null; // do not let dedupe state leak across a page boundary
  repeatCount = 1;
  const short = url.startsWith('data:')
    ? url.includes('Recording%20started') ? '(start page)' : `(data: page ${url.slice(0, 60)}…)`
    : url;
  out.push('');
  out.push(`## ${short}`);
}

for (const e of lines) {
  const time = ts(e.t || 0);
  if (e.kind === 'session') {
    if (e.type === 'started') push(`- ${time} ▶ session started (limit: ${e.timeLimitMinutes}m)`);
    if (e.type === 'paused') push(`- ${time} ⏸ paused (nothing was recorded during this interval)`);
    if (e.type === 'resumed') push(`- ${time} ▶ resumed`);
    if (e.type === 'stopping') push(`- ${time} ■ session stopped (${e.reason})`);
    continue;
  }
  if (e.kind === 'page') {
    if (e.type === 'navigated') { urlHeading(e.url); continue; }
    if (e.type === 'download') { push(`- ${time} ⬇ download: ${e.filename} (${e.url})`); continue; }
    if (e.type === 'dialog') { push(`- ${time} ⚠ ${e.dialogType} dialog: "${e.message}"`); continue; }
    if (e.type === 'page_opened' && e.url && e.url !== 'about:blank') urlHeading(e.url);
    continue;
  }
  if (e.kind !== 'dom') continue;
  urlHeading(e.url);

  switch (e.type) {
    case 'click':
      push(`- ${time} click ${label(e.target)}`);
      break;
    case 'dblclick':
      push(`- ${time} double-click ${label(e.target)}`);
      break;
    case 'contextmenu':
      push(`- ${time} right-click ${label(e.target)}`);
      break;
    case 'input':
      push(`- ${time} type into ${label(e.target)} → "${e.value}"${e.masked ? ' (masked)' : ''}`);
      break;
    case 'select':
      push(`- ${time} select ${label(e.target)} → "${e.label ?? e.value}"`);
      break;
    case 'toggle':
      push(`- ${time} ${e.checked ? 'check' : 'uncheck'} ${label(e.target)}`);
      break;
    case 'file_chosen':
      push(`- ${time} choose file(s) ${JSON.stringify(e.files)} in ${label(e.target)}`);
      break;
    case 'key':
      push(`- ${time} press ${[...(e.modifiers || []), e.key].join('+')} in ${label(e.target)}`);
      break;
    case 'submit':
      push(`- ${time} submit form ${label(e.target)}`);
      break;
    case 'paste':
      push(`- ${time} paste ${e.length} chars (${e.words ?? '?'} words) into ${label(e.target)}`);
      break;
    case 'copy':
      if (FULL) push(`- ${time} copy ${e.length} chars ("${e.text}")`);
      break;
    case 'selection':
      if (FULL) push(`- ${time} select text: "${e.text}"`);
      break;
    case 'scroll':
      if (FULL) push(`- ${time} scroll to y=${e.y}/${e.maxY}`);
      break;
    default:
      if (FULL) push(`- ${time} ${e.type}`);
  }
}

const MAX_LINES = 500;
if (!FULL && out.length > MAX_LINES) {
  const dropped = out.length - MAX_LINES;
  out.length = MAX_LINES;
  out.push('', `… ${dropped} more lines truncated — rerun with --full or read events.jsonl directly.`);
}

console.log(`# Recording summary — ${lines.length} raw events`);
console.log(out.join('\n'));
