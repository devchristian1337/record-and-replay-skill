#!/usr/bin/env python
"""record-and-replay — desktop capture cost.

What it measures:
  1. Screenshot path duration (including the cold first call) — doing this inside
     a pynput callback can get the macOS event tap silently disabled on timeout.
  2. Semantic target query duration (macOS AX / Windows UI Automation) — the
     description of the click target — and the focused-field check used for
     password masking.
  3. The monitor layout the recorder sees — needed to grab the right screen.
  4. How long pynput takes to go live — anything the user does before that is lost
     if the driver does not wait for READY.
  5. Permission state (macOS) — without it the recording yields 0 events.

Usage: .venv-desktop/bin/python bench/desktop-capture.py
"""

import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

IS_MAC = sys.platform == "darwin"
TMP = Path(tempfile.gettempdir()) / "rr-bench-shot.jpg"


def row(name, value, note=""):
    print(f"  {name:<40} {value:>12}  {note}")


def bench_screenshot():
    try:
        try:
            from mss import MSS as factory
        except ImportError:
            from mss import mss as factory
        from PIL import Image
    except ImportError as e:
        row("screenshot", "skipped", f"{e}")
        return

    sct = factory()
    mons = sct.monitors
    row("mss monitor count", len(mons) - 1, "; ".join(
        f"{m['width']}x{m['height']}@{m['left']},{m['top']}" for m in mons[1:]))

    def shot(mon):
        t = time.perf_counter()
        raw = sct.grab(mon)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
        img = img.resize((img.width // 2, img.height // 2), Image.BILINEAR)
        img.save(TMP, "JPEG", quality=60)
        return (time.perf_counter() - t) * 1000

    first = shot(mons[1])
    rest = [shot(mons[1]) for _ in range(6)]
    row("screenshot first call", f"{first:.0f} ms", "COLD — must not run in a callback")
    row("screenshot median", f"{statistics.median(rest):.0f} ms",
        f"{TMP.stat().st_size // 1024} KB / frame")


def bench_targets():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "rr_lite", Path(__file__).resolve().parent.parent / "scripts" / "desktop-lite-recorder.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    result = {}

    def run():  # inspectors are per-thread (COM apartment on Windows), like the recorder's workers
        t = time.perf_counter()
        insp = mod.make_inspector()
        result["init"] = (time.perf_counter() - t) * 1000
        if insp is None:
            return
        times, sample = [], None
        for pos in [(400, 400), (900, 600), (200, 200), (700, 300)]:
            t = time.perf_counter()
            try:
                d = insp.target_at(*pos)
            except Exception as e:
                d = {"error": getattr(e, "code", str(e))}
            times.append((time.perf_counter() - t) * 1000)
            sample = sample or d
        focus = []
        for _ in range(5):
            t = time.perf_counter()
            try:
                insp.focus()
            except Exception:
                pass
            focus.append((time.perf_counter() - t) * 1000)
        result.update(times=times, sample=sample, focus=focus)
        insp.close()

    th = threading.Thread(target=run)
    th.start()
    th.join()
    if "times" not in result:
        row("semantic target", "n/a", "no inspector on this platform/setup")
        return
    row("inspector init", f"{result['init']:.1f} ms", "once per worker thread")
    row("target first call", f"{result['times'][0]:.1f} ms", "COLD")
    row("target median", f"{statistics.median(result['times'][1:]):.1f} ms",
        str(result["sample"] or "no permission → empty")[:60])
    row("focus check median", f"{statistics.median(result['focus']):.1f} ms", "per typing burst / 1 s")


def bench_pynput():
    t = time.perf_counter()
    from pynput import mouse
    imported = (time.perf_counter() - t) * 1000
    listener = mouse.Listener(on_click=lambda *a: None)
    t = time.perf_counter()
    listener.start()
    listener.wait()
    live = (time.perf_counter() - t) * 1000
    listener.stop()
    row("pynput import", f"{imported:.0f} ms", "far slower on a cold disk (~9 s measured)")
    row("listener start+wait", f"{live:.0f} ms", "READY must be printed after this")


def bench_permissions():
    if not IS_MAC:
        row("permissions", "n/a", "macOS only")
        return
    try:
        from ApplicationServices import AXIsProcessTrusted
        from Quartz import CGPreflightScreenCaptureAccess
    except ImportError as e:
        row("permissions", "unreadable", str(e))
        return
    row("Input Monitoring / Accessibility", str(bool(AXIsProcessTrusted())), "False → 0 events")
    row("Screen Recording", str(bool(CGPreflightScreenCaptureAccess())), "False → blank screenshot")


print("desktop recorder — capture cost\n")
bench_permissions()
bench_pynput()
bench_screenshot()
bench_targets()
print("\nnote: the screenshot and target queries run on worker threads; the durations")
print("above block the worker, NOT the pynput callback.")
