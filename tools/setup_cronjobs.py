#!/usr/bin/env python3
"""
Configure cron-job.org jobs that trigger our GitHub Actions workflows
(manual + live monitors, daily summary, manual + live wheel screeners)
plus the dashboard auto-grading webhook.

Reads from .env at the project root:
- GITHUB_ACCESS_TOKEN — required for GitHub Actions dispatch jobs
- CRONJOB_API_KEY — required for cron-job.org API auth
- DASHBOARD_CRON_TOKEN — required for the dashboard webhook bearer token
  (must match Vercel env var CRON_TOKEN)

Idempotent: lists existing jobs first. Updates any with a matching title
in place via PATCH; creates new ones via PUT. Safe to re-run.

Note: cron-job.org's REST API rejects DELETE /jobs/{id} with HTTP 400
(empty body) — likely an undocumented quirk. We update via PATCH instead.

Usage:
    python tools/setup_cronjobs.py
"""
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# "" fallback keeps the module import-safe without .env (tests/CI); a real
# run with empty creds still hard-fails at the API call (recorded, exit 1).
GH_TOKEN  = os.environ.get("GITHUB_ACCESS_TOKEN", "")
CRON_KEY  = os.environ.get("CRONJOB_API_KEY", "")

REPO      = "tsronco/TradingBotTest-Claude"
GH_HEADERS = {
    "Accept": "application/vnd.github+json",
    "Authorization": f"Bearer {GH_TOKEN}",
    "X-GitHub-Api-Version": "2022-11-28",
}
GH_BODY = json.dumps({"ref": "main"})

CRONJOB_BASE = "https://api.cron-job.org"
CRONJOB_HEADERS = {
    "Authorization": f"Bearer {CRON_KEY}",
    "Content-Type": "application/json",
}

# Job definitions. Two accounts run side-by-side: manual paper + live (real
# money). Mon–Fri jobs: TSLA Monitor × 2, Daily Summary. Sunday-only jobs:
# Wheel Screener × 2. Plus the dashboard webhook crons.
#
# NOTE: this script PATCHes existing jobs and PUTs new ones — it never deletes
# jobs that were removed from this list. After the 2026-06-29 account sunset,
# the retired cron-job.org jobs (conservative/aggressive/sm* monitors, both
# old screeners, congress copy, the head-to-head daily summary) must be
# deleted by hand in the cron-job.org dashboard. Their GitHub workflows are
# gone, so until then they'll just dispatch to a 404 and no-op.
JOBS = [
    # Manual paper account.
    {
        "title": "TSLA Monitor (Manual)",
        "workflow": "tsla-monitor-manual.yml",
        "hours": list(range(13, 21)),
        "minutes": [1, 11, 21, 31, 41, 51],  # every 10 min, :01 offset
        "wdays": [1, 2, 3, 4, 5],
    },
    # Live (REAL MONEY) account — offset :02 from manual so the two monitors
    # stagger inside the 10-min window.
    {
        "title": "TSLA Monitor (Live)",
        "workflow": "tsla-monitor-live.yml",
        "hours": list(range(13, 21)),
        "minutes": [3, 13, 23, 33, 43, 53],  # every 10 min, :03 offset
        "wdays": [1, 2, 3, 4, 5],
    },
    {
        # Combined daily summary: posts manual + live summaries.
        "title": "Daily Summary",
        "workflow": "daily-summary.yml",
        "hours": [20],
        "minutes": [12],
        "wdays": [1, 2, 3, 4, 5],
    },
    {
        # Sundays at 22:00 UTC (5pm CT / 6pm ET). Manual wheel candidate
        # digest goes to #manual-summary as IDEAS only — manual never
        # auto-executes the wheel.
        "title": "Wheel Screener (Manual)",
        "workflow": "wheel-screener-manual.yml",
        "hours": [22],
        "minutes": [4],
        "wdays": [0],  # Sunday only
    },
    {
        # Live wheel candidate digest goes to #live-summary as IDEAS only —
        # live never auto-executes either. Offset :02 from manual.
        "title": "Wheel Screener (Live)",
        "workflow": "wheel-screener-live.yml",
        "hours": [22],
        "minutes": [6],
        "wdays": [0],
    },
    {
        # Dashboard auto-grading: polls open manual trades every 5 min during
        # market hours and fires AI hindsight grades on newly-closed trades.
        # Hits the Vercel webhook directly with a bearer token (not a GitHub
        # workflow dispatch).
        "title": "Dashboard — Grade Open Trades",
        "kind": "webhook",
        "url": "https://tradingbot-dashboard-blue.vercel.app/api/cron/grade-open-trades?job=grade-open-trades",
        "method": "POST",
        "auth_header": "Bearer ${CRON_TOKEN}",  # placeholder — set real value via env
        "hours": list(range(13, 21)),  # 13–20 UTC, market hours
        "minutes": [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55],  # every 5 min
        "wdays": [1, 2, 3, 4, 5],
    },
    {
        # Tendency detection: scans 90 days of closed trades for behavioral
        # patterns once a week, surfaces tendencies + AI-generated rule
        # proposals on /rules. Sunday 22:00 UTC = 6 PM ET during DST.
        # During EST (Nov–Mar) it fires at 5 PM ET, which is fine.
        "title": "Dashboard — Detect Tendencies",
        "kind": "webhook",
        "url": "https://tradingbot-dashboard-blue.vercel.app/api/cron/detect-tendencies?job=detect-tendencies",
        "method": "POST",
        "auth_header": "Bearer ${CRON_TOKEN}",
        "hours": [22],
        "minutes": [0],
        "wdays": [0],   # Sunday only
    },
]


RETRIES = 6
BACKOFF_BASE = 2
BACKOFF_CAP = 32


def compute_backoff(attempt: int, retry_after: str | None = None) -> float:
    """Seconds to wait before the next retry.

    Honors a server ``Retry-After`` (seconds) when present; otherwise
    exponential with a cap plus jitter to avoid lockstep retries.
    """
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            pass
    return min(BACKOFF_BASE * (2 ** attempt), BACKOFF_CAP) + random.uniform(0, 1)


def exit_code_for(failures: list[tuple[str, str]]) -> int:
    """0 = all good; 75 = only recoverable rate-limit partials; 1 = hard."""
    if not failures:
        return 0
    if any(kind == "hard" for _, kind in failures):
        return 1
    return 75


class CronRateLimited(RuntimeError):
    pass


def cronjob_request(method: str, path: str, body: dict | None = None,
                    _retries: int = RETRIES) -> dict:
    """Make a request to cron-job.org API. Retries on 429 with backoff."""
    url = f"{CRONJOB_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    for attempt in range(_retries):
        req = urllib.request.Request(url, data=data, method=method,
                                     headers=CRONJOB_HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = resp.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            if e.code == 429:
                if attempt < _retries - 1:
                    wait = compute_backoff(
                        attempt, e.headers.get("Retry-After"))
                    print(f"  Rate limited (429), retrying in "
                          f"{wait:.1f}s...")
                    time.sleep(wait)
                    continue
                raise CronRateLimited(f"429 exhausted for {method} {path}")
            print(f"  HTTP {e.code}: {e.read().decode()[:300]}",
                  file=sys.stderr)
            raise
    raise CronRateLimited(f"Exhausted retries for {method} {path}")


def list_existing_jobs() -> list[dict]:
    return cronjob_request("GET", "/jobs").get("jobs", [])


def patch_job(job_id: int, spec: dict) -> None:
    """Update an existing job's schedule + URL in place."""
    body = build_job_body(spec)
    cronjob_request("PATCH", f"/jobs/{job_id}", body)


def build_job_body(spec: dict) -> dict:
    schedule = {
        "timezone": "UTC",
        "expiresAt": 0,
        "hours": spec["hours"],
        "mdays": [-1],
        "minutes": spec["minutes"],
        "months": [-1],
        "wdays": spec["wdays"],
    }

    kind = spec.get("kind", "github_dispatch")

    if kind == "webhook":
        # Direct webhook-style job — hits an external URL with custom headers,
        # used by the dashboard auto-grading cron.
        cron_token = os.environ.get("DASHBOARD_CRON_TOKEN", "")
        auth_header_value = spec["auth_header"].replace("${CRON_TOKEN}", cron_token)
        return {
            "job": {
                "url": spec["url"],
                "enabled": True,
                "title": spec["title"],
                "saveResponses": True,
                "schedule": schedule,
                "requestMethod": {"GET": 0, "POST": 1, "PUT": 2, "PATCH": 3, "DELETE": 4}.get(spec.get("method", "POST"), 1),
                "extendedData": {
                    "headers": {
                        "Authorization": auth_header_value,
                        "Content-Type": "application/json",
                    },
                    "body": "",
                },
            }
        }

    # Default: github_dispatch (existing behavior)
    return {
        "job": {
            "url": f"https://api.github.com/repos/{REPO}/actions/workflows/{spec['workflow']}/dispatches",
            "enabled": True,
            "title": spec["title"],
            "saveResponses": True,
            "schedule": schedule,
            "requestMethod": 1,  # POST
            "extendedData": {
                "headers": GH_HEADERS,
                "body": GH_BODY,
            },
        }
    }


def main() -> int:
    print(f"Configuring cron-job.org for repo {REPO}")
    print()
    existing = list_existing_jobs()
    by_title = {j.get("title"): j for j in existing if j.get("title")}
    titles = {spec["title"] for spec in JOBS}

    failures: list[tuple[str, str]] = []
    for i, spec in enumerate(JOBS):
        sched = (f"hours={spec['hours']} minutes={spec['minutes']} "
                 f"wdays={spec['wdays']}")
        try:
            if spec["title"] in by_title:
                jid = by_title[spec["title"]]["jobId"]
                patch_job(jid, spec)
                print(f"  [OK] Updated '{spec['title']}' (jobId={jid}) "
                      f"-- {sched}")
            else:
                body = build_job_body(spec)
                result = cronjob_request("PUT", "/jobs", body)
                jid = result.get("jobId")
                print(f"  [OK] Created '{spec['title']}' (jobId={jid}) "
                      f"-- {sched}")
        except CronRateLimited:
            print(f"  [RATE-LIMITED] '{spec['title']}' — will need a re-run")
            failures.append((spec["title"], "ratelimit"))
        except Exception as e:  # noqa: BLE001 - record + continue
            print(f"  [FAIL] '{spec['title']}': {e}", file=sys.stderr)
            failures.append((spec["title"], "hard"))
        if i < len(JOBS) - 1:
            time.sleep(2)
    print()

    print("Final state:")
    try:
        for job in list_existing_jobs():
            if job.get("title") in titles:
                print(f"  {job['title']}: enabled={job.get('enabled')} "
                      f"jobId={job.get('jobId')} url={job.get('url')}")
    except Exception:  # listing is best-effort
        pass

    code = exit_code_for(failures)
    if code == 75:
        print(f"\n  {len(failures)} job(s) rate-limited — re-run Apply to "
              "finish the rest (idempotent).")
    elif code == 1:
        print("\n  Some jobs failed for non-rate-limit reasons — see above.",
              file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
