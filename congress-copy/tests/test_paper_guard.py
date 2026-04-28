import pytest
from src.paper_guard import assert_paper_only, PaperOnlyGuardError


def test_paper_url_passes(paper_env):
    assert_paper_only()


def test_live_url_blocks(live_env):
    with pytest.raises(PaperOnlyGuardError) as exc:
        assert_paper_only()
    assert "REFUSING TO RUN" in str(exc.value)
    assert "paper-trading only" in str(exc.value)


def test_missing_url_blocks(monkeypatch):
    monkeypatch.delenv("ALPACA_BASE_URL", raising=False)
    with pytest.raises(PaperOnlyGuardError):
        assert_paper_only()


def test_typo_url_blocks(monkeypatch):
    monkeypatch.setenv("ALPACA_BASE_URL", "https://paper-api.alpaca.market/v2")  # missing 's'
    with pytest.raises(PaperOnlyGuardError):
        assert_paper_only()


def test_trailing_slash_blocks(monkeypatch):
    monkeypatch.setenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets/v2/")
    with pytest.raises(PaperOnlyGuardError):
        assert_paper_only()


def test_no_scheme_blocks(monkeypatch):
    monkeypatch.setenv("ALPACA_BASE_URL", "paper-api.alpaca.markets/v2")
    with pytest.raises(PaperOnlyGuardError):
        assert_paper_only()


def test_no_v2_suffix_blocks(monkeypatch):
    monkeypatch.setenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets")
    with pytest.raises(PaperOnlyGuardError):
        assert_paper_only()
