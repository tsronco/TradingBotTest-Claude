#!/usr/bin/env python3
"""
Configure cron-job.org jobs that trigger our 3 GitHub Actions workflows.

Reads GITHUB_ACCESS_TOKEN and CRONJOB_API_KEY from .env at the project root,
then PUTs 3 job definitions to cron-job.org's REST API.

Idempotent: lists existing jobs first, deletes any with a matching title
before creating the new ones. Safe to re-run.

Usage:
    python tools/setup_cronjobs.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

GH_TOKEN  = os.environ["GITHUB_ACCESS_TOKEN"]
CRON_KEY  = os.environ["CRONJOB_API_KEY"]

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

# 4 job definitions. The first three run Mon-Fri; "Wheel Screener" overrides
# wdays for Sunday-evening firing.
JOBS = [
    {
        "title": "TSLA Monitor",
        "workflow": "tsla-monitor.yml",
        "hours": list(range(13, 21)),  # 13–20 UTC inclusive
        "minutes": [7, 37],
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
        "title": "Daily Summary",
        "workflow": "daily-summary.yml",
        "hours": [20],
        "minutes": [12],
        "wdays": [1, 2, 3, 4, 5],
    },
    {
        # Sundays at 22:00 UTC (5pm CT / 6pm ET). Posts the upcoming week's
        # wheel candidate digest to #daily-summary so Tim sees it on Sunday
        # evening, a few hours before Monday's open.
        "title": "Wheel Screener",
        "workflow": "wheel-screener.yml",
        "hours": [22],
        "minutes": [0],
        "wdays": [0],  # Sunday only
    },
]


def cronjob_request(method: str, path: str, body: dict | None = None, _retries: int = 3) -> dict:
    """Make a request to cron-job.org API. Retries on 429 with backoff."""
    url = f"{CRONJOB_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    for attempt in range(_retries):
        req = urllib.request.Request(url, data=data, method=method, headers=CRONJOB_HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = resp.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < _retries - 1:
                wait = 2 ** (attempt + 1)  # 2, 4, 8 seconds
                print(f"  Rate limited (429), retrying in {wait}s...")
                time.sleep(wait)
                continue
            print(f"  HTTP {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
            raise
    raise RuntimeError(f"Exhausted retries for {method} {path}")


def list_existing_jobs() -> list[dict]:
    return cronjob_request("GET", "/jobs").get("jobs", [])


def delete_job(job_id: int) -> None:
    cronjob_request("DELETE", f"/jobs/{job_id}")


def build_job_body(spec: dict) -> dict:
    return {
        "job": {
            "url": f"https://api.github.com/repos/{REPO}/actions/workflows/{spec['workflow']}/dispatches",
            "enabled": True,
            "title": spec["title"],
            "saveResponses": True,
            "schedule": {
                "timezone": "UTC",
                "expiresAt": 0,
                "hours": spec["hours"],
                "mdays": [-1],
                "minutes": spec["minutes"],
                "months": [-1],
                "wdays": spec["wdays"],
            },
            "requestMethod": 1,  # POST
            "extendedData": {
                "headers": GH_HEADERS,
                "body": GH_BODY,
            },
        }
    }


def main() -> None:
    print(f"Configuring cron-job.org for repo {REPO}")
    print()

    # Step 1: clean up any pre-existing jobs with matching titles (idempotent)
    existing = list_existing_jobs()
    titles = {spec["title"] for spec in JOBS}
    for job in existing:
        if job.get("title") in titles:
            jid = job["jobId"]
            print(f"  Deleting existing '{job['title']}' (jobId={jid})")
            delete_job(jid)
    if not any(j.get("title") in titles for j in existing):
        print("  No existing matching jobs; clean slate.")
    print()

    # Step 2: create the 3 jobs (sleep between to avoid 429)
    for i, spec in enumerate(JOBS):
        body = build_job_body(spec)
        result = cronjob_request("PUT", "/jobs", body)
        jid = result.get("jobId")
        sched = f"hours={spec['hours']} minutes={spec['minutes']}"
        print(f"  [OK] Created '{spec['title']}' (jobId={jid}) -- {sched}")
        if i < len(JOBS) - 1:
            time.sleep(2)  # be polite to the API
    print()

    # Step 3: list back and confirm
    print("Final state:")
    for job in list_existing_jobs():
        if job.get("title") in titles:
            print(f"  {job['title']}: enabled={job.get('enabled')} jobId={job.get('jobId')} url={job.get('url')}")


if __name__ == "__main__":
    main()
