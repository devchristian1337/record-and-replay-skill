#!/usr/bin/env node
/**
 * record-and-replay — in-page cost of the browser recorder.
 *
 * Extracts INIT_SCRIPT verbatim from recorder.mjs, injects it into an isolated
 * page and measures how many events it emits / how long it takes under realistic
 * load — so regressions are caught without opening a headed recorder.
 *
 * Usage: node bench/browser-overhead.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// INIT_SCRIPT is a template literal: `\\s` in the source becomes `\s` at runtime,
// so we must apply the same unescaping before injecting it.
function loadInitScript() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'recorder.mjs'), 'utf8');
  const open = 'const INIT_SCRIPT = `';
  const start = src.indexOf(open) + open.length;
  const end = src.indexOf('\n})();`', start) + '\n})();'.length;
  const script = src.slice(start, end)
    .replace(/\\\\/g, '\\')
    .replace(/\$\{NONCE\}/g, 'bench-nonce')
    .replace(/\$\{USE_BADGE\}/g, 'false')
    .replace(/\$\{JSON\.stringify\(false\)\}/g, 'false');
  if (script.includes('${')) throw new Error('INIT_SCRIPT extraction broke: unresolved ${…}');
  return script;
}

const results = [];
const record = (name, value, note = '') => {
  results.push({ name, value, note });
  console.log(`  ${name.padEnd(38)} ${String(value).padStart(10)}  ${note}`);
};

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext();
const kinds = {};
let total = 0;
await ctx.exposeBinding('__rrEmit', (_s, p) => { total += 1; kinds[p.type] = (kinds[p.type] || 0) + 1; });
await ctx.addInitScript(loadInitScript());
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

const reset = () => { total = 0; for (const k of Object.keys(kinds)) delete kinds[k]; };

console.log('browser recorder — in-page cost\n');

// 1) Held key: does OS auto-repeat bloat the stream?
await page.goto('data:text/html,' + encodeURIComponent('<input id="t" value="a fairly long value sitting here">'));
await page.click('#t');
reset();
const cdp = await ctx.newCDPSession(page);
const REPEATS = 60;
for (let i = 0; i < REPEATS; i += 1) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, autoRepeat: i > 0 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
}
await page.waitForTimeout(1200);
record(`${REPEATS}x auto-repeat Backspace`, kinds.key || 0, 'events — expect 1 (repeats must be skipped)');

// 2) Is real typing debounced?
await page.goto('data:text/html,' + encodeURIComponent('<input id="t">'));
await page.click('#t');
reset();
await page.keyboard.type('hello world!!', { delay: 15 });
await page.waitForTimeout(1200);
record('13-character typing', kinds.input || 0, 'input events — expect 1 (debounce)');

// 3) Total cost per click.
const HTML = '<body>' + Array.from({ length: 40 }, (_, i) =>
  `<div><span>row ${i}</span><button id="b${i}">Button ${i}</button></div>`).join('') + '</body>';
await page.goto('data:text/html,' + encodeURIComponent(HTML));
reset();
const clickStart = Date.now();
const CLICKS = 120;
for (let i = 0; i < CLICKS; i += 1) await page.click(`#b${i % 40}`);
await page.waitForTimeout(300);
record(`${CLICKS} clicks`, `${Date.now() - clickStart} ms`, `${kinds.click || 0} click events`);

// 4) How long do describe()/cssPath take on a deep DOM?
const deep = '<body>' + '<div>'.repeat(60) + '<button id="deep">x</button>' + '</div>'.repeat(60) + '</body>';
await page.goto('data:text/html,' + encodeURIComponent(deep));
const perClick = await page.evaluate(() => {
  const el = document.getElementById('deep');
  const t = performance.now();
  for (let i = 0; i < 5000; i += 1) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return (performance.now() - t) / 5000;
});
record('60-level deep DOM, per click', `${perClick.toFixed(4)} ms`, 'isTrusted=false → early return');

// 5) Does the scroll listener slow the page down?
await page.goto('data:text/html,' + encodeURIComponent('<body style="height:20000px">x</body>'));
const perScroll = await page.evaluate(() => {
  const t = performance.now();
  for (let i = 0; i < 3000; i += 1) window.scrollTo(0, i);
  return (performance.now() - t) / 3000;
});
record('per scroll', `${perScroll.toFixed(4)} ms`, '1 s debounce');

await browser.close();
console.log(`\n${results.length} measurements.`);
