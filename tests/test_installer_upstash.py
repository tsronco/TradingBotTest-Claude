"""Upstash Management-API provisioning — all network mocked."""
import pytest

from tools.installer import upstash_api
from tools.installer.upstash_api import UpstashError, UpstashProvisioner


class _Resp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload
        self.text = text
        self.content = b"x" if payload is not None or text else b""

    def json(self):
        return self._payload


def _mock_requests(monkeypatch, handler):
    def fake_request(method, url, **kw):
        return handler(method, url, kw)
    monkeypatch.setattr(upstash_api.requests, "request", fake_request)


def test_reuses_existing_db_by_name(monkeypatch):
    def handler(method, url, kw):
        if method == "GET" and url.endswith("/redis/databases"):
            return _Resp(200, [{"database_name": "tradingbot-dashboard-kv",
                                "database_id": "abc"}])
        if method == "GET" and url.endswith("/redis/database/abc"):
            return _Resp(200, {"database_name": "tradingbot-dashboard-kv",
                               "database_id": "abc", "endpoint": "x.upstash.io",
                               "port": 6379, "rest_token": "T",
                               "read_only_rest_token": "RO", "password": "P"})
        raise AssertionError(f"unexpected {method} {url}")
    _mock_requests(monkeypatch, handler)
    db, plan = UpstashProvisioner("e@x.com", "k").find_or_create()
    assert plan == "existing"
    assert db["rest_token"] == "T"


def test_creates_free_when_absent(monkeypatch):
    def handler(method, url, kw):
        if method == "GET":
            return _Resp(200, [])
        if method == "POST":
            assert kw["json"]["plan"] == "free"
            assert "region" not in kw["json"]            # regional API is deprecated
            assert kw["json"]["platform"] == "aws"
            assert kw["json"]["primary_region"] == "us-east-1"
            return _Resp(200, {"database_name": "tradingbot-dashboard-kv",
                               "endpoint": "y.upstash.io", "port": 6379,
                               "rest_token": "FT", "read_only_rest_token": "FRO",
                               "password": "FP"})
        raise AssertionError
    _mock_requests(monkeypatch, handler)
    db, plan = UpstashProvisioner("e@x.com", "k").find_or_create()
    assert plan == "free" and db["rest_token"] == "FT"


def test_free_rejected_falls_back_to_payg(monkeypatch):
    calls = {"post": 0}

    def handler(method, url, kw):
        if method == "GET":
            return _Resp(200, [])
        if method == "POST":
            calls["post"] += 1
            if kw["json"]["plan"] == "free":
                return _Resp(402, text="payment required")
            assert kw["json"]["plan"] == "payg"
            assert "region" not in kw["json"]            # global contract on retry too
            assert kw["json"]["primary_region"] == "us-east-1"
            return _Resp(200, {"database_name": "tradingbot-dashboard-kv",
                               "endpoint": "z.upstash.io", "port": 6379,
                               "rest_token": "ZT", "password": "ZP"})
        raise AssertionError
    _mock_requests(monkeypatch, handler)
    db, plan = UpstashProvisioner("e@x.com", "k").find_or_create()
    assert plan == "payg" and calls["post"] == 2


def test_bad_credentials_raise_not_retried(monkeypatch):
    def handler(method, url, kw):
        return _Resp(401, text="unauthorized")
    _mock_requests(monkeypatch, handler)
    with pytest.raises(UpstashError, match="rejected the credentials"):
        UpstashProvisioner("e@x.com", "bad").find_or_create()


def test_dry_run_makes_no_calls(monkeypatch):
    def handler(method, url, kw):
        raise AssertionError("dry-run must not hit the network")
    _mock_requests(monkeypatch, handler)
    db, plan = UpstashProvisioner("e@x.com", "k", dry_run=True).find_or_create()
    assert plan == "free" and db["rest_token"] == "DRYRUN"


def test_kv_env_maps_dashboard_required_keys():
    db = {"endpoint": "rich-cat-1.upstash.io", "port": 6379,
          "rest_token": "AX", "read_only_rest_token": "RO", "password": "PW"}
    env = UpstashProvisioner.kv_env(db)
    assert env["KV_REST_API_URL"] == "https://rich-cat-1.upstash.io"
    assert env["KV_REST_API_TOKEN"] == "AX"
    assert env["KV_REST_API_READ_ONLY_TOKEN"] == "RO"
    assert env["KV_URL"] == "rediss://default:PW@rich-cat-1.upstash.io:6379"
    assert env["REDIS_URL"] == env["KV_URL"]
    # exactly the five keys the env shape expects, no extras
    assert set(env) == {"KV_REST_API_URL", "KV_REST_API_TOKEN",
                        "KV_REST_API_READ_ONLY_TOKEN", "KV_URL", "REDIS_URL"}


def test_create_body_uses_global_not_regional_contract(monkeypatch):
    captured = {}

    def handler(method, url, kw):
        if method == "GET":
            return _Resp(200, [])
        if method == "POST":
            captured.update(kw["json"])
            return _Resp(200, {"database_name": "tradingbot-dashboard-kv",
                               "endpoint": "g.upstash.io", "port": 6379,
                               "rest_token": "GT", "password": "GP"})
        raise AssertionError
    _mock_requests(monkeypatch, handler)
    UpstashProvisioner("e@x.com", "k").find_or_create()
    assert "region" not in captured              # deprecated field absent
    assert captured["platform"] == "aws"
    assert captured["primary_region"] == "us-east-1"
    assert captured["database_name"] == "tradingbot-dashboard-kv"
    assert captured["plan"] == "free"
