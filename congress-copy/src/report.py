"""On-demand performance report. Reads the state DB and prints to stdout + CSV."""
import csv
import sqlite3
import sys
from pathlib import Path

DB_PATH = str(Path(__file__).resolve().parent.parent / "data" / "state.db")
CSV_PATH = str(Path(__file__).resolve().parent.parent / "data" / "report.csv")


def main() -> int:
    if not Path(DB_PATH).exists():
        print(f"No state DB at {DB_PATH}. Run the bot first.", file=sys.stderr)
        return 1

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print("=== Recent events ===")
    rows = conn.execute(
        "SELECT event_type, trade_id, reason, created_at FROM events "
        "ORDER BY id DESC LIMIT 50"
    ).fetchall()
    for r in rows:
        print(f"  {r['created_at']}  {r['event_type']:<25}  {r['trade_id'] or '-':<20}  {r['reason'] or ''}")

    print("\n=== Open positions ===")
    pos_rows = conn.execute(
        "SELECT symbol, SUM(CAST(qty AS REAL)) as total_qty, "
        "       SUM(CAST(qty AS REAL) * CAST(entry_price AS REAL))"
        "       / NULLIF(SUM(CAST(qty AS REAL)), 0) as avg_entry "
        "FROM positions WHERE closed_at IS NULL GROUP BY symbol"
    ).fetchall()
    for r in pos_rows:
        print(f"  {r['symbol']:<8}  qty={r['total_qty']:.2f}  avg_entry=${r['avg_entry']:.2f}")

    print("\n=== Event-type counts (lifetime) ===")
    counts = conn.execute(
        "SELECT event_type, COUNT(*) as n FROM events GROUP BY event_type ORDER BY n DESC"
    ).fetchall()
    for r in counts:
        print(f"  {r['event_type']:<25}  {r['n']}")

    # CSV export of all events
    with open(CSV_PATH, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["created_at", "event_type", "trade_id", "reason"])
        for r in conn.execute("SELECT created_at, event_type, trade_id, reason FROM events ORDER BY id"):
            writer.writerow([r["created_at"], r["event_type"], r["trade_id"], r["reason"]])
    print(f"\nFull event log exported to {CSV_PATH}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
