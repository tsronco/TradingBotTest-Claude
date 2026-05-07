"""Tests for config.py and the mode-switching machinery.

Verifies that:
  - config.MODES has exactly the three expected modes
  - Each mode's required keys are present
  - Manual mode declares the auto-discover and skip-new-puts flags
  - parse_mode_arg correctly extracts --mode from argv
  - apply_mode in each script switches the right module globals
"""
import pytest

import config


# ── config.MODES sanity ───────────────────────────────────────────────────


def test_modes_dict_has_expected_keys():
    assert set(config.MODES.keys()) == {"conservative", "aggressive", "manual"}


REQUIRED_MODE_KEYS = {
    "alpaca_key_env", "alpaca_secret_env", "alpaca_url_env",
    "trades_channel", "summary_channel", "errors_channel", "actions_channel",
    "log_stream",
    "wheel_state_file", "strategy_state_file",
    "wheel_symbols", "put_strike_pct", "call_strike_pct",
    "put_dte_min", "put_dte_max", "call_dte_min", "call_dte_max",
    "early_close_pct",
    "stale_after_hours",
    "screener_universe", "screener_strike_pct",
    "screener_dte_min", "screener_dte_max",
}


@pytest.mark.parametrize("mode_name", ["conservative", "aggressive", "manual"])
def test_mode_has_all_required_keys(mode_name):
    cfg = config.MODES[mode_name]
    missing = REQUIRED_MODE_KEYS - set(cfg.keys())
    assert not missing, f"{mode_name} mode missing keys: {missing}"


def test_manual_mode_declares_auto_discover_and_skip_new_puts():
    """Manual mode is defined by these two flags — without them, it would
    behave like a third static-symbol mode that auto-executes."""
    cfg = config.MODES["manual"]
    assert cfg.get("auto_discover_symbols") is True, \
        "manual mode must set auto_discover_symbols=True"
    assert cfg.get("wheel_skip_new_puts") is True, \
        "manual mode must set wheel_skip_new_puts=True"


def test_modes_use_distinct_alpaca_credentials():
    """All three modes must hit DIFFERENT paper accounts."""
    keys   = [config.MODES[m]["alpaca_key_env"]    for m in ("conservative", "aggressive", "manual")]
    secrets = [config.MODES[m]["alpaca_secret_env"] for m in ("conservative", "aggressive", "manual")]
    assert len(set(keys))    == 3, f"alpaca_key_env not unique across modes: {keys}"
    assert len(set(secrets)) == 3, f"alpaca_secret_env not unique across modes: {secrets}"


def test_modes_use_distinct_state_files():
    """State files must differ so the three accounts don't share memory."""
    wheel    = [config.MODES[m]["wheel_state_file"]    for m in ("conservative", "aggressive", "manual")]
    strategy = [config.MODES[m]["strategy_state_file"] for m in ("conservative", "aggressive", "manual")]
    streams  = [config.MODES[m]["log_stream"]          for m in ("conservative", "aggressive", "manual")]
    assert len(set(wheel))    == 3, f"wheel_state_file not unique: {wheel}"
    assert len(set(strategy)) == 3, f"strategy_state_file not unique: {strategy}"
    assert len(set(streams))  == 3, f"log_stream not unique: {streams}"


def test_modes_use_distinct_discord_channels():
    """All four channel slots must differ across all three modes."""
    for slot in ("trades_channel", "summary_channel", "errors_channel", "actions_channel"):
        values = [config.MODES[m][slot] for m in ("conservative", "aggressive", "manual")]
        assert len(set(values)) == 3, f"{slot} not differentiated across modes: {values}"


def test_aggressive_is_more_aggressive_than_conservative():
    """Sanity check: the named parameters actually differ in the expected direction."""
    cons = config.MODES["conservative"]
    aggr = config.MODES["aggressive"]
    assert aggr["put_strike_pct"] < cons["put_strike_pct"]   # closer to money
    assert aggr["put_dte_max"]    < cons["put_dte_max"]      # shorter DTE
    assert aggr["early_close_pct"] < cons["early_close_pct"] # earlier close


def test_aggressive_includes_high_iv_symbols():
    """Aggressive wheel SYMBOLS should include the volatile names we picked."""
    aggr_symbols = set(config.MODES["aggressive"]["wheel_symbols"])
    expected_high_iv = {"COIN", "MARA", "RIOT", "SMCI", "NVDA", "AMD", "MU"}
    missing = expected_high_iv - aggr_symbols
    assert not missing, f"aggressive missing expected high-IV: {missing}"


# ── parse_mode_arg ────────────────────────────────────────────────────────


def test_parse_mode_default_when_absent():
    mode, remaining = config.parse_mode_arg(["once"])
    assert mode == "conservative"
    assert remaining == ["once"]


def test_parse_mode_two_token_form():
    mode, remaining = config.parse_mode_arg(["--mode", "aggressive", "once"])
    assert mode == "aggressive"
    assert remaining == ["once"]


def test_parse_mode_equals_form():
    mode, remaining = config.parse_mode_arg(["--mode=aggressive", "once"])
    assert mode == "aggressive"
    assert remaining == ["once"]


def test_parse_mode_can_appear_after_command():
    mode, remaining = config.parse_mode_arg(["once", "--mode", "aggressive"])
    assert mode == "aggressive"
    assert remaining == ["once"]


def test_parse_mode_ignores_other_args():
    mode, remaining = config.parse_mode_arg(["once", "--head-to-head"])
    assert mode == "conservative"
    assert remaining == ["once", "--head-to-head"]


# ── get_mode validation ───────────────────────────────────────────────────


def test_get_mode_raises_on_unknown():
    with pytest.raises(ValueError, match="Unknown mode"):
        config.get_mode("yolo")


def test_get_mode_returns_dict():
    cfg = config.get_mode("aggressive")
    assert isinstance(cfg, dict)
    assert cfg["wheel_state_file"] == "wheel_state_aggressive.json"


# ── Module-level apply_mode tests ─────────────────────────────────────────


def test_wheel_strategy_apply_mode_switches_globals():
    import wheel_strategy as ws
    ws.apply_mode("conservative")
    assert ws.MODE == "conservative"
    assert ws.STATE_FILE.endswith("wheel_state.json")
    assert ws.TRADES_CH == "tsla"
    assert ws.PUT_STRIKE_PCT == 0.10

    ws.apply_mode("aggressive")
    assert ws.MODE == "aggressive"
    assert ws.STATE_FILE.endswith("wheel_state_aggressive.json")
    assert ws.TRADES_CH == "agg_trades"
    assert ws.PUT_STRIKE_PCT == 0.05

    # Reset for any later tests that assume conservative defaults.
    ws.apply_mode("conservative")


def test_strategy_apply_mode_switches_globals():
    import strategy
    strategy.apply_mode("aggressive")
    assert strategy.MODE == "aggressive"
    assert strategy.STATE_FILE.endswith("strategy_state_aggressive.json")
    assert strategy.TRADES_CH == "agg_trades"
    strategy.apply_mode("conservative")


def test_long_options_apply_mode_propagates_to_wheel_strategy():
    """long_options_strategy.apply_mode MUST also switch wheel_strategy
    because long_options_strategy reuses wheel_strategy's API helpers."""
    import long_options_strategy as los
    import wheel_strategy as ws

    los.apply_mode("aggressive")
    assert los.MODE == "aggressive"
    assert ws.MODE == "aggressive", "long_options didn't propagate mode to wheel_strategy"

    los.apply_mode("conservative")
    assert ws.MODE == "conservative"


def test_wheel_screener_apply_mode_switches_universe():
    import wheel_screener as wsc
    wsc.apply_mode("conservative")
    cons_universe = set(wsc.UNIVERSE)
    cons_dte_min  = wsc.TARGET_DTE_MIN

    wsc.apply_mode("aggressive")
    aggr_universe = set(wsc.UNIVERSE)
    aggr_dte_min  = wsc.TARGET_DTE_MIN

    assert cons_universe != aggr_universe, "screener universes should differ"
    assert "MSTR" in aggr_universe, "aggressive screener should include MSTR"
    assert "AAPL" in cons_universe, "conservative screener should include AAPL"
    assert aggr_dte_min < cons_dte_min, "aggressive should screen shorter DTE"

    wsc.apply_mode("conservative")


# ── Manual-mode-specific behaviour ────────────────────────────────────────


def test_wheel_strategy_apply_mode_manual_sets_skip_flags():
    """Manual mode must populate both behaviour flags on wheel_strategy."""
    import wheel_strategy as ws
    ws.apply_mode("manual")
    assert ws.MODE == "manual"
    assert ws.WHEEL_SKIP_NEW_PUTS is True
    assert ws.AUTO_DISCOVER_SYMBOLS is True
    assert ws.STATE_FILE.endswith("wheel_state_manual.json")
    assert ws.TRADES_CH == "manual_trades"
    # Manual mirrors conservative wheel parameters
    assert ws.PUT_STRIKE_PCT  == 0.10
    assert ws.EARLY_CLOSE_PCT == 0.50
    ws.apply_mode("conservative")
    # Conservative must NOT have these flags set after switching back
    assert ws.WHEEL_SKIP_NEW_PUTS is False
    assert ws.AUTO_DISCOVER_SYMBOLS is False


def test_strategy_apply_mode_manual_enables_auto_discover():
    """strategy.auto_discover_enabled() must report True only for manual."""
    import strategy
    strategy.apply_mode("conservative")
    assert strategy.auto_discover_enabled() is False
    strategy.apply_mode("aggressive")
    assert strategy.auto_discover_enabled() is False
    strategy.apply_mode("manual")
    assert strategy.MODE == "manual"
    assert strategy.STATE_FILE.endswith("strategy_state_manual.json")
    assert strategy.TRADES_CH == "manual_trades"
    assert strategy.auto_discover_enabled() is True
    strategy.apply_mode("conservative")
