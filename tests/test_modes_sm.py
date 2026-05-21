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

def test_auto_open_enabled_on_sm_and_manual_modes():
    """auto_open_spreads is True on the three SM accounts plus manual
    (shortcut $10k validation enabled 2026-05-22). Conservative,
    aggressive, and live (real-money) stay OFF — those accounts either
    have their own opener (cons/agg via wheel CSPs) or are user-only
    (live)."""
    for m in SM:
        assert config.get_mode(m)["auto_open_spreads"] is True
    assert config.get_mode("manual")["auto_open_spreads"] is True
    for m in ("conservative", "aggressive", "live"):
        assert config.get_mode(m).get("auto_open_spreads", False) is False

def test_auto_open_param_block_defaults():
    c = config.get_mode("sm1000")
    assert c["bp_switch_threshold"] == 5000
    # 2026-05-21: sm1000/sm2000 wheelability_min dropped 85 → 80 (percentile-90
    # was clipping at 81.8 on the small eligible pool); sm500 stays at 85.
    assert c["wheelability_min"] == 80
    assert config.get_mode("sm2000")["wheelability_min"] == 80
    assert config.get_mode("sm500")["wheelability_min"] == 75
    # 2026-05-21: sm500 risk cap raised 0.10 → 0.20 (a $50 cap can't fit
    # any $1-wide spread's ~$80–95 net max loss). sm1000/sm2000 stay 0.10.
    assert c["max_risk_pct_equity"] == 0.10
    assert config.get_mode("sm500")["max_risk_pct_equity"] == 0.20
    assert config.get_mode("sm2000")["max_risk_pct_equity"] == 0.10
    assert config.get_mode("sm1000")["min_net_credit"] == 0.05
    # sm500 Conservative posture: max_concurrent_spreads 3 -> 1
    assert config.get_mode("sm500")["max_concurrent_spreads"] == 1
    # sm1000 Balanced posture: max_concurrent_spreads 3 -> 2
    assert c["max_concurrent_spreads"] == 2
    # sm2000 Balanced posture: max_concurrent_spreads stays 3
    assert config.get_mode("sm2000")["max_concurrent_spreads"] == 3
    assert c["account_floor"] == 300
    assert c["earnings_exclusion_days"] == 7
    assert c["max_opens_per_cycle"] == 1
    assert c["short_put_otm_pct"] == 0.10
    assert c["spread_dte_min"] == 14 and c["spread_dte_max"] == 28
    # sm500-only universe price filter; sm1000/sm2000 unfiltered (None)
    assert config.get_mode("sm500")["max_underlying_price"] == 25
    assert config.get_mode("sm1000").get("max_underlying_price") is None
    assert config.get_mode("sm2000").get("max_underlying_price") is None


def test_sm1000_balanced_posture_params():
    import config
    cfg = config.MODES["sm1000"]
    assert cfg["min_credit_to_width_pct"] == 0.33
    assert cfg["trend_filter"] is True
    assert cfg["spread_stop_credit_mult"] == 2.0
    assert cfg["max_risk_pct_equity"] == 0.10
    assert cfg["max_concurrent_spreads"] == 2
    from screener_core import SM_CURATED_UNIVERSE
    assert cfg["screener_universe"] == SM_CURATED_UNIVERSE


def test_sm2000_balanced_posture_params():
    import config
    cfg = config.MODES["sm2000"]
    assert cfg["min_credit_to_width_pct"] == 0.33
    assert cfg["trend_filter"] is True
    assert cfg["spread_stop_credit_mult"] == 2.0
    assert cfg["max_risk_pct_equity"] == 0.10
    assert cfg["max_concurrent_spreads"] == 3
    from screener_core import SM_CURATED_UNIVERSE
    assert cfg["screener_universe"] == SM_CURATED_UNIVERSE


def test_sm500_conservative_posture_params():
    import config
    cfg = config.MODES["sm500"]
    assert cfg["min_credit_to_width_pct"] == 0.40   # stricter than balanced
    assert cfg["trend_filter"] is True
    assert cfg["spread_stop_credit_mult"] == 2.0
    assert cfg["max_risk_pct_equity"] == 0.20       # 2026-05-21: 0.10 → 0.20
    assert cfg["max_concurrent_spreads"] == 1
    assert cfg["max_underlying_price"] == 25         # retained intentionally
    from screener_core import SM_CURATED_UNIVERSE
    assert cfg["screener_universe"] == SM_CURATED_UNIVERSE


def test_apply_mode_reads_spread_stop_credit_mult_for_sm_modes():
    import wheel_strategy as ws
    ws.apply_mode("sm1000")
    assert ws.SPREAD_STOP_CREDIT_MULT == 2.0


def test_apply_mode_spread_stop_credit_mult_none_for_non_sm_modes():
    import wheel_strategy as ws
    ws.apply_mode("conservative")
    assert ws.SPREAD_STOP_CREDIT_MULT is None
    ws.apply_mode("aggressive")
    assert ws.SPREAD_STOP_CREDIT_MULT is None
    ws.apply_mode("manual")
    assert ws.SPREAD_STOP_CREDIT_MULT is None
    ws.apply_mode("live")
    assert ws.SPREAD_STOP_CREDIT_MULT is None


def test_non_sm_modes_have_no_management_side_hardened_keys():
    """Conservative, aggressive, and live must NOT carry any hardened-engine
    management-side key. Manual is the deliberate exception (2026-05-22): it
    now has opener-side hardened keys (min_credit_to_width_pct, trend_filter)
    because auto_open_spreads is enabled there as a $10k validation shortcut.
    But manual must still NOT have management-side keys (spread_stop_credit_mult,
    underlying tripwire) so existing user-opened spreads keep their original
    50%-of-max-loss stop contract."""
    import config
    # Management-side keys — must stay out of all non-SM modes including manual.
    management_keys = {"spread_stop_credit_mult"}
    # Opener-side keys — out of conservative/aggressive/live; allowed on manual.
    opener_keys = {"min_credit_to_width_pct", "trend_filter", "max_underlying_price"}

    for mode_name in ("conservative", "aggressive", "manual", "live"):
        cfg = config.MODES[mode_name]
        mgmt_leaks = management_keys.intersection(cfg.keys())
        assert not mgmt_leaks, (
            f"{mode_name} has management-side hardened-engine keys leaked "
            f"into its config: {mgmt_leaks}"
        )

    # Opener-side keys still must not leak into cons/agg/live (manual is
    # the deliberate exception).
    for mode_name in ("conservative", "aggressive", "live"):
        cfg = config.MODES[mode_name]
        opener_leaks = opener_keys.intersection(cfg.keys())
        assert not opener_leaks, (
            f"{mode_name} has opener-side hardened-engine keys leaked: "
            f"{opener_leaks}"
        )
        assert cfg.get("auto_open_spreads", False) is False, (
            f"{mode_name} should not have auto_open_spreads enabled"
        )
