"""The installer's account model must stay derived from the bot's own
config.MODES + notifications.discord.CHANNEL_ENV_MAP — these tests fail loudly
if the two ever drift apart.
"""
import config
import pytest
from notifications.discord import CHANNEL_ENV_MAP

from tools.installer import spec

ROLES = ["trades_channel", "summary_channel", "errors_channel", "actions_channel"]


def test_every_config_mode_has_a_spec_account():
    assert set(spec.ACCOUNT_ORDER) == set(config.MODES)


@pytest.mark.parametrize("mode", sorted(config.MODES))
def test_alpaca_env_matches_config(mode):
    acc = spec.account(mode)
    m = config.MODES[mode]
    assert acc.key_env == m["alpaca_key_env"]
    assert acc.secret_env == m["alpaca_secret_env"]
    assert acc.url_env == m["alpaca_url_env"]


@pytest.mark.parametrize("mode", sorted(config.MODES))
def test_webhook_envs_match_channel_env_map(mode):
    acc = spec.account(mode)
    m = config.MODES[mode]
    for role in ROLES:
        expected = CHANNEL_ENV_MAP[m[role]]
        assert expected in acc.webhooks, f"{mode}/{role} -> {expected} missing"


def test_only_live_is_real_and_urls_are_right():
    for mode in config.MODES:
        acc = spec.account(mode)
        if mode == "live":
            assert acc.is_real and acc.default_url == spec.LIVE_URL
        else:
            assert not acc.is_real and acc.default_url == spec.PAPER_URL


def test_congress_webhook_only_on_conservative():
    cons = spec.account("conservative")
    assert spec.CONGRESS_WEBHOOK_ENV in cons.webhooks
    for mode in config.MODES:
        if mode != "conservative":
            assert spec.CONGRESS_WEBHOOK_ENV not in spec.account(mode).webhooks


def test_conservative_channel_names_match_instructions():
    names = set(spec.account("conservative").webhooks.values())
    assert {"trades", "daily-summary", "errors", "all-actions", "congress-trades"} == names


def test_prefixed_account_channel_names():
    names = set(spec.account("aggressive").webhooks.values())
    assert names == {
        "aggressive-trades", "aggressive-summary",
        "aggressive-errors", "aggressive-actions",
    }


def test_github_secret_envs_excludes_congress_when_disabled():
    envs = spec.github_secret_envs(["conservative"], include_congress=False)
    assert spec.CONGRESS_WEBHOOK_ENV not in envs
    assert "ALPACA_API_KEY" in envs
    assert "BOT_PUSH_TOKEN" in envs
    assert len(envs) == len(set(envs))  # de-duped


def test_github_secret_envs_includes_congress_when_enabled():
    envs = spec.github_secret_envs(["conservative"], include_congress=True)
    assert spec.CONGRESS_WEBHOOK_ENV in envs


def test_github_secret_envs_multi_account_dedup():
    envs = spec.github_secret_envs(["conservative", "aggressive"], include_congress=False)
    assert "ALPACA_AGG_API_KEY" in envs and "ALPACA_API_KEY" in envs
    assert envs.count("BOT_PUSH_TOKEN") == 1


def test_dashboard_env_keys_excludes_live_alpaca():
    keys = spec.dashboard_env_keys(["conservative", "live"])
    assert "ALPACA_API_KEY" in keys
    assert "ALPACA_LIVE_API_KEY" not in keys
    assert "SESSION_SECRET" in keys
    assert "ALPACA_DATA_BASE_URL" in keys


def test_upstash_globals_present_and_ask_kind():
    by_name = {n: (k, d) for n, k, d in spec.GLOBAL_SECRETS}
    assert by_name["UPSTASH_EMAIL"][0] == "ask"
    assert by_name["UPSTASH_API_KEY"][0] == "ask"
    # GitHub PAT description must now mention Workflows (push touches workflows)
    gh_desc = by_name["GITHUB_ACCESS_TOKEN"][1]
    assert "Workflows" in gh_desc
