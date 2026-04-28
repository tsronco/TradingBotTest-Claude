"""SQLite-backed bookkeeping. Only module that touches the database."""
import sqlite3
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from src.models import Disclosure

SCHEMA = """
CREATE TABLE IF NOT EXISTS seen_disclosures (
    trade_id TEXT PRIMARY KEY,
    seen_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    symbol      TEXT NOT NULL,
    entry_price TEXT NOT NULL,
    qty         TEXT NOT NULL,
    opened_at   TEXT NOT NULL,
    closed_at   TEXT,
    exit_price  TEXT,
    drawdown    TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    trade_id   TEXT,
    reason     TEXT,
    created_at TEXT NOT NULL
);
"""


class State:
    def __init__(self, db_path: str, stale_cutoff_days: int = 7) -> None:
        self.db_path = db_path
        self.stale_cutoff_days = stale_cutoff_days
        # WAL mode + 30s timeout: trader and monitor run as separate Task Scheduler
        # processes and may hit the same DB simultaneously. WAL lets readers and
        # writers coexist without blocking each other.
        self._conn = sqlite3.connect(db_path, timeout=30.0)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA busy_timeout=30000")
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def filter_unseen(self, disclosures: list[Disclosure]) -> list[Disclosure]:
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.stale_cutoff_days)
        cur = self._conn.execute("SELECT trade_id FROM seen_disclosures")
        seen = {row["trade_id"] for row in cur.fetchall()}
        return [
            d for d in disclosures
            if d.trade_id not in seen and d.filed_at >= cutoff
        ]

    def record_seen(self, disclosure: Disclosure) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO seen_disclosures (trade_id, seen_at) VALUES (?, ?)",
            (disclosure.trade_id, datetime.now(timezone.utc).isoformat()),
        )
        self._conn.commit()

    def record_position(self, symbol: str, entry_price: Decimal, qty: Decimal) -> None:
        self._conn.execute(
            "INSERT INTO positions (symbol, entry_price, qty, opened_at) VALUES (?, ?, ?, ?)",
            (symbol, str(entry_price), str(qty), datetime.now(timezone.utc).isoformat()),
        )
        self._conn.commit()

    def get_avg_entry(self, symbol: str) -> Optional[Decimal]:
        cur = self._conn.execute(
            "SELECT entry_price, qty FROM positions WHERE symbol = ? AND closed_at IS NULL",
            (symbol,),
        )
        rows = cur.fetchall()
        if not rows:
            return None
        total_qty = Decimal(0)
        total_cost = Decimal(0)
        for row in rows:
            qty = Decimal(row["qty"])
            price = Decimal(row["entry_price"])
            total_qty += qty
            total_cost += qty * price
        if total_qty == 0:
            return None
        return total_cost / total_qty

    def mark_stopped_out(self, symbol: str, exit_price: Decimal, drawdown: Decimal) -> None:
        # Atomic: soft-close all open positions for symbol + log event in one txn.
        # Soft-close (closed_at IS NOT NULL) preserves entry-price audit history.
        now = datetime.now(timezone.utc).isoformat()
        with self._conn:
            self._conn.execute(
                "UPDATE positions SET closed_at = ?, exit_price = ?, drawdown = ? "
                "WHERE symbol = ? AND closed_at IS NULL",
                (now, str(exit_price), str(drawdown), symbol),
            )
            self._conn.execute(
                "INSERT INTO events (event_type, trade_id, reason, created_at) VALUES (?, ?, ?, ?)",
                ("STOP_LOSS_FIRED", None,
                 f"{symbol} exit={exit_price} drawdown={drawdown}", now),
            )

    def log_event(self, event_type: str, trade_id: Optional[str], reason: Optional[str]) -> None:
        self._conn.execute(
            "INSERT INTO events (event_type, trade_id, reason, created_at) VALUES (?, ?, ?, ?)",
            (event_type, trade_id, reason, datetime.now(timezone.utc).isoformat()),
        )
        self._conn.commit()

    def recent_events(self, limit: int = 50) -> list[dict]:
        cur = self._conn.execute(
            "SELECT event_type, trade_id, reason, created_at FROM events "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        return [dict(row) for row in cur.fetchall()]

    def close(self) -> None:
        self._conn.close()
