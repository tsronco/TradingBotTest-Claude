"""Thin wrapper over the Alpaca paper REST API. Knows nothing about politicians."""
import os
import time
from decimal import Decimal
from typing import Optional

import httpx

from src.models import FillResult, OrderIntent, Position
from src.paper_guard import assert_paper_only

RETRY_BACKOFFS = [1, 2, 4, 8, 16]  # seconds


class AlpacaClient:
    def __init__(self, timeout_seconds: float = 10.0) -> None:
        assert_paper_only()
        self.base_url = os.environ["ALPACA_BASE_URL"].rstrip("/")
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={
                "APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
                "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET"],
            },
            timeout=timeout_seconds,
        )

    def submit(self, intent: OrderIntent) -> FillResult:
        body: dict = {
            "symbol": intent.symbol,
            "side": intent.side,
            "type": "market",
            "time_in_force": "day",
        }
        if intent.asset_kind == "option":
            body["qty"] = str(intent.qty)
        else:
            body["notional"] = str(intent.notional_usd)

        last_err: Optional[str] = None
        for backoff in RETRY_BACKOFFS:
            try:
                resp = self._client.post("/orders", json=body)
            except httpx.HTTPError as e:
                last_err = str(e)
                time.sleep(backoff)
                continue

            if 500 <= resp.status_code < 600:
                last_err = f"{resp.status_code}: {resp.text[:200]}"
                time.sleep(backoff)
                continue

            data = resp.json()
            if resp.status_code >= 400:
                return FillResult(
                    order_id="",
                    status="rejected",
                    reason=data.get("message", resp.text[:200]),
                )
            return FillResult(
                order_id=data["id"],
                status="filled" if data.get("filled_avg_price") else "pending",
                filled_avg_price=(
                    Decimal(data["filled_avg_price"]) if data.get("filled_avg_price") else None
                ),
                filled_qty=(
                    Decimal(data["filled_qty"]) if data.get("filled_qty") else None
                ),
            )
        return FillResult(order_id="", status="rejected", reason=f"retries exhausted: {last_err}")

    def is_market_open(self) -> bool:
        resp = self._client.get("/clock")
        resp.raise_for_status()
        return bool(resp.json()["is_open"])

    def list_positions(self) -> list[Position]:
        resp = self._client.get("/positions")
        resp.raise_for_status()
        return [
            Position(
                symbol=p["symbol"],
                qty=Decimal(p["qty"]),
                avg_entry_price=Decimal(p["avg_entry_price"]),
                current_price=Decimal(p["current_price"]),
                market_value=Decimal(p["market_value"]),
                unrealized_pl_pct=Decimal(p["unrealized_plpc"]),
            )
            for p in resp.json()
        ]

    def close_position(self, symbol: str) -> FillResult:
        resp = self._client.delete(f"/positions/{symbol}")
        if resp.status_code >= 400:
            return FillResult(order_id="", status="rejected",
                               reason=resp.json().get("message", resp.text[:200]))
        data = resp.json()
        return FillResult(
            order_id=data.get("id", ""),
            status="pending",
        )

    def find_option_contract(
        self,
        underlying: str,
        option_type: str,
        target_strike: Decimal,
        target_expiry,
        min_days_to_expiry: int,
        max_strike_deviation_pct: Decimal,
    ) -> Optional[str]:
        """
        Query Alpaca's option contracts endpoint and return the OCC symbol of the
        best-matching tradable contract, or None if nothing fits.
        """
        params = {
            "underlying_symbols": underlying,
            "type": option_type,
            "status": "active",
            "limit": 1000,
        }
        resp = self._client.get("/options/contracts", params=params)
        if resp.status_code >= 400:
            return None

        contracts = resp.json().get("option_contracts", [])
        from datetime import date, timedelta
        cutoff = date.today() + timedelta(days=min_days_to_expiry)

        best: Optional[tuple[Decimal, dict]] = None
        for c in contracts:
            strike = Decimal(c["strike_price"])
            expiry = date.fromisoformat(c["expiration_date"])
            if expiry < cutoff:
                continue
            # target_strike == 0 should never happen in practice (politicians don't disclose
            # zero-strike options). If it does, force deviation = 100% so the candidate fails
            # the max_deviation filter unless callers explicitly set max >= 1.0.
            if target_strike == 0:
                deviation = Decimal("1")
            else:
                deviation = abs(strike - target_strike) / target_strike
            if deviation > max_strike_deviation_pct:
                continue
            if best is None or deviation < best[0]:
                best = (deviation, c)
        return best[1]["symbol"] if best else None
