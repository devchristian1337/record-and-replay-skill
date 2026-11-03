"""record-and-replay — privacy rules for the desktop recorder.

Applied BEFORE anything reaches disk:
  - excluded windows/processes: no keystrokes, no screenshot, no semantic target,
    and the window title itself is replaced;
  - redaction patterns: matches in typed text (and in captured target names /
    values) become ***REDACTED***.

Password fields are masked by the recorder itself, always, whatever this file says.

Config: JSON, by default ~/.agents/recordings/privacy.json (optional):
  {
    "excludeWindows":   ["KeePass", "(?i)online banking"],   # regex, searched in the title
    "excludeProcesses": ["KeePassXC.exe", "1Password"],      # regex, searched in the process name
    "redactPatterns":   ["\\b\\d{6}\\b"],                    # regex, replaced in typed text
    "useDefaultPatterns": true                                # API keys, JWTs, cards, IBANs, private keys
  }
All matching is case-insensitive.
"""

import json
import re
from pathlib import Path

DEFAULT_PATH = Path.home() / ".agents" / "recordings" / "privacy.json"
REDACTED = "***REDACTED***"
MAX_PATTERN_LEN = 500  # a user regex runs on every flushed text block; keep it bounded

# Shape-based secrets — same spirit as the browser recorder's looksLikeSecret().
DEFAULT_PATTERNS = {
    "api_key": r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})",
    "jwt": r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
    "private_key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "iban": r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b",
}
CARD_CANDIDATE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")


class PrivacyConfigError(ValueError):
    pass


def luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def _compile_list(cfg: dict, key: str) -> list:
    raw = cfg.get(key, [])
    if not isinstance(raw, list) or not all(isinstance(p, str) for p in raw):
        raise PrivacyConfigError(f"{key} must be a list of strings")
    out = []
    for pattern in raw:
        if not pattern or len(pattern) > MAX_PATTERN_LEN:
            raise PrivacyConfigError(f"{key}: empty or over-long pattern ({len(pattern)} chars)")
        try:
            out.append(re.compile(pattern, re.IGNORECASE))
        except re.error as e:
            raise PrivacyConfigError(f"{key}: invalid regex {pattern!r}: {e}") from None
    return out


class Privacy:
    def __init__(self, cfg: dict | None = None, source: str | None = None):
        cfg = cfg or {}
        if not isinstance(cfg, dict):
            raise PrivacyConfigError("privacy config must be a JSON object")
        unknown = set(cfg) - {"excludeWindows", "excludeProcesses", "redactPatterns", "useDefaultPatterns"}
        if unknown:
            raise PrivacyConfigError(f"unknown keys: {', '.join(sorted(unknown))}")
        self.source = source
        self.exclude_windows = _compile_list(cfg, "excludeWindows")
        self.exclude_processes = _compile_list(cfg, "excludeProcesses")
        self.use_defaults = cfg.get("useDefaultPatterns", True) is not False
        self.patterns = _compile_list(cfg, "redactPatterns")
        if self.use_defaults:
            self.patterns = [re.compile(p) for p in DEFAULT_PATTERNS.values()] + self.patterns

    @classmethod
    def load(cls, path: str | None = None) -> "Privacy":
        """Explicit path must exist; the default path is optional."""
        target = Path(path).expanduser() if path else DEFAULT_PATH
        if not target.exists():
            if path:
                raise PrivacyConfigError(f"privacy file not found: {target}")
            return cls()
        try:
            cfg = json.loads(target.read_text(encoding="utf-8"))
        except ValueError as e:
            raise PrivacyConfigError(f"{target}: invalid JSON: {e}") from None
        return cls(cfg, str(target))

    def summary(self) -> dict:
        """What the session log may say about the rules — counts only, never the patterns."""
        return {"source": self.source, "excludeWindows": len(self.exclude_windows),
                "excludeProcesses": len(self.exclude_processes),
                "redactPatterns": len(self.patterns), "defaultPatterns": self.use_defaults}

    def excluded(self, window: dict | None) -> bool:
        if not window:
            return False
        title = window.get("title") or ""
        process = window.get("process") or ""
        return (any(p.search(title) for p in self.exclude_windows)
                or any(p.search(process) for p in self.exclude_processes))

    def redact(self, text: str | None) -> tuple:
        """(text with matches replaced, number of replacements)."""
        if not text:
            return text, 0
        count = 0
        for pattern in self.patterns:
            text, n = pattern.subn(REDACTED, text)
            count += n
        if self.use_defaults:
            def card(m):
                nonlocal count
                digits = re.sub(r"\D", "", m.group(0))
                if 13 <= len(digits) <= 19 and luhn_ok(digits):
                    count += 1
                    return REDACTED
                return m.group(0)
            text = CARD_CANDIDATE.sub(card, text)
        return text, count
