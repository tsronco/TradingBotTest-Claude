"""Safe, idempotent .env read/merge/write.

Rules that matter for not destroying a user's secrets:
- An update to an existing ``KEY=`` line rewrites only that line, in place.
- Keys not in the update set are left byte-for-byte untouched.
- Comments and blank lines are preserved.
- Empty/None update values are skipped (never blanks out an existing key).
- New keys are appended under a generated header.
"""
from __future__ import annotations

import re
from pathlib import Path

_LINE_RE = re.compile(r"^(?:export\s+)?(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?P<val>.*)$")


def parse(text: str) -> dict[str, str]:
    """Return {KEY: value} for simple KEY=VALUE lines (comments ignored)."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _LINE_RE.match(line)
        if m:
            out[m.group("key")] = m.group("val").strip()
    return out


def read_values(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    return parse(path.read_text())


def merge(existing: str, updates: dict[str, str]) -> str:
    """Apply ``updates`` onto ``existing`` .env text and return the new text."""
    clean = {k: v for k, v in updates.items() if v not in (None, "")}
    lines = existing.splitlines()
    seen: set[str] = set()

    for i, raw in enumerate(lines):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = _LINE_RE.match(stripped)
        if not m:
            continue
        key = m.group("key")
        if key in clean:
            lines[i] = f"{key}={clean[key]}"
            seen.add(key)

    appended = [k for k in clean if k not in seen]
    if appended:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("# === Added by setup.py ===")
        for k in appended:
            lines.append(f"{k}={clean[k]}")

    text = "\n".join(lines)
    if not text.endswith("\n"):
        text += "\n"
    return text


def write_merged(path: Path, updates: dict[str, str]) -> dict[str, str]:
    """Merge ``updates`` into the .env at ``path`` (created if missing).

    Returns the dict of keys actually written (post-filter).
    """
    existing = path.read_text() if path.exists() else ""
    written = {k: v for k, v in updates.items() if v not in (None, "")}
    path.write_text(merge(existing, written))
    return written


def mask(value: str) -> str:
    """Render a secret for on-screen confirmation without exposing it."""
    if not value:
        return "(empty)"
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}…{value[-4:]} ({len(value)} chars)"
