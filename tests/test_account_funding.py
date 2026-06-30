import alpaca_data


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
