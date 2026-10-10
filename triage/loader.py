"""Flexible CSV loader, schema mapper, and data-quality inspector."""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from .config import CANDIDATE_ALIASES, ColumnMapping


@dataclass
class ColumnProfile:
    """Metadata summary for a single CSV column."""

    name: str
    dtype: str
    null_count: int
    null_pct: float
    non_null_count: int
    sample_values: List[str]


@dataclass
class DataQualityReport:
    """Comprehensive data quality and schema inspection report."""

    total_rows: int
    total_columns: int
    column_profiles: List[ColumnProfile]
    unique_search_terms: int
    duplicate_query_row_count: int
    duplicate_campaign_query_row_count: int
    missing_required_row_count: int
    zero_click_row_count: int
    negative_metric_row_count: int
    conversions_exceed_clicks_row_count: int
    fractional_conversion_row_count: int
    cost_without_clicks_row_count: int
    sample_rows: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_rows": self.total_rows,
            "total_columns": self.total_columns,
            "column_profiles": [
                {
                    "name": c.name,
                    "dtype": c.dtype,
                    "null_count": c.null_count,
                    "null_pct": round(c.null_pct, 2),
                    "non_null_count": c.non_null_count,
                    "sample_values": c.sample_values,
                }
                for c in self.column_profiles
            ],
            "unique_search_terms": self.unique_search_terms,
            "duplicate_query_row_count": self.duplicate_query_row_count,
            "duplicate_campaign_query_row_count": self.duplicate_campaign_query_row_count,
            "missing_required_row_count": self.missing_required_row_count,
            "zero_click_row_count": self.zero_click_row_count,
            "negative_metric_row_count": self.negative_metric_row_count,
            "conversions_exceed_clicks_row_count": self.conversions_exceed_clicks_row_count,
            "fractional_conversion_row_count": self.fractional_conversion_row_count,
            "cost_without_clicks_row_count": self.cost_without_clicks_row_count,
            "sample_rows": self.sample_rows,
        }


def load_csv_flexible(
    source: Union[str, Path, io.IOBase],
) -> pd.DataFrame:
    """Load a CSV file or buffer safely without assuming fixed column names."""
    if isinstance(source, (str, Path)):
        path = Path(source)
        if not path.exists():
            raise FileNotFoundError(f"CSV file not found: {path}")
        df = pd.read_csv(path, dtype=object, keep_default_na=True)
    else:
        df = pd.read_csv(source, dtype=object, keep_default_na=True)

    # Clean whitespace from column headers
    df.columns = [str(c).strip() for c in df.columns]
    return df


def suggest_column_mapping(columns: Sequence[str]) -> Dict[str, Optional[str]]:
    """Suggest canonical column mappings from arbitrary CSV header names."""
    norm_to_actual: Dict[str, str] = {}
    for col in columns:
        norm = str(col).strip().lower().replace("-", "_").replace("  ", " ")
        norm_to_actual[norm] = col
        norm_spaces = norm.replace("_", " ")
        norm_to_actual[norm_spaces] = col

    suggested: Dict[str, Optional[str]] = {
        "search_term": None,
        "campaign": None,
        "ad_group": None,
        "match_type": None,
        "impressions": None,
        "clicks": None,
        "cost": None,
        "conversions": None,
        "conversion_value": None,
    }

    used_actuals = set()
    for canonical, aliases in CANDIDATE_ALIASES.items():
        for alias in aliases:
            candidate = norm_to_actual.get(alias.lower())
            if candidate and candidate not in used_actuals:
                suggested[canonical] = candidate
                used_actuals.add(candidate)
                break

    # Fallback substring matching for required fields if still unmapped
    for canonical in ["search_term", "clicks", "cost", "conversions", "campaign"]:
        if suggested[canonical] is not None:
            continue
        for col in columns:
            if col in used_actuals:
                continue
            low = col.lower()
            if canonical == "search_term" and ("term" in low or "query" in low or "keyword" in low):
                suggested[canonical] = col
                used_actuals.add(col)
                break
            elif canonical == "clicks" and "click" in low:
                suggested[canonical] = col
                used_actuals.add(col)
                break
            elif canonical == "cost" and ("cost" in low or "spend" in low):
                suggested[canonical] = col
                used_actuals.add(col)
                break
            elif canonical == "conversions" and ("conv" in low and "val" not in low and "rate" not in low):
                suggested[canonical] = col
                used_actuals.add(col)
                break
            elif canonical == "campaign" and "camp" in low:
                suggested[canonical] = col
                used_actuals.add(col)
                break

    return suggested


def _parse_numeric_series(series: pd.Series) -> Tuple[pd.Series, pd.Series]:
    """Parse a Series into float values, stripping currency/commas if present.

    Returns:
        (numeric_series_with_nan, is_missing_or_unparseable_mask)
    """
    if pd.api.types.is_numeric_dtype(series):
        num = pd.to_numeric(series, errors="coerce").astype(float)
        return num, num.isna()

    cleaned = (
        series.astype(str)
        .str.strip()
        .replace({"": np.nan, "nan": np.nan, "None": np.nan, "null": np.nan, "N/A": np.nan, "--": np.nan, "-": np.nan})
    )
    # Strip currency symbols and thousands separators
    cleaned_str = cleaned.str.replace(r"[$₹€£,]", "", regex=True).str.strip()
    num = pd.to_numeric(cleaned_str, errors="coerce").astype(float)
    return num, num.isna()


def prepare_and_inspect_dataframe(
    df: pd.DataFrame,
    mapping: ColumnMapping,
    sample_size: int = 5,
) -> Tuple[pd.DataFrame, DataQualityReport]:
    """Standardize a raw DataFrame using ColumnMapping and build a DataQualityReport.

    Never drops rows. Annotates each row with quality flags so questionable records
    are surfaced transparently.
    """
    missing_cols = []
    for req_field in ["search_term", "clicks", "cost", "conversions"]:
        col_name = getattr(mapping, req_field)
        if not col_name or col_name not in df.columns:
            missing_cols.append(f"{req_field} -> {col_name!r}")
    if missing_cols:
        raise ValueError(
            f"Required mapped columns not found in CSV: {', '.join(missing_cols)}. "
            f"Available columns: {list(df.columns)}"
        )

    work = df.copy()
    n_rows = len(work)

    # Build column profiles from raw data
    profiles: List[ColumnProfile] = []
    for col in df.columns:
        s = df[col]
        # Treat blank strings as null for profiling
        is_null = s.isna() | (s.astype(str).str.strip() == "") | (s.astype(str).str.strip().isin(["nan", "None", "null"]))
        null_cnt = int(is_null.sum())
        non_null_cnt = n_rows - null_cnt
        null_pct = (null_cnt / n_rows * 100.0) if n_rows > 0 else 0.0

        # Infer friendly dtype
        non_null_vals = s[~is_null]
        inferred_dtype = str(s.dtype)
        if len(non_null_vals) > 0:
            parsed_num, num_na = _parse_numeric_series(non_null_vals)
            if int(num_na.sum()) == 0:
                # Check if all integers
                if np.all(np.isclose(parsed_num % 1.0, 0.0)):
                    inferred_dtype = "integer"
                else:
                    inferred_dtype = "float"
            else:
                inferred_dtype = "string"

        samples = [str(v) for v in non_null_vals.head(3).tolist()]
        profiles.append(
            ColumnProfile(
                name=col,
                dtype=inferred_dtype,
                null_count=null_cnt,
                null_pct=null_pct,
                non_null_count=non_null_cnt,
                sample_values=samples,
            )
        )

    # Extract search_term
    raw_term = work[mapping.search_term]
    term_missing = (
        raw_term.isna()
        | (raw_term.astype(str).str.strip() == "")
        | (raw_term.astype(str).str.strip().isin(["nan", "None", "null"]))
    )
    clean_term = raw_term.fillna("").astype(str).str.strip()
    norm_term = clean_term.str.lower().str.replace(r"\s+", " ", regex=True)

    # Extract campaign
    if mapping.campaign and mapping.campaign in work.columns:
        raw_camp = work[mapping.campaign]
        camp_missing = (
            raw_camp.isna()
            | (raw_camp.astype(str).str.strip() == "")
            | (raw_camp.astype(str).str.strip().isin(["nan", "None", "null"]))
        )
        clean_camp = raw_camp.fillna("").astype(str).str.strip()
        clean_camp = clean_camp.where(~camp_missing, "Unassigned Campaign")
    else:
        camp_missing = pd.Series(False, index=work.index)
        clean_camp = pd.Series("Default Campaign", index=work.index)

    # Optional text columns
    if mapping.ad_group and mapping.ad_group in work.columns:
        clean_ad_group = work[mapping.ad_group].fillna("").astype(str).str.strip()
    else:
        clean_ad_group = pd.Series("", index=work.index)

    if mapping.match_type and mapping.match_type in work.columns:
        clean_match_type = work[mapping.match_type].fillna("").astype(str).str.strip()
    else:
        clean_match_type = pd.Series("", index=work.index)

    # Numeric columns
    clicks_num, clicks_na = _parse_numeric_series(work[mapping.clicks])
    cost_num, cost_na = _parse_numeric_series(work[mapping.cost])
    conv_num, conv_na = _parse_numeric_series(work[mapping.conversions])

    if mapping.impressions and mapping.impressions in work.columns:
        impr_num, impr_na = _parse_numeric_series(work[mapping.impressions])
    else:
        impr_num = pd.Series(np.nan, index=work.index, dtype=float)
        impr_na = pd.Series(False, index=work.index)

    if mapping.conversion_value and mapping.conversion_value in work.columns:
        val_num, val_na = _parse_numeric_series(work[mapping.conversion_value])
    else:
        val_num = pd.Series(np.nan, index=work.index, dtype=float)
        val_na = pd.Series(False, index=work.index)

    # Duplicate detection on valid non-empty normalized terms
    valid_term_mask = ~term_missing & (norm_term != "")
    dup_query_mask = pd.Series(False, index=work.index)
    dup_camp_query_mask = pd.Series(False, index=work.index)

    if valid_term_mask.any():
        term_counts = norm_term[valid_term_mask].value_counts()
        dup_terms = set(term_counts[term_counts > 1].index)
        dup_query_mask = valid_term_mask & norm_term.isin(dup_terms)

        camp_term_key = clean_camp.str.lower() + "||" + norm_term
        camp_term_counts = camp_term_key[valid_term_mask].value_counts()
        dup_camp_terms = set(camp_term_counts[camp_term_counts > 1].index)
        dup_camp_query_mask = valid_term_mask & camp_term_key.isin(dup_camp_terms)

    # Per-row quality flags
    missing_req_mask = term_missing | clicks_na | cost_na | conv_na
    neg_metric_mask = (
        (clicks_num < 0.0)
        | (cost_num < 0.0)
        | (conv_num < 0.0)
        | (impr_num.notna() & (impr_num < 0.0))
    )
    zero_click_mask = (~clicks_na) & (clicks_num == 0.0)
    conv_exceed_clicks_mask = (
        (~clicks_na)
        & (~conv_na)
        & (clicks_num >= 0.0)
        & (conv_num > clicks_num + 1e-9)
    )
    fractional_conv_mask = (
        (~conv_na)
        & (conv_num > 0.0)
        & (~np.isclose(conv_num % 1.0, 0.0, atol=1e-6))
        & (~np.isclose(conv_num % 1.0, 1.0, atol=1e-6))
    )
    cost_without_clicks_mask = zero_click_mask & (~cost_na) & (cost_num > 0.0)

    flags_list: List[List[str]] = []
    for idx in work.index:
        row_flags: List[str] = []
        if bool(missing_req_mask.loc[idx]):
            row_flags.append("MISSING_VALUES")
        if bool(camp_missing.loc[idx]):
            row_flags.append("MISSING_CAMPAIGN")
        if bool(neg_metric_mask.loc[idx]):
            row_flags.append("NEGATIVE_METRICS")
        if bool(zero_click_mask.loc[idx]):
            row_flags.append("ZERO_CLICKS")
        if bool(cost_without_clicks_mask.loc[idx]):
            row_flags.append("COST_WITHOUT_CLICKS")
        if bool(conv_exceed_clicks_mask.loc[idx]):
            row_flags.append("CONVERSIONS_EXCEED_CLICKS")
        if bool(fractional_conv_mask.loc[idx]):
            row_flags.append("FRACTIONAL_CONVERSIONS")
        if bool(dup_camp_query_mask.loc[idx]):
            row_flags.append("DUPLICATE_QUERY_IN_CAMPAIGN")
        elif bool(dup_query_mask.loc[idx]):
            row_flags.append("DUPLICATE_QUERY_ACROSS_CAMPAIGNS")
        flags_list.append(row_flags)

    work["_row_id"] = np.arange(1, n_rows + 1, dtype=int)
    work["_search_term"] = np.where(term_missing, "[MISSING_SEARCH_TERM]", clean_term)
    work["_norm_term"] = norm_term
    work["_campaign"] = clean_camp
    work["_ad_group"] = clean_ad_group
    work["_match_type"] = clean_match_type
    work["_impressions"] = impr_num
    work["_clicks"] = clicks_num.fillna(0.0)
    work["_cost"] = cost_num.fillna(0.0)
    work["_conversions"] = conv_num.fillna(0.0)
    work["_conversion_value"] = val_num
    work["_quality_flags_list"] = flags_list
    work["_quality_flags"] = ["; ".join(fl) if fl else "OK" for fl in flags_list]
    work["_has_fatal_anomaly"] = (
        missing_req_mask | neg_metric_mask | conv_exceed_clicks_mask
    )

    sample_records = df.head(sample_size).fillna("").to_dict(orient="records")

    report = DataQualityReport(
        total_rows=n_rows,
        total_columns=len(df.columns),
        column_profiles=profiles,
        unique_search_terms=int(norm_term[valid_term_mask].nunique()) if valid_term_mask.any() else 0,
        duplicate_query_row_count=int(dup_query_mask.sum()),
        duplicate_campaign_query_row_count=int(dup_camp_query_mask.sum()),
        missing_required_row_count=int(missing_req_mask.sum()),
        zero_click_row_count=int(zero_click_mask.sum()),
        negative_metric_row_count=int(neg_metric_mask.sum()),
        conversions_exceed_clicks_row_count=int(conv_exceed_clicks_mask.sum()),
        fractional_conversion_row_count=int(fractional_conv_mask.sum()),
        cost_without_clicks_row_count=int(cost_without_clicks_mask.sum()),
        sample_rows=sample_records,
    )

    return work, report
