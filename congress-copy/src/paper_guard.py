"""Hard guard: refuse to run against anything but the Alpaca paper URL."""
import os

PAPER_URL = "https://paper-api.alpaca.markets/v2"


class PaperOnlyGuardError(RuntimeError):
    """Raised when ALPACA_BASE_URL is not the paper URL."""


def assert_paper_only() -> None:
    """Exit-loud if anyone is about to trade against a non-paper Alpaca account."""
    url = os.environ.get("ALPACA_BASE_URL", "")
    if url != PAPER_URL:
        raise PaperOnlyGuardError(
            f"REFUSING TO RUN: ALPACA_BASE_URL must be exactly "
            f"{PAPER_URL!r}, got {url!r}. This bot is paper-trading only."
        )
