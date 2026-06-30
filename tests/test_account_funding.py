import json

import account_funding
import alpaca_data
from notifications import Color


def _activity(id_, atype, amount, date="2026-06-30", status="executed"):
    return {
        "id": id_,
        "activity_type": atype,
        "net_amount": str(amount),
        "date": date,
        "status": status,
    }


def _wire(monkeypatch, tmp_path, activities, account=None):
    """Point account_funding at a tmp state file + stubbed Alpaca calls."""
    monkeypatch.setattr(
        account_funding, "_state_path",
        lambda mode: tmp_path / f"account_state_{mode}.json",
    )
    monkeypatch.setattr(
        account_funding, "get_account_activities",
        lambda mode, types, after=None, until=None: list(activities),
    )
    monkeypatch.setattr(
        account_funding, "get_account",
        lambda mode: account or {"cash": "1500", "equity": "1500", "portfolio_value": "1500"},
    )


def _capture(monkeypatch):
    calls = []
    monkeypatch.setattr(account_funding, "send_embed",
                        lambda *a, **k: calls.append((a, k)))
    return calls


def test_classify_activity():
    assert account_funding.classify_activity(_activity("1", "CSD", 1000)) == ("deposit", 1000.0)
    assert account_funding.classify_activity(_activity("2", "CSW", -250)) == ("withdrawal", 250.0)
    assert account_funding.classify_activity(_activity("3", "DIV", 5)) == (None, 0.0)
    assert account_funding.classify_activity(_activity("4", "CSW", 100, status="canceled")) == (None, 0.0)
    assert account_funding.classify_activity({"activity_type": "CSD", "net_amount": "x"}) == (None, 0.0)


def test_first_run_seeds_silently(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path, [_activity("dep1", "CSD", 1000)])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert calls == []  # nothing announced on the seeding run
    state = json.loads((tmp_path / "account_state_live.json").read_text())
    assert "dep1" in state["seen_activity_ids"]


def test_new_deposit_announced_green(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": ["old"]}))
    _wire(monkeypatch, tmp_path, [_activity("dep1", "CSD", 1000)])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args[0] == "live_trades"          # channel
    assert "Deposit" in args[1]              # title
    assert "1,000.00" in args[1]
    assert kwargs["color"] == Color.GREEN


def test_new_withdrawal_announced_red(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": ["old"]}))
    _wire(monkeypatch, tmp_path, [_activity("wd1", "CSW", -500)])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert "Withdrawal" in args[1]
    assert "500.00" in args[1]
    assert kwargs["color"] == Color.RED


def test_dedup_no_reannounce(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": ["dep1"]}))
    _wire(monkeypatch, tmp_path, [_activity("dep1", "CSD", 1000)])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert calls == []


def test_canceled_not_announced_but_recorded(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": ["old"]}))
    _wire(monkeypatch, tmp_path, [_activity("x", "CSW", 100, status="canceled")])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert calls == []
    state = json.loads((tmp_path / "account_state_live.json").read_text())
    assert "x" in state["seen_activity_ids"]


def test_fetch_error_is_failsoft(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": []}))
    monkeypatch.setattr(account_funding, "_state_path",
                        lambda mode: tmp_path / f"account_state_{mode}.json")

    def boom(*a, **k):
        raise RuntimeError("alpaca down")

    monkeypatch.setattr(account_funding, "get_account_activities", boom)
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")  # must not raise
    # Only an error-channel embed (if any), never a trades embed.
    assert all(c[0][0] == "live_errors" for c in calls)


def test_get_account_activities_builds_request(monkeypatch):
    captured = {}

    def fake_get(url, mode, params=None):
        captured["url"] = url
        captured["mode"] = mode
        captured["params"] = params
        return [{"id": "x", "activity_type": "CSD"}]

    monkeypatch.setattr(alpaca_data, "_get", fake_get)
    out = alpaca_data.get_account_activities(
        "live", ["CSD", "CSW"], after="2026-01-01T00:00:00Z"
    )
    assert out == [{"id": "x", "activity_type": "CSD"}]
    assert captured["url"] == "https://api.alpaca.markets/v2/account/activities"
    assert captured["mode"] == "live"
    assert captured["params"]["activity_types"] == "CSD,CSW"
    assert captured["params"]["after"] == "2026-01-01T00:00:00Z"
    assert captured["params"]["page_size"] == 100
