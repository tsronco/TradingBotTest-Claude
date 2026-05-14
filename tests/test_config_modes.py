"""Tests for config.py and the mode-switching machinery.

Verifies that:
  - config.MODES has exactly the four expected modes
  - Each mode's required keys are present
  - Manual + live modes declare the auto-discover and skip-new-puts flags
  - parse_mode_arg correctly extracts --mode from argv
  - apply_mode in each script switches the right module globals
"""
import pytest

import config


ALL_MODES = ("conservative", "aggressive", "manual", "live")


# ── config.MODES sanity ───────────────────────────────────────────────────


def test_modes_dict_has_expected_keys():
    assert set(config.MODES.keys()) == set(ALL_MODES)


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


@pytest.mark.parametrize("mode_name", list(ALL_MODES))
def test_mode_has_all_required_keys(mode_name):
    cfg = config.MODES[mode_name]
    missing = REQUIRED_MODE_KEYS - set(cfg.keys())
    assert not missing, f"{mode_name} mode missing keys: {missing}"


@pytest.mark.parametrize("mode_name", ["manual", "live"])
def test_user_driven_modes_declare_auto_discover_and_skip_new_puts(mode_name):
    """Manual and live modes are defined by these two flags — without them
    they would behave like static-symbol modes that auto-execute. Live
    intentionally mirrors manual's behaviour on real-money credentials."""
    cfg = config.MODES[mode_name]
    assert cfg.get("auto_discover_symbols") is True, \
        f"{mode_name} mode must set auto_discover_symbols=True"
    assert cfg.get("wheel_skip_new_puts") is True, \
        f"{mode_name} mode must set wheel_skip_new_puts=True"


def test_auto_execute_modes_do_not_set_skip_flags():
    """Conservative + aggressive must NOT carry the manual/live flags —
    otherwise they would stop opening new puts."""
    for m in ("conservative", "aggressive"):
        cfg = config.MODES[m]
        assert not cfg.get("auto_discover_symbols", False), \
            f"{m} must not set auto_discover_symbols"
        assert not cfg.get("wheel_skip_new_puts", False), \
            f"{m} must not set wheel_skip_new_puts"


def test_modes_use_distinct_alpaca_credentials():
    """All four modes must hit DIFFERENT accounts (3 paper + 1 live)."""
    keys    = [config.MODES[m]["alpaca_key_env"]    for m in ALL_MODES]
    secrets = [config.MODES[m]["alpaca_secret_env"] for m in ALL_MODES]
    assert len(set(keys))    == len(ALL_MODES), f"alpaca_key_env not unique: {keys}"
    assert len(set(secrets)) == len(ALL_MODES), f"alpaca_secret_env not unique: {secrets}"


def test_live_mode_uses_live_credentials_env():
    """Live must read from ALPACA_LIVE_* env vars, NOT any of the paper vars.
    A typo here would point the real-money bot at a paper account or vice
    versa — both bad in their own ways."""
    cfg = config.MODES["live"]
    assert cfg["alpaca_key_env"]    == "ALPACA_LIVE_API_KEY"
    assert cfg["alpaca_secret_env"] == "ALPACA_LIVE_API_SECRET"
    assert cfg["alpaca_url_env"]    == "ALPACA_LIVE_BASE_URL"


def test_modes_use_distinct_state_files():
    """State files must differ so the four accounts don't share memory."""
    wheel    = [config.MODES[m]["wheel_state_file"]    for m in ALL_MODES]
    strategy = [config.MODES[m]["strategy_state_file"] for m in ALL_MODES]
    streams  = [config.MODES[m]["log_stream"]          for m in ALL_MODES]
    assert len(set(wheel))    == len(ALL_MODES), f"wheel_state_file not unique: {wheel}"
    assert len(set(strategy)) == len(ALL_MODES), f"strategy_state_file not unique: {strategy}"
    assert len(set(streams))  == len(ALL_MODES), f"log_stream not unique: {streams}"


def test_modes_use_distinct_discord_channels():
    """All four channel slots must differ across all four modes."""
    for slot in ("trades_channel", "summary_channel", "errors_channel", "actions_channel"):
        values = [config.MODES[m][slot] for m in ALL_MODES]
        assert len(set(values)) == len(ALL_MODES), \
            f"{slot} not differentiated across modes: {values}"


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
    """strategy.auto_discover_enabled() must report True for manual and live
    (the two user-driven modes), False for conservative and aggressive."""
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


def test_wheel_strategy_apply_mode_live_mirrors_manual_behaviour():
    """Live must set the same two behaviour flags as manual, write to live
    state files, and post to live Discord channels."""
    import wheel_strategy as ws
    ws.apply_mode("live")
    assert ws.MODE == "live"
    assert ws.WHEEL_SKIP_NEW_PUTS is True
    assert ws.AUTO_DISCOVER_SYMBOLS is True
    assert ws.STATE_FILE.endswith("wheel_state_live.json")
    assert ws.TRADES_CH == "live_trades"
    # Live mirrors conservative/manual wheel parameters
    assert ws.PUT_STRIKE_PCT  == 0.10
    assert ws.EARLY_CLOSE_PCT == 0.50
    ws.apply_mode("conservative")


def test_strategy_apply_mode_live_enables_auto_discover():
    """Live, like manual, must auto-discover symbols and write to live state."""
    import strategy
    strategy.apply_mode("live")
    assert strategy.MODE == "live"
    assert strategy.STATE_FILE.endswith("strategy_state_live.json")
    assert strategy.TRADES_CH == "live_trades"
    assert strategy.auto_discover_enabled() is True
    strategy.apply_mode("conservative")


def test_each_mode_channel_names_are_wired_in_discord_channel_map():
    """Every channel name referenced in config.MODES MUST have a matching
    entry in notifications.discord.CHANNEL_ENV_MAP — otherwise messages get
    silently dropped (the function falls back to a no-op when the channel
    name isn't recognized)."""
    from notifications.discord import CHANNEL_ENV_MAP
    for mode_name, cfg in config.MODES.items():
        for slot in ("trades_channel", "summary_channel", "errors_channel", "actions_channel"):
            ch = cfg[slot]
            assert ch in CHANNEL_ENV_MAP, \
                f"{mode_name}.{slot}='{ch}' not in CHANNEL_ENV_MAP — messages would be dropped"


def test_all_modes_declare_spread_management_flag():
    """Every mode must declare spread_management explicitly so future
    handle_spread() logic has a deterministic toggle. The per-mode value
    is asserted by test_only_manual_has_spread_management_enabled below."""
    import config
    for mode_name, mode_cfg in config.MODES.items():
        assert "spread_management" in mode_cfg, (
            f"mode {mode_name} missing spread_management flag"
        )
        assert isinstance(mode_cfg["spread_management"], bool), (
            f"mode {mode_name} spread_management must be bool"
        )


def test_all_modes_declare_spread_thresholds():
    """Every mode must declare the three spread management thresholds
    consistently. Default values are: 50% early close, 50% stop loss,
    DTE floor of 2."""
    import config
    expected = {
        "spread_early_close_pct": 0.50,
        "spread_stop_loss_pct":   0.50,
        "spread_dte_floor":       2,
    }
    for mode_name, mode_cfg in config.MODES.items():
        for key, value in expected.items():
            assert key in mode_cfg, f"mode {mode_name} missing {key}"
            assert mode_cfg[key] == value, (
                f"mode {mode_name} {key}={mode_cfg[key]!r}, "
                f"expected {value!r}"
            )


def test_only_manual_has_spread_management_enabled():
    """Phase 2 enables spread management on manual paper account only.
    Other modes must keep spread_management=False until later plans
    flip them deliberately."""
    import config
    assert config.MODES["manual"]["spread_management"] is True
    for mode_name in ("conservative", "aggressive", "live"):
        assert config.MODES[mode_name]["spread_management"] is False, (
            f"mode {mode_name} should still have spread_management=False"
        )
