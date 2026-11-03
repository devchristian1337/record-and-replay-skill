# record-and-replay

**Agent-agnostic, open-source record & replay skill.** Let the user demonstrate a workflow — in the browser or on the desktop — while an AI coding agent records it, then turns the demonstration into a reusable agent skill.

Inspired by OpenAI Codex's macOS-only Record & Replay plugin, rebuilt on open tooling so it works **across platforms and across agents**: Claude Code, Codex CLI, opencode, and any agent that can run shell commands and read `SKILL.md`-style skills.

## Platform support

| Mode | macOS | Windows | Linux |
|---|---|---|---|
| Browser recording (Playwright) | ✅ | ✅ | ✅ |
| Desktop recording (event stream) | ✅ | ✅ | ✅ (X11) |

## How it works

**Browser mode** (default — richest evidence): launches a headed browser via Playwright (your installed Google Chrome if available, bundled Chromium otherwise) and records every user action into `events.jsonl` — each with **multiple selector candidates** (`testId` → `role+name` → `id` → `text` → `css`) — plus Playwright trace chunks (DOM snapshots + screenshots, 60 s checkpoints).

**Desktop mode**: a single-process recorder (pynput) captures global mouse/keyboard events, active-window/title changes and a half-resolution JPEG at each click into `desktop-events.jsonl` + `screens/` — the same philosophy as Codex's native Record & Replay (an event/context stream, **not** video) at ~0-3% CPU. Every click also records the **accessibility description of the element under the cursor** — macOS AX and Windows UI Automation (`Button "Save" in ToolBar "Standard"`) — so generated skills target semantics rather than pixels. Typing is stored as text blocks, with **password fields masked** and optional per-user exclusions/redactions (`privacy.json`).

The agent then reads the recording (compact markdown summaries via the bundled summarizers), treats it as **evidence of intent** — not a pixel-by-pixel script — asks the user a few questions about what the recording cannot show (why a choice was made, what varies between runs), and generates a reusable skill with semantic locators and verification steps. `scripts/export-skill.mjs` validates it and packages it as a ZIP you can upload to claude.ai.

## Install

**With the [skills CLI](https://github.com/vercel-labs/skills)** (Node.js 22.20+; links the skill into 75+ agents):

```bash
npx skills add devchristian1337/record-and-replay-skill -g
cd ~/.agents/skills/record-and-replay
node setup.mjs      # required: the CLI copies files but runs no setup
```

Re-run `node setup.mjs` after `npx skills update` if the update replaced the folder (Playwright and the desktop venv live inside it). Set `DISABLE_TELEMETRY=1` to opt out of the CLI's anonymous install telemetry.

**With git** (Node.js 18+):

```bash
git clone https://github.com/devchristian1337/record-and-replay-skill ~/.agents/skills/record-and-replay
cd ~/.agents/skills/record-and-replay
node setup.mjs      # npm install + (no Chrome? download Chromium) + browser & desktop self-tests
node install.mjs    # link into agent skill dirs (symlink on macOS/Linux, junction on Windows)
```

`install.mjs` links the skill into `~/.claude/skills/`, `~/.codex/skills/` and `~/.config/opencode/skills/` for every agent that is installed. For any other agent supporting the SKILL.md format, link the folder into its skill directory. Update with `git pull && node setup.mjs`.

Desktop mode's Python env (`.venv-desktop` from `requirements-desktop.txt`: pynput+mss+pillow, plus comtypes on Windows; ~50 MB) is created — and kept in sync on re-runs — by `setup.mjs` automatically when [uv](https://docs.astral.sh/uv/) is installed. Windows needs no admin rights.

**macOS permissions.** Desktop capture needs Accessibility/Input Monitoring and Screen Recording. Without them it records nothing at all, so the recorder preflights and reports them instead of failing quietly:

```bash
node scripts/desktop-record.mjs permissions
```

This opens the system dialog and the exact Settings pane, and reports `grantTo` — **the app that actually owns the grant**. A TCC grant binds to the `.app` bundle hosting your agent (e.g. `Claude`, `Terminal`, `iTerm`), never to the Python binary, and that app must be **restarted** afterwards. `start` runs the same flow automatically when a permission is missing (`--no-permission-prompt` opts out).

## Usage

Tell your agent *"watch me do this and make it a skill"* — the skill file guides it. Manually:

```bash
# Browser (macOS/Linux; Windows: Start-Process node …)
nohup node scripts/recorder.mjs --minutes 30 --name my-task &
node scripts/summarize.mjs ~/.agents/recordings/my-task

# Desktop
node scripts/desktop-record.mjs start my-task 30 [--privacy privacy.json]
node scripts/desktop-record.mjs pause  my-task   # closes segment desktop-events-partN.jsonl
node scripts/desktop-record.mjs resume my-task
node scripts/desktop-record.mjs stop   my-task
python3 scripts/desktop-summarize.py ~/.agents/recordings/my-task

# Validate a generated skill and export it for claude.ai
node scripts/export-skill.mjs ~/.agents/skills/<name> --check
node scripts/export-skill.mjs ~/.agents/skills/<name>        # → ~/.agents/exports/<name>.zip
```

### Desktop privacy

- Typing into a **password field** (Windows `IsPassword`/`ES_PASSWORD`, macOS `AXSecureTextField`) is always masked; when the field cannot be checked in time it is masked too (fail closed).
- `~/.agents/recordings/privacy.json` (template: [`privacy.example.json`](privacy.example.json)) adds **excluded windows/processes** — no keystrokes, screenshots, targets or titles from them — and **redaction regexes** for typed text. API keys, JWTs, card numbers, IBANs and private keys are redacted by default.
- Blind spots are marked in the timeline instead of silently missing: elevated (admin) windows on Windows, macOS secure input, Windows hooks that had to be reinstalled.
- Screenshots are not redacted: close what you do not want captured before recording.

### Recording controls

- **Floating control window** (bottom-right, separate from the recorded pages — like Codex's native Recording Controls panel): live timer, **Pause/Resume**, **Stop**, and **Discard** (two-tap confirm; deletes all evidence, session ends as `discarded`). Reopens itself if closed by accident. Pass `--badge` to use an in-page badge instead.
- While paused, *nothing* is captured — events **and** trace both stop.
- Agent/file control: `touch <outDir>/PAUSE` (delete to resume), `touch <outDir>/STOP`. Stays in sync with the window buttons.
- Auto-stop at the time limit; closing the browser window also ends the session (avoid Cmd+Q — the last minute of the trace may be lost; everything else survives thanks to 60 s trace checkpoints).
- Desktop pause/resume is segment-based (suspending the capture process could silently kill the macOS event tap) — the summarizer merges segments into one timeline.

### Performance defaults (lightweight by design)

- Browser trace defaults to **light**: full DOM snapshots per action, **no continuous screencast** (`--trace full` re-enables screenshots, `--trace off` disables tracing entirely).
- Desktop capture is a **single process with no continuous screen reading and no video** — measured at ~0-3% CPU while recording. (Continuous full-res video capture was tried and rejected: the raw frame pipeline can overwhelm a machine.)
- **Nothing heavy runs in an input callback.** Screenshots (~25-35 ms warm, ~60-220 ms cold), AX queries (up to ~130 ms) and UI Automation queries (~3 ms median, ~200 ms cold, 250 ms timeout) run on worker threads; callbacks only enqueue. On macOS the pynput callback executes on the CGEventTap thread, and a slow callback there can get the tap disabled; on Windows a low-level hook that exceeds `LowLevelHooksTimeout` is removed without notice — the recorder compares `GetLastInputInfo` with its last hook event and reinstalls the hooks when they go quiet.
- Typing is debounced, held keys skip auto-repeat, scroll/selection are sampled, and the event stream is rate-limited — a 30-minute recording stays in the tens of MB, not GBs.
- `start` returns only when capture is genuinely live (READY handshake), not when the output file appears — otherwise a cold Python start swallowed the first ~10 seconds of the demonstration.
- Stopping is signal-free on every platform (STOP-file watch) — recordings always finalize cleanly, including on Windows.

### Benchmarks & self-tests

```bash
node scripts/recorder.mjs --self-test              # browser: end-to-end, headless
node scripts/desktop-record.mjs selftest           # desktop: end-to-end, no permissions (+ live UI Automation check on Windows)
node scripts/export-skill.mjs --self-test          # skill validator + ZIP writer
node bench/browser-overhead.mjs                    # in-page recorder cost
.venv-desktop/bin/python bench/desktop-capture.py  # screenshot / target / startup cost (Windows: .venv-desktop\Scripts\python.exe)
```

All three self-tests run as part of `node setup.mjs`.

## Design notes

- **Two-layer evidence** (browser): `events.jsonl` (semantic actions, multi-candidate selectors) + `trace-NNN.zip` (per-action DOM snapshot & screenshot; open with `npx playwright show-trace trace-*.zip`).
- **Persistent browser profile** at `~/.agents/recordings/.browser-profile` keeps logins across recordings and replays. ⚠ It holds live session cookies — treat it as plaintext credentials; never commit or share it.
- **Sensitive data** (browser): password/OTP/card fields (English *and* Turkish field names) arrive pre-masked; paste content is never logged; secret-looking selections/copies are masked; plain-character keydowns aren't logged at all. Masking is heuristic — trace chunks are **not** masked; treat recordings as sensitive.
- **Desktop masking is heuristic**: password fields, excluded windows and secret-shaped text are masked before reaching disk; other typed text and all screenshots are raw. The summarizer warns the agent explicitly.
- **Page-JS hardening**: the recording binding is nonce-guarded and removed from `window`; the event stream is rate-limited and capped (no fake-event injection, no disk-fill).
- **One active recording** per mode (lock files); restarting with the same name archives the previous evidence as `.bak` instead of appending.
- **Replaying**: generated skills use semantic Playwright locators (browser) or an accessibility-tree computer-use layer such as [cua-driver](https://github.com/trycua/cua) (desktop) — never raw coordinates unless there is no better target. Desktop recordings carry an AX/UIA target per click, so "no better target" is now the exception rather than the rule on macOS and Windows.

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | The skill definition your agent reads. |
| `scripts/recorder.mjs` | Browser recorder (`--self-test` for a headless end-to-end check). |
| `scripts/summarize.mjs` | `events.jsonl` → compact markdown timeline. |
| `scripts/desktop-record.mjs` | Desktop recorder driver: start/pause/resume/stop/status/permissions/selftest. |
| `scripts/desktop-lite-recorder.py` | Desktop engine: event/window/click-screenshot/semantic-target/masked-text stream. |
| `scripts/desktop_win.py` | Windows helpers: UI Automation client (comtypes), DPI, foreground/elevation, ES_PASSWORD. |
| `scripts/desktop_privacy.py` | Privacy rules: excluded windows/processes, redaction patterns. |
| `scripts/desktop-permissions.py` | macOS permission preflight & request (`--request`). |
| `scripts/desktop-selftest.py` | Desktop engine end-to-end self-test (fakes pynput and the platform; live UIA check on Windows). |
| `scripts/desktop-summarize.py` | `desktop-events.jsonl` → markdown timeline (stdlib only). |
| `scripts/export-skill.mjs` | Validate a skill folder and export a claude.ai-ready ZIP (no dependencies). |
| `references/skill-authoring.md` | How the agent turns a recording into a skill: questions, limits, skeleton, checklist. |
| `scripts/replay-template.mjs` | Skeleton for generated replay scripts. |
| `requirements-desktop.txt`, `privacy.example.json` | Desktop venv requirements; privacy rules template. |
| `bench/` | Performance harnesses for the browser and desktop recorders. |
| `setup.mjs` / `install.mjs` | Cross-platform setup & agent-dir linking. |

## License

[MIT](LICENSE)
