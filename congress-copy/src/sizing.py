"""Tiered position sizing: maps a disclosed dollar range to a fixed commit."""
from decimal import Decimal

import config


class SizingError(ValueError):
    """Raised on malformed range inputs."""


def compute_position_size(range_low: Decimal, range_high: Decimal) -> Decimal:
    """
    Map a disclosed (range_low, range_high) USD pair to a dollar amount.

    Uses range_high to pick the tier — the disclosure's upper bound is the
    most conservative read of the politician's conviction.
    """
    if range_low.is_nan() or range_high.is_nan():
        raise SizingError(f"Range cannot be NaN: ({range_low}, {range_high})")
    if range_low < 0 or range_high < 0:
        raise SizingError(f"Range cannot be negative: ({range_low}, {range_high})")
    if range_low > range_high:
        raise SizingError(f"range_low > range_high: ({range_low}, {range_high})")

    for tier_max, dollars in config.SIZING_TIERS:
        if range_high <= tier_max:
            return dollars
    return config.SIZING_TIERS[-1][1]
