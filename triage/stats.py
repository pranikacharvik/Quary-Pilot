"""Statistical helpers for Search Term Triage Engine.

Includes:
- Wilson score confidence interval for binomial proportions
- Exact binomial lower and upper tail probabilities via SciPy
- Benjamini-Hochberg step-up False Discovery Rate (FDR) adjustment
- Leave-one-out Empirical Bayes campaign-to-account baseline shrinkage
"""

from __future__ import annotations

import math
from typing import Iterable, List, Sequence, Tuple

import numpy as np
from scipy import stats


def wilson_interval(
    successes: float,
    trials: float,
    alpha: float = 0.05,
) -> Tuple[float, float]:
    """Compute the Wilson score (1 - alpha) confidence interval for a proportion.

    Handles edge cases safely:
    - Zero or negative trials -> (0.0, 0.0)
    - Negative or NaN inputs -> (0.0, 0.0)
    - Fractional conversions -> uses continuous p_hat = successes / trials
    - Conversions exceeding clicks -> clamps p_hat to [0.0, 1.0]

    Args:
        successes: Observed conversions (k >= 0, may be fractional).
        trials: Observed clicks (n >= 0).
        alpha: Two-sided significance level in (0, 1). Default 0.05 (95% CI).

    Returns:
        Tuple (lower_bound, upper_bound) clamped to [0.0, 1.0].
    """
    if (
        trials is None
        or successes is None
        or math.isnan(trials)
        or math.isnan(successes)
        or trials <= 0.0
        or successes < 0.0
    ):
        return (0.0, 0.0)

    if not (0.0 < alpha < 1.0):
        raise ValueError(f"alpha must be in (0, 1), got {alpha}")

    n = float(trials)
    k = float(successes)
    p_hat = min(1.0, max(0.0, k / n))

    z = float(stats.norm.ppf(1.0 - alpha / 2.0))
    z2 = z * z

    denom = 1.0 + z2 / n
    center = (p_hat + z2 / (2.0 * n)) / denom
    radicand = max(0.0, (p_hat * (1.0 - p_hat) / n) + (z2 / (4.0 * n * n)))
    half_width = (z * math.sqrt(radicand)) / denom

    lower = 0.0 if p_hat <= 0.0 else max(0.0, min(1.0, center - half_width))
    upper = 1.0 if p_hat >= 1.0 else max(0.0, min(1.0, center + half_width))
    if lower < 1e-14:
        lower = 0.0
    if upper > 1.0 - 1e-14:
        upper = 1.0
    return (lower, upper)


def exact_binomial_tails(
    successes: float,
    trials: float,
    p0: float,
) -> Tuple[float, float]:
    """Compute exact one-sided binomial tail probabilities using SciPy.

    Because the exact binomial distribution is discrete on integer counts {0, ..., n},
    fractional conversions (from multi-touch / data-driven attribution) are handled
    conservatively:
    - Lower tail P(X <= k_lower | n, p0) uses k_lower = ceil(successes), making it
      harder to falsely BLOCK a term that has partial conversion credit.
    - Upper tail P(X >= k_upper | n, p0) uses k_upper = floor(successes), making it
      harder to falsely PROMOTE a term from fractional credit alone.

    For integer conversions, floor(k) == ceil(k) == k.

    Args:
        successes: Observed conversions (k).
        trials: Observed clicks (n).
        p0: Baseline null conversion rate in [0.0, 1.0].

    Returns:
        Tuple (p_lower, p_upper) where:
        - p_lower = P(X <= ceil(k) | n, p0)  [evidence of underperformance / BLOCK]
        - p_upper = P(X >= floor(k) | n, p0) [evidence of outperformance / PROMOTE]
    """
    if (
        trials is None
        or successes is None
        or p0 is None
        or math.isnan(trials)
        or math.isnan(successes)
        or math.isnan(p0)
        or trials <= 0
        or successes < 0
    ):
        return (1.0, 1.0)

    n_int = int(math.floor(trials))
    if n_int <= 0:
        return (1.0, 1.0)

    p_null = min(1.0, max(0.0, float(p0)))
    k_clamped = min(float(n_int), max(0.0, float(successes)))

    k_lower = min(n_int, int(math.ceil(k_clamped - 1e-12)))
    k_upper = max(0, int(math.floor(k_clamped + 1e-12)))

    if p_null <= 0.0:
        p_lower = 1.0
        p_upper = 1.0 if k_upper == 0 else 0.0
        return (p_lower, p_upper)

    if p_null >= 1.0:
        p_lower = 0.0 if k_lower < n_int else 1.0
        p_upper = 1.0
        return (p_lower, p_upper)

    # Exact lower tail P(X <= k_lower)
    p_lower = float(stats.binom.cdf(k_lower, n_int, p_null))
    # Exact upper tail P(X >= k_upper) = P(X > k_upper - 1)
    if k_upper <= 0:
        p_upper = 1.0
    else:
        p_upper = float(stats.binom.sf(k_upper - 1, n_int, p_null))

    return (
        min(1.0, max(0.0, p_lower)),
        min(1.0, max(0.0, p_upper)),
    )


def benjamini_hochberg(p_values: Sequence[float]) -> List[float]:
    """Apply the Benjamini-Hochberg step-up FDR adjustment to a sequence of p-values.

    Supports sequences containing NaN values: finite p-values in [0, 1] are adjusted
    together as a single testing family of size m = count(finite), and NaNs remain NaN
    in their original positions.

    Args:
        p_values: Sequence of raw p-values.

    Returns:
        List of BH-adjusted q-values in the original order, clamped to [0.0, 1.0].
    """
    arr = np.asarray(list(p_values), dtype=float)
    if arr.size == 0:
        return []

    finite_mask = np.isfinite(arr)
    m = int(np.sum(finite_mask))
    if m == 0:
        return [float("nan")] * int(arr.size)

    valid_p = np.clip(arr[finite_mask], 0.0, 1.0)
    order = np.argsort(valid_p, kind="mergesort")
    sorted_p = valid_p[order]

    ranks = np.arange(1, m + 1, dtype=float)
    raw_q = (sorted_p * float(m)) / ranks

    # Enforce step-up monotonicity from largest rank down to smallest rank
    monotonic_q = np.minimum.accumulate(raw_q[::-1])[::-1]
    clamped_q = np.clip(monotonic_q, 0.0, 1.0)

    # Restore original order among valid indices
    restored_valid = np.empty(m, dtype=float)
    restored_valid[order] = clamped_q

    result = np.full(arr.size, np.nan, dtype=float)
    result[finite_mask] = restored_valid
    return [float(x) for x in result]


def compute_leave_one_out_shrunk_baseline(
    term_clicks: float,
    term_conversions: float,
    campaign_clicks: float,
    campaign_conversions: float,
    account_clicks: float,
    account_conversions: float,
    shrinkage_k: float = 100.0,
) -> Tuple[float, float, float]:
    """Compute leave-one-out campaign CVR shrunk toward leave-one-out account CVR.

    Excludes the search term's own clicks and conversions from both the campaign
    and account totals to prevent self-influence.

    Formula:
        acct_cvr_loo = (account_conversions - term_conversions) / (account_clicks - term_clicks)
        camp_cvr_loo = (campaign_conversions - term_conversions) / (campaign_clicks - term_clicks)
        shrunk_cvr   = (camp_clicks_loo * camp_cvr_loo + k * acct_cvr_loo) / (camp_clicks_loo + k)

    Returns:
        Tuple of (shrunk_baseline_cvr, camp_cvr_loo, acct_cvr_loo)
    """
    t_clicks = max(0.0, float(term_clicks))
    t_conv = max(0.0, float(term_conversions))

    acct_clicks_loo = max(0.0, float(account_clicks) - t_clicks)
    acct_conv_loo = max(0.0, float(account_conversions) - t_conv)
    if acct_clicks_loo > 0.0:
        acct_cvr_loo = min(1.0, max(0.0, acct_conv_loo / acct_clicks_loo))
    else:
        acct_cvr_loo = 0.0

    camp_clicks_loo = max(0.0, float(campaign_clicks) - t_clicks)
    camp_conv_loo = max(0.0, float(campaign_conversions) - t_conv)
    if camp_clicks_loo > 0.0:
        camp_cvr_loo = min(1.0, max(0.0, camp_conv_loo / camp_clicks_loo))
    else:
        camp_cvr_loo = acct_cvr_loo

    k = max(0.0, float(shrinkage_k))
    denom = camp_clicks_loo + k
    if denom > 0.0:
        shrunk_cvr = (camp_clicks_loo * camp_cvr_loo + k * acct_cvr_loo) / denom
    else:
        shrunk_cvr = acct_cvr_loo

    return (
        min(1.0, max(0.0, shrunk_cvr)),
        min(1.0, max(0.0, camp_cvr_loo)),
        min(1.0, max(0.0, acct_cvr_loo)),
    )
