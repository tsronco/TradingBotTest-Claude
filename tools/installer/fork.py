"""Auto-fix the two fork gotchas documented in instructions.md.

1. ``tools/setup_cronjobs.py`` has ``REPO = "tsronco/TradingBotTest-Claude"``
   hardcoded — must become the forker's ``OWNER/REPO``.
2. The original dashboard URL ``https://tradingbot-dashboard-blue.vercel.app``
   is baked into every ``.github/workflows/*.yml`` and into two URL lines in
   ``setup_cronjobs.py`` — must become the forker's Vercel URL.

The string transforms are pure (unit-tested); ``apply`` does the file I/O.
"""
from __future__ import annotations

import re
from pathlib import Path

ORIGINAL_REPO = "tsronco/TradingBotTest-Claude"
ORIGINAL_DASHBOARD_URL = "https://tradingbot-dashboard-blue.vercel.app"

_REPO_RE = re.compile(r'^(?P<pre>REPO\s*=\s*)"[^"]*"', re.MULTILINE)
_OWNER_REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$")


def parse_owner_repo(remote_url: str) -> str | None:
    """Extract ``owner/repo`` from any common git remote URL form.

    Handles https, ssh (git@), and proxied-path remotes; trailing ``.git``
    and ``/`` are stripped.
    """
    url = remote_url.strip()
    if not url:
        return None
    url = re.sub(r"\.git/?$", "", url)
    url = url.rstrip("/")
    if url.startswith("git@") and ":" in url:
        url = url.split(":", 1)[1]
        parts = url.split("/")
    else:
        parts = url.split("/")
    if len(parts) < 2:
        return None
    owner, repo = parts[-2], parts[-1]
    if not owner or not repo:
        return None
    candidate = f"{owner}/{repo}"
    return candidate if _OWNER_REPO_RE.match(candidate) else None


def rewrite_repo(text: str, owner_repo: str) -> str:
    """Replace the ``REPO = "..."`` assignment regardless of its old value."""
    return _REPO_RE.sub(lambda m: f'{m.group("pre")}"{owner_repo}"', text, count=1)


def rewrite_dashboard_url(text: str, new_url: str, old_url: str = ORIGINAL_DASHBOARD_URL) -> str:
    """Replace every occurrence of ``old_url`` with ``new_url``."""
    return text.replace(old_url, new_url.rstrip("/"))


def workflow_files(root: Path) -> list[Path]:
    return sorted((root / ".github" / "workflows").glob("*.yml"))


def apply(root: Path, owner_repo: str, dashboard_url: str | None) -> list[str]:
    """Apply both fixes on disk. Returns a list of human-readable changes."""
    changes: list[str] = []
    cron_path = root / "tools" / "setup_cronjobs.py"

    if cron_path.exists():
        original = cron_path.read_text()
        updated = rewrite_repo(original, owner_repo)
        if dashboard_url:
            updated = rewrite_dashboard_url(updated, dashboard_url)
        if updated != original:
            cron_path.write_text(updated)
            changes.append(f"tools/setup_cronjobs.py (REPO -> {owner_repo}"
                            + (", dashboard URL" if dashboard_url else "") + ")")

    if dashboard_url:
        for wf in workflow_files(root):
            original = wf.read_text()
            updated = rewrite_dashboard_url(original, dashboard_url)
            if updated != original:
                wf.write_text(updated)
                changes.append(f".github/workflows/{wf.name} (dashboard URL)")

    return changes
