"""Tests for the autonomous agent paper account's configuration + wiring.

The agent account is a separate subsystem from the wheel modes (manual + live).
It carries none of the wheel parameter surface and must NOT appear in
config.MODES. These tests verify that separation, and that the shared read-only
infra (alpaca_data credentials, Discord channel map) recognizes the "agent"
string with its own isolated credentials / channels / state file — so the agent
account can never cross-pollinate with the manual or live accounts.
"""
import os

import pytest

import agent_config
import alpaca_data
import config
from notifications import discord


# ── Separation from the wheel modes ────────────────────────────────────────

def test_agent_is_not_a_wheel_mode():
    """The agent must NOT be registered in config.MODES — it runs none of the
    wheel/strategy/screener machinery, and config.MODES is locked to manual+live."""
    assert "agent" not in config.MODES


def test_agent_config_has_required_keys():
    cfg = agent_config.get()
    required = {
        "alpaca_key_env", "alpaca_secret_env", "alpaca_url_env",
        "trades_channel", "summary_channel", "errors_channel", "actions_channel",
        "log_stream", "state_file", "max_decision_tokens",
        "seed_capital", "equity_floor", "universe",
    }
    missing = required - set(cfg.keys())
    assert not missing, f"agent config missing keys: {missing}"


# ── Credential isolation ────────────────────────────────────────────────────

def test_agent_credentials_are_distinct_from_wheel_accounts():
    """Agent must read its OWN Alpaca env vars, never manual's or live's."""
    cfg = agent_config.get()
    assert cfg["alpaca_key_env"] == "ALPACA_AGENT_API_KEY"
    assert cfg["alpaca_secret_env"] == "ALPACA_AGENT_API_SECRET"
    assert cfg["alpaca_url_env"] == "ALPACA_AGENT_BASE_URL"

    wheel_key_envs = {config.MODES[m]["alpaca_key_env"] for m in ("manual", "live")}
    wheel_secret_envs = {config.MODES[m]["alpaca_secret_env"] for m in ("manual", "live")}
    assert cfg["alpaca_key_env"] not in wheel_key_envs
    assert cfg["alpaca_secret_env"] not in wheel_secret_envs


def test_alpaca_data_reads_agent_credentials(monkeypatch):
    """alpaca_data._credentials('agent') must read the ALPACA_AGENT_* env vars."""
    monkeypatch.setenv("ALPACA_AGENT_API_KEY", "AGENT_KEY_XYZ")
    monkeypatch.setenv("ALPACA_AGENT_API_SECRET", "AGENT_SECRET_XYZ")
    monkeypatch.setenv("ALPACA_MANUAL_API_KEY", "MANUAL_KEY")
    monkeypatch.setenv("ALPACA_LIVE_API_KEY", "LIVE_KEY")
    key, secret = alpaca_data._credentials("agent")
    assert key == "AGENT_KEY_XYZ"
    assert secret == "AGENT_SECRET_XYZ"


def test_agent_uses_paper_trading_endpoint():
    """Agent is a PAPER account — its trading base must be the paper endpoint,
    never the real-money live endpoint."""
    base = alpaca_data._trading_base("agent")
    assert "paper-api.alpaca.markets" in base
    assert base != alpaca_data.LIVE_TRADING_API_URL


# ── Discord channel isolation ───────────────────────────────────────────────

def test_agent_discord_channels_are_mapped_and_distinct():
    cfg = agent_config.get()
    agent_slots = [cfg["trades_channel"], cfg["summary_channel"],
                   cfg["errors_channel"], cfg["actions_channel"]]
    # All four map to a real env var in the channel map.
    for ch in agent_slots:
        assert ch in discord.CHANNEL_ENV_MAP, f"{ch} not in Discord channel map"
        assert discord.CHANNEL_ENV_MAP[ch].startswith("DISCORD_AGENT_")

    # And they don't collide with any manual/live channel name.
    wheel_channels = set()
    for m in ("manual", "live"):
        for slot in ("trades_channel", "summary_channel", "errors_channel", "actions_channel"):
            wheel_channels.add(config.MODES[m][slot])
    assert not (set(agent_slots) & wheel_channels)


# ── State-file isolation ────────────────────────────────────────────────────

def test_agent_state_file_is_distinct():
    cfg = agent_config.get()
    wheel_states = set()
    for m in ("manual", "live"):
        wheel_states.add(config.MODES[m]["wheel_state_file"])
        wheel_states.add(config.MODES[m]["strategy_state_file"])
    assert cfg["state_file"] == "agent_state.json"
    assert cfg["state_file"] not in wheel_states


def test_agent_log_stream_is_distinct():
    cfg = agent_config.get()
    wheel_streams = {config.MODES[m]["log_stream"] for m in ("manual", "live")}
    assert cfg["log_stream"] == "agent"
    assert cfg["log_stream"] not in wheel_streams


# ── Guard values ────────────────────────────────────────────────────────────

def test_equity_floor_below_seed_and_nonnegative():
    cfg = agent_config.get()
    assert cfg["seed_capital"] > 0
    assert 0 <= cfg["equity_floor"] < cfg["seed_capital"]


def test_per_trade_size_cap_is_present_and_bounded():
    """A single OPEN's defined-risk max loss is capped at this fraction of equity
    (enforced in check_feasibility). Must be a sane 0<pct<=1 seatbelt."""
    cfg = agent_config.get()
    pct = cfg["max_risk_pct_equity"]
    assert 0 < pct <= 1, f"unexpected size cap {pct}"


def test_universe_is_wide_liquid_and_deduped():
    """The agent scans a wide field (~150-250 names) so it has real choice. The
    two-phase scan (quotes for all, chains for a shortlist) keeps this cheap."""
    universe = agent_config.get()["universe"]
    assert isinstance(universe, list) and universe, "universe must be a non-empty list"
    # Wide enough to give the agent genuine breadth, capped so it stays curated.
    assert 150 <= len(universe) <= 300, f"unexpected universe size {len(universe)}"
    # No duplicates, all clean upper-case tickers.
    assert len(universe) == len(set(universe)), "universe has duplicate tickers"
    assert all(isinstance(s, str) and s == s.upper() and 1 <= len(s) <= 5
               for s in universe)
    # A few bellwethers we always want in the field.
    for anchor in ("AAPL", "SPY", "NVDA", "QQQ"):
        assert anchor in universe


def test_focus_knobs_present_and_bounded():
    cfg = agent_config.get()
    assert 1 <= cfg["max_focus_symbols"] <= 60
    assert cfg["max_focus_tokens"] > 0
    assert cfg["breadth_chunk_size"] > 0


# ── Model resolution ────────────────────────────────────────────────────────

def test_model_defaults_to_opus_and_honors_env_override(monkeypatch):
    monkeypatch.delenv("AGENT_MODEL", raising=False)
    assert agent_config.model() == agent_config.DEFAULT_MODEL
    assert "opus" in agent_config.DEFAULT_MODEL.lower()

    monkeypatch.setenv("AGENT_MODEL", "claude-sonnet-5")
    assert agent_config.model() == "claude-sonnet-5"
