"""R1 — order-placement idempotency (client_order_id).

Every POST /orders must carry a client_order_id so a transport-level retry
after a lost response can't double-place. Covers wheel_strategy.api_post (also
used by long_options_strategy via import) and strategy.place_order:
  - a client_order_id is injected on order POSTs (not other POSTs);
  - a retry re-sends the SAME id;
  - a duplicate-id 422 (the retry reached Alpaca after the original already
    created the order) resolves to the existing order instead of raising;
  - an unresolvable duplicate still raises (no silent no-op).
"""
import pytest
import requests

import config
import wheel_strategy as ws
import strategy as strat


class FakeResp:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}
        self.text = text

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"{self.status_code}")


@pytest.fixture
def manual_mode():
    ws.apply_mode("manual")
    strat.apply_mode("manual")
    yield
    ws.apply_mode(config.DEFAULT_MODE)
    strat.apply_mode(config.DEFAULT_MODE)


def test_api_post_orders_injects_client_order_id(monkeypatch, manual_mode):
    captured = {}

    def fake_req(method, url, **kwargs):
        captured["json"] = kwargs.get("json")
        return FakeResp(200, {"id": "o1"})

    monkeypatch.setattr(ws.requests, "request", fake_req)
    ws.api_post("/orders", {"symbol": "AAPL", "side": "buy"})
    assert captured["json"]["client_order_id"].startswith("manual-")


def test_api_post_non_orders_not_stamped(monkeypatch, manual_mode):
    captured = {}

    def fake_req(method, url, **kwargs):
        captured["json"] = kwargs.get("json")
        return FakeResp(200, {"ok": True})

    monkeypatch.setattr(ws.requests, "request", fake_req)
    ws.api_post("/account/configurations", {"foo": "bar"})
    assert "client_order_id" not in captured["json"]


def test_api_post_orders_retry_reuses_id_and_resolves_duplicate(monkeypatch, manual_mode):
    monkeypatch.setattr(ws.time, "sleep", lambda *_: None)
    posts = []
    state = {"posts": 0}

    def fake_req(method, url, **kwargs):
        if method == "POST":
            state["posts"] += 1
            posts.append(kwargs.get("json"))
            if state["posts"] == 1:
                return FakeResp(502, text="bad gateway")   # response lost → retry
            return FakeResp(422, text='{"message":"client_order_id must be unique"}')
        return FakeResp(200, {"id": "existing-1", "status": "new"})  # GET by client id

    monkeypatch.setattr(ws.requests, "request", fake_req)
    result = ws.api_post("/orders", {"symbol": "AAPL", "side": "buy"})
    assert len(posts) == 2
    assert posts[0]["client_order_id"] == posts[1]["client_order_id"]
    assert result["id"] == "existing-1"


def test_api_post_orders_unresolvable_duplicate_raises(monkeypatch, manual_mode):
    def fake_req(method, url, **kwargs):
        if method == "POST":
            return FakeResp(422, text="client_order_id must be unique")
        return FakeResp(404, text="not found")  # can't resolve the existing order

    monkeypatch.setattr(ws.requests, "request", fake_req)
    with pytest.raises(requests.exceptions.HTTPError):
        ws.api_post("/orders", {"symbol": "AAPL", "side": "buy"})


def test_place_order_injects_and_resolves_duplicate(monkeypatch, manual_mode):
    monkeypatch.setattr(strat.time, "sleep", lambda *_: None)
    posts = []
    state = {"posts": 0}

    def fake_req(method, url, **kwargs):
        if method == "POST":
            state["posts"] += 1
            posts.append(kwargs.get("json"))
            if state["posts"] == 1:
                return FakeResp(504, text="gateway timeout")
            return FakeResp(422, text="client_order_id must be unique")
        return FakeResp(200, {"id": "existing-strat", "status": "new"})

    monkeypatch.setattr(strat.requests, "request", fake_req)
    result = strat.place_order("AAPL", 5, "buy")
    assert posts[0]["client_order_id"].startswith("manual-")
    assert posts[0]["client_order_id"] == posts[1]["client_order_id"]
    assert result["id"] == "existing-strat"


def test_distinct_orders_get_distinct_ids(manual_mode):
    a = ws._gen_client_order_id()
    b = ws._gen_client_order_id()
    assert a != b
    assert a.startswith("manual-")
