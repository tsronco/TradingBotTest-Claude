"""Append-only JSON-lines event log.

Every script run appends one or more lines to logs/<stream>.jsonl.

Why JSONL:
  - Append-only, never rewritten — safe across concurrent runs
  - One event = one line, easy to grep/parse
  - Claude can read it directly with the Read or Grep tools
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

LOG_DIR = Path(os.getenv("BOT_LOG_DIR", "logs"))


def log_event(
    stream: str,
    script: str,
    action: str,
    result: str = "success",
    symbol: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
    alpaca_order_id: Optional[str] = None,
    notes: Optional[str] = None,
) -> None:
    """Append one structured event to logs/<stream>.jsonl.

    stream:  "tsla" | "congress" | "errors" | "daily-summary"
    script:  caller's filename (e.g. "wheel_strategy.py")
    action:  short verb-phrase (e.g. "sold_put", "stop_hit", "no_action")
    result:  "success" | "failure" | "skipped"
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = LOG_DIR / f"{stream}.jsonl"

    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "script": script,
        "action": action,
        "result": result,
    }
    if symbol is not None:
        event["symbol"] = symbol
    if details is not None:
        event["details"] = details
    if alpaca_order_id is not None:
        event["alpaca_order_id"] = alpaca_order_id
    if notes is not None:
        event["notes"] = notes

    try:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
    except Exception as e:
        print(f"[jsonl_log] write failed for {path}: {e}", file=sys.stderr)
