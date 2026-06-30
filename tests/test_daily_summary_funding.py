import config
import daily_summary


class _FakeResp:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


def test_funding_today_sums_executed(monkeypatch):
    acts = [
        {"activity_type": "CSD", "net_amount": "1000", "date": "2026-06-30"},
        {"activity_type": "CSW", "net_amount": "-250", "date": "2026-06-30"},
        {"activity_type": "CSD", "net_amount": "500", "date": "2026-06-29"},  # not today
    ]
    monkeypatch.setattr(daily_summary.requests, "get", lambda *a, **k: _FakeResp(acts))
    dep, wd = daily_summary._funding_today(config.get_mode("live"), "2026-06-30")
    assert dep == 1000.0
    assert wd == 250.0


def test_funding_today_failsoft(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("network")

    monkeypatch.setattr(daily_summary.requests, "get", boom)
    dep, wd = daily_summary._funding_today(config.get_mode("live"), "2026-06-30")
    assert (dep, wd) == (0.0, 0.0)


def test_funding_field_both():
    f = daily_summary._funding_field(1000.0, 250.0)
    assert f["name"] == "💵 Funding Today"
    assert "Deposits +$1,000.00" in f["value"]
    assert "Withdrawals −$250.00" in f["value"]


def test_funding_field_none_when_zero():
    assert daily_summary._funding_field(0.0, 0.0) is None


def test_funding_field_deposit_only():
    f = daily_summary._funding_field(500.0, 0.0)
    assert f["value"] == "Deposits +$500.00"
