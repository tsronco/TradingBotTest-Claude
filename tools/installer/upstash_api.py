"""Provision the dashboard's Redis (KV) via the Upstash Management API.

Replaces the retired Vercel-Marketplace "free tier" click: the user creates
an Upstash account + a Management API key (Upstash console -> Account ->
Management API); the installer creates (or reuses) one free Redis database
and returns the KV_* env the dashboard's ``Redis.fromEnv()`` needs.

Idempotent: a database whose name matches ``DB_NAME`` is reused, so
re-running the installer never piles up duplicates.
"""
from __future__ import annotations

import requests

API = "https://api.upstash.com/v2"
DB_NAME = "tradingbot-dashboard-kv"
DEFAULT_REGION = "us-east-1"


class UpstashError(RuntimeError):
    pass


class UpstashProvisioner:
    def __init__(self, email: str, api_key: str, *, dry_run: bool = False):
        self.dry_run = dry_run
        self._auth = (email.strip(), api_key.strip())

    def _request(self, method: str, path: str,
                 json: dict | None = None) -> dict | list:
        try:
            r = requests.request(
                method, f"{API}{path}", auth=self._auth, json=json, timeout=30
            )
        except requests.RequestException as e:
            raise UpstashError(f"Upstash API unreachable: {e}") from e
        if r.status_code in (401, 403):
            raise UpstashError(
                "Upstash rejected the credentials. Check the account email "
                "and Management API key (Upstash console -> Account -> "
                "Management API)."
            )
        if r.status_code >= 400:
            raise UpstashError(
                f"{method} {path} -> HTTP {r.status_code}: {r.text[:200]}"
            )
        return r.json() if r.content else {}

    def _find(self, name: str) -> dict | None:
        dbs = self._request("GET", "/redis/databases")
        if isinstance(dbs, list):
            for db in dbs:
                if db.get("database_name") == name:
                    return db
        return None

    def find_or_create(self, name: str = DB_NAME,
                        region: str = DEFAULT_REGION) -> tuple[dict, str]:
        """Return ``(database, plan_used)``.

        ``plan_used`` is ``"existing"`` (reused), ``"free"`` (created free),
        or ``"payg"`` (free rejected, created pay-as-you-go). Bad-credential
        (401/403) errors are never retried as payg.
        """
        if self.dry_run:
            return ({"database_name": name, "endpoint": "dry-run.upstash.io",
                     "port": 6379, "rest_token": "DRYRUN",
                     "read_only_rest_token": "DRYRUN_RO",
                     "password": "DRYRUN"}, "free")
        existing = self._find(name)
        if existing:
            full = self._request(
                "GET", f"/redis/database/{existing['database_id']}"
            )
            return (full if isinstance(full, dict) else existing, "existing")
        # Upstash deprecated single-`region` (regional) creation -> HTTP 400.
        # Use the global contract: platform + primary_region (no `region`).
        body = {"database_name": name, "platform": "aws",
                "primary_region": region, "plan": "free", "tls": True}
        try:
            db = self._request("POST", "/redis/database", body)
            return (db, "free")  # type: ignore[return-value]
        except UpstashError as e:
            if "-> HTTP 4" not in str(e):
                raise  # bad creds / network / 5xx — not a plan problem
            body["plan"] = "payg"
            db = self._request("POST", "/redis/database", body)
            return (db, "payg")  # type: ignore[return-value]

    @staticmethod
    def kv_env(db: dict) -> dict[str, str]:
        host = db["endpoint"]
        port = db.get("port", 6379)
        pw = db.get("password", "")
        conn = f"rediss://default:{pw}@{host}:{port}"
        return {
            "KV_REST_API_URL": f"https://{host}",
            "KV_REST_API_TOKEN": db["rest_token"],
            "KV_REST_API_READ_ONLY_TOKEN": db.get("read_only_rest_token", ""),
            "KV_URL": conn,
            "REDIS_URL": conn,
        }
