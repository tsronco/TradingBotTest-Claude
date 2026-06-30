"""Tests for config.py and the mode-switching machinery.

Verifies that:
  - config.MODES has exactly the two expected modes (manual + live)
  - Each mode's required keys are present
  - Manual + live modes declare the auto-discover and skip-new-puts flags
  - parse_mode_arg correctly extracts --mode from argv
  - apply_mode in each script switches the right module globals

(History: conservative, aggressive, and sm500/sm1000/sm2000 were retired
2026-06-29. The shared strategy/wheel/auto-spread engine is unchanged.)
"""
import pytest

import config


ALL_MODES = ("manual", "live")


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


def test_retired_modes_are_gone():
    """The five sunset accounts must not reappear in config.MODES."""
    for m in ("conservative", "aggressive", "sm500", "sm1000", "sm2000"):
        assert m not in config.MODES, f"{m} should have been removed"


def test_modes_use_distinct_alpaca_credentials():
    """The two modes must hit DIFFERENT accounts (1 paper + 1 live)."""
    keys    = [config.MODES[m]["alpaca_key_env"]    for m in ALL_MODES]
    secrets = [config.MODES[m]["alpaca_secret_env"] for m in ALL_MODES]
    assert len(set(keys))    == len(ALL_MODES), f"alpaca_key_env not unique: {keys}"
    assert len(set(secrets)) == len(ALL_MODES), f"alpaca_secret_env not unique: {secrets}"


def test_live_mode_uses_live_credentials_env():
    """Live must read from ALPACA_LIVE_* env vars, NOT the paper vars.
    A typo here would point the real-money bot at a paper account or vice
    versa — both bad in their own ways."""
    cfg = config.MODES["live"]
    assert cfg["alpaca_key_env"]    == "ALPACA_LIVE_API_KEY"
    assert cfg["alpaca_secret_env"] == "ALPACA_LIVE_API_SECRET"
    assert cfg["alpaca_url_env"]    == "ALPACA_LIVE_BASE_URL"


def test_modes_use_distinct_state_files():
    """State files must differ so the two accounts don't share memory."""
    wheel    = [config.MODES[m]["wheel_state_file"]    for m in ALL_MODES]
    strategy = [config.MODES[m]["strategy_state_file"] for m in ALL_MODES]
    streams  = [config.MODES[m]["log_stream"]          for m in ALL_MODES]
    assert len(set(wheel))    == len(ALL_MODES), f"wheel_state_file not unique: {wheel}"
    assert len(set(strategy)) == len(ALL_MODES), f"strategy_state_file not unique: {strategy}"
    assert len(set(streams))  == len(ALL_MODES), f"log_stream not unique: {streams}"


def test_modes_use_distinct_discord_channels():
    """All four channel slots must differ across both modes."""
    for slot in ("trades_channel", "summary_channel", "errors_channel", "actions_channel"):
        values = [config.MODES[m][slot] for m in ALL_MODES]
        assert len(set(values)) == len(ALL_MODES), \
            f"{slot} not differentiated across modes: {values}"


# ── parse_mode_arg ────────────────────────────────────────────────────────


def test_parse_mode_default_when_absent():
    mode, remaining = config.parse_mode_arg(["once"])
    assert mode == "manual"   # DEFAULT_MODE
    assert remaining == ["once"]


def test_parse_mode_two_token_form():
    mode, remaining = config.parse_mode_arg(["--mode", "live", "once"])
    assert mode == "live"
    assert remaining == ["once"]


def test_parse_mode_equals_form():
    mode, remaining = config.parse_mode_arg(["--mode=live", "once"])
    assert mode == "live"
    assert remaining == ["once"]


def test_parse_mode_can_appear_after_command():
    mode, remaining = config.parse_mode_arg(["once", "--mode", "live"])
    assert mode == "live"
    assert remaining == ["once"]


def test_parse_mode_ignores_other_args():
    mode, remaining = config.parse_mode_arg(["once", "--verbose"])
    assert mode == "manual"
    assert remaining == ["once", "--verbose"]


# ── get_mode validation ───────────────────────────────────────────────────


def test_get_mode_raises_on_unknown():
    with pytest.raises(ValueError, match="Unknown mode"):
        config.get_mode("yolo")


def test_get_mode_returns_dict():
    cfg = config.get_mode("manual")
    assert isinstance(cfg, dict)
    assert cfg["wheel_state_file"] == "wheel_state_manual.json"


# ── Module-level apply_mode tests ─────────────────────────────────────────


def test_wheel_strategy_apply_mode_switches_globals():
    import wheel_strategy as ws
    ws.apply_mode("manual")
    assert ws.MODE == "manual"
    assert ws.STATE_FILE.endswith("wheel_state_manual.json")
    assert ws.TRADES_CH == "manual_trades"
    assert ws.PUT_STRIKE_PCT == 0.10

    ws.apply_mode("live")
    assert ws.MODE == "live"
    assert ws.STATE_FILE.endswith("wheel_state_live.json")
    assert ws.TRADES_CH == "live_trades"
    assert ws.PUT_STRIKE_PCT == 0.10

    # Reset for any later tests that assume default-mode globals.
    ws.apply_mode(config.DEFAULT_MODE)


def test_strategy_apply_mode_switches_globals():
    import strategy
    strategy.apply_mode("live")
    assert strategy.MODE == "live"
    assert strategy.STATE_FILE.endswith("strategy_state_live.json")
    assert strategy.TRADES_CH == "live_trades"
    strategy.apply_mode(config.DEFAULT_MODE)


def test_long_options_apply_mode_propagates_to_wheel_strategy():
    """long_options_strategy.apply_mode MUST also switch wheel_strategy
    because long_options_strategy reuses wheel_strategy's API helpers."""
    import long_options_strategy as los
    import wheel_strategy as ws

    los.apply_mode("live")
    assert los.MODE == "live"
    assert ws.MODE == "live", "long_options didn't propagate mode to wheel_strategy"

    los.apply_mode("manual")
    assert ws.MODE == "manual"


def test_wheel_screener_apply_mode_switches_universe():
    import wheel_screener as wsc
    wsc.apply_mode("manual")
    manual_universe = set(wsc.UNIVERSE)

    wsc.apply_mode("live")
    live_universe = set(wsc.UNIVERSE)

    # manual screens the curated auto-spread universe; live falls through to
    # the default large-cap universe — they should differ, both non-empty.
    assert manual_universe, "manual screener universe should be non-empty"
    assert live_universe, "live screener universe should be non-empty"
    assert manual_universe != live_universe, "screener universes should differ"

    wsc.apply_mode(config.DEFAULT_MODE)


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
    assert ws.PUT_STRIKE_PCT  == 0.10
    assert ws.EARLY_CLOSE_PCT == 0.50
    ws.apply_mode(config.DEFAULT_MODE)


def test_strategy_apply_mode_manual_and_live_enable_auto_discover():
    """strategy.auto_discover_enabled() must report True for both surviving
    modes (manual + live), the two user-driven accounts."""
    import strategy
    strategy.apply_mode("manual")
    assert strategy.MODE == "manual"
    assert strategy.STATE_FILE.endswith("strategy_state_manual.json")
    assert strategy.TRADES_CH == "manual_trades"
    assert strategy.auto_discover_enabled() is True
    strategy.apply_mode("live")
    assert strategy.auto_discover_enabled() is True
    strategy.apply_mode(config.DEFAULT_MODE)


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
    assert ws.PUT_STRIKE_PCT  == 0.10
    assert ws.EARLY_CLOSE_PCT == 0.50
    ws.apply_mode(config.DEFAULT_MODE)


def test_strategy_apply_mode_live_enables_auto_discover():
    """Live, like manual, must auto-discover symbols and write to live state."""
    import strategy
    strategy.apply_mode("live")
    assert strategy.MODE == "live"
    assert strategy.STATE_FILE.endswith("strategy_state_live.json")
    assert strategy.TRADES_CH == "live_trades"
    assert strategy.auto_discover_enabled() is True
    strategy.apply_mode(config.DEFAULT_MODE)


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
    """Every mode must declare spread_management explicitly so handle_spread()
    logic has a deterministic toggle."""
    for mode_name, mode_cfg in config.MODES.items():
        assert "spread_management" in mode_cfg, (
            f"mode {mode_name} missing spread_management flag"
        )
        assert isinstance(mode_cfg["spread_management"], bool), (
            f"mode {mode_name} spread_management must be bool"
        )


def test_all_modes_declare_spread_thresholds():
    """Every mode must declare the three spread management thresholds
    consistently. Default values are: 50% early close, 50% stop loss
    (manual was loosened 0.50 → 0.75 on 2026-05-22 after a same-day
    MU whipsaw stop), DTE floor of 2."""
    expected = {
        "spread_early_close_pct": 0.50,
        "spread_stop_loss_pct":   0.50,
        "spread_dte_floor":       2,
    }
    # Per-mode overrides — assert intentional deviations, not legacy drift.
    overrides = {
        "manual": {"spread_stop_loss_pct": 0.75},
    }
    for mode_name, mode_cfg in config.MODES.items():
        for key, value in expected.items():
            assert key in mode_cfg, f"mode {mode_name} missing {key}"
            expected_val = overrides.get(mode_name, {}).get(key, value)
            assert mode_cfg[key] == expected_val, (
                f"mode {mode_name} {key}={mode_cfg[key]!r}, "
                f"expected {expected_val!r}"
            )


def test_only_manual_has_spread_management_enabled():
    """Spread management is enabled on manual paper; live keeps it False until
    a future plan flips it deliberately."""
    assert config.MODES["manual"]["spread_management"] is True
    assert config.MODES["live"]["spread_management"] is False


def test_sm_management_keys_absent_from_surviving_modes():
    """The SM-only 2×-credit stop (spread_stop_credit_mult) must never silently
    appear on manual/live — if added it would retighten the stop on real/
    hand-opened spreads mid-trade.

    (Restores a guard deleted with tests/test_modes_sm.py when the SM accounts
    were retired 2026-06-29.)
    """
    assert "spread_stop_credit_mult" not in config.MODES["manual"], (
        "spread_stop_credit_mult must not be set on manual — it would silently "
        "tighten the stop on hand-opened spreads mid-trade"
    )
    assert "spread_stop_credit_mult" not in config.MODES["live"], (
        "spread_stop_credit_mult must not be set on live — real-money spreads "
        "should not have their stop tightened by an SM-era parameter"
    )


def test_auto_open_spreads_disabled_on_surviving_modes():
    """The autonomous spread opener must not be enabled on real money (live) or
    re-enabled on manual without a deliberate, test-visible change.

    Manual has auto_open_spreads explicitly False since 2026-06-03 PDT (PDT
    trader flagging shut it down after a PDT violation). Live omits the key
    entirely; both must resolve to False.
    """
    assert config.MODES["manual"].get("auto_open_spreads", False) is False, (
        "auto_open_spreads must remain False on manual (PDT-protection: "
        "same-day churn trips pattern-day-trader rules on a sub-$25k account)"
    )
    assert config.MODES["live"].get("auto_open_spreads", False) is False, (
        "auto_open_spreads must never be enabled on the live real-money account "
        "without an explicit, reviewed plan"
    )
