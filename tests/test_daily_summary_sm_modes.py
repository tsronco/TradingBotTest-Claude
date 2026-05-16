"""Tests for Phase 5 (Task 5.2): sm500/sm1000/sm2000 daily-summary inclusion.

Verifies:
  1. run_daily_summary accepts each SM mode and routes the embed to that
     mode's summary_channel (each SM mode has its own channel, not shared
     with conservative/aggressive/manual/live).
  2. run_head_to_head uses ONLY conservative and aggressive — SM modes are
     NOT included in the head-to-head comparison.
  3. SM modes can render a spread section (the existing spread-rendering
     code is generic over the wheel state structure, which SM shares).
"""
import json
import pytest

import config
import daily_summary


SM_MODES = ("sm500", "sm1000", "sm2000")


# ── per-mode channel isolation ────────────────────────────────────────────


def test_sm_modes_have_distinct_summary_channels():
    """Each SM mode must route to its own summary channel, different from
    each other and from conservative/aggressive/manual/live."""
    all_summary_channels = {
        config.get_mode(m)["summary_channel"]
        for m in ("conservative", "aggressive", "manual", "live", "sm500", "sm1000", "sm2000")
    }
    # 7 modes -> 7 distinct channels (no sharing)
    assert len(all_summary_channels) == 7, (
        f"Expected 7 distinct summary channels, got {len(all_summary_channels)}: "
        f"{all_summary_channels}"
    )


# ── run_daily_summary routes to SM channels ───────────────────────────────


@pytest.mark.parametrize("mode_name", SM_MODES)
def test_run_daily_summary_posts_to_sm_summary_channel(monkeypatch, mode_name):
    """run_daily_summary('smN') must post the embed to the smN summary
    channel and NOT to any other mode's channel."""
    expected_channel = config.get_mode(mode_name)["summary_channel"]

    # Minimal mocks so run_daily_summary runs end-to-end without side effects.
    monkeypatch.setattr(daily_summary, "_get_account", lambda cfg: {
        "cash": "500", "equity": "500", "portfolio_value": "500",
    })
    monkeypatch.setattr(daily_summary, "_get_positions", lambda cfg: [])
    monkeypatch.setattr(daily_summary, "_summarize_strategy", lambda cfg: {"available": False})
    monkeypatch.setattr(daily_summary, "_summarize_long_options",
                        lambda cfg, exclude_occs=None: {"available": False, "count": 0})
    monkeypatch.setattr(daily_summary, "_summarize_held_stocks",
                        lambda cfg, tracked: {"available": False})
    monkeypatch.setattr(daily_summary, "_summarize_congress",
                        lambda: {"available": False})

    # Provide a minimal wheel state so _summarize_wheel returns something,
    # but no spreads — we test spreads separately below.
    monkeypatch.setattr(daily_summary, "_summarize_wheel", lambda cfg: {
        "available": True,
        "format": "multi_stock",
        "symbols": {},
        "spreads": {},
        "total_premium": 0.0,
        "total_today": 0.0,
        "total_cycles": 0,
    })

    posted_to = []
    monkeypatch.setattr(daily_summary, "send_embed",
                        lambda ch, title, **kw: posted_to.append(ch))
    monkeypatch.setattr(daily_summary, "log_event",
                        lambda *args, **kw: None)

    daily_summary.run_daily_summary(mode_name)

    assert posted_to, f"run_daily_summary('{mode_name}') did not call send_embed"
    assert posted_to[0] == expected_channel, (
        f"Expected embed to '{expected_channel}', got '{posted_to[0]}'"
    )


# ── head-to-head does NOT include SM modes ────────────────────────────────


def test_run_head_to_head_only_queries_conservative_and_aggressive(monkeypatch):
    """run_head_to_head must only access the conservative and aggressive
    Alpaca accounts. It must NOT call _get_account or _get_positions for
    sm500, sm1000, or sm2000 — those have different capital bases and are
    excluded from the 2-way comparison by design."""
    queried_modes = []

    def mock_snapshot(cfg):
        # Identify which mode this snapshot is for by its alpaca_key_env
        for mode_name, mode_cfg in config.MODES.items():
            if mode_cfg.get("alpaca_key_env") == cfg.get("alpaca_key_env"):
                queried_modes.append(mode_name)
                break
        return {
            "equity": 100_000.0, "cash": 50_000.0, "portfolio": 100_000.0,
            "premium_today": 0.0, "premium_total": 0.0, "cycles": 0,
            "long_pnl": 0.0, "long_count": 0, "wheel_symbols": [],
        }

    monkeypatch.setattr(daily_summary, "_snapshot", mock_snapshot)
    monkeypatch.setattr(daily_summary, "send_embed",
                        lambda ch, title, **kw: None)
    monkeypatch.setattr(daily_summary, "log_event",
                        lambda *args, **kw: None)

    daily_summary.run_head_to_head()

    assert set(queried_modes) == {"conservative", "aggressive"}, (
        f"head-to-head queried unexpected modes: {queried_modes}. "
        f"SM modes must NOT be in the head-to-head comparison."
    )


def test_run_head_to_head_posts_to_conservative_and_aggressive_channels_only(monkeypatch):
    """The head-to-head embed must land only in the conservative and
    aggressive summary channels — never in sm500/sm1000/sm2000 channels."""
    sm_summary_channels = {
        config.get_mode(m)["summary_channel"] for m in SM_MODES
    }

    monkeypatch.setattr(daily_summary, "_snapshot", lambda cfg: {
        "equity": 100_000.0, "cash": 50_000.0, "portfolio": 100_000.0,
        "premium_today": 0.0, "premium_total": 0.0, "cycles": 0,
        "long_pnl": 0.0, "long_count": 0, "wheel_symbols": [],
    })

    posted_to = []
    monkeypatch.setattr(daily_summary, "send_embed",
                        lambda ch, title, **kw: posted_to.append(ch))
    monkeypatch.setattr(daily_summary, "log_event",
                        lambda *args, **kw: None)

    daily_summary.run_head_to_head()

    for ch in posted_to:
        assert ch not in sm_summary_channels, (
            f"head-to-head posted to SM channel '{ch}' — must not happen"
        )

    # And it must post to at least one channel (the two it's supposed to)
    assert len(posted_to) >= 1, "head-to-head posted no embeds at all"


# ── SM modes render the spread section (re-uses existing generic code) ────


@pytest.mark.parametrize("mode_name", SM_MODES)
def test_sm_mode_summarize_wheel_includes_spreads_field(monkeypatch, tmp_path, mode_name):
    """_summarize_wheel is mode-agnostic and reads any wheel state file.
    For SM modes (which hold auto-opened put credit spreads), the spreads
    block must populate when the state file contains spread_active entries.
    This confirms SM spread data will render in the daily summary."""
    state = {
        "_meta": {},
        "F": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "F260620P00011000", "strike": 11.0,
                          "entry_premium": 0.28, "qty": 1},
            "long_leg":  {"occ": "F260620P00010000", "strike": 10.0,
                          "entry_premium": 0.08, "qty": 1},
            "expiration": "2026-06-20",
            "net_credit": 0.20, "max_loss": 0.80, "width": 1.0,
            "opened_at": "2026-05-16T15:00:00Z",
            "total_premium_collected": 0.0, "cycle_count": 0,
            "cycle_history": [], "last_action": "",
        },
    }
    # Write the state to the SM mode's expected state file path.
    state_file_name = config.get_mode(mode_name)["wheel_state_file"]
    state_file = tmp_path / state_file_name
    state_file.write_text(json.dumps(state))

    # Temporarily redirect daily_summary's ROOT to tmp_path so it finds the file.
    original_root = daily_summary.ROOT
    daily_summary.ROOT = tmp_path
    try:
        result = daily_summary._summarize_wheel({"wheel_state_file": state_file_name})
    finally:
        daily_summary.ROOT = original_root

    assert result["available"] is True
    assert result["format"] == "multi_stock"
    assert "F" in result["spreads"], (
        f"SM mode '{mode_name}' spread not found in _summarize_wheel output"
    )
    sp = result["spreads"]["F"]
    assert sp["spread_type"] == "put_credit"
    assert sp["net_credit"] == 0.20
    assert sp["short_strike"] == 11.0
    assert sp["long_strike"] == 10.0
