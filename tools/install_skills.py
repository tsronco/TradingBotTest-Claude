#!/usr/bin/env python3
"""Install this repo's project-level skills to your personal Claude skills dir.

Project-level skills (`.claude/skills/`) are CLI-only. Personal skills
(`~/.claude/skills/`) are read by the CLI, the desktop app, and the web app
at claude.ai/code. So copying our project skills into the personal location
makes them available everywhere — at the cost of them no longer auto-syncing
when you `git pull` (you re-run this script after each change).

Behavior:
  - Copies every directory under <repo>/.claude/skills/<name>/ to
    ~/.claude/skills/<name>/.
  - If the destination already exists, it's overwritten so you always end up
    with the current version from the repo.
  - Cross-platform: works on Windows, macOS, Linux. Path.home() handles the
    OS-specific home directory.

Usage:
    python tools/install_skills.py            # install (copy) all skills
    python tools/install_skills.py --remove   # remove the installed copies
    python tools/install_skills.py --dry-run  # show what would happen
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PROJECT_SKILLS_DIR = REPO_ROOT / ".claude" / "skills"
PERSONAL_SKILLS_DIR = Path.home() / ".claude" / "skills"


def list_project_skills() -> list[Path]:
    if not PROJECT_SKILLS_DIR.exists():
        return []
    return sorted(p for p in PROJECT_SKILLS_DIR.iterdir() if p.is_dir())


def install(dry_run: bool) -> int:
    skills = list_project_skills()
    if not skills:
        print(f"No project skills found at {PROJECT_SKILLS_DIR}")
        return 1

    PERSONAL_SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Installing {len(skills)} skill(s) to {PERSONAL_SKILLS_DIR}")
    if dry_run:
        print("(dry run — no files written)")

    for src in skills:
        dst = PERSONAL_SKILLS_DIR / src.name
        action = "replace" if dst.exists() else "create"
        print(f"  {action:<8} {src.name}")
        if dry_run:
            continue
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)

    print()
    print("Done. Skills should now be available in:")
    print("  - Claude Code CLI")
    print("  - Claude Code desktop app")
    print("  - Claude Code at claude.ai/code")
    print()
    print("Note: re-run this script after pulling skill changes from the repo —")
    print("personal skills don't auto-sync from .claude/skills/.")
    return 0


def remove(dry_run: bool) -> int:
    skills = list_project_skills()
    if not skills:
        print(f"No project skills found at {PROJECT_SKILLS_DIR}")
        return 1

    print(f"Removing {len(skills)} skill(s) from {PERSONAL_SKILLS_DIR}")
    if dry_run:
        print("(dry run — no files removed)")

    removed = 0
    for src in skills:
        dst = PERSONAL_SKILLS_DIR / src.name
        if dst.exists():
            print(f"  remove   {src.name}")
            if not dry_run:
                shutil.rmtree(dst)
            removed += 1
        else:
            print(f"  skip     {src.name} (not installed)")

    print()
    print(f"{removed} removed.")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--remove", action="store_true",
                   help="Remove installed copies instead of installing.")
    p.add_argument("--dry-run", action="store_true",
                   help="Show what would happen without changing files.")
    args = p.parse_args(argv)

    return remove(args.dry_run) if args.remove else install(args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
