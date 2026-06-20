#!/usr/bin/env python3
"""
Configure cron-job.org jobs that trigger our 6 GitHub Actions workflows
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

# Job definitions. Conservative + aggressive + manual paper accounts plus a
# live (real-money) account run side-by-side. Mon–Fri jobs: TSLA Monitor × 4,
# Congress Copy, Daily Summary. Sunday-only jobs: Wheel Screener × 4.
JOBS = [
    # Conservative paper account — original setup.
    {
        "title": "TSLA Monitor",
        "workflow": "tsla-monitor.yml",
        "hours": list(range(13, 21)),  # 13–20 UTC inclusive
        "minutes": [7, 17, 27, 37, 47, 57],  # every 10 min, :7 offset
        "wdays": [1, 2, 3, 4, 5],
    },
    # Aggressive paper account — same cadence, offset by :2 minutes so the
    # two monitors don't fire simultaneously. The 'bot-commits' concurrency
    # group serializes their commits anyway, but staggering reduces queueing.
    {
        "title": "TSLA Monitor (Aggressive)",
        "workflow": "tsla-monitor-aggressive.yml",
        "hours": list(range(13, 21)),
        "minutes": [9, 19, 29, 39, 49, 59],  # every 10 min, :9 offset (+2 from cons)
        "wdays": [1, 2, 3, 4, 5],
    },
    # Manual paper account — same cadence, offset by another :2 minutes
    # so all three monitors stagger evenly inside the 10-min window.
    {
        "title": "TSLA Monitor (Manual)",
        "workflow": "tsla-monitor-manual.yml",
        "hours": list(range(13, 21)),
        "minutes": [1, 11, 21, 31, 41, 51],  # every 10 min, :11 offset (+2 from agg)
        "wdays": [1, 2, 3, 4, 5],
    },
    # Live (REAL MONEY) account — same cadence, offset by another :2 minutes
    # so all four monitors stagger evenly inside the 10-min window.
    {
        "title": "TSLA Monitor (Live)",
        "workflow": "tsla-monitor-live.yml",
        "hours": list(range(13, 21)),
        "minutes": [3, 13, 23, 33, 43, 53],  # every 10 min, :13 offset (+2 from manual)
        "wdays": [1, 2, 3, 4, 5],
    },
    {
        "title": "Congress Copy",
        "workflow": "congress-copy.yml",
        "hours": [13, 15, 17, 19],
        "minutes": [7],
        "wdays": [1, 2, 3, 4, 5],
    },
    {
        # Combined daily summary: posts conservative + aggressive + head-to-head.
        "title": "Daily Summary",
        "workflow": "daily-summary.yml",
        "hours": [20],
        "minutes": [12],
        "wdays": [1, 2, 3, 4, 5],
    },
    {
        # Sundays at 22:00 UTC (5pm CT / 6pm ET). Conservative wheel candidate
        # digest goes to #daily-summary.
        "title": "Wheel Screener",
        "workflow": "wheel-screener.yml",
        "hours": [22],
        "minutes": [0],
        "wdays": [0],  # Sunday only
    },
    {
        # Aggressive wheel candidate digest (high-IV universe) goes to
        # #aggressive-summary, offset by 2 min so it doesn't race the
        # conservative screener for a Sunday-evening fire.
        "title": "Wheel Screener (Aggressive)",
        "workflow": "wheel-screener-aggressive.yml",
        "hours": [22],
        "minutes": [2],
        "wdays": [0],
    },
    {
        # Manual wheel candidate digest (default conservative universe) goes
        # to #manual-summary as IDEAS only — manual mode never auto-executes.
        # Offset another 2 min from aggressive so screeners stagger evenly.
        "title": "Wheel Screener (Manual)",
        "workflow": "wheel-screener-manual.yml",
        "hours": [22],
        "minutes": [4],
        "wdays": [0],
    },
    {
        # Live wheel candidate digest (default conservative universe) goes to
        # #live-summary as IDEAS only — live mode never auto-executes either.
        # Offset another 2 min from manual so all four screeners stagger.
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
    # SM500 small-account paper — auto-spread mode. Offset :05 (no collision
    # with cons :07, agg :09, manual :01, live :03, sm2000 :06, sm1000 :08).
    {
        "title": "TSLA Monitor (SM500)",
        "workflow": "tsla-monitor-sm500.yml",
        "hours": list(range(13, 21)),
        "minutes": [5, 15, 25, 35, 45, 55],  # every 10 min, :05 offset
        "wdays": [1, 2, 3, 4, 5],
    },
    # SM1000 small-account paper — auto-spread mode. Offset :08 (no collision
    # with cons :07, agg :09, manual :01, live :03, sm500 :05, sm2000 :06).
    {
        "title": "TSLA Monitor (SM1000)",
        "workflow": "tsla-monitor-sm1000.yml",
        "hours": list(range(13, 21)),
        "minutes": [8, 18, 28, 38, 48, 58],  # every 10 min, :08 offset
        "wdays": [1, 2, 3, 4, 5],
    },
    # SM2000 small-account paper — auto-spread mode. Offset :06 (no collision
    # with cons :07, agg :09, manual :01, live :03, sm500 :05, sm1000 :08).
    {
        "title": "TSLA Monitor (SM2000)",
        "workflow": "tsla-monitor-sm2000.yml",
        "hours": list(range(13, 21)),
        "minutes": [6, 16, 26, 36, 46, 56],  # every 10 min, :06 offset
        "wdays": [1, 2, 3, 4, 5],
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
