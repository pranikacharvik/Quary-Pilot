"""Deterministic Search Term Triage Engine.

Assigns every input row to exactly one of {PROMOTE, BLOCK, IGNORE} with:
- A one-line numerical reason
- A decision-support confidence tier (not a calibrated probability)
- A boolean review_flag and explicit data-quality flags
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .config import ColumnMapping, TriageConfig
from .loader import DataQualityReport, prepare_and_inspect_dataframe
from .stats import (
    benjamini_hochberg,
    compute_leave_one_out_shrunk_baseline,
    exact_binomial_tails,
    wilson_interval,
)

VALID_DECISIONS = ("PROMOTE", "BLOCK", "IGNORE")


@dataclass
class TriageSummary:
    """Account-level and decision-level summary metrics for a triage run."""

    total_rows: int
    promote_count: int
    block_count: int
    ignore_count: int
    review_flagged_count: int
    account_valid_clicks: float
    account_valid_conversions: float
    account_valid_cost: float
    account_baseline_cvr: float
    account_cpa: Optional[float]
    effective_block_cost_gate: float
    config: TriageConfig

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_rows": self.total_rows,
            "promote_count": self.promote_count,
            "block_count": self.block_count,
            "ignore_count": self.ignore_count,
            "review_flagged_count": self.review_flagged_count,
            "account_valid_clicks": round(self.account_valid_clicks, 2),
            "account_valid_conversions": round(self.account_valid_conversions, 2),
            "account_valid_cost": round(self.account_valid_cost, 2),
            "account_baseline_cvr": round(self.account_baseline_cvr, 6),
            "account_cpa": round(self.account_cpa, 2) if self.account_cpa is not None else None,
            "effective_block_cost_gate": round(self.effective_block_cost_gate, 2),
        }


def run_triage_engine(
    raw_df: pd.DataFrame,
    mapping: ColumnMapping,
    config: Optional[TriageConfig] = None,
) -> Tuple[pd.DataFrame, TriageSummary, DataQualityReport]:
    """Run the deterministic triage engine across all rows of raw_df.

    Guarantees:
    - Output row count == Input row count.
    - Every row receives exactly one decision in {'PROMOTE', 'BLOCK', 'IGNORE'}.
    - Never promotes a term with < 2 conversions (hard invariant).
    - Conversion value is preserved strictly as informational metadata.
    """
    cfg = config or TriageConfig()
    cfg.validate()

    std_df, quality_report = prepare_and_inspect_dataframe(raw_df, mapping)
    n_rows = len(std_df)

    # 1. Identify clean rows eligible to contribute to baseline totals.
    # Rows with fatal anomalies (missing required values, negative numbers, or conversions > clicks)
    # are excluded from corrupting the account/campaign baseline pool.
    valid_pool_mask = (~std_df["_has_fatal_anomaly"]) & (std_df["_clicks"] >= 0.0)

    account_valid_clicks = float(std_df.loc[valid_pool_mask, "_clicks"].sum())
    account_valid_conversions = float(std_df.loc[valid_pool_mask, "_conversions"].sum())
    account_valid_cost = float(std_df.loc[valid_pool_mask, "_cost"].sum())

    account_baseline_cvr = (
        account_valid_conversions / account_valid_clicks
        if account_valid_clicks > 0.0
        else 0.0
    )

    if account_valid_conversions > 0.0:
        account_cpa: Optional[float] = account_valid_cost / account_valid_conversions
        effective_block_cost_gate = cfg.block_cost_cpa_multiplier * account_cpa
    else:
        account_cpa = None
        effective_block_cost_gate = cfg.fallback_block_cost_floor

    # Campaign totals on valid pool
    camp_totals = (
        std_df.loc[valid_pool_mask]
        .groupby("_campaign", as_index=True)[["_clicks", "_conversions"]]
        .sum()
    )
    camp_clicks_map = camp_totals["_clicks"].to_dict()
    camp_conv_map = camp_totals["_conversions"].to_dict()

    # 2. First pass: compute per-row observed metrics, leave-one-out shrunk baseline,
    # Wilson intervals, and exact binomial tail p-values.
    observed_cvr_list: List[float] = []
    cpa_list: List[Optional[float]] = []
    camp_loo_cvr_list: List[float] = []
    acct_loo_cvr_list: List[float] = []
    shrunk_baseline_list: List[float] = []
    wilson_low_list: List[float] = []
    wilson_high_list: List[float] = []
    p_lower_list: List[float] = []
    p_upper_list: List[float] = []

    # Candidate masks for Benjamini-Hochberg multiple testing families
    # Only rows that pass minimum sample-size & directional pre-filters enter each testing family.
    promote_test_pvals: List[float] = []
    block_test_pvals: List[float] = []

    min_promote_conv_gate = max(2.0, float(cfg.min_promote_conversions))

    for idx in std_df.index:
        clicks = float(std_df.loc[idx, "_clicks"])
        cost = float(std_df.loc[idx, "_cost"])
        conv = float(std_df.loc[idx, "_conversions"])
        camp = str(std_df.loc[idx, "_campaign"])
        fatal = bool(std_df.loc[idx, "_has_fatal_anomaly"])
        row_flags: List[str] = list(std_df.loc[idx, "_quality_flags_list"])

        obs_cvr = (conv / clicks) if (clicks > 0.0 and not fatal) else 0.0
        obs_cpa = (cost / conv) if (conv > 0.0 and not fatal) else None

        # If this row was part of the valid pool, subtract its own clicks/conversions
        # when computing its leave-one-out campaign & account baselines.
        term_c_for_loo = clicks if not fatal else 0.0
        term_x_for_loo = conv if not fatal else 0.0

        c_clicks = float(camp_clicks_map.get(camp, 0.0))
        c_conv = float(camp_conv_map.get(camp, 0.0))

        shrunk_p0, camp_loo, acct_loo = compute_leave_one_out_shrunk_baseline(
            term_clicks=term_c_for_loo,
            term_conversions=term_x_for_loo,
            campaign_clicks=c_clicks,
            campaign_conversions=c_conv,
            account_clicks=account_valid_clicks,
            account_conversions=account_valid_conversions,
            shrinkage_k=cfg.shrinkage_k,
        )

        if shrunk_p0 <= 0.0 and "ZERO_BASELINE" not in row_flags:
            row_flags.append("ZERO_BASELINE")
            std_df.at[idx, "_quality_flags_list"] = row_flags
            std_df.at[idx, "_quality_flags"] = "; ".join(row_flags)

        if fatal or clicks <= 0.0:
            w_low, w_high = (0.0, 0.0)
            p_low, p_up = (1.0, 1.0)
        else:
            w_low, w_high = wilson_interval(conv, clicks, alpha=cfg.alpha)
            p_low, p_up = exact_binomial_tails(conv, clicks, shrunk_p0)

        observed_cvr_list.append(obs_cvr)
        cpa_list.append(obs_cpa)
        camp_loo_cvr_list.append(camp_loo)
        acct_loo_cvr_list.append(acct_loo)
        shrunk_baseline_list.append(shrunk_p0)
        wilson_low_list.append(w_low)
        wilson_high_list.append(w_high)
        p_lower_list.append(p_low)
        p_upper_list.append(p_up)

        # Eligibility for upper-tail (PROMOTE) hypothesis test family
        if (
            not fatal
            and clicks >= cfg.min_test_clicks
            and conv >= min_promote_conv_gate
            and obs_cvr > shrunk_p0
        ):
            promote_test_pvals.append(p_up)
        else:
            promote_test_pvals.append(float("nan"))

        # Eligibility for lower-tail (BLOCK) hypothesis test family
        if (
            not fatal
            and clicks >= cfg.min_test_clicks
            and cost >= effective_block_cost_gate
            and shrunk_p0 > 0.0
            and obs_cvr < shrunk_p0
        ):
            block_test_pvals.append(p_low)
        else:
            block_test_pvals.append(float("nan"))

    # 3. Compute Benjamini-Hochberg adjusted q-values across tested families
    # Also compute full-table BH q-values across all rows with clicks >= min_test_clicks
    # so analysts can inspect both pre-filtered family FDR and all-tested-terms FDR.
    q_upper_family = benjamini_hochberg(promote_test_pvals)
    q_lower_family = benjamini_hochberg(block_test_pvals)

    q_upper_list: List[float] = []
    q_lower_list: List[float] = []
    for i in range(n_rows):
        qu = q_upper_family[i]
        ql = q_lower_family[i]
        q_upper_list.append(1.0 if np.isnan(qu) else float(qu))
        q_lower_list.append(1.0 if np.isnan(ql) else float(ql))

    # 4. Deterministic Decision Assignment
    decisions: List[str] = []
    confidence_tiers: List[str] = []
    review_flags: List[bool] = []
    reasons: List[str] = []

    for i, idx in enumerate(std_df.index):
        clicks = float(std_df.loc[idx, "_clicks"])
        cost = float(std_df.loc[idx, "_cost"])
        conv = float(std_df.loc[idx, "_conversions"])
        fatal = bool(std_df.loc[idx, "_has_fatal_anomaly"])
        row_flags: List[str] = list(std_df.loc[idx, "_quality_flags_list"])

        obs_cvr = observed_cvr_list[i]
        shrunk_p0 = shrunk_baseline_list[i]
        w_low = wilson_low_list[i]
        w_high = wilson_high_list[i]
        p_low = p_lower_list[i]
        p_up = p_upper_list[i]
        q_low = q_lower_list[i]
        q_up = q_upper_list[i]

        has_nonfatal_quality_warning = any(
            f in row_flags
            for f in (
                "FRACTIONAL_CONVERSIONS",
                "DUPLICATE_QUERY_IN_CAMPAIGN",
                "DUPLICATE_QUERY_ACROSS_CAMPAIGNS",
                "MISSING_CAMPAIGN",
                "ZERO_BASELINE",
                "COST_WITHOUT_CLICKS",
            )
        )

        # Case 1: Fatal data anomaly (missing values, negative metrics, conversions > clicks)
        if fatal:
            decisions.append("IGNORE")
            confidence_tiers.append("Data Anomaly (Hold)")
            review_flags.append(True)
            reasons.append(
                f"IGNORE: Data quality anomaly [{', '.join(row_flags)}] "
                f"(clicks={clicks:g}, conv={conv:g}, cost=${cost:.2f}); manual review required."
            )
            continue

        # Case 2: Zero clicks
        if clicks <= 0.0:
            decisions.append("IGNORE")
            confidence_tiers.append("Insufficient Data")
            needs_rev = bool(cost > 0.0 or conv > 0.0 or has_nonfatal_quality_warning)
            review_flags.append(needs_rev)
            reasons.append(
                f"IGNORE: Zero clicks (0 clicks, {conv:g} conv, cost=${cost:.2f}); "
                f"minimum {cfg.min_test_clicks} clicks required for statistical triage."
            )
            continue

        # Case 3: Below minimum test clicks threshold
        if clicks < cfg.min_test_clicks:
            decisions.append("IGNORE")
            confidence_tiers.append("Insufficient Data")
            # Flag for review if high spend or multiple conversions despite low clicks
            needs_rev = bool(
                cost >= effective_block_cost_gate
                or conv >= min_promote_conv_gate
                or has_nonfatal_quality_warning
            )
            review_flags.append(needs_rev)
            if conv == 1.0:
                reasons.append(
                    f"IGNORE: Single-conversion low-click trap ({conv:g} conv / {clicks:g} clicks, "
                    f"CVR {obs_cvr * 100:.1f}% vs {shrunk_p0 * 100:.2f}% baseline, "
                    f"95% Wilson CI [{w_low * 100:.1f}%, {w_high * 100:.1f}%]); "
                    f"requires >={min_promote_conv_gate:g} conv and >={cfg.min_test_clicks} clicks."
                )
            else:
                reasons.append(
                    f"IGNORE: Insufficient click volume ({clicks:g} clicks < min {cfg.min_test_clicks}, "
                    f"{conv:g} conv, cost=${cost:.2f}, 95% Wilson CI [{w_low * 100:.1f}%, {w_high * 100:.1f}%])."
                )
            continue

        # Case 4: Evaluate PROMOTE candidate
        # Hard invariant: never promote a term with < 2 conversions (or < min_promote_conversions).
        if conv >= min_promote_conv_gate and obs_cvr > shrunk_p0:
            stat_pass = (q_up <= cfg.alpha) if cfg.strict_fdr_gate else (p_up <= cfg.alpha)
            if stat_pass:
                decisions.append("PROMOTE")
                if q_up <= cfg.alpha and w_low > shrunk_p0 and not has_nonfatal_quality_warning:
                    confidence_tiers.append("Tier 1: High (FDR & CI Confirmed)")
                    review_flags.append(False)
                elif q_up <= cfg.alpha:
                    confidence_tiers.append("Tier 2: Medium (FDR Adjusted, Review Flags)")
                    review_flags.append(True)
                else:
                    confidence_tiers.append("Tier 3: Low (Unadjusted Signal, Review Required)")
                    review_flags.append(True)

                reasons.append(
                    f"PROMOTE: {conv:g} conv / {clicks:g} clicks "
                    f"(CVR {obs_cvr * 100:.2f}% vs {shrunk_p0 * 100:.2f}% shrunk baseline, "
                    f"95% CI [{w_low * 100:.2f}%, {w_high * 100:.2f}%], "
                    f"p_up={p_up:.4f}, q_up={q_up:.4f} <= alpha={cfg.alpha})."
                )
                continue

        # Case 5: Evaluate BLOCK candidate
        if (
            shrunk_p0 > 0.0
            and obs_cvr < shrunk_p0
            and cost >= effective_block_cost_gate
        ):
            stat_pass = (q_low <= cfg.alpha) if cfg.strict_fdr_gate else (p_low <= cfg.alpha)
            if stat_pass:
                decisions.append("BLOCK")
                # If a term has any positive conversions (>0) and still triggers BLOCK, always flag for review
                has_positive_conv = conv > 0.0
                if (
                    q_low <= cfg.alpha
                    and w_high < shrunk_p0
                    and not has_positive_conv
                    and not has_nonfatal_quality_warning
                ):
                    confidence_tiers.append("Tier 1: High (FDR & CI Confirmed)")
                    review_flags.append(False)
                elif q_low <= cfg.alpha:
                    confidence_tiers.append("Tier 2: Medium (FDR Adjusted, Review Flags)")
                    review_flags.append(True)
                else:
                    confidence_tiers.append("Tier 3: Low (Unadjusted Signal, Review Required)")
                    review_flags.append(True)

                reasons.append(
                    f"BLOCK: {conv:g} conv / {clicks:g} clicks, cost ${cost:.2f} >= gate ${effective_block_cost_gate:.2f} "
                    f"(CVR {obs_cvr * 100:.2f}% vs {shrunk_p0 * 100:.2f}% shrunk baseline, "
                    f"95% CI [{w_low * 100:.2f}%, {w_high * 100:.2f}%], "
                    f"p_low={p_low:.4f}, q_low={q_low:.4f} <= alpha={cfg.alpha})."
                )
                continue

        # Case 6: Otherwise IGNORE (explain why with exact numbers)
        decisions.append("IGNORE")
        confidence_tiers.append("Baseline / Inconclusive")

        # Determine if human review is helpful (e.g. unadjusted p <= alpha blocked by strict_fdr_gate,
        # or high spend, or quality flags)
        near_sig_up = (conv >= min_promote_conv_gate and p_up <= cfg.alpha)
        near_sig_low = (cost >= effective_block_cost_gate and shrunk_p0 > 0.0 and p_low <= cfg.alpha)
        review_flags.append(bool(near_sig_up or near_sig_low or has_nonfatal_quality_warning))

        if conv == 1.0 and obs_cvr > shrunk_p0:
            reasons.append(
                f"IGNORE: Single conversion never promoted ({conv:g} conv < min {min_promote_conv_gate:g} "
                f"across {clicks:g} clicks; CVR {obs_cvr * 100:.2f}% vs {shrunk_p0 * 100:.2f}% baseline, "
                f"95% CI [{w_low * 100:.2f}%, {w_high * 100:.2f}%])."
            )
        elif obs_cvr < shrunk_p0 and p_low <= cfg.alpha and cost < effective_block_cost_gate:
            reasons.append(
                f"IGNORE: Underperforming CVR ({obs_cvr * 100:.2f}% vs {shrunk_p0 * 100:.2f}% baseline, p_low={p_low:.4f}) "
                f"but cost ${cost:.2f} is below block cost gate ${effective_block_cost_gate:.2f}."
            )
        elif near_sig_up and cfg.strict_fdr_gate:
            reasons.append(
                f"IGNORE: Unadjusted p_up={p_up:.4f} <= {cfg.alpha}, but BH-adjusted q_up={q_up:.4f} > {cfg.alpha} "
                f"({conv:g} conv / {clicks:g} clicks, CVR {obs_cvr * 100:.2f}% vs {shrunk_p0 * 100:.2f}% baseline)."
            )
        elif near_sig_low and cfg.strict_fdr_gate:
            reasons.append(
                f"IGNORE: Unadjusted p_low={p_low:.4f} <= {cfg.alpha}, but BH-adjusted q_low={q_low:.4f} > {cfg.alpha} "
                f"({conv:g} conv / {clicks:g} clicks, cost=${cost:.2f})."
            )
        else:
            reasons.append(
                f"IGNORE: Within expected baseline variation ({conv:g} conv / {clicks:g} clicks, "
                f"cost=${cost:.2f}, CVR {obs_cvr * 100:.2f}% vs {shrunk_p0 * 100:.2f}% shrunk baseline, "
                f"95% CI [{w_low * 100:.2f}%, {w_high * 100:.2f}%], p_low={p_low:.4f}, p_up={p_up:.4f})."
            )

    # Assemble clean result DataFrame
    result_df = pd.DataFrame(
        {
            "row_id": std_df["_row_id"],
            "search_term": std_df["_search_term"],
            "campaign": std_df["_campaign"],
            "ad_group": std_df["_ad_group"],
            "match_type": std_df["_match_type"],
            "impressions": std_df["_impressions"],
            "clicks": std_df["_clicks"],
            "cost": std_df["_cost"].round(2),
            "conversions": std_df["_conversions"],
            "conversion_value_info": std_df["_conversion_value"],
            "observed_cvr": np.round(observed_cvr_list, 6),
            "observed_cpa": [round(x, 2) if x is not None else np.nan for x in cpa_list],
            "campaign_loo_cvr": np.round(camp_loo_cvr_list, 6),
            "account_loo_cvr": np.round(acct_loo_cvr_list, 6),
            "shrunk_baseline_cvr": np.round(shrunk_baseline_list, 6),
            "wilson_ci_lower": np.round(wilson_low_list, 6),
            "wilson_ci_upper": np.round(wilson_high_list, 6),
            "p_value_lower": np.round(p_lower_list, 6),
            "p_value_upper": np.round(p_upper_list, 6),
            "q_value_lower": np.round(q_lower_list, 6),
            "q_value_upper": np.round(q_upper_list, 6),
            "decision": decisions,
            "confidence_tier": confidence_tiers,
            "review_flag": review_flags,
            "quality_flags": std_df["_quality_flags"],
            "reason": reasons,
        }
    )

    # Verify post-conditions
    assert len(result_df) == len(raw_df), "Output row count must equal input row count"
    assert set(result_df["decision"]).issubset(set(VALID_DECISIONS)), "Invalid decision label produced"
    assert not ((result_df["decision"] == "PROMOTE") & (result_df["conversions"] < 2.0)).any(), (
        "Invariant violation: promoted a term with < 2 conversions"
    )

    summary = TriageSummary(
        total_rows=n_rows,
        promote_count=int((result_df["decision"] == "PROMOTE").sum()),
        block_count=int((result_df["decision"] == "BLOCK").sum()),
        ignore_count=int((result_df["decision"] == "IGNORE").sum()),
        review_flagged_count=int(result_df["review_flag"].sum()),
        account_valid_clicks=account_valid_clicks,
        account_valid_conversions=account_valid_conversions,
        account_valid_cost=account_valid_cost,
        account_baseline_cvr=account_baseline_cvr,
        account_cpa=account_cpa,
        effective_block_cost_gate=effective_block_cost_gate,
        config=cfg,
    )

    return result_df, summary, quality_report
