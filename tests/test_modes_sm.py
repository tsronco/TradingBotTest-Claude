# tests/test_modes_sm.py
import config

SM = ["sm500", "sm1000", "sm2000"]

def test_sm_modes_exist_and_are_isolated():
    seen_keys, seen_state, seen_chan = set(), set(), set()
    for m in SM:
        cfg = config.get_mode(m)
        # distinct Alpaca creds env names
        assert cfg["alpaca_key_env"] == f"ALPACA_{m.upper()}_API_KEY"
        assert cfg["alpaca_secret_env"] == f"ALPACA_{m.upper()}_API_SECRET"
        assert cfg["alpaca_url_env"] == f"ALPACA_{m.upper()}_BASE_URL"
        # distinct state files
        assert cfg["wheel_state_file"] == f"wheel_state_{m}.json"
        assert cfg["strategy_state_file"] == f"strategy_state_{m}.json"
        # distinct discord channels
        for ch in ("trades_channel", "summary_channel", "errors_channel", "actions_channel"):
            seen_chan.add(cfg[ch])
        seen_keys.add(cfg["alpaca_key_env"]); seen_state.add(cfg["wheel_state_file"])
    assert len(seen_keys) == 3 and len(seen_state) == 3 and len(seen_chan) == 12

def test_sm_modes_inherit_manual_management_flags():
    for m in SM:
        cfg = config.get_mode(m)
        assert cfg["auto_discover_symbols"] is True
        assert cfg["spread_management"] is True
        assert cfg["wheel_skip_new_puts"] is True   # static CSP wheel stays OFF

def test_auto_open_only_on_sm_modes():
    for m in SM:
        assert config.get_mode(m)["auto_open_spreads"] is True
    for m in ("conservative", "aggressive", "manual", "live"):
        assert config.get_mode(m).get("auto_open_spreads", False) is False

def test_auto_open_param_block_defaults():
    c = config.get_mode("sm1000")
    assert c["bp_switch_threshold"] == 5000
    assert c["wheelability_min"] == 85
    assert c["max_risk_pct_equity"] == 0.15
    assert config.get_mode("sm1000")["min_net_credit"] == 0.05
    assert c["max_concurrent_spreads"] == 3
    assert c["account_floor"] == 300
    assert c["earnings_exclusion_days"] == 7
    assert c["max_opens_per_cycle"] == 1
    assert c["short_put_otm_pct"] == 0.10
    assert c["spread_dte_min"] == 14 and c["spread_dte_max"] == 28
    # sm500-only universe price filter; sm1000/sm2000 unfiltered (None)
    assert config.get_mode("sm500")["max_underlying_price"] == 25
    assert config.get_mode("sm1000").get("max_underlying_price") is None
    assert config.get_mode("sm2000").get("max_underlying_price") is None
