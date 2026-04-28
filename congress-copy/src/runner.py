"""CLI entrypoint: `python -m src.runner disclosures` or `... monitor`."""
import argparse
import json
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root (parent of congress-copy/)
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

# Make notifications/ at project root importable
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from notifications import send_embed, log_event, Color

import config
from src.alpaca_client import AlpacaClient
from src.monitor import Monitor
from src.paper_guard import assert_paper_only
from src.state import State
from src.trader import Trader
from src import scraper

DB_PATH = str(Path(__file__).resolve().parent.parent / "data" / "state.db")
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


def _setup_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(LOG_DIR / "bot.log", maxBytes=5_000_000, backupCount=5)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler(sys.stdout)])


def main(argv: list[str] | None = None) -> int:
    _setup_logging()
    assert_paper_only()  # blocks before any network call

    parser = argparse.ArgumentParser(prog="congress-copy")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("disclosures", help="Pull new CapitolTrades disclosures and place orders")
    sub.add_parser("monitor", help="Check open positions for stop-loss triggers")

    args = parser.parse_args(argv)

    state = State(DB_PATH, stale_cutoff_days=config.STALE_DISCLOSURE_CUTOFF_DAYS)
    alpaca = AlpacaClient()

    try:
        if args.cmd == "disclosures":
            trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
            summary = trader.run_disclosure_cycle()
        elif args.cmd == "monitor":
            monitor = Monitor(state=state, alpaca=alpaca)
            summary = monitor.run_monitor_cycle()
        else:
            parser.error(f"unknown command: {args.cmd}")
    except Exception as e:
        send_embed(
            "errors", f"runner.py — {args.cmd} subcommand crashed",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer="runner.py",
        )
        log_event("errors", "runner.py", "exception",
                  result="failure",
                  notes=f"{args.cmd}: {type(e).__name__}: {str(e)[:500]}")
        state.close()
        raise

    print(json.dumps(summary, indent=2))
    state.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
