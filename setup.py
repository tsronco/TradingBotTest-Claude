#!/usr/bin/env python3
"""Interactive setup wizard for this trading bot.

    python setup.py              # run the full interactive wizard (terminal)
    python setup.py --web        # open a guided installer in your browser
    python setup.py --dry-run    # walk the flow, change nothing external
    python setup.py --check      # health-check the existing .env (no prompts)
    python setup.py --fix-urls   # re-point fork/dashboard URLs after deploy

This is NOT a packaging script. It collects the accounts/keys you created
(per instructions.md), writes your .env files, fixes the two fork gotchas,
and optionally wires Discord, GitHub secrets, cron-job.org, and Vercel.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tools.installer import wizard


def main() -> int:
    p = argparse.ArgumentParser(prog="setup.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--web", action="store_true",
                   help="open the guided installer in a local browser window")
    g.add_argument("--check", action="store_true",
                   help="health-check the existing .env and exit")
    g.add_argument("--fix-urls", action="store_true",
                   help="re-apply only the fork/dashboard-URL fixes")
    p.add_argument("--dry-run", action="store_true",
                   help="preview only — change nothing external (works with --web too)")
    p.add_argument("--no-browser", action="store_true",
                   help="with --web, don't auto-open the browser")
    args = p.parse_args()

    try:
        if args.check:
            wizard.run_doctor()
        elif args.fix_urls:
            wizard.run_fix_urls()
        elif args.web:
            from tools.installer import webapp
            webapp.serve(dry_run=args.dry_run, open_browser=not args.no_browser)
        else:
            wizard.run_wizard(dry_run=args.dry_run)
    except KeyboardInterrupt:
        print("\nAborted. Nothing further was changed.")
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
