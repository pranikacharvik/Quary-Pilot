"""CSV export utilities for Search Term Triage Engine.

Guarantees that exported CSV rows match the displayed/filtered or full triage results
with deterministic column ordering and formatting.
"""

from __future__ import annotations

from typing import List, Optional

import pandas as pd

EXPORT_COLUMNS: List[str] = [
    "row_id",
    "search_term",
    "campaign",
    "ad_group",
    "match_type",
    "impressions",
    "clicks",
    "cost",
    "conversions",
    "conversion_value_info",
    "observed_cvr",
    "observed_cpa",
    "campaign_loo_cvr",
    "account_loo_cvr",
    "shrunk_baseline_cvr",
    "wilson_ci_lower",
    "wilson_ci_upper",
    "p_value_lower",
    "p_value_upper",
    "q_value_lower",
    "q_value_upper",
    "decision",
    "confidence_tier",
    "review_flag",
    "quality_flags",
    "reason",
]


TEXT_EXPORT_COLUMNS: List[str] = [
    "search_term",
    "campaign",
    "ad_group",
    "match_type",
    "quality_flags",
    "reason",
]


def sanitize_for_csv_export(val: Any) -> Any:
    """Mitigate CSV formula injection (CWE-1236) for user-controlled text fields.

    Prepend a single quote to text fields starting with =, +, -, @, tab, or CR
    so spreadsheet software (Excel, Calc) treats them as literal text.
    """
    if isinstance(val, str) and len(val) > 0:
        if val[0] in ("=", "+", "-", "@", "\t", "\r"):
            return f"'{val}"
    return val


def filter_and_sort_results(
    results_df: pd.DataFrame,
    decisions: Optional[List[str]] = None,
    campaigns: Optional[List[str]] = None,
    match_types: Optional[List[str]] = None,
    review_only: bool = False,
    search_query: str = "",
    sort_by: str = "row_id",
    ascending: bool = True,
) -> pd.DataFrame:
    """Apply deterministic filtering and sorting to the triage output DataFrame."""
    filtered = results_df.copy()

    if decisions:
        filtered = filtered[filtered["decision"].isin(decisions)]

    if campaigns:
        filtered = filtered[filtered["campaign"].isin(campaigns)]

    if match_types:
        filtered = filtered[filtered["match_type"].isin(match_types)]

    if review_only:
        filtered = filtered[filtered["review_flag"] == True]  # noqa: E712

    if search_query and search_query.strip():
        q = search_query.strip().lower()
        mask = (
            filtered["search_term"].astype(str).str.lower().str.contains(q, regex=False, na=False)
            | filtered["campaign"].astype(str).str.lower().str.contains(q, regex=False, na=False)
            | filtered["reason"].astype(str).str.lower().str.contains(q, regex=False, na=False)
            | filtered["quality_flags"].astype(str).str.lower().str.contains(q, regex=False, na=False)
        )
        filtered = filtered[mask]

    if sort_by in filtered.columns:
        filtered = filtered.sort_values(
            by=sort_by,
            ascending=ascending,
            na_position="last",
            kind="mergesort",
        )

    cols = [c for c in EXPORT_COLUMNS if c in filtered.columns]
    return filtered[cols].reset_index(drop=True)


def results_to_csv_string(results_df: pd.DataFrame) -> str:
    """Serialize the triage DataFrame (full or filtered view) to a UTF-8 CSV string."""
    cols = [c for c in EXPORT_COLUMNS if c in results_df.columns]
    out_df = results_df[cols].copy()
    for col in cols:
        if col in TEXT_EXPORT_COLUMNS and col in out_df.columns:
            out_df[col] = out_df[col].apply(sanitize_for_csv_export)
    return out_df.to_csv(index=False, lineterminator="\n")
