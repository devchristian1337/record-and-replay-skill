---
name: record-and-replay
description: Records the user's actions — browser (Playwright event stream + trace) or native desktop (event/window/screenshot stream with accessibility targets and password masking) — on macOS, Windows and Linux, asks the user what the recording cannot show, then turns the demonstration into a reusable agent skill, optionally exported as a ZIP for claude.ai. Use when the user asks you to watch them perform a task, record a workflow, or create/refine a skill from their demonstration, even if they never say "skill". Agent-agnostic — works in Claude Code, Codex, opencode, or any agent with shell access.
---

# Record & Replay (browser + desktop)

Record & Replay lets an agent learn a user-demonstrated workflow and turn it into a reusable skill. Two modes:

- **Browser mode** (default, richest evidence): a headed Playwright browser (system Google Chrome if available) records every user action into `events.jsonl` with multiple selector candidates, plus Playwright trace chunks (`trace-NNN.zip`). Works on macOS, Windows and Linux.
- **Desktop mode** (native apps): a lightweight single-process recorder (pynput) captures global mouse/keyboard events, active-window changes, click-moment screenshots and the accessibility target of each click (macOS AX, Windows UI Automation) into `desktop-events.jsonl` + `screens/`, with password fields masked — Codex-parity (Codex records an event/context stream too, not video), ~1-3% CPU. Works on macOS, Windows and Linux (X11). See "Desktop recording" below.

Pick browser mode whenever the workflow is browser-only — its semantic selectors produce far better skills than desktop coordinates.

## Setup preflight (run it yourself before the first recording)

Do the setup for the user — on a fresh machine they should only have to confirm. Run these checks from the skill folder (`~/.agents/skills/record-and-replay`) before the first recording, and again whenever a recorder reports a missing module or `desktop_env_missing` (`npx skills update` can replace the folder and drop the installed dependencies). Every step is user-level: none needs admin rights.

1. **Node.js 18+** — `node --version`. If it is missing or older, the skill cannot run at all: tell the user, and with their consent install the LTS release (Windows: `winget install OpenJS.NodeJS.LTS`, which may show a UAC prompt; macOS: `brew install node`; Linux: the distro package manager or https://nodejs.org). The agent must be restarted afterwards so the new PATH is seen; say so and stop until it is.
2. **Browser mode** — if `node_modules/playwright` is missing, run `node setup.mjs`. It installs the `playwright` npm package, downloads Chromium only when Google Chrome is not installed (the recorder uses `channel: 'chrome'`), and runs the self-tests.
3. **Desktop mode** (only when the workflow needs it) — if `.venv-desktop` is missing, check `uv --version`. When uv is missing, tell the user you are installing [uv](https://docs.astral.sh/uv/) with Astral's official user-level installer, then run it:
   - Windows (PowerShell): `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`

   Then run `node setup.mjs` again: it finds uv in `~/.local/bin` even when the current shell's PATH has not been refreshed, downloads Python 3.12 through uv (no system Python needed) and builds `.venv-desktop`. On macOS the user must then grant permissions — see "Permissions (macOS)" below; this is the one step that cannot be automated.
4. If `setup.mjs` exits non-zero, report the failing step from its output and do not start a recording.

After a `git clone` install (not needed after `npx skills add`), also run `node install.mjs` once to link the skill into the agent skill directories.

## Recording Workflow

1. Before starting, tell the user to close windows, files and conversations they do not want captured, and not to type secrets they would not want stored. Start the recorder **detached in the background** only when the user is ready to begin. Always pass `--name <slug>` so the output directory is known up front:

   ```bash
   cd ~/.agents/skills/record-and-replay
   # macOS / Linux:
   nohup node scripts/recorder.mjs --minutes 30 --name <slug> [--url <startUrl>] \
     > ~/.agents/recordings/recorder.log 2>&1 &
   # Windows (PowerShell):
   Start-Process node -WindowStyle Hidden -ArgumentList "scripts/recorder.mjs","--minutes","30","--name","<slug>"
   ```

   Agents with a native background-run facility (e.g. Claude Code's Bash `run_in_background`) may use it instead. Outputs go to `~/.agents/recordings/<slug>/`.

2. **Verify startup once** (~2-3 seconds after launching — a single check, not a polling loop): confirm `~/.agents/recordings/<slug>/session.json` exists with `"status": "recording"` (the recorder also prints a `{"status":"recording",...}` line to the log on success). If the check fails, read the log: `recording_already_active` (exit 2) means another recording holds the lock; `launch_failed` or a missing-module error means setup is needed. Report the actual problem instead of telling the user recording has begun.

3. After the startup check, **do not sleep, poll, or wait in a loop**. End your turn: tell the user recording has begun, what the time limit is, and that a small **floating control window** (bottom-right, like Codex's recording controls) has a timer plus **Pause/Resume**, **Stop** and **Discard** (tap twice to confirm) buttons. Nothing is captured while paused — events and trace both stop. If they close the control window by accident it reopens itself; closing the main browser window also ends the session (avoid quitting the browser entirely with Cmd+Q, which can lose the last minute of trace). Pass `--badge` at start to use an in-page badge instead of the control window (fallback for exotic environments).

4. Pause/resume (user asks you to pause, or you need to skip a sensitive stretch): `touch ~/.agents/recordings/<slug>/PAUSE` pauses within 2 seconds; delete the file to resume. The control-window buttons and the PAUSE file stay in sync; `session.json` carries the current `paused` state. Paused intervals appear as `paused`/`resumed` markers in `events.jsonl` and are absent from the trace.

5. When the user says they are done:
   - If the process is still running, stop it gracefully: `touch ~/.agents/recordings/<slug>/STOP` (the recorder notices within 2 seconds and finalizes).
   - Read `session.json` — `status: "recording"` means still live; `"completed"` means outputs are final; `"discarded"` means the user pressed Discard — the evidence files were deleted, acknowledge and NEVER create a skill from it. `endReason` is one of `user_stopped`, `user_discarded`, `browser_closed`, `stop_file`, `time_limit`, `signal`, `event_limit`.
   - Inspect the captured events **before responding**: run `node scripts/summarize.mjs <outDir>` for a compact timeline, then read `events.jsonl` directly for steps that need detail.

6. Cancellation is defined by **content, not endReason**: if the recording contains few or no `kind: "dom"` events — whatever the endReason — treat it as cancelled. Acknowledge, do not create or update a skill.

7. If the recording contains enough information to identify a reusable workflow, **create or refine a skill for it by default** — even if the user did not explicitly ask. Do not stop after producing only a summary or a replay plan. Follow "Creating Skills from a Recording" below — it starts with a short clarification round.

8. If the recording is too thin or ambiguous to identify the workflow, do not guess. Explain what is unclear and ask the user for the missing pieces.

### Concurrent recording

Only one recording can be active at a time (lock file `~/.agents/recordings/.lock`). If the recorder exits with `recording_already_active`, do not force-start another; tell the user a recording is already in progress and ask whether to use it or stop it first. Restarting with the same `--name` is safe: the previous `events.jsonl` is preserved as a timestamped `.bak`, not appended to.

## Interpreting Events

`events.jsonl` is the primary evidence; `session.json` gives timing/paths only; the `trace-NNN.zip` chunks are the DOM-level ground truth (`npx playwright show-trace <outDir>/trace-*.zip`; `session.json`'s `traceChunks` lists them in order). Trace defaults to **light** mode — full DOM snapshots per action but no continuous screenshots (keeps CPU low). Start with `--trace full` when the user wants pixel-perfect visual evidence, or `--trace off` for the absolute minimum footprint.

Each line is one event: `{seq, t (ms since start), kind, type, url, ...}`.

- `kind: "page"` — navigations, downloads, dialogs, tab opens/closes. Navigations segment the workflow into stages.
- `kind: "dom"` — user actions. `target.selectors` carries **multiple selector candidates**: `testId`, `role` (`{role, name}`), `id`, `nameAttr`, `text`, `css`. Prefer them in that order when generating replay code; `css` is the last resort.
- `type: "input"` events are debounced — one event per field with the **final value** (flushed on blur, Enter, change, and form submit). Password/credit-card/OTP-like fields (English and Turkish names: password, parola, şifre, kart, kimlik…) arrive pre-masked (`***MASKED***`, `masked: true`).
- `selection` and `copy` events reveal what content the user was working with — often the best clue when the user refers to "this" or "the thing I selected". Secret-looking selections (OTPs, API keys, tokens) are masked. `paste` events carry only length/word-count, never content.
- **Sensitive data**: masking is heuristic, not a guarantee — and it applies **only to `events.jsonl`**. The trace chunks are NOT masked: DOM snapshots contain raw input values (including values masked in the JSONL) and screenshots capture everything visible on screen (revealed tokens, 2FA codes, balances). Treat the entire `~/.agents/recordings/<name>/` directory as sensitive: inspect it locally only, never upload or commit it, and never quote literal secrets from it in summaries or generated skills — use placeholders or generic descriptions.

## Creating Skills from a Recording

Read [references/skill-authoring.md](references/skill-authoring.md) before writing: it holds the question bank, the frontmatter limits, the SKILL.md skeleton, the rules for bundled scripts and the quality checklist. If a `skill-creator` skill is available in your environment, its guidance applies too. Create an actual discoverable skill (a `SKILL.md` folder), not just a Markdown runbook.

Copy this checklist and tick it off:

```
- [ ] 1. Summarize the recording; note every gap (decisions, masked stretches, blind spots)
- [ ] 2. Clarify: one message, at most 6 questions, only about the gaps
- [ ] 3. Check for an existing skill covering this workflow → update it instead of duplicating
- [ ] 4. Write the skill + evals/evals.json (the recording is test case 1)
- [ ] 5. Validate: node scripts/export-skill.mjs <skillDir> --check → fix errors, re-run
- [ ] 6. Offer the trigger check + a dry run; fold corrections back in, bump metadata.version
- [ ] 7. Offer the claude.ai ZIP export
```

**Step 2 — clarify before writing.** There is no audio: the recording shows what happened, not why. Answer from the recording whatever it shows, then ask the user — once, in a single message, at most 6 questions — about what it cannot: the outcome and how to tell it worked, which values vary between runs, why they chose X at a given moment, which actions were detours, what they would say to trigger the skill (and what should not), and which actions need confirmation. Quote the moment you mean ("at 02:14 you cleared the date filter — why?"). Use your structured question tool if you have one; plain chat otherwise. Skip the round only when the recording plus the user's request already answer everything, and say so.

**Writing rules:**

- Treat the recording as **evidence of the user's intended outcome**, not a script to replay pixel by pixel. If a connector/API/CLI/MCP tool can achieve the same outcome semantically (create a calendar event, open a PR, post a message), prefer it over UI automation.
- When UI replay is genuinely needed, generate a Playwright script from `scripts/replay-template.mjs`: semantic locators (`getByTestId` > `getByRole` > `getByLabel` > `getByText`), a verification step after each critical action, secrets from env vars. Never use raw coordinates unless the event stream offers no better target.
- Desktop steps name the captured target (role + name + window, e.g. *Button "Save" in "Invoice — Acme"*) so an accessibility-tree tool can find it; coordinates only when no target was captured.
- The recorder's persistent profile (`~/.agents/recordings/.browser-profile`) keeps logins across sessions, so generated skills usually need no login steps. **Security**: that directory holds live authenticated session material (cookies/localStorage; Playwright launches Chrome with a mock keychain, so treat it as plaintext credentials). Never commit, share, or back it up unencrypted — and remember that any replay skill reusing it runs with the user's logins. For recordings on untrusted or high-sensitivity sites, prefer a disposable profile (`--out` plus a temp profile) or clear the profile afterwards.
- Save new skills to `~/.agents/skills/<skill-name>/` (folder name = `name`, kebab-case) and symlink them into the agent skill directories (see `install.mjs` for the pattern) so every agent on this machine can use them.
- Parametrize what varies (dates, amounts, names) and hard-code what does not. State the workflow's purpose and verification criteria in the generated SKILL.md. Never copy secrets or masked values into the skill.

**Export for claude.ai** (offer it; run on request): `node scripts/export-skill.mjs ~/.agents/skills/<name>` writes `~/.agents/exports/<name>.zip` (folder at the ZIP root; README, evals, caches and recording evidence left out; archive read back before success). If the skill uses Claude Code-only frontmatter (`disable-model-invocation`, …) add `--strip-cc-keys`. Tell the user where the file is and that it uploads under Customize › Skills › + › Upload a skill (code execution must be enabled).

## Desktop recording (macOS, Windows, Linux/X11)

Setup: see "Setup preflight" step 3 (`node setup.mjs` creates the minimal `.venv-desktop` Python env from `requirements-desktop.txt` — pynput+mss+pillow, plus comtypes on Windows, ~50 MB; requires [uv](https://docs.astral.sh/uv/), which you install for the user when missing).

**Permissions (macOS)**: the recorder preflights them and reports machine-readable state, so never guess. `start` prints `permissions: {inputMonitoring, screenRecording, grantTo}` plus a `warning` when something is missing, and automatically pops the system dialog and opens the right Settings pane (`--no-permission-prompt` disables that; `node scripts/desktop-record.mjs permissions` runs it on demand). **`grantTo` names the app the user must grant** — a TCC grant binds to the `.app` bundle hosting the agent, not to Python, and **that app must be restarted afterwards**. Relay `grantTo` verbatim; telling the user "grant it to your terminal" is usually wrong. Windows needs no permission and no admin rights.

The engine is a single-process recorder (~0-3% CPU): input event stream + active-window/title changes + a half-resolution JPEG at each click (max 1/700ms) → `desktop-events.jsonl` + `screens/`. Each click also carries the accessibility description of the element under the cursor (`kind: "target"` line, joined to the click by `forSeq`): `role`, `name`, `automationId`, `window`, `ancestors` — a semantic target such as `Button "Save"` instead of a bare coordinate (macOS AX, Windows UI Automation; none on Linux). Typing arrives as `type: "text"` events holding the final value of each burst (backspace corrections applied); shortcuts and special keys as `press` events (`ctrl+c`, `enter`). Screenshots, target queries and focus checks run on worker threads, never in the input callback: a slow callback gets the macOS event tap disabled and the Windows hook silently removed (the recorder also watches for the latter and reinstalls the hooks).

This is Codex-parity: Codex's Record & Replay also records an event/context stream, **not video** — do not try to add continuous video/screen capture; it can overwhelm the machine.

**Privacy**: typing into a password field (Windows `IsPassword`/`ES_PASSWORD`, macOS `AXSecureTextField`) is always stored as `{"type":"text","masked":true,"reason":"password"}`; a field that cannot be checked in time is masked too (`reason: "timeout"`/`"unverified"`). An optional `~/.agents/recordings/privacy.json` (or `start … --privacy <file>`; template: `privacy.example.json`) adds excluded windows/processes — no keystrokes, screenshot, target or title from them — and redaction regexes. API keys, JWTs, card numbers (Luhn-checked), IBANs and private keys are redacted by default.

Workflow mirrors browser mode (all commands cross-platform):

1. Start (background is handled by the script): `node scripts/desktop-record.mjs start <slug> [minutes] [--privacy <file>]` — outputs to `~/.agents/recordings/<slug>/`. It returns only once capture is actually live, printing `{"status":"recording",...}`; on `recording_already_active` or `start_failed`, report the real problem (a `privacy_config` line in the log tail means the privacy file is invalid). If the output carries a `warning`, capture is running but will produce nothing useful — relay the warning (with `grantTo`) before telling the user to start working.
2. **Verify once** ~10s in: `node scripts/desktop-record.mjs status <slug>` — if the user is active but `actionEvents` stays 0, permissions are missing; report `warning`/`grantTo`. Then end your turn as in browser mode (no polling).
3. Pause/resume: `node scripts/desktop-record.mjs pause <slug>` / `resume <slug>`. Pause closes the current segment and stops all capture; resume opens a new segment with the same privacy rules. `status` reports `paused: true`.
4. Stop: `node scripts/desktop-record.mjs stop <slug>` — signal-free on every platform: the recorder watches a STOP file and finalizes gracefully (also auto-stops at the time limit; works from paused state too). `cleanStop: false` in the output means the fallback kill was needed.
5. Inspect: `python3 scripts/desktop-summarize.py <outDir>` (Windows: `python scripts/desktop-summarize.py <outDir>`) → markdown timeline (window-titled sections, typed text, masked/redacted markers, clicks with their semantic target and screenshot ref, blind-spot warnings; segments merged in order with pause markers). Read a few JPEGs from `screens/` around the key moments for visual context.
6. Then follow the same rules as browser mode: cancellation by content, clarify, create a skill by default, ask when ambiguous.

Desktop-specific caveats:

- **Masking is heuristic**: password fields, excluded windows and secret-shaped text are masked; other typed text and every screenshot are raw. Treat `desktop-events.jsonl` and `screens/` as sensitive; never quote literal secrets — use placeholders.
- **Blind spots are marked, not hidden**: input to an elevated (admin) window on Windows (`blind` … `blind_end`), macOS secure input (`secure_input on`: keystrokes reach no recorder), reinstalled Windows hooks (`hook_reinstalled`). Ask the user what happened there.
- Desktop events are still weaker than browser selectors. Prefer the captured target (`role` + `name`/`automationId` + `window`) over coordinates; when generating a replay skill, map actions to an accessibility-tree computer-use tool (find + click/type, e.g. cua-driver or agent-desktop). Use the recording as intent evidence, and fall back to coordinates only when no target was captured. In Chromium/Electron apps the first click of a session may resolve only to a coarse `Pane`.
- One desktop recording at a time (`~/.agents/recordings/.desktop-lock`); browser and desktop recordings may run together only if the workflow genuinely spans both.
- Restarting with the same slug archives the previous run's segments and `screens/` as `.bak` — old evidence never leaks into the new timeline.

## Files

| File | Purpose |
|---|---|
| `scripts/recorder.mjs` | Browser recorder. `--self-test` runs a headless end-to-end check (throwaway profile). |
| `scripts/summarize.mjs` | `events.jsonl` → compact markdown timeline (`--full` for everything). |
| `scripts/replay-template.mjs` | Skeleton for generated browser replay scripts. |
| `scripts/export-skill.mjs` | Validate a skill folder (`--check`) and export it as a claude.ai-ready ZIP (`--help`). |
| `references/skill-authoring.md` | Question bank, frontmatter limits, SKILL.md skeleton, script rules, quality checklist. |
| `scripts/desktop-record.mjs` | Desktop recorder driver: `start/pause/resume/stop/status <slug>`, `permissions`, `selftest` — cross-platform. |
| `scripts/desktop-lite-recorder.py` | Desktop engine: event/window/click-screenshot/semantic-target/masked-text stream (~0-3% CPU). |
| `scripts/desktop_win.py`, `scripts/desktop_privacy.py` | Windows UI Automation + user32 helpers; privacy rules (exclusions, redaction). |
| `scripts/desktop-permissions.py` | macOS permission preflight; `--request` opens the system dialog + Settings pane. |
| `scripts/desktop-selftest.py` | Desktop engine end-to-end self-test (fakes pynput and the platform, so it needs no permissions; live UI Automation check on Windows). |
| `scripts/desktop-summarize.py` | `desktop-events.jsonl` → markdown timeline (segments merged, targets joined, masked text flagged). |
| `privacy.example.json` | Template for `~/.agents/recordings/privacy.json`. |
| `bench/browser-overhead.mjs`, `bench/desktop-capture.py` | Performance harnesses for both recorders. |
| `setup.mjs` / `install.mjs` | Cross-platform setup / link into agent skill dirs (`.sh` wrappers exist for POSIX). |
