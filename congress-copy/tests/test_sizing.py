from decimal import Decimal

import pytest
from src.sizing import compute_position_size, SizingError


@pytest.mark.parametrize("low,high,expected", [
    # Tier 1: max $15K → $500
    ("1000",   "15000",   "500"),
    ("0",      "1000",    "500"),
    # Tier 2: max $50K → $1000
    ("15001",  "50000",   "1000"),
    ("15000.01", "16000", "1000"),
    # Tier 3: max $100K → $2000
    ("50001",  "100000",  "2000"),
    # Tier 4: max $250K → $3000
    ("100001", "250000",  "3000"),
    # Tier 5: max $1M → $4000
    ("250001", "1000000", "4000"),
    # Tier 6 (cap): anything over $1M → $5000
    ("1000001", "5000000",  "5000"),
    ("5000001", "50000000", "5000"),
])
def test_tier_boundaries(low: str, high: str, expected: str):
    result = compute_position_size(Decimal(low), Decimal(high))
    assert result == Decimal(expected)


def test_negative_range_raises():
    with pytest.raises(SizingError):
        compute_position_size(Decimal("-1"), Decimal("1000"))


def test_low_greater_than_high_raises():
    with pytest.raises(SizingError):
        compute_position_size(Decimal("100000"), Decimal("1000"))


def test_zero_zero_returns_smallest_tier():
    assert compute_position_size(Decimal("0"), Decimal("0")) == Decimal("500")


def test_nan_range_raises():
    with pytest.raises(SizingError):
        compute_position_size(Decimal("NaN"), Decimal("15000"))
    with pytest.raises(SizingError):
        compute_position_size(Decimal("0"), Decimal("NaN"))
