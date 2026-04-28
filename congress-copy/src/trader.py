"""Orchestrates: scraper disclosures -> sized OrderIntents -> Alpaca submission."""
import logging
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from notifications import send_embed, log_event, Color

import config
from src.alpaca_client import AlpacaClient
from src.models import Disclosure, OrderIntent
from src.options_resolver import resolve_option
from src.sizing import compute_position_size
from src.state import State

log = logging.getLogger(__name__)


class Trader:
    def __init__(self, state: State, alpaca: AlpacaClient, scraper) -> None:
        self.state = state
        self.alpaca = alpaca
        self.scraper = scraper

    def run_disclosure_cycle(self) -> dict:
        summary = {"new": 0, "ordered": 0, "skipped": 0, "circuit_broken": 0, "errors": 0}

        # NOTE: orders_placed_this_cycle is per-cycle, not per-day. If the
        # scheduler fires twice in a day, the daily budget is effectively doubled.
        # See plan follow-up: query state for today's ORDER_PLACED count instead.
        # For now this is acceptable because Task Scheduler runs disclosures only
        # 4× daily and the budget (MAX_DAILY_TRADES=20) is well above per-cycle volume.

        # Iterate over every politician in config.POLITICIANS; partial-failure
        # tolerant — one bad slug doesn't abort the whole cycle.
        all_disclosures = []
        for pol in config.POLITICIANS:
            slug = pol["slug"]
            name = pol["name"]
            try:
                fetched = self.scraper.fetch_recent_disclosures(slug)
                log.info("scraper fetched %d disclosures for %s (%s)", len(fetched), name, slug)
                all_disclosures.extend(fetched)
            except Exception as e:
                summary["errors"] += 1
                self.state.log_event(
                    "SCRAPER_ERROR",
                    trade_id=None,
                    reason=f"{slug} ({name}): {str(e)[:400]}",
                )
                send_embed(
                    "errors", f"Congress Copy: scraper failed for {name}",
                    color=Color.RED,
                    description=f"Slug `{slug}` may be stale.\n`{type(e).__name__}: {str(e)[:300]}`",
                    footer="trader.py",
                )
                log_event("errors", "trader.py", "scraper_error",
                          result="failure",
                          notes=f"{slug} ({name}): {type(e).__name__}: {str(e)[:300]}")
                log.exception("scraper failed for %s (%s)", name, slug)
                # Continue to next politician instead of aborting the whole cycle

        # Dedupe by trade_id — defensive against the same disclosure appearing
        # in multiple politicians' feeds (rare but possible) or duplicate scraper
        # results from a single politician.
        seen_in_batch: set[str] = set()
        deduped: list[Disclosure] = []
        for d in all_disclosures:
            if d.trade_id in seen_in_batch:
                continue
            seen_in_batch.add(d.trade_id)
            deduped.append(d)
        all_disclosures = deduped

        try:
            new = self.state.filter_unseen(all_disclosures)
        except Exception as e:
            summary["errors"] += 1
            self.state.log_event("STATE_ERROR", trade_id=None, reason=str(e)[:500])
            log.exception("filter_unseen failed")
            return summary

        summary["new"] = len(new)

        orders_placed_this_cycle = 0
        for disclosure in new:
            try:
                if orders_placed_this_cycle >= config.MAX_DAILY_TRADES:
                    summary["circuit_broken"] += 1
                    self.state.log_event(
                        "CIRCUIT_BREAKER_TRIPPED",
                        trade_id=disclosure.trade_id,
                        reason=f"exceeded MAX_DAILY_TRADES={config.MAX_DAILY_TRADES}",
                    )
                    continue

                intent = self._build_intent(disclosure)
                if intent is None:
                    summary["skipped"] += 1
                    self.state.record_seen(disclosure)
                    self.state.log_event(
                        "OPTION_UNRESOLVABLE",
                        trade_id=disclosure.trade_id,
                        reason=f"no contract or fallback for {disclosure.ticker}",
                    )
                    log_event("congress", "trader.py", "disclosure_skipped",
                              symbol=disclosure.ticker, result="skipped",
                              notes=f"option unresolvable for {disclosure.ticker}")
                    continue

                fill = self.alpaca.submit(intent)
                self.state.record_seen(disclosure)
                if fill.status == "rejected":
                    summary["skipped"] += 1
                    self.state.log_event(
                        "ORDER_REJECTED",
                        trade_id=disclosure.trade_id,
                        reason=fill.reason or "unknown",
                    )
                    send_embed(
                        "errors", f"Congress Copy: Order REJECTED for {intent.symbol}",
                        color=Color.RED,
                        description=f"`{fill.reason or 'unknown'}`",
                        footer="trader.py",
                    )
                    log_event("errors", "trader.py", "order_rejected",
                              symbol=intent.symbol, result="failure",
                              notes=fill.reason or "unknown")
                    continue
                if fill.status == "filled" and fill.filled_avg_price and fill.filled_qty:
                    self.state.record_position(intent.symbol, fill.filled_avg_price, fill.filled_qty)
                # NOTE: pending/accepted fills don't get record_position here.
                # Monitor falls back to Alpaca's avg_entry_price when state lacks
                # an entry, so stop-loss still works. Reporting gap only.
                self.state.log_event(
                    "ORDER_PLACED",
                    trade_id=disclosure.trade_id,
                    reason=f"{intent.side} {intent.symbol} fallback={intent.fallback_path}",
                )
                send_embed(
                    "congress", f"Congress Copy: {intent.side.upper()} {intent.symbol} — ${intent.notional_usd}",
                    color=Color.YELLOW,
                    description=f"Source: Gottheimer disclosure {disclosure.trade_id}",
                    fields=[
                        {"name": "Side", "value": intent.side, "inline": True},
                        {"name": "Asset", "value": intent.asset_kind, "inline": True},
                        {"name": "Fallback", "value": intent.fallback_path, "inline": True},
                        {"name": "Range", "value": f"${disclosure.range_low:,.0f}–${disclosure.range_high:,.0f}", "inline": False},
                    ],
                    footer="trader.py",
                )
                log_event("congress", "trader.py", "copy_trade_placed",
                          symbol=intent.symbol,
                          details={
                              "side": intent.side,
                              "notional_usd": float(intent.notional_usd),
                              "trade_id": disclosure.trade_id,
                              "asset_kind": intent.asset_kind,
                              "fallback_path": intent.fallback_path,
                              "fill_status": fill.status,
                          },
                          alpaca_order_id=getattr(fill, "order_id", None))
                summary["ordered"] += 1
                orders_placed_this_cycle += 1
            except Exception as e:
                summary["errors"] += 1
                self.state.log_event(
                    "TRADE_ERROR",
                    trade_id=disclosure.trade_id,
                    reason=f"{type(e).__name__}: {str(e)[:300]}",
                )
                send_embed(
                    "errors", f"trader.py — exception processing {disclosure.trade_id}",
                    color=Color.RED,
                    description=f"`{type(e).__name__}: {str(e)[:500]}`",
                    footer="trader.py",
                )
                log_event("errors", "trader.py", "exception",
                          symbol=disclosure.ticker, result="failure",
                          notes=f"{type(e).__name__}: {str(e)[:500]}")
                log.exception("trade processing failed for %s", disclosure.trade_id)

        return summary

    def _build_intent(self, disclosure: Disclosure):
        notional = compute_position_size(disclosure.range_low, disclosure.range_high)
        if disclosure.asset_kind == "option":
            return resolve_option(disclosure, notional, self.alpaca)
        return OrderIntent(
            symbol=disclosure.ticker,
            side=disclosure.side,
            notional_usd=notional,
            asset_kind=disclosure.asset_kind,
            fallback_path="direct",
        )
