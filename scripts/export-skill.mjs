#!/usr/bin/env node
/**
 * record-and-replay — validate a skill folder and export it as a ZIP that
 * claude.ai accepts (Customize › Skills › + › Upload a skill).
 *
 * Usage:
 *   node scripts/export-skill.mjs <skillDir> [--out <file.zip>] [--strip-cc-keys] [--include-recordings]
 *   node scripts/export-skill.mjs <skillDir> --check        # validate only, write nothing
 *   node scripts/export-skill.mjs --self-test
 *
 * Prints JSON on stdout: {status: "exported"|"valid"|"invalid", errors, warnings, …}.
 * Exit codes: 0 valid/exported, 1 invalid skill, 2 usage error.
 *
 * Rules — the union of the Agent Skills spec (agentskills.io), Anthropic's
 * authoring guide and the claude.ai upload checks:
 *   - the file is exactly SKILL.md, with --- YAML frontmatter;
 *   - name: 1-64 chars of a-z 0-9 and single hyphens, equal to the folder name,
 *     without "anthropic"/"claude";
 *   - description: 1-1024 chars, no < or >;
 *   - only name, description, license, compatibility, metadata, allowed-tools —
 *     Claude Code-only keys (disable-model-invocation, argument-hint, …) fail the
 *     upload, so they are an error unless --strip-cc-keys drops them from the
 *     zipped copy;
 *   - exactly one SKILL.md, total size ≤ 30 MB.
 * Warnings cover the softer guidance: body over 500 lines, long references
 * without a table of contents, links to missing files, backslash paths, a
 * description over claude.ai's legacy 200-char hint or without "Use when".
 *
 * The ZIP holds the folder at its root (<name>/SKILL.md), forward-slash UTF-8
 * names, sorted entries and a fixed timestamp (reproducible), 0755 for scripts.
 * README.md, evals/, OS/editor/cache files and raw recording evidence (screens/,
 * *events*.jsonl, trace-*.zip) are left out; --include-recordings keeps the
 * evidence. Symlinks/junctions are skipped, never followed. No dependencies:
 * Node's zlib does the deflate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const CLAUDE_CODE_KEYS = new Set(['when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation',
  'user-invocable', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths']);
const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // Skills API upload cap; claude.ai rejects oversize uploads too
const BODY_LINES_LIMIT = 500;
const TOC_THRESHOLD = 100; // reference files longer than this need a table of contents
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__pycache__', 'node_modules', '.git']);
const SKIP_PATTERNS = [/\.pyc$/, /^\.venv/, /~$/, /\.swp$/];
const RECORDING_PATTERNS = [/^(desktop-)?events(-part\d+)?\.jsonl/, /^trace-\d+\.zip$/];
const UPLOAD_HINT = 'claude.ai → Customize › Skills › + › Upload a skill (older UI: Settings › Capabilities › Skills)';

// --- frontmatter ----------------------------------------------------------------

/** Minimal YAML subset: top-level keys with plain, quoted, block (| >) or nested values. */
export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') return { error: 'SKILL.md must start with a "---" frontmatter line' };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close === -1) return { error: 'frontmatter is not closed with "---"' };
  const entries = [];
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (/^#/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (m) entries.push({ key: m[1], first: m[2], rest: [], from: i, to: i });
    else if ((/^\s/.test(line) || !line.trim()) && entries.length) {
      const e = entries[entries.length - 1];
      e.rest.push(line);
      e.to = i;
    } else if (line.trim()) return { error: `cannot parse frontmatter line ${i + 1}: ${line.trim().slice(0, 60)}` };
  }
  const values = {};
  for (const e of entries) {
    const v = scalar(e);
    if (v.error) return { error: `${e.key}: ${v.error}` };
    values[e.key] = v.value;
  }
  return { entries, values, lines, close, body: lines.slice(close + 1) };
}

function scalar(entry) {
  const first = entry.first.trim();
  const rest = entry.rest.map((l) => l.trim());
  while (rest.length && !rest[rest.length - 1]) rest.pop();
  if (/^[|>][-+]?\d*$/.test(first)) {
    if (first[0] === '|') return { value: rest.join('\n').trim() };
    // Folded: lines join with spaces, blank lines become newlines.
    return { value: rest.reduce((acc, l) => (l ? (acc && !acc.endsWith('\n') ? `${acc} ${l}` : acc + l) : `${acc}\n`), '').trim() };
  }
  if (!first && rest.length) return { value: { mapping: rest.filter(Boolean) } };
  const joined = [first, ...rest].filter(Boolean).join(' ').trim();
  if (joined.startsWith('"')) {
    if (joined.length < 2 || !joined.endsWith('"')) return { error: 'unclosed double quote' };
    try { return { value: JSON.parse(joined) }; } catch { return { value: joined.slice(1, -1) }; }
  }
  if (joined.startsWith("'")) {
    if (joined.length < 2 || !joined.endsWith("'")) return { error: 'unclosed single quote' };
    return { value: joined.slice(1, -1).replace(/''/g, "'") };
  }
  return { value: joined.replace(/\s+#.*$/, '') };
}

// --- validation -------------------------------------------------------------------

function walk(dir, rel, out, warnings, includeRecordings) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) { // Node reports Windows junctions as symlinks too
      warnings.push(`skipped link (links are never followed): ${relPath}`);
      continue;
    }
    if (SKIP_NAMES.has(name) || SKIP_PATTERNS.some((re) => re.test(name))) continue;
    if (!rel && name === 'evals' && st.isDirectory()) {
      warnings.push('left out evals/ (test cases are for development, not for the uploaded skill)');
      continue;
    }
    if (!includeRecordings && (RECORDING_PATTERNS.some((re) => re.test(name)) || (st.isDirectory() && name === 'screens'))) {
      warnings.push(`left out recording evidence (use --include-recordings to keep it): ${relPath}`);
      continue;
    }
    if (st.isDirectory()) walk(abs, relPath, out, warnings, includeRecordings);
    else if (st.isFile()) out.push({ rel: relPath, abs, size: st.size });
  }
}

export function validateSkill(skillDir, { stripCcKeys = false, includeRecordings = false } = {}) {
  const errors = [];
  const warnings = [];
  const dir = path.resolve(skillDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { errors: [`not a directory: ${dir}`], warnings };
  }
  const folder = path.basename(dir);
  const files = [];
  walk(dir, '', files, warnings, includeRecordings);

  const rootNames = fs.readdirSync(dir);
  if (!rootNames.includes('SKILL.md')) {
    const variant = rootNames.find((n) => n.toLowerCase() === 'skill.md');
    errors.push(variant ? `rename ${variant} to SKILL.md (the name is case-sensitive)` : 'SKILL.md is missing');
    return { errors, warnings, folder };
  }
  for (const f of files) {
    if (f.rel !== 'SKILL.md' && path.posix.basename(f.rel).toLowerCase() === 'skill.md') {
      errors.push(`only one SKILL.md is allowed; remove or rename ${f.rel}`);
    }
  }
  const readme = files.findIndex((f) => f.rel.toLowerCase() === 'readme.md');
  if (readme !== -1) {
    warnings.push('README.md left out: a skill folder keeps its documentation in SKILL.md or references/');
    files.splice(readme, 1);
  }

  const skillText = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(skillText);
  if (fm.error) {
    errors.push(fm.error);
    return { errors, warnings, folder };
  }
  const { values, entries } = fm;

  const name = values.name;
  if (typeof name !== 'string' || !name) errors.push('name is required');
  else {
    if (name.length > 64) errors.push(`name is ${name.length} chars (max 64)`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`name "${name}" must be lowercase letters, digits and single hyphens (kebab-case)`);
    if (/anthropic|claude/.test(name)) errors.push(`name "${name}" contains a reserved word (anthropic, claude)`);
    if (name !== folder) errors.push(`name "${name}" must equal the folder name "${folder}"`);
  }

  const desc = values.description;
  if (typeof desc !== 'string' || !desc.trim()) errors.push('description is required');
  else {
    if (desc.length > 1024) errors.push(`description is ${desc.length} chars (max 1024)`);
    if (/[<>]/.test(desc)) errors.push('description must not contain < or > (XML tags are forbidden in frontmatter)');
    if (desc.length > 200) warnings.push(`description is ${desc.length} chars; claude.ai's help center still cites 200 — put the key trigger first`);
    if (!/\buse (it |this skill )?(when|for|whenever|if)\b/i.test(desc)) warnings.push('description should say when to use the skill ("Use when …")');
    if (/^\s*(i|you)\b/i.test(desc)) warnings.push('description should be written in the third person ("Processes …", not "I/You …")');
  }

  if (typeof values.compatibility === 'string' && values.compatibility.length > 500) {
    errors.push(`compatibility is ${values.compatibility.length} chars (max 500)`);
  }
  if ('metadata' in values && !(values.metadata && values.metadata.mapping)) {
    errors.push('metadata must be a mapping of keys to values');
  }
  // Angle brackets anywhere in a value (not the "|" / ">" block indicators).
  for (const [key, value] of Object.entries(values)) {
    const text = typeof value === 'string' ? value : (value?.mapping || []).join('\n');
    if (key !== 'description' && /[<>]/.test(text)) errors.push(`${key} must not contain < or >`);
  }

  const stripped = [];
  for (const e of entries) {
    if (ALLOWED_KEYS.has(e.key)) continue;
    if (CLAUDE_CODE_KEYS.has(e.key)) {
      if (stripCcKeys) stripped.push(e);
      else errors.push(`"${e.key}" is Claude Code-only and fails the claude.ai upload; rerun with --strip-cc-keys to drop it from the ZIP`);
    } else if (e.key === 'dependencies') {
      errors.push('"dependencies" is not a spec field; describe requirements in "compatibility" instead');
    } else {
      errors.push(`unknown frontmatter key "${e.key}" (allowed: ${[...ALLOWED_KEYS].join(', ')})`);
    }
  }
  let exportText = skillText;
  if (stripped.length) {
    const drop = new Set(stripped.flatMap((e) => Array.from({ length: e.to - e.from + 1 }, (_, k) => e.from + k)));
    exportText = fm.lines.filter((_, i) => !drop.has(i)).join('\n');
    warnings.push(`dropped Claude Code-only keys from the exported copy: ${stripped.map((e) => e.key).join(', ')}`);
  }

  // Body guidance.
  const body = fm.body.join('\n');
  const bodyLines = fm.body.length;
  if (bodyLines > BODY_LINES_LIMIT) warnings.push(`SKILL.md body is ${bodyLines} lines; keep it under ${BODY_LINES_LIMIT} and move detail to references/`);
  const present = new Set(files.map((f) => f.rel));
  const refs = new Set();
  // Links inside fenced blocks are templates/examples, not references.
  const prose = body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) refs.add(m[1]);
  for (const m of body.matchAll(/`((?:scripts|references|assets)[/\\][^`\s]+)`/g)) refs.add(m[1]);
  for (const ref of refs) {
    if (/^(https?:|mailto:|#|<)/.test(ref)) continue; // <url>-style placeholders included
    if (ref.includes('\\')) warnings.push(`use forward slashes in paths: ${ref}`);
    const target = ref.split('#')[0].replace(/\\/g, '/').replace(/^\.\//, '');
    if (target && !present.has(target) && !files.some((f) => f.rel.startsWith(`${target.replace(/\/$/, '')}/`))) {
      warnings.push(`SKILL.md references a file that is not in the skill: ${target}`);
    }
  }
  for (const f of files) {
    if (!f.rel.endsWith('.md') || f.rel === 'SKILL.md') continue;
    const lines = fs.readFileSync(f.abs, 'utf8').split(/\r?\n/);
    const hasToc = lines.slice(0, 40).some((l) => /^#+\s*(contents|table of contents|toc|indice|sommario)\b/i.test(l));
    if (lines.length > TOC_THRESHOLD && !hasToc) {
      warnings.push(`${f.rel} has ${lines.length} lines; add a "## Contents" list at the top so partial reads see its scope`);
    }
  }

  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_BYTES) errors.push(`skill is ${(total / 1048576).toFixed(1)} MB uncompressed (max 30 MB)`);

  return { errors, warnings, folder, name, files, exportText, totalBytes: total };
}

// --- ZIP writer -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// zlib.crc32 exists from Node 20.15 / 22.2; the table keeps Node 18 working.
const crc32 = zlib.crc32 ? (buf) => zlib.crc32(buf) >>> 0 : (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1; // 1980-01-01, fixed for reproducible archives
const FLAG_UTF8 = 0x0800;

export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so external attrs carry the mode
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(DOS_DATE_1980, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

/** Reads a ZIP back (central directory → data, CRC-checked). Used to verify every export. */
export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch: ${name}`);
    out.push({ name, data, mode: mode & 0o777, utf8: Boolean(flags & FLAG_UTF8) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function exportSkill(skillDir, opts = {}) {
  const v = validateSkill(skillDir, opts);
  if (v.errors.length) return { status: 'invalid', errors: v.errors, warnings: v.warnings };
  if (opts.check) {
    return { status: 'valid', name: v.name, files: v.files.length, bytes: v.totalBytes, warnings: v.warnings };
  }
  const entries = v.files
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((f) => {
      const data = f.rel === 'SKILL.md' ? Buffer.from(v.exportText, 'utf8') : fs.readFileSync(f.abs);
      const executable = f.rel.startsWith('scripts/') || data.subarray(0, 2).toString() === '#!';
      return { name: `${v.name}/${f.rel}`, data, mode: executable ? 0o755 : 0o644 };
    });
  const zip = buildZip(entries);
  const out = path.resolve(opts.out || path.join(os.homedir(), '.agents', 'exports', `${v.name}.zip`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip);

  // Never hand over an archive we have not read back.
  const back = readZip(fs.readFileSync(out));
  const bad = back.filter((e) => !e.name.startsWith(`${v.name}/`));
  const skills = back.filter((e) => /(^|\/)skill\.md$/i.test(e.name));
  if (bad.length || skills.length !== 1 || skills[0].name !== `${v.name}/SKILL.md`) {
    return { status: 'invalid', errors: ['written ZIP failed verification'], warnings: v.warnings };
  }
  return { status: 'exported', zip: out, name: v.name, files: back.length, bytes: zip.length,
    warnings: v.warnings, upload: UPLOAD_HINT };
}

// --- self-test ----------------------------------------------------------------------

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-export-selftest-'));
  const failures = [];
  const expect = (cond, msg) => { if (!cond) failures.push(msg); };
  const skill = (folder, frontmatter, body = '# Demo\n\nRun `scripts/run.py`. See [guide](references/guide.md).\n', extra = {}) => {
    const dir = path.join(root, folder);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
    fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), '#!/usr/bin/env python\nprint("ok")\n');
    fs.writeFileSync(path.join(dir, 'references', 'guide.md'), '# Guide\n\nShort.\n');
    for (const [rel, content] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  };
  const good = 'name: demo-skill\ndescription: >-\n  Files weekly expense reports in the Acme portal.\n  Use when the user asks to submit or file expenses.\nmetadata:\n  author: test\n  version: 1.0.0';

  // 1. valid skill, junk and evidence excluded, folder at the ZIP root
  const dir = skill('demo-skill', good, undefined, {
    'README.md': '# for humans\n', '__pycache__/x.pyc': 'x', '.DS_Store': 'x',
    'screens/click-1.jpg': 'x', 'desktop-events.jsonl': '{}\n', 'evals/evals.json': '{}\n',
  });
  const out = path.join(root, 'demo-skill.zip');
  const r = exportSkill(dir, { out });
  expect(r.status === 'exported', `valid skill not exported: ${JSON.stringify(r)}`);
  if (r.status === 'exported') {
    const entries = readZip(fs.readFileSync(out));
    const names = entries.map((e) => e.name);
    expect(JSON.stringify(names) === JSON.stringify(['demo-skill/SKILL.md', 'demo-skill/references/guide.md', 'demo-skill/scripts/run.py']),
      `unexpected entries: ${names.join(', ')}`);
    expect(entries.every((e) => e.utf8), 'UTF-8 flag missing');
    expect(entries.find((e) => e.name.endsWith('run.py'))?.mode === 0o755, 'script is not 0755');
    expect(entries[0].data.toString().includes('Files weekly expense reports'), 'SKILL.md content changed');
    expect(r.warnings.some((w) => w.startsWith('README.md left out')), 'README.md exclusion not reported');
    expect(r.warnings.some((w) => w.startsWith('left out evals/')), 'evals/ exclusion not reported');
    // Reproducible: same input → identical bytes.
    const again = path.join(root, 'again.zip');
    exportSkill(dir, { out: again });
    expect(fs.readFileSync(out).equals(fs.readFileSync(again)), 'export is not reproducible');
    // Cross-check with the system archiver when it can read ZIPs (bsdtar: Windows 10+, macOS).
    const tar = spawnSync('tar', ['--version'], { encoding: 'utf8' });
    if (tar.status === 0 && /bsdtar/.test(tar.stdout)) {
      const list = spawnSync('tar', ['-tf', out], { encoding: 'utf8' });
      expect(list.status === 0 && list.stdout.trim().split(/\r?\n/).length === 3, `bsdtar could not list the ZIP: ${list.stderr}`);
    }
  }

  // 2. folded description parses; multi-line values survive
  const parsed = parseFrontmatter(`---\n${good}\n---\nbody`);
  expect(parsed.values?.description === 'Files weekly expense reports in the Acme portal. Use when the user asks to submit or file expenses.',
    `folded description parsed as ${JSON.stringify(parsed.values?.description)}`);

  // 3. errors
  const errorCases = [
    ['mismatch', 'name: other-name\ndescription: Does X. Use when Y.', 'must equal the folder name'],
    ['Bad_Name', 'name: Bad_Name\ndescription: Does X. Use when Y.', 'kebab-case'],
    ['claude-helper', 'name: claude-helper\ndescription: Does X. Use when Y.', 'reserved word'],
    ['long-desc', `name: long-desc\ndescription: ${'x'.repeat(1100)}`, 'max 1024'],
    ['xml-desc', 'name: xml-desc\ndescription: Does <b>X</b>. Use when Y.', 'must not contain < or >'],
    ['cc-key', 'name: cc-key\ndescription: Does X. Use when Y.\ndisable-model-invocation: true', 'Claude Code-only'],
    ['deps', 'name: deps\ndescription: Does X. Use when Y.\ndependencies: python>=3.8', 'compatibility'],
    ['no-desc', 'name: no-desc', 'description is required'],
  ];
  for (const [folder, fmText, needle] of errorCases) {
    const res = exportSkill(skill(folder, fmText), { check: true });
    expect(res.status === 'invalid' && res.errors.some((e) => e.includes(needle)),
      `${folder}: expected error containing "${needle}", got ${JSON.stringify(res.errors)}`);
  }
  const nested = skill('nested', 'name: nested\ndescription: Does X. Use when Y.', undefined, { 'references/SKILL.md': 'x' });
  expect(exportSkill(nested, { check: true }).errors?.some((e) => e.includes('only one SKILL.md')), 'nested SKILL.md accepted');
  const lower = path.join(root, 'lower');
  fs.mkdirSync(lower);
  fs.writeFileSync(path.join(lower, 'skill.md'), '---\nname: lower\ndescription: Does X. Use when Y.\n---\n');
  expect(exportSkill(lower, { check: true }).errors?.some((e) => e.includes('case-sensitive')), 'skill.md (lowercase) accepted');

  // 4. --strip-cc-keys drops Claude Code-only keys from the zipped copy only
  const ccDir = path.join(root, 'cc-key');
  const stripped = exportSkill(ccDir, { stripCcKeys: true, out: path.join(root, 'cc.zip') });
  expect(stripped.status === 'exported', `strip-cc-keys export failed: ${JSON.stringify(stripped)}`);
  if (stripped.status === 'exported') {
    const md = readZip(fs.readFileSync(path.join(root, 'cc.zip')))[0].data.toString();
    expect(!md.includes('disable-model-invocation') && md.includes('name: cc-key'), 'CC key not stripped from the ZIP copy');
    expect(fs.readFileSync(path.join(ccDir, 'SKILL.md'), 'utf8').includes('disable-model-invocation'), 'source SKILL.md was modified');
  }

  // 5. warnings: long body, long reference without TOC, missing link, no "Use when", links
  const warnDir = skill('warn-skill', 'name: warn-skill\ndescription: Processes invoices for the finance team.',
    `# Warn\n\nSee [missing](references/missing.md). Template: [<title>](<url>)\n\n\`\`\`markdown\n1. [Example](example/file.md)\n\`\`\`\n${'line\n'.repeat(510)}`,
    { 'references/long.md': `# Long\n${'row\n'.repeat(120)}` });
  try { fs.symlinkSync(path.join(warnDir, 'references'), path.join(warnDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* no link support */ }
  const w = exportSkill(warnDir, { check: true });
  expect(w.status === 'valid', `warn-skill should be valid: ${JSON.stringify(w.errors)}`);
  for (const needle of ['body is', 'references/long.md has', 'not in the skill: references/missing.md', 'Use when']) {
    expect((w.warnings || []).some((x) => x.includes(needle)), `missing warning containing "${needle}"`);
  }
  expect(!(w.warnings || []).some((x) => x.includes('<url>') || x.includes('example/file.md')),
    'placeholders or fenced-block links were reported as missing files');
  if (fs.existsSync(path.join(warnDir, 'linked'))) {
    expect((w.warnings || []).some((x) => x.includes('skipped link')), 'link was not skipped');
  }

  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log('EXPORT SELF-TEST FAIL');
    return 1;
  }
  console.log('EXPORT SELF-TEST PASS');
  return 0;
}

// --- CLI ------------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const HELP = `Usage: node scripts/export-skill.mjs <skillDir> [options]

Validate a skill folder and export it as a ZIP for claude.ai (folder at the ZIP root).

Options:
  --check               validate only, write nothing
  --out <file.zip>      output path (default: ~/.agents/exports/<name>.zip)
  --strip-cc-keys       drop Claude Code-only frontmatter keys from the zipped copy
  --include-recordings  keep screens/, *events*.jsonl and trace-*.zip
  --self-test           run the built-in tests

Output: JSON on stdout. Exit codes: 0 valid/exported, 1 invalid skill, 2 usage error.

Examples:
  node scripts/export-skill.mjs ~/.agents/skills/filing-acme-expenses --check
  node scripts/export-skill.mjs ~/.agents/skills/filing-acme-expenses --strip-cc-keys`;

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.includes('--self-test')) process.exit(selfTest());
  const outAt = args.indexOf('--out');
  const out = outAt !== -1 ? args[outAt + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith('--') && (outAt === -1 || i !== outAt + 1));
  if (!positional[0]) {
    console.error(`Error: <skillDir> is required.\n\n${HELP}`);
    process.exit(2);
  }
  const result = exportSkill(positional[0], {
    out, check: args.includes('--check'),
    stripCcKeys: args.includes('--strip-cc-keys'),
    includeRecordings: args.includes('--include-recordings'),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'invalid' ? 1 : 0);
}
