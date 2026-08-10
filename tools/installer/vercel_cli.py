"""Thin wrappers around the ``vercel`` CLI for the dashboard deploy leg.

The Vercel CLI is interactive and quirky, so each call is a narrow,
best-effort subprocess. Anything that fails returns ``(False, message)`` so
the wizard can fall back to printing manual steps rather than aborting.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

_URL_RE = re.compile(r"https://[a-z0-9-]+\.vercel\.app")


def _run(args: list[str], cwd: Path, stdin: str | None = None, timeout: int = 300):
    return subprocess.run(
        args, cwd=cwd, input=stdin, capture_output=True, text=True, timeout=timeout
    )


def available() -> bool:
    try:
        p = _run(["npx", "--yes", "vercel", "--version"], cwd=Path.cwd(), timeout=60)
        return p.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def link(dashboard_dir: Path, project_name: str) -> tuple[bool, str]:
    try:
        p = _run(
            ["npx", "--yes", "vercel", "link", "--yes", "--project", project_name],
            cwd=dashboard_dir,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return (p.returncode == 0), (p.stdout + p.stderr).strip()[-400:]


def set_env(dashboard_dir: Path, key: str, value: str,
            environments=("production", "preview", "development")) -> tuple[bool, str]:
    """Replace ``key`` in each target environment (rm then add)."""
    msgs: list[str] = []
    for env in environments:
        try:
            _run(["npx", "--yes", "vercel", "env", "rm", key, env, "--yes"],
                 cwd=dashboard_dir, timeout=60)
            p = _run(["npx", "--yes", "vercel", "env", "add", key, env],
                     cwd=dashboard_dir, stdin=value + "\n", timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, f"{key}: {e}"
        if p.returncode != 0 and "already exists" not in (p.stdout + p.stderr):
            return False, f"{key}/{env}: {(p.stdout + p.stderr).strip()[-200:]}"
        msgs.append(env)
    return True, f"{key} -> {', '.join(msgs)}"


def deploy(dashboard_dir: Path) -> tuple[bool, str]:
    try:
        p = _run(["npx", "--yes", "vercel", "--prod", "--yes"], cwd=dashboard_dir, timeout=600)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    out = p.stdout + p.stderr
    if p.returncode != 0:
        return False, out.strip()[-400:]
    m = _URL_RE.search(out)
    return True, (m.group(0) if m else out.strip()[-200:])
