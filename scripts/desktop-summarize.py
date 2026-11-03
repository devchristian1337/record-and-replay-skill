#!/usr/bin/env python3
"""record-and-replay — desktop recording (desktop-events.jsonl) summarizer.

Reduces the lite recorder's raw event stream to a compact markdown timeline
suited to skill generation: window changes become headings, typed text blocks
(masked/redacted ones flagged) and shortcuts are one line each, and clicks carry
their semantic target and screenshot reference. Blind spots (elevated windows,
macOS secure input, reinstalled hooks) are called out. Pause segments
(desktop-events-partN.jsonl) are merged in order. Recordings made before the
recorder emitted `text` events (one `press` per keystroke) are coalesced here.

Usage:
    desktop-summarize.py <sessionDir|desktop-events.jsonl> [--full]

Stdlib only; runs under any python3.
"""

import json
import re
import sys
from pathlib import Path

SENSITIVE_HINT = (
    "WARNING: masking is heuristic — password fields, privacy.json exclusions and "
    "secret-shaped text are masked, but screenshots are raw and other typed text is "
    "kept verbatim. If you see a password/OTP/card value, never reproduce it in "
    "summaries or generated skills; use a placeholder."
)

MASK_REASONS = {
    "password": "password field",
    "timeout": "field could not be checked in time",
    "unverified": "field could not be checked",
}

MARKERS = {
    "blind": "⚠ input to an elevated (admin) window is invisible to the recorder — steps may be missing",
    "blind_end": "elevated window left — recording input again",
    "hook_reinstalled": "⚠ Windows had dropped the input hooks; reinstalled — a few events may be missing",
    "capture_error": "⚠ capture error",
}

SPECIAL_KEYS = {
    "enter": "⏎", "tab": "⇥", "backspace": "⌫", "esc": "⎋",
    "space": " ", "delete": "⌦",
}

MODIFIERS = {"shift", "shift_r", "ctrl", "ctrl_r", "alt", "alt_r", "alt_gr",
             "cmd", "cmd_r", "caps_lock"}


def fmt_ts(ms: float) -> str:
    s = int(ms / 1000)
    return f"[{s // 60:02d}:{s % 60:02d}]"


def read_events(file: Path) -> list:
    events = []
    with open(file, encoding="utf-8") as fh:
        for line in fh:
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
    return events


def describe_target(target: dict) -> str:
    """Reduces AX/UIA info to a one-line readable target.

    Current recordings carry {role, name, automationId, window, ancestors};
    older macOS ones carried raw AX keys (AXButton, title, identifier)."""
    if not target:
        return ""
    if target.get("excluded"):
        return " → [excluded window]"
    role = target.get("role") or ""
    if role.startswith("AX"):
        role = role[2:]
    name = target.get("name") or target.get("title") or target.get("description") \
        or target.get("value") or target.get("help")
    ident = target.get("automationId") or target.get("identifier")
    if role and name:
        out = f' → {role} "{name}"'
    elif name:
        out = f' → "{name}"'
    elif role:
        out = f" → {role}"
    else:
        return ""
    if ident:
        out += f" #{ident}"
    if target.get("isPassword"):
        out += " (password field)"
    path = [f'{a.get("role", "")} "{a["name"]}"'.strip() for a in target.get("ancestors", [])[:2]
            if a.get("name")]
    if path:
        out += " in " + " › ".join(path)
    return out


def summarize_jsonl(file: Path, out: list, full: bool):
    """Appends one desktop-events.jsonl segment to the out list."""
    n_actions = n_windows = 0
    task = "?"
    text_buf: list[str] = []
    text_start = None
    screens_dir = file.parent / "screens"

    def flush_text():
        nonlocal text_buf, text_start
        if text_buf:
            out.append(f"- {fmt_ts(text_start)} type → \"{''.join(text_buf)}\"")
            text_buf = []
            text_start = None

    events = read_events(file)
    # Screenshot + AX target are written as a separate "target" line after the
    # click (the recorder does that heavy work on a worker thread); rejoin them here.
    targets = {e["forSeq"]: e for e in events if e.get("kind") == "target" and "forSeq" in e}

    for e in events:
        kind = e.get("kind")
        t = e.get("t", 0)
        if kind == "target":
            continue
        if kind == "session":
            typ = e.get("type")
            if typ == "started":
                task = e.get("name", "?")
                caps = ""
                if e.get("targets"):
                    caps = f", targets: {e['targets']}, masking: {e.get('masking')}"
                out.append(f"- {fmt_ts(t)} ▶ session started (limit: {e.get('timeLimitMinutes')}m{caps})")
            elif typ == "stopping":
                flush_text()
                out.append(f"- {fmt_ts(t)} ■ session stopped ({e.get('reason')})")
            elif typ == "secure_input":
                flush_text()
                out.append(f"- {fmt_ts(t)} " + (
                    "⚠ macOS secure input ON — keystrokes are invisible until it ends"
                    if e.get("on") else "macOS secure input off"))
            elif typ in MARKERS:
                flush_text()
                msg = e.get("message")
                out.append(f"- {fmt_ts(t)} {MARKERS[typ]}" + (f": {msg}" if msg else ""))
            elif full:
                out.append(f"- {fmt_ts(t)} {typ}")
        elif kind == "window":
            flush_text()
            n_windows += 1
            out.append("")
            app = f" ({e['app']})" if e.get("app") and e["app"] not in (e.get("title") or "") else ""
            out.append(f"## {e.get('title')}{app}")
        elif kind == "input":
            n_actions += 1
            typ = e.get("type")
            if typ == "text":
                flush_text()
                if e.get("masked"):
                    why = MASK_REASONS.get(e.get("reason"), e.get("reason") or "sensitive")
                    out.append(f"- {fmt_ts(t)} type → [masked: {why}]")
                else:
                    note = f" ({e['redacted']} redacted)" if e.get("redacted") else ""
                    out.append(f"- {fmt_ts(t)} type → \"{e.get('text', '')}\"{note}")
            elif typ == "press":
                ch = e.get("char")
                key = (e.get("key") or "").lower()
                if ch:
                    if text_start is None:
                        text_start = t
                    text_buf.append(ch)
                elif key == "space":
                    if text_start is None:
                        text_start = t
                    text_buf.append(" ")
                elif key and key not in MODIFIERS:
                    flush_text()
                    out.append(f"- {fmt_ts(t)} press {SPECIAL_KEYS.get(key, key)}")
            elif typ == "click":
                flush_text()
                info = targets.get(e.get("seq"), {})
                name = e.get("screenshot") or info.get("screenshot")
                shot = f" [screens/{name}]" if name and (screens_dir / name).exists() else ""
                out.append(f"- {fmt_ts(t)} click ({e.get('button')}) @ "
                           f"({e.get('x')},{e.get('y')}){describe_target(info)}{shot}")
            elif typ == "scroll" and full:
                out.append(f"- {fmt_ts(t)} scroll @ ({e.get('x')},{e.get('y')})")
    flush_text()
    n_targets = sum(1 for v in targets.values() if describe_target(v))
    return task, n_actions, n_windows, n_targets


def part_number(p: Path) -> int:
    m = re.search(r"-part(\d+)\.jsonl$", p.name)
    return int(m.group(1)) if m else 10**9  # the live segment sorts last


def main() -> int:
    # Windows pipes default to the ANSI code page, which cannot encode → ⏎ ⚠.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    full = "--full" in sys.argv

    if not args:
        print(__doc__, file=sys.stderr)
        return 2

    target = Path(args[0]).expanduser()
    if target.is_dir():
        files = sorted(target.glob("desktop-events-part*.jsonl"), key=part_number)
        if (target / "desktop-events.jsonl").exists():
            files.append(target / "desktop-events.jsonl")
    else:
        files = [target]

    files = [f for f in files if f.exists()]
    if not files:
        print(f"no recording found: {target}", file=sys.stderr)
        return 1

    out: list = []
    total_actions = total_windows = total_targets = 0
    task = "?"
    for i, f in enumerate(files):
        if len(files) > 1:
            out.append("")
            if i > 0:
                out.append(f"--- ⏸ recording paused / ▶ segment {i + 1} ---")
            else:
                out.append(f"--- segment {i + 1} ---")
        t, a, w, g = summarize_jsonl(f, out, full)
        task = t
        total_actions += a
        total_windows += w
        total_targets += g

    screens = (target if target.is_dir() else target.parent) / "screens"
    n_screens = len(list(screens.glob("*.jpg"))) if screens.exists() else 0

    MAX_LINES = 500
    if not full and len(out) > MAX_LINES:
        dropped = len(out) - MAX_LINES
        out = out[:MAX_LINES]
        out.append("")
        out.append(f"… {dropped} lines truncated — rerun with --full.")

    parts_note = f", {len(files)} segments" if len(files) > 1 else ""
    targets_note = f", {total_targets} semantic targets" if total_targets else ""
    print(f"# Desktop recording summary — task: {task}")
    print(f"_{total_actions} input events, {total_windows} window changes, "
          f"{n_screens} screenshots{targets_note}{parts_note}._")
    print(f"_{SENSITIVE_HINT}_")
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
