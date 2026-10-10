"""Unit tests for statistical helpers in triage.stats."""

from __future__ import annotations

import math
import numpy as np
import pytest
from scipy import stats as scipy_stats

from triage.stats import (
    benjamini_hochberg,
    compute_leave_one_out_shrunk_baseline,
    exact_binomial_tails,
    wilson_interval,
)


def test_wilson_interval_standard():
    low, high = wilson_interval(10, 100, alpha=0.05)
    assert 0.05 < low < 0.10
    assert 0.10 < high < 0.18
    assert math.isclose(low, 0.055229, rel_tol=1e-3)
    assert math.isclose(high, 0.174366, rel_tol=1e-3)


def test_wilson_interval_edge_cases():
    # Zero clicks
    assert wilson_interval(0, 0) == (0.0, 0.0)
    # Negative inputs
    assert wilson_interval(-1, 10) == (0.0, 0.0)
    assert wilson_interval(2, -5) == (0.0, 0.0)
    # Zero conversions with positive clicks
    low, high = wilson_interval(0, 50, alpha=0.05)
    assert low == 0.0
    assert 0.06 < high < 0.08
    # Conversions exceeding clicks clamps p_hat safely to 1.0
    low_exc, high_exc = wilson_interval(8, 5, alpha=0.05)
    assert 0.5 < low_exc <= 1.0
    assert math.isclose(high_exc, 1.0, abs_tol=1e-9)
    # Fractional conversions
    low_frac, high_frac = wilson_interval(2.5, 20, alpha=0.05)
    assert 0.0 <= low_frac < 0.125 < high_frac <= 1.0


def test_wilson_interval_invalid_alpha():
    with pytest.raises(ValueError):
        wilson_interval(5, 20, alpha=0.0)
    with pytest.raises(ValueError):
        wilson_interval(5, 20, alpha=1.0)


def test_exact_binomial_tails_integer():
    p_low, p_up = exact_binomial_tails(0, 80, 0.05)
    expected_low = float(scipy_stats.binom.cdf(0, 80, 0.05))
    assert math.isclose(p_low, expected_low, rel_tol=1e-9)
    assert math.isclose(p_up, 1.0, rel_tol=1e-9)

    p_low2, p_up2 = exact_binomial_tails(12, 50, 0.05)
    expected_up2 = float(scipy_stats.binom.sf(11, 50, 0.05))
    assert math.isclose(p_up2, expected_up2, rel_tol=1e-9)
    assert p_up2 < 0.0001


def test_exact_binomial_tails_fractional_conservative():
    # For k = 1.6 on n = 20, p0 = 0.05:
    # Lower tail uses ceil(1.6) = 2, Upper tail uses floor(1.6) = 1
    p_low, p_up = exact_binomial_tails(1.6, 20, 0.05)
    assert math.isclose(p_low, float(scipy_stats.binom.cdf(2, 20, 0.05)), rel_tol=1e-9)
    assert math.isclose(p_up, float(scipy_stats.binom.sf(0, 20, 0.05)), rel_tol=1e-9)


def test_exact_binomial_tails_boundaries():
    assert exact_binomial_tails(0, 0, 0.05) == (1.0, 1.0)
    assert exact_binomial_tails(0, 20, 0.0) == (1.0, 1.0)
    assert exact_binomial_tails(3, 20, 0.0) == (1.0, 0.0)
    assert exact_binomial_tails(5, 20, 1.0) == (0.0, 1.0)


def test_benjamini_hochberg_monotonicity_and_order():
    # Unsorted p-values with known BH step-up behavior
    raw_p = [0.04, 0.001, 0.50, 0.03, 0.01]
    # Sorted: 0.001 (r=1), 0.01 (r=2), 0.03 (r=3), 0.04 (r=4), 0.50 (r=5)
    # m/r * p: 0.005, 0.025, 0.05, 0.05, 0.50
    q = benjamini_hochberg(raw_p)
    assert math.isclose(q[0], 0.05, rel_tol=1e-9)
    assert math.isclose(q[1], 0.005, rel_tol=1e-9)
    assert math.isclose(q[2], 0.50, rel_tol=1e-9)
    assert math.isclose(q[3], 0.05, rel_tol=1e-9)
    assert math.isclose(q[4], 0.025, rel_tol=1e-9)


def test_benjamini_hochberg_with_nans_and_clamping():
    raw_p = [float("nan"), 0.02, 0.90, float("nan"), 0.01]
    # Valid m=3: 0.01 (r=1 -> 0.03), 0.02 (r=2 -> 0.03), 0.90 (r=3 -> 0.90)
    q = benjamini_hochberg(raw_p)
    assert math.isnan(q[0])
    assert math.isclose(q[1], 0.03, rel_tol=1e-9)
    assert math.isclose(q[2], 0.90, rel_tol=1e-9)
    assert math.isnan(q[3])
    assert math.isclose(q[4], 0.03, rel_tol=1e-9)
    assert benjamini_hochberg([]) == []


def test_leave_one_out_shrunk_baseline():
    # Campaign has 200 clicks, 20 conversions (including term's 50 clicks, 10 conversions)
    # Account has 1000 clicks, 50 conversions (including term's 50 clicks, 10 conversions)
    # Excluding term:
    # camp_loo = (20 - 10) / (200 - 50) = 10 / 150 = 0.0666667
    # acct_loo = (50 - 10) / (1000 - 50) = 40 / 950 = 0.0421053
    # shrunk (k=100) = (150 * (10/150) + 100 * (40/950)) / (150 + 100)
    shrunk, camp_loo, acct_loo = compute_leave_one_out_shrunk_baseline(
        term_clicks=50,
        term_conversions=10,
        campaign_clicks=200,
        campaign_conversions=20,
        account_clicks=1000,
        account_conversions=50,
        shrinkage_k=100.0,
    )
    assert math.isclose(camp_loo, 10.0 / 150.0, rel_tol=1e-6)
    assert math.isclose(acct_loo, 40.0 / 950.0, rel_tol=1e-6)
    expected_shrunk = (10.0 + 100.0 * (40.0 / 950.0)) / 250.0
    assert math.isclose(shrunk, expected_shrunk, rel_tol=1e-6)
