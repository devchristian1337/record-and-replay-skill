#!/usr/bin/env python
"""record-and-replay — end-to-end self-test for the desktop engine.

The desktop counterpart of recorder.mjs --self-test. It injects fake listeners in
place of pynput and a fake platform (foreground window, focused-field and
target inspector) so the whole engine runs WITHOUT any permission, verifying
event ordering, the worker queues, screenshot writing, target joining, text
coalescing, password masking (including the fail-closed path), privacy.json
exclusions and redaction, STOP finalization and the summarizer's output.

On Windows it also runs a LIVE UI Automation check against a real Win32 window
it creates (a "Save" button and an ES_PASSWORD edit): the target must come back
semantic and the password field must be flagged without its value. The window
is topmost for about a second; if something still covers it the check is
skipped, not failed.

Usage: .venv-desktop/bin/python scripts/desktop-selftest.py   (Windows: .venv-desktop\\Scripts\\python.exe)
       add --no-live to skip the live Windows check.
Exit code 0 → PASS.
"""

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
LISTENERS = []


class FakeButton:
    def __str__(self):
        return "Button.left"


class FakeListener:
    def __init__(self, **handlers):
        self.handlers = handlers

    def start(self):
        LISTENERS.append(self)

    def wait(self):
        pass

    def stop(self):
        pass


class FakeFocusError(Exception):
    code = "0x80131505"  # UIA_E_TIMEOUT


def install_fake_pynput():
    import types
    mouse = types.ModuleType("pynput.mouse")
    keyboard = types.ModuleType("pynput.keyboard")
    mouse.Listener = FakeListener
    keyboard.Listener = FakeListener
    pynput = types.ModuleType("pynput")
    pynput.mouse = mouse
    pynput.keyboard = keyboard
    sys.modules["pynput"] = pynput
    sys.modules["pynput.mouse"] = mouse
    sys.modules["pynput.keyboard"] = keyboard


def load_recorder():
    spec = importlib.util.spec_from_file_location(
        "rr_lite", HERE / "desktop-lite-recorder.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_fake_platform(base):
    class FakeInspector:
        def __init__(self, state):
            self.state = state

        def target_at(self, x, y):
            if (x, y) == (300, 300):
                return {"role": "Edit", "name": "Password", "isPassword": True}
            return {"role": "Button", "name": "Save", "automationId": "saveBtn",
                    "ancestors": [{"role": "ToolBar", "name": "Standard"}]}

        def focus(self):
            if self.state["focus_error"]:
                raise FakeFocusError()
            return {"secure": self.state["secure"]}

        def close(self):
            pass

    class FakePlatform(base):
        targets = "fake"
        masking = "fake"

        def __init__(self):
            self.state = {"fg": {"title": "Notes — draft", "process": "notes.exe"},
                          "secure": False, "focus_error": False}

        def foreground(self):
            return dict(self.state["fg"])

        def make_inspector(self):
            return FakeInspector(self.state)

    return FakePlatform()


def read_events(path: Path):
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def wait_for(predicate, timeout=20.0, interval=0.1):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(interval)
    return False


class K:
    def __init__(self, char=None, name=None):
        if char is not None:
            self.char = char
        if name is not None:
            self.name = name


def engine_test() -> list:
    install_fake_pynput()
    recorder = load_recorder()
    fake = make_fake_platform(recorder.Platform)
    recorder.make_platform = lambda: fake

    out_dir = Path(tempfile.mkdtemp(prefix="rr-desktop-selftest-"))
    events_path = out_dir / "desktop-events.jsonl"
    privacy_path = out_dir / "privacy.json"
    privacy_path.write_text(json.dumps({
        "excludeWindows": ["KeePass"],
        "redactPatterns": [r"\bORDER-\d{4}\b"],
    }), encoding="utf-8")
    failures = []

    sys.argv = ["desktop-lite-recorder.py", str(out_dir), "selftest", "2",
                "--privacy", str(privacy_path)]
    thread = threading.Thread(target=recorder.main, daemon=True)
    thread.start()

    if not wait_for(lambda: len(LISTENERS) >= 2 and events_path.exists()):
        return ["recorder did not start"], out_dir
    mouse_l = next(l for l in LISTENERS if "on_click" in l.handlers)
    kb_l = next(l for l in LISTENERS if "on_press" in l.handlers)
    click = lambda x, y: mouse_l.handlers["on_click"](x, y, FakeButton(), True)
    press = kb_l.handlers["on_press"]
    release = kb_l.handlers["on_release"]

    def type_text(text):
        for ch in text:
            press(K(name="space") if ch == " " else K(char=ch))

    settle = lambda: time.sleep(0.4)

    # --- 1. plain typing, in-place correction, Enter -----------------------
    click(120, 240)
    mouse_l.handlers["on_click"](120, 240, FakeButton(), False)  # button up → must be ignored
    click(130, 250)  # within 700 ms → no screenshot
    type_text("helx")
    press(K(name="backspace"))
    type_text("lo")
    press(K(name="enter"))
    # --- 2. shortcut: Windows reports Ctrl+C as '\x03' ------------------------
    press(K(name="ctrl_l"))
    press(K(char="\x03"))
    release(K(name="ctrl_l"))
    press(K(name="alt_l"))
    press(K(name="tab"))  # modifiers ride along on special keys too
    release(K(name="alt_l"))
    # --- 3. redaction: default (API key) + privacy.json pattern ---------------
    type_text("key sk-abcdefghijklmnopqrstu ref ORDER-1234")
    press(K(name="enter"))
    settle()
    # --- 4. password field → masked, characters never written ------------------
    time.sleep(0.5)  # past the screenshot rate limit
    fake.state["secure"] = True
    click(300, 300)
    type_text("s3cretPW!")
    press(K(name="enter"))
    settle()
    # --- 5. focus check fails → fail closed ------------------------------------
    fake.state["secure"] = False
    fake.state["focus_error"] = True
    time.sleep(0.4)  # past the screenshot rate limit again
    click(310, 310)
    type_text("maybe-secret")
    press(K(name="tab"))
    settle()
    # --- 6. excluded window: no text, no target, title hidden -----------------
    fake.state["focus_error"] = False
    fake.state["fg"] = {"title": "KeePass — vault.kdbx", "process": "KeePass.exe"}
    time.sleep(1.3)  # let the window poller see the change
    click(500, 400)
    type_text("masterpw")
    press(K(name="enter"))
    settle()
    # --- 7. scroll debounce ----------------------------------------------------
    for _ in range(3):
        mouse_l.handlers["on_scroll"](10, 10, 0, -1)  # 1 s debounce → 1 event

    time.sleep(0.5)
    (out_dir / "STOP").write_text("stop\n")
    if not wait_for(lambda: not thread.is_alive(), timeout=25):
        failures.append("recorder did not exit after STOP")

    raw = events_path.read_text(encoding="utf-8")
    events = read_events(events_path)
    by = lambda k, t=None: [e for e in events
                            if e.get("kind") == k and (t is None or e.get("type") == t)]

    clicks = by("input", "click")
    texts = by("input", "text")
    presses = by("input", "press")
    scrolls = by("input", "scroll")
    targets = by("target")
    stopping = by("session", "stopping")
    started = by("session", "started")

    if len(clicks) != 5:
        failures.append(f"expected 5 clicks, found {len(clicks)} (a mouse-up may have leaked)")
    plain = [t for t in texts if not t.get("masked")]
    if not plain or plain[0].get("text") != "hello":
        failures.append(f"text coalescing/backspace failed: {plain[:1]}")
    if not any(p.get("key") == "ctrl+c" for p in presses):
        failures.append("Ctrl+C shortcut not recognised")
    if not any(p.get("key") == "alt+tab" for p in presses):
        failures.append("Alt+Tab recorded without its modifier")
    redacted = [t for t in plain if t.get("redacted")]
    if not redacted or redacted[0].get("redacted") != 2 or "sk-" in raw or "ORDER-1234" in raw:
        failures.append(f"redaction failed: {redacted[:1]}")
    reasons = [t.get("reason") for t in texts if t.get("masked")]
    if "password" not in reasons:
        failures.append(f"password field not masked (masked reasons: {reasons})")
    if "timeout" not in reasons:
        failures.append(f"focus-check failure did not fail closed (masked reasons: {reasons})")
    for secret in ("s3cretPW", "maybe-secret", "masterpw", "vault.kdbx"):
        if secret in raw:
            failures.append(f"secret {secret!r} reached disk")
    if not any(w.get("excluded") and w.get("title") == "[excluded window]" for w in by("window")):
        failures.append("excluded window title was not replaced")
    if len(scrolls) != 1:
        failures.append(f"scroll debounce failed: {len(scrolls)} events")
    if not stopping or stopping[0].get("reason") != "stop_file":
        failures.append("did not finalize via the STOP file")
    if not started or started[0].get("privacy", {}).get("excludeWindows") != 1:
        failures.append("started event lacks the privacy summary")

    # Every target line must join back to a real click seq.
    click_seqs = {c["seq"] for c in clicks}
    orphan = [t for t in targets if t.get("forSeq") not in click_seqs]
    if orphan:
        failures.append(f"{len(orphan)} target lines join to no click")
    excluded_targets = [t for t in targets if t.get("excluded")]
    if len(excluded_targets) != 1 or "screenshot" in excluded_targets[0]:
        failures.append(f"excluded-window click was annotated: {excluded_targets}")
    pw_target = [t for t in targets if t.get("isPassword")]
    if not pw_target or "value" in pw_target[0]:
        failures.append("password-field target missing or carries a value")

    shots = sorted((out_dir / "screens").glob("*.jpg"))
    shot_events = [t for t in targets if t.get("screenshot")]
    if len(shots) != len(shot_events):
        failures.append(f"{len(shot_events)} screenshot events but {len(shots)} files on disk")
    # Clicks 1 and 2 fall within 700 ms; the excluded click gets no frame → 3 frames for 5 clicks.
    if shots and len(shots) != 3:
        failures.append(f"screenshot rate limit/exclusion failed: {len(shots)} frames (3 expected)")

    # The summarizer must be able to read this recording.
    summary = subprocess.run([sys.executable, str(HERE / "desktop-summarize.py"), str(out_dir)],
                             capture_output=True, text=True, encoding="utf-8")
    if summary.returncode != 0:
        failures.append(f"summarizer failed: {summary.stderr.strip()[:200]}")
    else:
        for needle in ('type → "hello"', "press ctrl+c", "[masked: password field]",
                       "[excluded window]", 'Button "Save" #saveBtn'):
            if needle not in summary.stdout:
                failures.append(f"summary lacks {needle!r}")

    print(f"clicks={len(clicks)} texts={len(texts)} presses={len(presses)} scroll={len(scrolls)} "
          f"targets={len(targets)} screenshots={len(shots)}")
    return failures, out_dir


def live_uia_test() -> tuple:
    """(status, detail): status is PASS, SKIP or FAIL."""
    import ctypes
    from ctypes import wintypes
    try:
        import desktop_win
    except Exception as e:
        return "SKIP", f"desktop_win unavailable: {e}"
    if importlib.util.find_spec("comtypes") is None:
        return "SKIP", "comtypes not installed"
    desktop_win.set_dpi_awareness()
    user32 = desktop_win.user32
    user32.CreateWindowExW.argtypes = (
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID)
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.GetWindowRect.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.RECT))
    user32.WindowFromPoint.argtypes = (wintypes.POINT,)
    user32.WindowFromPoint.restype = wintypes.HWND
    user32.DestroyWindow.argtypes = (wintypes.HWND,)
    user32.PostThreadMessageW.argtypes = (wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

    WS_POPUP, WS_VISIBLE, WS_BORDER, WS_CHILD = 0x80000000, 0x10000000, 0x00800000, 0x40000000
    WS_EX_TOPMOST, WS_EX_TOOLWINDOW, ES_PASSWORD, WM_QUIT = 0x8, 0x80, 0x20, 0x12
    hwnds, ready = {}, threading.Event()

    def ui_thread():
        top = user32.CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, "STATIC", "rr-selftest",
                                     WS_POPUP | WS_VISIBLE | WS_BORDER, 120, 120, 320, 120,
                                     None, None, None, None)
        btn = user32.CreateWindowExW(0, "BUTTON", "Save", WS_CHILD | WS_VISIBLE,
                                     10, 10, 140, 34, top, None, None, None)
        edit = user32.CreateWindowExW(0, "EDIT", "hunter2", WS_CHILD | WS_VISIBLE | WS_BORDER | ES_PASSWORD,
                                      10, 60, 220, 30, top, None, None, None)
        hwnds.update(top=top, btn=btn, edit=edit, tid=desktop_win.kernel32.GetCurrentThreadId())
        ready.set()
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        user32.DestroyWindow(top)

    ui = threading.Thread(target=ui_thread, daemon=True)
    ui.start()
    ready.wait(5)
    if not hwnds.get("top"):
        return "SKIP", "could not create a test window"
    time.sleep(0.3)

    def center(hwnd):
        r = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        return (r.left + r.right) // 2, (r.top + r.bottom) // 2

    result = {}

    def probe():  # the UIA client runs on its own window-less thread, like the recorder's workers
        try:
            insp = desktop_win.UIAInspector(ignore_own_process=False)
            result["btn"] = insp.target_at(*center(hwnds["btn"]))
            result["edit"] = insp.target_at(*center(hwnds["edit"]))
            insp.close()
        except Exception as e:
            result["error"] = repr(e)

    try:
        for key in ("btn", "edit"):
            x, y = center(hwnds[key])
            hit = user32.WindowFromPoint(wintypes.POINT(x, y))
            if hit != hwnds[key]:
                return "SKIP", "test window is covered (another topmost window or locked screen)"
        t = threading.Thread(target=probe, daemon=True)
        t.start()
        t.join(10)
    finally:
        user32.PostThreadMessageW(hwnds["tid"], WM_QUIT, 0, 0)
        ui.join(3)

    if "error" in result:
        return "FAIL", result["error"]
    btn, edit = result.get("btn") or {}, result.get("edit") or {}
    problems = []
    if btn.get("role") != "Button" or btn.get("name") != "Save":
        problems.append(f"button target wrong: {btn}")
    if edit.get("role") != "Edit" or not edit.get("isPassword") or "value" in edit:
        problems.append(f"password edit not flagged (or value leaked): {edit}")
    if "hunter2" in json.dumps(result):
        problems.append("password value leaked")
    if problems:
        return "FAIL", "; ".join(problems)
    return "PASS", f"button={btn} edit={edit}"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # ✗ — on Windows consoles
    live = sys.platform == "win32" and "--no-live" not in sys.argv  # engine_test rewrites sys.argv
    failures, out_dir = engine_test()
    if live:
        status, detail = live_uia_test()
        print(f"live UIA check: {status} — {detail}")
        if status == "FAIL":
            failures.append(f"live UIA: {detail}")

    if failures:
        for f in failures:
            print("  ✗", f)
        print("DESKTOP SELF-TEST FAIL")
        print(f"inspect the recording at: {out_dir}")
        return 1
    print("DESKTOP SELF-TEST PASS")
    shutil.rmtree(out_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
