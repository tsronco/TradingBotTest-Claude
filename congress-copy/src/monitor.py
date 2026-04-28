"""Independent stop-loss watcher. Runs every 30 minutes during market hours."""
import logging
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from notifications import send_embed, log_event, Color

import config
from src.alpaca_client import AlpacaClient
from src.state import State

log = logging.getLogger(__name__)


class Monitor:
    def __init__(self, state: State, alpaca: AlpacaClient) -> None:
        self.state = state
        self.alpaca = alpaca

    def run_monitor_cycle(self) -> dict:
        summary = {"checked": 0, "stopped_out": 0, "skipped_market_closed": 0, "errors": 0}

        try:
            if not self.alpaca.is_market_open():
                summary["skipped_market_closed"] = 1
                return summary
            positions = self.alpaca.list_positions()
        except Exception as e:
            summary["errors"] += 1
            self.state.log_event("MONITOR_FETCH_ERROR", trade_id=None, reason=str(e)[:500])
            send_embed(
                "errors", "Congress Copy Monitor: fetch error",
                color=Color.RED,
                description=f"`{type(e).__name__}: {str(e)[:500]}`",
                footer="monitor.py",
            )
            log_event("errors", "monitor.py", "fetch_error",
                      result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
            log.exception("monitor failed to fetch market state or positions")
            return summary

        for pos in positions:
            # Only act on positions this bot actually opened. Other strategies
            # (TSLA shares, wheel puts) share the same Alpaca account and must
            # be left alone — get_avg_entry returns None for unknown symbols.
            entry = self.state.get_avg_entry(pos.symbol)
            if entry is None:
                continue
            summary["checked"] += 1
            try:
                drawdown = (pos.current_price - entry) / entry
                if drawdown <= config.STOP_LOSS_PCT:
                    # Order matters: close at broker FIRST, then mark in state.
                    # If state update fails after a successful close, next cycle
                    # self-corrects (Alpaca won't return the closed position).
                    self.alpaca.close_position(pos.symbol)
                    self.state.mark_stopped_out(pos.symbol, pos.current_price, drawdown)
                    summary["stopped_out"] += 1
                    log.info("STOP_LOSS_FIRED %s drawdown=%s", pos.symbol, drawdown)
                    send_embed(
                        "congress", f"Congress Copy: STOP HIT — closed {pos.symbol}",
                        color=Color.RED,
                        description=f"Drawdown: {float(drawdown)*100:.2f}%\nExit: ${float(pos.current_price):.2f}",
                        fields=[
                            {"name": "Entry", "value": f"${float(entry):.2f}", "inline": True},
                            {"name": "Exit", "value": f"${float(pos.current_price):.2f}", "inline": True},
                            {"name": "Threshold", "value": f"{float(config.STOP_LOSS_PCT)*100:.0f}%", "inline": True},
                        ],
                        footer="monitor.py",
                    )
                    log_event("congress", "monitor.py", "stop_loss_fired",
                              symbol=pos.symbol, result="success",
                              details={
                                  "drawdown_pct": float(drawdown),
                                  "exit_price": float(pos.current_price),
                                  "entry": float(entry),
                              })
            except Exception as e:
                summary["errors"] += 1
                self.state.log_event(
                    "MONITOR_POSITION_ERROR",
                    trade_id=None,
                    reason=f"{pos.symbol}: {type(e).__name__}: {str(e)[:300]}",
                )
                log_event("errors", "monitor.py", "position_error",
                          symbol=pos.symbol, result="failure",
                          notes=f"{type(e).__name__}: {str(e)[:300]}")
                log.exception("monitor failed for position %s", pos.symbol)

        log_event("congress", "monitor.py", "cycle_complete",
                  result="success", details=summary)
        return summary
