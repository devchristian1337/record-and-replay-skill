"""record-and-replay — Windows helpers for the desktop recorder.

Two layers:
  - plain user32/kernel32 calls (ctypes): DPI awareness, foreground window and
    process, elevation, last-input tick, and the classic Edit ES_PASSWORD check;
  - a UI Automation client (comtypes on UIAutomationCore.dll) that describes the
    element under a point and the focused element — the Windows counterpart of
    the macOS AX target.

Threading rules (Microsoft "UI Automation Threading Issues"): a UIA client runs
on a thread that owns no windows, in the MTA. Each recorder worker builds its
own UIAInspector inside its own thread; nothing here is called from a pynput
callback (a slow low-level hook callback gets the hook silently removed).
"""

import ctypes
import sys
import threading
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetClassNameW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
user32.GetWindowLongW.argtypes = (wintypes.HWND, ctypes.c_int)
user32.GetWindowLongW.restype = ctypes.c_long
kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = (
    wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
advapi32.OpenProcessToken.argtypes = (wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE))
advapi32.GetTokenInformation.argtypes = (
    wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD))

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TOKEN_ELEVATION = 20
GWL_STYLE = -16
ES_PASSWORD = 0x0020
ERROR_ACCESS_DENIED = 5


class GUITHREADINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("hwndActive", wintypes.HWND), ("hwndFocus", wintypes.HWND),
                ("hwndCapture", wintypes.HWND), ("hwndMenuOwner", wintypes.HWND),
                ("hwndMoveSize", wintypes.HWND), ("hwndCaret", wintypes.HWND),
                ("rcCaret", wintypes.RECT)]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


user32.GetGUIThreadInfo.argtypes = (wintypes.DWORD, ctypes.POINTER(GUITHREADINFO))
user32.GetLastInputInfo.argtypes = (ctypes.POINTER(LASTINPUTINFO),)


def set_dpi_awareness() -> str:
    """Per-monitor V2 awareness, before anything reads coordinates.

    Low-level hook points are always physical pixels; GetCursorPos, mss and UIA
    ElementFromPoint follow the process awareness. Setting it first makes all of
    them agree on multi-monitor setups with different scale factors (mss's own
    SetProcessDpiAwareness(2) call then fails harmlessly)."""
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return "per-monitor-v2"
    except AttributeError:  # Windows < 10 1703
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return "per-monitor"
    except Exception:
        return "unaware"


def window_title(hwnd) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def class_name(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_pid(hwnd) -> int:
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def process_name(pid: int) -> str | None:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return None
        return buf.value.replace("/", "\\").rsplit("\\", 1)[-1]
    finally:
        kernel32.CloseHandle(handle)


def is_elevated(pid: int) -> bool | None:
    """True when the process runs elevated. A non-elevated recorder cannot open
    an elevated process's token — that access denial is itself the answer."""
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return True if ctypes.get_last_error() == ERROR_ACCESS_DENIED else None
    token = wintypes.HANDLE()
    try:
        if not advapi32.OpenProcessToken(handle, TOKEN_QUERY, ctypes.byref(token)):
            return True if ctypes.get_last_error() == ERROR_ACCESS_DENIED else None
        try:
            elevation = wintypes.DWORD(0)
            size = wintypes.DWORD(0)
            if not advapi32.GetTokenInformation(token, TOKEN_ELEVATION, ctypes.byref(elevation),
                                                ctypes.sizeof(elevation), ctypes.byref(size)):
                return None
            return bool(elevation.value)
        finally:
            kernel32.CloseHandle(token)
    finally:
        kernel32.CloseHandle(handle)


SELF_ELEVATED = None


def foreground() -> dict | None:
    """Foreground window: title, owning process, and whether input to it is
    invisible to us (an elevated window, when we are not elevated — UIPI)."""
    global SELF_ELEVATED
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = window_pid(hwnd)
    if SELF_ELEVATED is None:
        SELF_ELEVATED = bool(is_elevated(kernel32.GetCurrentProcessId()))
    info = {"hwnd": int(hwnd), "title": window_title(hwnd), "pid": pid,
            "process": process_name(pid)}
    if not SELF_ELEVATED and pid and is_elevated(pid):
        info["elevated"] = True
    return info


def focused_edit_is_password(hwnd_foreground) -> bool:
    """Classic Win32 Edit/RichEdit with ES_PASSWORD has keyboard focus.

    Cheap and UIA-free. The class check matters: 0x20 means something else for
    other window classes (BS_LEFTTEXT on buttons, for instance)."""
    tid = user32.GetWindowThreadProcessId(hwnd_foreground, None)
    info = GUITHREADINFO(cbSize=ctypes.sizeof(GUITHREADINFO))
    if not tid or not user32.GetGUIThreadInfo(tid, ctypes.byref(info)) or not info.hwndFocus:
        return False
    if "edit" not in class_name(info.hwndFocus).lower():
        return False
    return bool(user32.GetWindowLongW(info.hwndFocus, GWL_STYLE) & ES_PASSWORD)


def last_input_tick() -> int:
    """GetTickCount-based time of the last input event system-wide (any source)."""
    info = LASTINPUTINFO(cbSize=ctypes.sizeof(LASTINPUTINFO))
    user32.GetLastInputInfo(ctypes.byref(info))
    return info.dwTime


def tick_now() -> int:
    return kernel32.GetTickCount() & 0xFFFFFFFF


# --- UI Automation ------------------------------------------------------------

UIA_TIMEOUT_MS = 250       # per cross-process call (defaults: 2 s connect, 20 s transaction)
MAX_ANCESTORS = 6          # parent walk: one cross-process call per level
UIA_E_TIMEOUT = 0x80131505

P = {  # UIA property ids (UIAutomationClient.h)
    "BoundingRectangle": 30001, "ProcessId": 30002, "ControlType": 30003,
    "Name": 30005, "AutomationId": 30011, "ClassName": 30012, "IsPassword": 30019,
    "NativeWindowHandle": 30020, "FrameworkId": 30024, "Value": 30045,
    "LegacyState": 30096,
}
STATE_SYSTEM_PROTECTED = 0x20000000
CT_WINDOW = 50032

CONTROL_TYPES = {
    50000: "Button", 50001: "Calendar", 50002: "CheckBox", 50003: "ComboBox",
    50004: "Edit", 50005: "Hyperlink", 50006: "Image", 50007: "ListItem",
    50008: "List", 50009: "Menu", 50010: "MenuBar", 50011: "MenuItem",
    50012: "ProgressBar", 50013: "RadioButton", 50014: "ScrollBar", 50015: "Slider",
    50016: "Spinner", 50017: "StatusBar", 50018: "Tab", 50019: "TabItem",
    50020: "Text", 50021: "ToolBar", 50022: "ToolTip", 50023: "Tree",
    50024: "TreeItem", 50025: "Custom", 50026: "Group", 50027: "Thumb",
    50028: "DataGrid", 50029: "DataItem", 50030: "Document", 50031: "SplitButton",
    50032: "Window", 50033: "Pane", 50034: "Header", 50035: "HeaderItem",
    50036: "Table", 50037: "TitleBar", 50038: "Separator", 50039: "SemanticZoom",
    50040: "AppBar",
}


class InspectorError(Exception):
    """A UIA query failed; `code` is the HRESULT as hex (0x80131505 = timeout)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _clean(value, limit=120):
    if value is None:
        return None
    text = str(value).strip().replace("\n", " ")
    return text[:limit] or None


# Two workers building their clients at the same instant (first comtypes import
# + CoCreateInstance of CUIAutomation8) intermittently failed with E_FAIL;
# construction is serialized and retried.
_INIT_LOCK = threading.Lock()
INIT_ATTEMPTS = 3


class UIAInspector:
    """UIA client bound to the calling thread. Build it inside the worker thread."""

    def __init__(self, timeout_ms: int = UIA_TIMEOUT_MS, ignore_own_process: bool = True):
        with _INIT_LOCK:
            for attempt in range(INIT_ATTEMPTS):
                try:
                    self._init(timeout_ms, ignore_own_process)
                    return
                except Exception:
                    if attempt == INIT_ATTEMPTS - 1:
                        raise
                    time.sleep(0.2 * (attempt + 1))

    def _init(self, timeout_ms: int, ignore_own_process: bool):
        # comtypes initializes COM on the thread that imports it, as STA unless
        # told otherwise; this module is only imported from worker threads.
        sys.coinit_flags = 0  # COINIT_MULTITHREADED
        import comtypes
        import comtypes.client
        comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
        self._comtypes = comtypes
        uia_mod = comtypes.client.GetModule("UIAutomationCore.dll")
        self._point = uia_mod.tagPOINT
        # CUIAutomation8 → IUIAutomation2: the only client exposing timeouts, so a
        # hung target app cannot block the worker for the default 20 s.
        self._uia = comtypes.client.CreateObject(uia_mod.CUIAutomation8,
                                                 interface=uia_mod.IUIAutomation2)
        self._uia.ConnectionTimeout = timeout_ms
        self._uia.TransactionTimeout = timeout_ms
        # One cross-process round trip fetches every property we need.
        self._cache = self._uia.CreateCacheRequest()
        for pid in P.values():
            self._cache.AddProperty(pid)
        self._walker = self._uia.ControlViewWalker
        # The recorder never describes its own windows; the live self-test must.
        self._own_pid = kernel32.GetCurrentProcessId() if ignore_own_process else None

    def _read(self, el) -> dict:
        get = el.GetCachedPropertyValue
        ct = get(P["ControlType"])
        protected = bool(get(P["IsPassword"])) or bool((get(P["LegacyState"]) or 0) & STATE_SYSTEM_PROTECTED)
        out = {"role": CONTROL_TYPES.get(ct, str(ct)), "_ct": ct,
               "name": _clean(get(P["Name"])),
               "automationId": _clean(get(P["AutomationId"])),
               "className": _clean(get(P["ClassName"])),
               "framework": _clean(get(P["FrameworkId"])),
               "pid": get(P["ProcessId"])}
        if protected:
            out["isPassword"] = True  # never read the value of a protected field
        else:
            out["value"] = _clean(get(P["Value"]))
        return out

    def _call(self, fn, *args):
        try:
            return fn(*args)
        except self._comtypes.COMError as e:
            raise InspectorError(hex(e.hresult & 0xFFFFFFFF)) from None
        except OSError as e:  # comtypes surfaces some HRESULTs as WindowsError
            raise InspectorError(hex((e.winerror or 0) & 0xFFFFFFFF)) from None

    def target_at(self, x: int, y: int) -> dict | None:
        el = self._call(self._uia.ElementFromPointBuildCache, self._point(int(x), int(y)), self._cache)
        if not el:
            return None
        target = self._read(el)
        if target["pid"] == self._own_pid:
            return None
        # Chromium builds its web accessibility tree only once a UIA client asks;
        # the very first query lands on the renderer's bare Pane. Ask once more.
        if target["_ct"] == 50033 and not target["name"] and target["framework"] == "Chrome":
            time.sleep(0.15)
            el = self._call(self._uia.ElementFromPointBuildCache, self._point(int(x), int(y)), self._cache) or el
            target = self._read(el)
        ancestors = []
        node = el
        for _ in range(MAX_ANCESTORS):
            node = self._call(self._walker.GetParentElementBuildCache, node, self._cache)
            if not node:
                break
            info = self._read(node)
            if info["className"] == "#32769":  # the desktop root: nothing above it is useful
                break
            if info["_ct"] == CT_WINDOW:
                target["window"] = info["name"]
                break
            # Unnamed panes/groups are layout noise; keep what a replay can search for.
            if info["name"] or info["automationId"]:
                ancestors.append({k: info[k] for k in ("role", "name", "automationId") if info.get(k)})
        if ancestors:
            target["ancestors"] = ancestors
        return _strip(target)

    def focus(self) -> dict:
        """{"secure": bool, "role": …} for the element with keyboard focus."""
        hwnd = user32.GetForegroundWindow()
        if hwnd and focused_edit_is_password(hwnd):
            return {"secure": True, "role": "Edit", "via": "ES_PASSWORD"}
        el = self._call(self._uia.GetFocusedElementBuildCache, self._cache)
        if not el:
            return {"secure": False}
        info = self._read(el)
        return {"secure": bool(info.get("isPassword")), "role": info["role"]}

    def close(self):
        self._walker = self._cache = self._uia = None
        try:
            self._comtypes.CoUninitialize()
        except Exception:
            pass


def _strip(target: dict) -> dict:
    return {k: v for k, v in target.items() if not k.startswith("_") and v not in (None, "", [])}
