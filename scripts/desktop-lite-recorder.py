#!/usr/bin/env python
"""record-and-replay — LITE desktop recorder (the default engine).

Codex's Record & Replay philosophy: NO video, NO continuous screen reading.
Only:
  - global mouse/keyboard events (pynput — macOS/Windows/Linux)
  - active window/title changes (polled once a second, written on change)
  - ONE screenshot AT EACH CLICK (half-resolution JPEG; at most 1 per 700 ms)
  - the accessibility description of the clicked element — macOS AX, Windows
    UI Automation — so the target is semantic (Button "Save"), not a coordinate
  - typed text coalesced into `text` events, with password fields masked
    (focused element is a secure/password field), privacy.json exclusions and
    redaction patterns applied before anything reaches disk

Threads — nothing heavy ever runs in a pynput callback:
  - callbacks only enqueue (a slow callback gets the macOS event tap disabled
    and, on Windows, the low-level hook silently removed past
    LowLevelHooksTimeout);
  - writer: serializes events to disk;
  - capture worker: screenshot + semantic target per click;
  - typing worker: focus classification (password? excluded window?) + text;
  - window poller: title changes, secure-input / elevated-window markers and,
    on Windows, a watchdog that reinstalls hooks Windows dropped.

Output: <outDir>/desktop-events.jsonl + <outDir>/screens/*.jpg
Stopping: the <outDir>/STOP file (signal-free — works identically on Windows)
or the time limit.

Usage: desktop-lite-recorder.py <outDir> <name> <minutes> [--privacy <file>]

Permissions: macOS → Input Monitoring/Accessibility + Screen Recording; Windows
→ no admin needed (input to elevated windows is invisible to a non-elevated
recorder); Linux → an X11 session. On macOS permissions are checked at startup
and written out as a `permissions` field.
"""

import gc
import json
import queue
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from desktop_privacy import Privacy, PrivacyConfigError  # noqa: E402

IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"

SHOT_MIN_INTERVAL = 0.7   # s — minimum gap between two screenshots
SHOT_QUEUE_MAX = 8        # drop new jobs when the worker falls behind
AX_TIMEOUT = 0.25         # s — per AX message, so an unresponsive app cannot hang us
AX_BUDGET = 0.5           # s — total per click; stop collecting attributes past this
AX_ATTRS = ("AXRole", "AXSubrole", "AXTitle", "AXValue", "AXDescription", "AXHelp", "AXIdentifier")
MAX_ANCESTORS = 6
TEXT_IDLE_FLUSH = 2.0     # s — a typing pause closes the current text event
TEXT_MAX = 500            # chars — long dictation is split into several text events
FOCUS_RECHECK = 1.0       # s — re-classify the focused field at least this often while typing
HOOK_STALE_MS = 3000      # Windows: input newer than our last hook event by this much → hooks died
HOOK_REINSTALL_GAP = 10.0  # s — rate limit for hook reinstalls

MODIFIERS = {"shift", "shift_l", "shift_r", "ctrl", "ctrl_l", "ctrl_r", "alt", "alt_l",
             "alt_r", "alt_gr", "cmd", "cmd_l", "cmd_r", "caps_lock"}
CTRL = {"ctrl", "ctrl_l", "ctrl_r"}
ALT = {"alt", "alt_l", "alt_r"}
CMD = {"cmd", "cmd_l", "cmd_r"}
RECHECK_KEYS = {"tab", "enter", "esc"}  # focus usually moves after these

try:
    from ApplicationServices import (AXUIElementCopyAttributeValue,
                                     AXUIElementCopyElementAtPosition,
                                     AXUIElementCreateApplication,
                                     AXUIElementCreateSystemWide,
                                     AXUIElementSetMessagingTimeout)
except ImportError:
    AXUIElementCreateSystemWide = None


def responsible_app() -> str | None:
    """The app that OWNS the permissions. On macOS a TCC grant binds to the .app
    bundle in the process tree, not to the python binary — users routinely grant
    it to the wrong app, so we report the name explicitly."""
    if not IS_MAC:
        return None
    import os
    import re
    import subprocess
    pid = os.getppid()  # our own interpreter lives in Python.app; start above it
    found = None
    for _ in range(12):
        try:
            r = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", str(pid)],
                               capture_output=True, text=True, timeout=2)
        except Exception:
            break
        parts = r.stdout.strip().split(None, 1)
        if len(parts) != 2:
            break
        parent, comm = parts
        m = re.search(r"/([^/]+)\.app/", comm)
        # Framework bundles (Python.app inside Python.framework) never hold the
        # grant. Of the real bundles, TCC follows the OUTERMOST one — a nested
        # helper .app is not what the user sees in System Settings.
        if m and ".framework/" not in comm:
            found = m.group(1)
        if parent in ("0", "1"):
            break
        pid = int(parent)
    return found


def check_permissions() -> dict:
    """Preflights macOS permissions. Returns empty on other platforms."""
    if not IS_MAC:
        return {}
    perms = {}
    try:
        from ApplicationServices import AXIsProcessTrusted
        perms["inputMonitoring"] = bool(AXIsProcessTrusted())
    except Exception:
        pass
    try:
        from Quartz import CGPreflightScreenCaptureAccess
        perms["screenRecording"] = bool(CGPreflightScreenCaptureAccess())
    except Exception:
        pass
    if False in perms.values():
        app = responsible_app()
        if app:
            perms["grantTo"] = app
    return perms


# --- macOS accessibility ------------------------------------------------------

def ax_attr(element, name):
    try:
        err, value = AXUIElementCopyAttributeValue(element, name, None)
    except Exception:
        return None
    return value if err == 0 else None


def ax_text(element, name):
    value = ax_attr(element, name)
    if value is None:
        return None
    text = str(value).strip().replace("\n", " ")
    return text[:120] or None


def ax_window_title(pid: int) -> str | None:
    """Focused window title of the given app (far more distinctive than its name).

    The system-wide element does not answer AXFocusedApplication, so the element
    is built from the frontmost process id instead."""
    if AXUIElementCreateSystemWide is None or not pid:
        return None
    try:
        app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, AX_TIMEOUT)
    except Exception:
        return None
    window = ax_attr(app, "AXFocusedWindow")
    title = ax_attr(window, "AXTitle") if window is not None else None
    if title is None:
        return None
    return str(title).strip() or None


def mac_frontmost():
    try:
        from AppKit import NSWorkspace
    except ImportError:
        return None
    return NSWorkspace.sharedWorkspace().frontmostApplication()


class AXInspector:
    """macOS counterpart of desktop_win.UIAInspector (same target shape)."""

    def __init__(self):
        self.root = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(self.root, AX_TIMEOUT)

    def target_at(self, x, y) -> dict | None:
        try:
            err, el = AXUIElementCopyElementAtPosition(self.root, float(x), float(y), None)
        except Exception:
            return None
        if err != 0 or el is None:
            return None
        deadline = time.monotonic() + AX_BUDGET
        raw = {}
        for attr in AX_ATTRS:
            text = ax_text(el, attr)
            if text:
                raw[attr[2:].lower()] = text
            # AXRole alone already identifies the target; the rest is nice to have.
            if time.monotonic() > deadline:
                break
        if not raw:
            return None
        role = raw.get("role", "")
        target = {"role": role[2:] if role.startswith("AX") else role, "platformRole": role,
                  "name": raw.get("title") or raw.get("description"),
                  "description": raw.get("description"), "help": raw.get("help"),
                  "automationId": raw.get("identifier")}
        if raw.get("subrole") == "AXSecureTextField":
            target["isPassword"] = True  # never keep the value of a secure field
        else:
            target["value"] = raw.get("value")
        ancestors = []
        node = el
        for _ in range(MAX_ANCESTORS):
            if time.monotonic() > deadline:
                break
            node = ax_attr(node, "AXParent")
            if node is None:
                break
            prole = ax_text(node, "AXRole") or ""
            pname = ax_text(node, "AXTitle") or ax_text(node, "AXDescription")
            if prole == "AXWindow":
                target["window"] = pname
                break
            if pname:
                ancestors.append({"role": prole[2:] if prole.startswith("AX") else prole, "name": pname})
        if ancestors:
            target["ancestors"] = ancestors
        return {k: v for k, v in target.items() if v not in (None, "", [])}

    def focus(self) -> dict:
        app = mac_frontmost()
        if app is None:
            return {"secure": False}
        el = AXUIElementCreateApplication(app.processIdentifier())
        AXUIElementSetMessagingTimeout(el, AX_TIMEOUT)
        focused = ax_attr(el, "AXFocusedUIElement")
        if focused is None:
            return {"secure": False}
        subrole = ax_text(focused, "AXSubrole")
        return {"secure": subrole == "AXSecureTextField", "role": ax_text(focused, "AXRole")}

    def close(self):
        pass


def mac_secure_input_enabled() -> bool | None:
    """Secure Event Input (password fields, some terminals) blinds every event
    tap system-wide: keystrokes simply never arrive (Apple TN2150)."""
    try:
        import ctypes
        carbon = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/Carbon.framework/Carbon")
        carbon.IsSecureEventInputEnabled.restype = ctypes.c_bool
        return bool(carbon.IsSecureEventInputEnabled())
    except Exception:
        return None


# --- platform layer -----------------------------------------------------------

class Platform:
    """Foreground window + per-thread inspector factory. `targets`/`masking`
    describe what this platform can do; they go into the `started` event."""
    targets = "none"
    masking = "none"
    dpi = None

    def foreground(self) -> dict | None:
        return None

    def make_inspector(self):
        return None

    def secure_input(self) -> bool | None:
        return None

    def hook_filter_kwargs(self, on_event) -> dict:
        return {}

    def hooks_stale(self, last_hook_tick) -> bool:
        return False


class WinPlatform(Platform):
    def __init__(self):
        import importlib.util
        import desktop_win
        self.win = desktop_win
        self.dpi = desktop_win.set_dpi_awareness()  # before pynput/mss read any coordinate
        has_uia = importlib.util.find_spec("comtypes") is not None
        self.targets = "uia" if has_uia else "none"
        self.masking = "uia+es_password" if has_uia else "es_password"

    def foreground(self):
        return self.win.foreground()

    def make_inspector(self):
        if self.targets == "uia":
            try:
                return self.win.UIAInspector()
            except Exception as e:
                # Surfaced as an `inspector_error` event: a silent fallback hides
                # why every click lacks a target.
                self.inspector_error = f"{type(e).__name__}: {e}"[:300]
        return Win32Inspector(self.win)

    def hook_filter_kwargs(self, on_event):
        def win32_event_filter(msg, data):
            on_event(data.time)  # read-only: returning True keeps the event flowing
            return True
        return {"win32_event_filter": win32_event_filter}

    def hooks_stale(self, last_hook_tick):
        # Unsigned tick difference; a "negative" one (hook newer) wraps above 2^31.
        lag = (self.win.last_input_tick() - last_hook_tick) & 0xFFFFFFFF
        return HOOK_STALE_MS < lag < 2 ** 31


class Win32Inspector:
    """Fallback without comtypes: no targets, ES_PASSWORD-only focus check."""

    def __init__(self, win):
        self.win = win

    def target_at(self, x, y):
        return None

    def focus(self):
        hwnd = self.win.user32.GetForegroundWindow()
        return {"secure": bool(hwnd and self.win.focused_edit_is_password(hwnd))}

    def close(self):
        pass


class MacPlatform(Platform):
    def __init__(self):
        ok = AXUIElementCreateSystemWide is not None
        self.targets = "ax" if ok else "none"
        self.masking = "ax+secure_input" if ok else "secure_input"

    def foreground(self):
        app = mac_frontmost()
        if app is None:
            return None
        name = app.localizedName()
        pid = app.processIdentifier()
        win = ax_window_title(pid)
        title = f"{name} — {win}" if name and win and win != name else (win or name)
        return {"title": title, "pid": pid, "process": name}

    def make_inspector(self):
        if AXUIElementCreateSystemWide is None:
            return None
        try:
            return AXInspector()
        except Exception:
            return None

    def secure_input(self):
        return mac_secure_input_enabled()


class LinuxPlatform(Platform):
    def __init__(self):
        import shutil
        self.xdotool = shutil.which("xdotool")

    def foreground(self):
        if not self.xdotool:
            return None
        import subprocess
        r = subprocess.run([self.xdotool, "getactivewindow", "getwindowname", "getwindowpid"],
                           capture_output=True, text=True, timeout=2)
        lines = r.stdout.strip().splitlines()
        if not lines:
            return None
        info = {"title": lines[0]}
        if len(lines) > 1 and lines[1].isdigit():
            info["pid"] = int(lines[1])
            try:
                info["process"] = Path(f"/proc/{lines[1]}/comm").read_text().strip()
            except OSError:
                pass
        return info


def make_platform() -> Platform:
    if IS_WIN:
        return WinPlatform()
    if IS_MAC:
        return MacPlatform()
    return LinuxPlatform()


def make_inspector(platform: Platform | None = None):
    """Inspector for the calling thread (benchmarks use this too)."""
    return (platform or make_platform()).make_inspector()


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception:
        return None


def main() -> int:
    args = sys.argv[1:]
    privacy_path = None
    if "--privacy" in args:
        i = args.index("--privacy")
        privacy_path = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    out_dir = Path(args[0])
    name = args[1]
    minutes = float(args[2])

    platform = make_platform()  # first: sets DPI awareness on Windows
    try:
        privacy = Privacy.load(privacy_path)
    except PrivacyConfigError as e:
        # The driver reports the log tail on start_failed; make it self-explanatory.
        print("ERROR " + json.dumps({"error": "privacy_config", "message": str(e)}), flush=True)
        return 3

    out_dir.mkdir(parents=True, exist_ok=True)
    screens_dir = out_dir / "screens"
    screens_dir.mkdir(exist_ok=True)
    stop_file = out_dir / "STOP"
    events_path = out_dir / "desktop-events.jsonl"

    t0 = time.time()
    lock = threading.Lock()
    fh = open(events_path, "a", encoding="utf-8")
    seq = 0
    out_q: queue.SimpleQueue = queue.SimpleQueue()

    def emit(evt: dict, t: float | None = None) -> int:
        """Queues the event for the writer and returns its sequence number (the
        capture worker joins targets to clicks with it). Cheap enough for a
        hook callback: a counter and a queue put."""
        nonlocal seq
        with lock:
            seq += 1
            n = seq
            out_q.put((n, round(((t or time.time()) - t0) * 1000), evt))
        return n

    def writer() -> None:
        while True:
            item = out_q.get()
            if item is None:
                break
            n, t, evt = item
            fh.write(json.dumps({"seq": n, "t": t, **evt}, ensure_ascii=False) + "\n")
            if out_q.empty():
                fh.flush()  # keeps `status` counts live without a flush per event
        fh.flush()

    writer_thread = threading.Thread(target=writer, daemon=True)
    writer_thread.start()

    def redact_target(target: dict) -> dict:
        hits = 0
        for key in ("name", "value", "description", "window"):
            if target.get(key):
                target[key], n = privacy.redact(target[key])
                hits += n
        if hits:
            target["redacted"] = hits
        return target

    # --- heavy-work queue: screenshot + target NEVER run on the hook thread ----
    jobs: queue.Queue = queue.Queue(maxsize=SHOT_QUEUE_MAX)
    dropped = [0]

    def report_inspector(worker_name: str) -> None:
        error = getattr(platform, "inspector_error", None)
        if error:
            emit({"kind": "session", "type": "inspector_error", "worker": worker_name, "message": error})

    def capture_worker() -> None:
        sct = None
        inspector = safe(platform.make_inspector)
        report_inspector("capture")
        # Without the screenshot dependencies we still collect target info.
        try:
            try:
                from mss import MSS as mss_factory
            except ImportError:
                from mss import mss as mss_factory
            from PIL import Image
        except Exception as e:
            mss_factory = Image = None
            emit({"kind": "session", "type": "screenshot_unavailable", "message": str(e)[:200]})

        if inspector is not None and IS_WIN:
            # Chromium/Electron switch their web accessibility tree on at the first
            # UIA query; do it now so the first recorded click is not coarse.
            safe(lambda: inspector.target_at(*_cursor_pos()))

        def monitor_for(x, y):
            for mon in sct.monitors[1:]:
                if (mon["left"] <= x < mon["left"] + mon["width"]
                        and mon["top"] <= y < mon["top"] + mon["height"]):
                    return mon
            return sct.monitors[1]

        def handle(job):
            nonlocal sct
            info = {"kind": "target", "forSeq": job["seq"]}
            if privacy.excluded(safe(platform.foreground)):
                # No pixels and no element text from an excluded window.
                emit({**info, "excluded": True})
                return
            if inspector is not None:
                try:
                    target = inspector.target_at(job["x"], job["y"])
                except Exception as e:
                    info["targetError"] = getattr(e, "code", None) or str(e)[:80]
                else:
                    if target:
                        info.update(redact_target(target))
            if job["shot"] and mss_factory is not None:
                try:
                    if sct is None:
                        sct = mss_factory()
                    raw = sct.grab(monitor_for(job["x"], job["y"]))
                    img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX").reduce(2)
                    # Saving to a path (not BytesIO) lets Pillow release the GIL while encoding.
                    img.save(screens_dir / job["shot"], "JPEG", quality=60)
                    info["screenshot"] = job["shot"]
                except Exception as e:
                    info["screenshotError"] = str(e)[:200]
            if len(info) > 2:
                emit(info)

        while True:
            job = jobs.get()
            if job is None:
                break
            try:
                handle(job)
            except Exception as e:
                # A dying worker would silently stop annotating every later click.
                emit({"kind": "session", "type": "capture_error", "message": str(e)[:200]})
        if inspector is not None:
            safe(inspector.close)

    worker = threading.Thread(target=capture_worker, daemon=True)
    worker.start()

    # --- typing worker: focus classification + coalesced text -----------------
    key_q: queue.SimpleQueue = queue.SimpleQueue()

    def typing_worker() -> None:
        inspector = safe(platform.make_inspector)
        report_inspector("typing")
        buf: list = []
        masked_chars = 0
        start_t = None
        mode = {"sensitive": False}
        last_check = 0.0
        need_check = True
        held: set = set()

        def classify() -> dict:
            fg = safe(platform.foreground)
            if privacy.excluded(fg):
                return {"sensitive": True, "reason": "excluded"}
            if inspector is None:
                return {"sensitive": False}
            try:
                focus = inspector.focus()
            except Exception as e:
                # Fail closed: an unverifiable field is treated as a password field.
                code = getattr(e, "code", "")
                return {"sensitive": True, "reason": "timeout" if code == "0x80131505" else "unverified"}
            if focus.get("secure"):
                return {"sensitive": True, "reason": "password"}
            return {"sensitive": False}

        def flush():
            nonlocal buf, masked_chars, start_t
            if mode.get("sensitive") and masked_chars:
                if mode.get("reason") != "excluded":
                    emit({"kind": "input", "type": "text", "masked": True,
                          "reason": mode.get("reason")}, start_t)
            elif buf:
                text, hits = privacy.redact("".join(buf))
                emit({"kind": "input", "type": "text", "text": text,
                      **({"redacted": hits} if hits else {})}, start_t)
            buf, masked_chars, start_t = [], 0, None

        def press(key: str, t: float):
            if mode.get("reason") != "excluded":
                emit({"kind": "input", "type": "press", "key": key}, t)

        while True:
            try:
                item = key_q.get(timeout=TEXT_IDLE_FLUSH)
            except queue.Empty:
                flush()
                continue
            if item is None:
                flush()
                break
            kind, t, ch, kname = item
            if kind == "recheck":  # click or window change: focus probably moved
                flush()
                need_check = True
                continue
            if kind == "release":
                held.discard(kname)
                continue
            if kname in MODIFIERS:
                held.add(kname)
                continue
            if kname == "space":
                ch = " "
            if need_check or time.time() - last_check > FOCUS_RECHECK:
                new = classify()
                if (new.get("sensitive"), new.get("reason")) != (mode.get("sensitive"), mode.get("reason")):
                    flush()
                mode, last_check, need_check = new, time.time(), False

            combo = None
            mods = sorted({m.split("_")[0] for m in held if m in CTRL | ALT | CMD})
            if ch and ord(ch) < 32:
                # Windows reports Ctrl+C as '\x03'; map back to the letter.
                letter = chr(ord(ch) + 96) if 1 <= ord(ch) <= 26 else f"0x{ord(ch):02x}"
                combo = "+".join((mods or ["ctrl"]) + [letter])
            elif ch and mods and "alt_gr" not in held and ch.isascii() and ch.isalnum():
                # AltGr arrives as Ctrl+AltGr on Windows: that is text (@, €), not a shortcut.
                combo = "+".join(mods + [ch.lower()])
            if combo:
                flush()
                press(combo, t)
                continue
            if ch:
                if start_t is None:
                    start_t = t
                if mode.get("sensitive"):
                    masked_chars += 1  # count only; the characters never leave this thread
                else:
                    buf.append(ch)
                    if len(buf) >= TEXT_MAX:
                        flush()
                continue
            if not kname:
                continue
            if kname == "backspace" and buf and not mode.get("sensitive") and not mods:
                buf.pop()  # in-place correction: the text event carries the final value
                continue
            flush()
            press("+".join(mods + [kname]), t)  # alt+tab, ctrl+backspace, shift+enter…
            if kname in RECHECK_KEYS:
                need_check = True
        if inspector is not None:
            safe(inspector.close)

    typing_thread = threading.Thread(target=typing_worker, daemon=True)
    typing_thread.start()

    # --- window poller (1 s): titles, blind-spot markers, hook watchdog --------
    finishing = threading.Event()
    hook_tick = [0]
    last_reinstall = [time.time()]

    def window_poller() -> None:
        last_title = None
        last_elevated = False
        last_secure = None
        if isinstance(platform, LinuxPlatform) and not platform.xdotool:
            emit({"kind": "session", "type": "window_tracking_unavailable",
                  "hint": "install xdotool for window titles on Linux"})
        while not finishing.is_set():
            fg = safe(platform.foreground)
            if fg and fg.get("title"):
                excluded = privacy.excluded(fg)
                title = "[excluded window]" if excluded else fg["title"][:200]
                if title != last_title:
                    last_title = title
                    emit({"kind": "window", "title": title,
                          **({"excluded": True} if excluded
                             else ({"app": fg["process"]} if fg.get("process") else {}))})
                    key_q.put(("recheck", time.time(), None, None))
                elevated = bool(fg.get("elevated"))
                if elevated != last_elevated:
                    last_elevated = elevated
                    # A non-elevated hook sees no input aimed at an elevated window.
                    emit({"kind": "session", "type": "blind" if elevated else "blind_end",
                          "reason": "elevated_window"})
            secure = safe(platform.secure_input)
            if secure is not None and secure != last_secure:
                if secure or last_secure is not None:
                    emit({"kind": "session", "type": "secure_input", "on": secure})
                last_secure = secure
            if (hook_tick[0] and not last_elevated
                    and time.time() - last_reinstall[0] > HOOK_REINSTALL_GAP
                    and safe(platform.hooks_stale, hook_tick[0])):
                last_reinstall[0] = time.time()
                reinstall_listeners()
            finishing.wait(1.0)

    # --- input listeners (pynput; threads — NO multiprocessing) ---------------
    from pynput import keyboard, mouse

    last_shot = [0.0]

    def on_hook_event(tick):
        hook_tick[0] = tick

    def on_click(x, y, button, pressed):
        # Runs inside the hook (Windows) / on the event tap thread (macOS): only enqueue.
        if not pressed:
            return
        now = time.time()
        want_shot = now - last_shot[0] >= SHOT_MIN_INTERVAL
        if want_shot:
            last_shot[0] = now
        n = emit({"kind": "input", "type": "click", "x": int(x), "y": int(y),
                  "button": str(button).replace("Button.", "")}, now)
        key_q.put(("recheck", now, None, None))
        try:
            jobs.put_nowait({"seq": n, "x": int(x), "y": int(y),
                             "shot": f"click-{round(now * 1000)}.jpg" if want_shot else None})
        except queue.Full:
            dropped[0] += 1

    scroll_last = [0.0]

    def on_scroll(x, y, dx, dy):
        now = time.time()
        if now - scroll_last[0] < 1.0:
            return
        scroll_last[0] = now
        emit({"kind": "input", "type": "scroll", "x": int(x), "y": int(y)}, now)

    def on_press(key):
        try:
            ch = key.char
        except AttributeError:
            ch = None
        key_q.put(("press", time.time(), ch, getattr(key, "name", None)))

    def on_release(key):
        kname = getattr(key, "name", None)
        if kname in MODIFIERS:
            key_q.put(("release", time.time(), None, kname))

    listeners: list = []
    listeners_lock = threading.Lock()

    def start_listeners() -> list:
        extra = platform.hook_filter_kwargs(on_hook_event)
        mouse_l = mouse.Listener(on_click=on_click, on_scroll=on_scroll, **extra)
        kb_l = keyboard.Listener(on_press=on_press, on_release=on_release, **extra)
        mouse_l.start()
        kb_l.start()
        # wait(): block until the hook is actually installed — no blind window before READY.
        mouse_l.wait()
        kb_l.wait()
        return [mouse_l, kb_l]

    def reinstall_listeners() -> None:
        """Windows removes a low-level hook that times out repeatedly, without
        telling anyone. Recreating the listeners is cheap; losing the rest of
        the recording is not."""
        with listeners_lock:
            if finishing.is_set():
                return
            for listener in listeners:
                safe(listener.stop)
            listeners[:] = start_listeners()
        emit({"kind": "session", "type": "hook_reinstalled"})

    perms = check_permissions()
    listeners[:] = start_listeners()
    threading.Thread(target=window_poller, daemon=True).start()

    emit({"kind": "session", "type": "started", "name": name,
          "platform": sys.platform, "timeLimitMinutes": minutes,
          "targets": platform.targets, "masking": platform.masking,
          "privacy": privacy.summary(),
          **({"dpiAwareness": platform.dpi} if platform.dpi else {}),
          **({"permissions": perms} if perms else {})})
    # Everything allocated so far lives for the whole session; keep the cyclic GC
    # from rescanning it while a hook callback waits for the GIL.
    gc.freeze()
    # The driver waits for this line; permission state travels machine-readable here.
    print("READY " + json.dumps(perms), flush=True)

    deadline = t0 + minutes * 60
    reason = "time_limit"
    while time.time() < deadline:
        if stop_file.exists():
            reason = "stop_file"
            break
        time.sleep(0.25)

    finishing.set()
    with listeners_lock:
        for listener in listeners:
            safe(listener.stop)
    key_q.put(None)
    typing_thread.join(timeout=5)
    # Let the last queued screenshot/target jobs reach disk (bounded wait). A
    # blocking put would hang forever here if the worker had already died with a
    # full queue.
    try:
        jobs.put(None, timeout=5)
    except queue.Full:
        pass
    worker.join(timeout=10)
    emit({"kind": "session", "type": "stopping", "reason": reason,
          **({"droppedCaptures": dropped[0]} if dropped[0] else {})})
    out_q.put(None)
    writer_thread.join(timeout=10)
    fh.close()
    print("DONE", flush=True)
    return 0


def _cursor_pos():
    import ctypes
    from ctypes import wintypes
    pt = wintypes.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


if __name__ == "__main__":
    sys.exit(main())
