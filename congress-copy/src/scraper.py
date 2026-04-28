"""Playwright-based scraper for CapitolTrades politician pages.

Returns a list of `Disclosure` dataclasses. On any parsing error, logs and
returns an empty list — never raises into the caller.
"""
import logging
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from playwright.sync_api import sync_playwright, Page

from src.models import Disclosure, OptionDetails

log = logging.getLogger(__name__)

CAPITOLTRADES_BASE = "https://www.capitoltrades.com"

# "1K-15K", "15K-50K", "1M-5M", "$1K-$15K" tolerated
RANGE_RE = re.compile(r"\$?([\d,.]+[KM]?)\s*[-–]\s*\$?([\d,.]+[KM]?)")

# "9 Apr | 2026" or "9 Apr\n2026" — current CapitolTrades date format
# The visible page renders a `|` separator via CSS, but inner_text() returns a newline.
# Tolerate either (or just whitespace) between month and year.
DATE_PIPE_RE = re.compile(r"^(\d{1,2})\s+([A-Za-z]{3,9})\s*[|\n]?\s*(\d{4})$")

MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

# "Air Products and Chemicals Inc | APD:US" or "Air Products...\nAPD:US" → ticker = APD
# Page renders the separator as `|` visually but inner_text() returns a newline.
# Match the trailing TICKER[:EXCH] token regardless of separator.
TICKER_RE = re.compile(r"(?:[|\n]|^)\s*([A-Z]{1,6})(?::[A-Z]+)?\s*$")


def _parse_dollar_range(text: str) -> Optional[tuple[Decimal, Decimal]]:
    m = RANGE_RE.search(text)
    if not m:
        return None
    return _parse_kmb(m.group(1)), _parse_kmb(m.group(2))


def _parse_kmb(raw: str) -> Decimal:
    raw = raw.replace(",", "").upper().strip()
    multiplier = Decimal(1)
    if raw.endswith("K"):
        multiplier = Decimal(1_000)
        raw = raw[:-1]
    elif raw.endswith("M"):
        multiplier = Decimal(1_000_000)
        raw = raw[:-1]
    return Decimal(raw) * multiplier


def _parse_date(raw: str) -> Optional[datetime]:
    """Parse current CapitolTrades date format `9 Apr | 2026`, with fallbacks."""
    raw = (raw or "").strip()
    if not raw:
        return None

    # Current format: "9 Apr | 2026"
    m = DATE_PIPE_RE.match(raw)
    if m:
        day = int(m.group(1))
        mon = MONTH_MAP.get(m.group(2).lower()[:4]) or MONTH_MAP.get(m.group(2).lower()[:3])
        year = int(m.group(3))
        if mon:
            return datetime(year, mon, day, tzinfo=timezone.utc)

    # Legacy fallbacks (in case CapitolTrades reverts)
    for fmt in ("%Y-%m-%d", "%d %b %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _extract_ticker(cell0_text: str) -> Optional[str]:
    """From 'Air Products and Chemicals Inc | APD:US' return 'APD'."""
    m = TICKER_RE.search(cell0_text or "")
    return m.group(1).upper() if m else None


def fetch_recent_disclosures(politician_slug: str, max_pages: int = 3) -> list[Disclosure]:
    """Scrape up to `max_pages` pages of trades for the politician.

    Returns [] on any parse failure (logged as PARSE_ERROR or zero-rows warning).
    """
    log.info("scraper start politician=%s max_pages=%d", politician_slug, max_pages)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (compatible; CongressCopyBot/1.0; paper-trading research)"
            )
            page = context.new_page()
            disclosures: list[Disclosure] = []
            for page_num in range(1, max_pages + 1):
                url = f"{CAPITOLTRADES_BASE}/politicians/{politician_slug}?page={page_num}"
                try:
                    page.goto(url, wait_until="networkidle", timeout=30_000)
                except Exception as e:
                    log.error("PARSE_ERROR navigation %s: %s", url, e)
                    break

                # Detect "Something went wrong" / empty result page
                body_text = (page.inner_text("body") or "").lower()
                if "something went wrong" in body_text or "page not found" in body_text:
                    log.error("PARSE_ERROR page %d returned error template (slug %s likely wrong)", page_num, politician_slug)
                    break

                rows = _extract_rows(page, politician_slug)
                log.info("scraper page=%d rows_extracted=%d", page_num, len(rows))
                disclosures.extend(rows)

            browser.close()
            log.info("scraper end total_disclosures=%d", len(disclosures))
            if not disclosures:
                log.warning("scraper returned ZERO disclosures — selectors or slug may be stale")
            return disclosures
    except Exception as e:
        log.error("PARSE_ERROR scraper top-level: %s", e)
        return []


def _extract_rows(page: Page, politician_slug: str) -> list[Disclosure]:
    """Extract Disclosure rows from CapitolTrades politician trades table.

    Current layout (verified 2026-04-25):
      cell[0]: 'Company Name | TICKER:US'
      cell[1]: filed/published date '9 Apr | 2026'
      cell[2]: traded date '4 Mar | 2026'
      cell[3]: filing delay 'days | 34' (unused)
      cell[4]: 'BUY' or 'SELL'
      cell[5]: dollar range '1K-15K'
      cell[6]: link (no asset-kind text)
    """
    out: list[Disclosure] = []
    try:
        rows = page.query_selector_all("table tbody tr")
    except Exception as e:
        log.error("PARSE_ERROR selecting rows: %s", e)
        return []

    for row in rows:
        try:
            cells = row.query_selector_all("td")
            if len(cells) < 7:
                continue

            ticker = _extract_ticker(cells[0].inner_text() or "")
            if not ticker:
                continue

            filed_at = _parse_date(cells[1].inner_text())
            traded_at = _parse_date(cells[2].inner_text())
            if not filed_at or not traded_at:
                continue

            side_text = (cells[4].inner_text() or "").strip().lower()
            side = "buy" if "buy" in side_text else "sell"

            range_text = cells[5].inner_text() or ""
            parsed_range = _parse_dollar_range(range_text)
            if not parsed_range:
                continue
            range_low, range_high = parsed_range

            link = cells[6].query_selector("a[href*='/trades/']") or row.query_selector("a[href*='/trades/']")
            href = link.get_attribute("href") if link else None
            trade_id = (href or "").rstrip("/").rsplit("/", 1)[-1] or f"{politician_slug}-{ticker}-{filed_at.isoformat()}"

            out.append(Disclosure(
                trade_id=trade_id,
                politician_slug=politician_slug,
                ticker=ticker,
                side=side,
                asset_kind="stock",  # listing page no longer surfaces asset_kind; resolver handles options-vs-stock downstream
                range_low=range_low,
                range_high=range_high,
                traded_at=traded_at,
                filed_at=filed_at,
                option=None,
            ))
        except Exception as e:
            log.error("PARSE_ERROR row: %s", e)
            continue
    return out
