"""All tunable knobs. See spec §7."""
from decimal import Decimal

# Who we're copying — list of politicians to track.
# Slugs are CapitolTrades politician identifiers (Bioguide IDs).
# Verify a slug works by visiting https://www.capitoltrades.com/politicians/<slug>
POLITICIANS: list[dict[str, str]] = [
    {"slug": "G000583", "name": "Josh Gottheimer"},   # original
    {"slug": "P000197", "name": "Nancy Pelosi"},      # very active historically
    {"slug": "T000278", "name": "Tommy Tuberville"},  # frequent disclosures
    {"slug": "G000599", "name": "Daniel Goldman"},    # newer member, fairly active
]

# Position sizing tiers: (max_range_high_usd, dollars_to_commit)
SIZING_TIERS: list[tuple[Decimal, Decimal]] = [
    (Decimal("15000"),    Decimal("500")),
    (Decimal("50000"),    Decimal("1000")),
    (Decimal("100000"),   Decimal("2000")),
    (Decimal("250000"),   Decimal("3000")),
    (Decimal("1000000"),  Decimal("4000")),
    (Decimal("Infinity"), Decimal("5000")),
]

# Risk management
STOP_LOSS_PCT = Decimal("-0.15")

# Options fallback
OPTIONS_MIN_DAYS_TO_EXPIRY = 30
OPTIONS_MAX_STRIKE_DEVIATION_PCT = Decimal("0.10")
OPTIONS_UNDERLYING_FALLBACK = True

# Schedule (US/Central, user's home timezone)
DISCLOSURE_CHECK_HOURS = [6, 12, 18, 23]
MONITOR_INTERVAL_MINUTES = 30

# Safety rails
MAX_OPEN_POSITIONS = 50
MAX_DAILY_TRADES = 20
STALE_DISCLOSURE_CUTOFF_DAYS = 7
PAPER_ONLY_GUARD = True
