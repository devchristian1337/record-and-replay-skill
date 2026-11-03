#!/usr/bin/env python
"""record-and-replay — check and request macOS recording permissions.

Without permission, desktop capture silently records 0 events and the user
concludes "it does not work". So on a missing permission we pop the native
system dialog ourselves and then open the exact System Settings pane.

Usage:
    desktop-permissions.py            # status only (JSON)
    desktop-permissions.py --request  # if missing, open the dialog + the pane

A TCC grant binds to the .app bundle in the process tree, not to the python
binary — the dialog therefore carries the name of the app hosting the agent,
and THAT app must be restarted after the grant.
"""

import json
import subprocess
import sys

# Panes the user must open directly (the dialog is shown only once; on a second
# attempt the system denies silently and the pane is the only way through).
PANES = {
    "inputMonitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
    "accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "screenRecording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
}


def status() -> dict:
    out = {}
    try:
        from ApplicationServices import AXIsProcessTrusted
        out["inputMonitoring"] = bool(AXIsProcessTrusted())
    except Exception as e:
        out["inputMonitoringError"] = str(e)[:120]
    try:
        from Quartz import CGPreflightScreenCaptureAccess
        out["screenRecording"] = bool(CGPreflightScreenCaptureAccess())
    except Exception as e:
        out["screenRecordingError"] = str(e)[:120]
    return out


def request(current: dict) -> list:
    """Triggers the system dialog for missing permissions; returns what was opened."""
    opened = []
    if current.get("inputMonitoring") is False:
        try:
            from ApplicationServices import AXIsProcessTrustedWithOptions
            from ApplicationServices import kAXTrustedCheckOptionPrompt
            AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: True})
            opened.append("accessibility-prompt")
        except Exception:
            pass
        for key in ("accessibility", "inputMonitoring"):
            if open_pane(PANES[key]):
                opened.append(key)
    if current.get("screenRecording") is False:
        try:
            from Quartz import CGRequestScreenCaptureAccess
            CGRequestScreenCaptureAccess()
            opened.append("screen-recording-prompt")
        except Exception:
            pass
        if open_pane(PANES["screenRecording"]):
            opened.append("screenRecording")
    return opened


def open_pane(url: str) -> bool:
    try:
        return subprocess.run(["open", url], capture_output=True, timeout=5).returncode == 0
    except Exception:
        return False


def main() -> int:
    if sys.platform != "darwin":
        print(json.dumps({"platform": sys.platform, "note": "permission preflight is only needed on macOS"}))
        return 0
    current = status()
    result = dict(current)
    if "--request" in sys.argv and False in current.values():
        result["prompted"] = request(current)
        # The state does not change within this process after the dialog/pane
        # opens: TCC only refreshes once the app restarts.
        result["restartRequired"] = True
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
