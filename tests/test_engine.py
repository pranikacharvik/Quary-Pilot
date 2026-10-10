"""Acceptance and edge-case tests for the Search Term Triage Engine."""

from __future__ import annotations

import io
from pathlib import Path

import pandas as pd
import pytest

from triage.config import ColumnMapping, TriageConfig
from triage.engine import VALID_DECISIONS, run_triage_engine
from triage.export import filter_and_sort_results, results_to_csv_string
from triage.loader import load_csv_flexible, suggest_column_mapping


DEFAULT_MAPPING = ColumnMapping(
    search_term="search_term",
    campaign="campaign",
    ad_group="ad_group",
    match_type="match_type",
    impressions="impressions",
    clicks="clicks",
    cost="cost",
    conversions="conversions",
    conversion_value="conversion_value",
)


def _build_reference_dataset() -> pd.DataFrame:
    """Build a controlled test dataset with known statistical properties."""
    rows = [
        # 1. Strong candidate for PROMOTE (65 clicks, 14 conversions -> ~21.5% CVR vs ~5% baseline)
        {
            "search_term": "strong winner query",
            "campaign": "Camp_A",
            "ad_group": "AG_1",
            "match_type": "Exact",
            "impressions": 900,
            "clicks": 65,
            "cost": 110.0,
            "conversions": 14,
            "conversion_value": 4200.0,
        },
        # 2. High-click zero-conversion costly term for BLOCK (105 clicks, 0 conv, $160 cost)
        {
            "search_term": "high spend zero conv loser",
            "campaign": "Camp_A",
            "ad_group": "AG_1",
            "match_type": "Broad",
            "impressions": 2200,
            "clicks": 105,
            "cost": 160.0,
            "conversions": 0,
            "conversion_value": 0.0,
        },
        # 3. Two-click / one-conversion trap (50% raw CVR, $2 CPA -> MUST BE IGNORE)
        {
            "search_term": "two click one conv trap",
            "campaign": "Camp_A",
            "ad_group": "AG_1",
            "match_type": "Phrase",
            "impressions": 25,
            "clicks": 2,
            "cost": 2.0,
            "conversions": 1,
            "conversion_value": 500.0,
        },
        # 4. Higher-click single-conversion term (15 clicks, 1 conv -> MUST NEVER PROMOTE)
        {
            "search_term": "fifteen click single conv",
            "campaign": "Camp_A",
            "ad_group": "AG_1",
            "match_type": "Phrase",
            "impressions": 180,
            "clicks": 15,
            "cost": 22.0,
            "conversions": 1,
            "conversion_value": 300.0,
        },
        # 5. Baseline anchor rows (~5% CVR, ~$25 CPA)
        {
            "search_term": "baseline query alpha",
            "campaign": "Camp_A",
            "ad_group": "AG_1",
            "match_type": "Phrase",
            "impressions": 1500,
            "clicks": 200,
            "cost": 250.0,
            "conversions": 10,
            "conversion_value": 2500.0,
        },
        {
            "search_term": "baseline query beta",
            "campaign": "Camp_B",
            "ad_group": "AG_2",
            "match_type": "Exact",
            "impressions": 1600,
            "clicks": 200,
            "cost": 250.0,
            "conversions": 10,
            "conversion_value": 2500.0,
        },
        {
            "search_term": "baseline query gamma",
            "campaign": "Camp_B",
            "ad_group": "AG_2",
            "match_type": "Broad",
            "impressions": 1400,
            "clicks": 200,
            "cost": 250.0,
            "conversions": 10,
            "conversion_value": 2500.0,
        },
    ]
    return pd.DataFrame(rows)


def test_acceptance_core_scenarios():
    """Verify the two-click/one-conversion trap, costly zero-conversion term, and strong winner."""
    df = _build_reference_dataset()
    results, summary, report = run_triage_engine(df, DEFAULT_MAPPING, TriageConfig())

    assert len(results) == len(df)
    assert summary.total_rows == len(df)
    assert set(results["decision"]).issubset(set(VALID_DECISIONS))

    by_term = results.set_index("search_term")

    # 1. Strong candidate for promotion -> PROMOTE
    winner = by_term.loc["strong winner query"]
    assert winner["decision"] == "PROMOTE"
    assert "PROMOTE:" in winner["reason"]

    # 2. High-click zero-conversion costly term -> BLOCK
    loser = by_term.loc["high spend zero conv loser"]
    assert loser["decision"] == "BLOCK"
    assert "BLOCK:" in loser["reason"]

    # 3. Two-click / one-conversion trap -> IGNORE (even though raw CVR is 50%)
    trap = by_term.loc["two click one conv trap"]
    assert trap["decision"] == "IGNORE"
    assert trap["observed_cvr"] == pytest.approx(0.5)

    # 4. Fifteen-click / one-conversion term -> IGNORE (never promote 1 conversion)
    single_conv = by_term.loc["fifteen click single conv"]
    assert single_conv["decision"] == "IGNORE"


def test_two_click_one_conversion_trap_even_if_min_clicks_lowered():
    """Even if a user sets min_test_clicks=1, a 2-click 1-conversion term is NEVER promoted."""
    df = _build_reference_dataset()
    cfg = TriageConfig(min_test_clicks=1, min_promote_conversions=2.0)
    results, _, _ = run_triage_engine(df, DEFAULT_MAPPING, cfg)
    trap = results.set_index("search_term").loc["two click one conv trap"]
    assert trap["decision"] == "IGNORE"


def test_edge_cases_anomalies_and_flags():
    """Verify safe handling of zero clicks, fractional conversions, conv > clicks, missing values, and duplicates."""
    csv_content = """search_term,campaign,clicks,cost,conversions,conversion_value
baseline one,Camp_1,200,200.00,10,1000
baseline two,Camp_1,200,200.00,10,1000
zero click term,Camp_1,0,0.00,0,0
conversions exceed clicks term,Camp_1,4,12.00,7,700
fractional conversion low,Camp_1,18,25.00,1.7,170
fractional conversion high,Camp_1,50,80.00,11.4,1140
duplicate query,Camp_1,40,50.00,2,200
duplicate query,Camp_1,35,45.00,2,200
missing clicks row,Camp_1,,15.00,0,0
"""
    raw_df = load_csv_flexible(io.StringIO(csv_content))
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
        conversion_value="conversion_value",
    )
    results, summary, report = run_triage_engine(raw_df, mapping, TriageConfig())

    assert len(results) == 9
    assert report.zero_click_row_count == 1
    assert report.conversions_exceed_clicks_row_count == 1
    assert report.fractional_conversion_row_count == 2
    assert report.duplicate_campaign_query_row_count == 2
    assert report.missing_required_row_count == 1

    # Zero clicks -> IGNORE + ZERO_CLICKS flag
    zc = results[results["search_term"] == "zero click term"].iloc[0]
    assert zc["decision"] == "IGNORE"
    assert "ZERO_CLICKS" in zc["quality_flags"]

    # Conversions > clicks -> IGNORE + CONVERSIONS_EXCEED_CLICKS + review_flag=True
    cec = results[results["search_term"] == "conversions exceed clicks term"].iloc[0]
    assert cec["decision"] == "IGNORE"
    assert "CONVERSIONS_EXCEED_CLICKS" in cec["quality_flags"]
    assert bool(cec["review_flag"]) is True

    # Fractional conversion < 2 (1.7 conv) -> NEVER promoted
    frac_low = results[results["search_term"] == "fractional conversion low"].iloc[0]
    assert frac_low["decision"] == "IGNORE"
    assert "FRACTIONAL_CONVERSIONS" in frac_low["quality_flags"]
    assert bool(frac_low["review_flag"]) is True

    # Fractional conversion high (11.4 conv / 50 clicks) -> PROMOTE with review_flag=True
    frac_high = results[results["search_term"] == "fractional conversion high"].iloc[0]
    assert frac_high["decision"] == "PROMOTE"
    assert "FRACTIONAL_CONVERSIONS" in frac_high["quality_flags"]
    assert bool(frac_high["review_flag"]) is True

    # Duplicate query in campaign -> both rows preserved, both flagged
    dups = results[results["search_term"] == "duplicate query"]
    assert len(dups) == 2
    assert all("DUPLICATE_QUERY_IN_CAMPAIGN" in fl for fl in dups["quality_flags"])
    assert all(bool(rf) is True for rf in dups["review_flag"])

    # Missing clicks row -> IGNORE + MISSING_VALUES + review_flag=True
    miss = results[results["search_term"] == "missing clicks row"].iloc[0]
    assert miss["decision"] == "IGNORE"
    assert "MISSING_VALUES" in miss["quality_flags"]
    assert bool(miss["review_flag"]) is True


def test_zero_baseline_dataset():
    """Verify safe handling when the entire dataset has 0 conversions (zero baseline)."""
    df = pd.DataFrame(
        [
            {"q": "term a", "c": "C1", "clk": 50, "spend": 100.0, "conv": 0},
            {"q": "term b", "c": "C1", "clk": 80, "spend": 150.0, "conv": 0},
        ]
    )
    mapping = ColumnMapping(
        search_term="q", campaign="c", clicks="clk", cost="spend", conversions="conv"
    )
    results, summary, _ = run_triage_engine(df, mapping, TriageConfig())
    assert len(results) == 2
    assert summary.account_baseline_cvr == 0.0
    assert summary.account_cpa is None
    assert all(results["decision"] == "IGNORE")
    assert all("ZERO_BASELINE" in fl for fl in results["quality_flags"])


def test_synthetic_sample_csv_end_to_end():
    """Run the triage engine on data/sample_synthetic.csv and verify export parity."""
    sample_path = Path(__file__).resolve().parent.parent / "data" / "sample_synthetic.csv"
    assert sample_path.exists(), "data/sample_synthetic.csv must exist"

    raw_df = load_csv_flexible(sample_path)
    suggested = suggest_column_mapping(list(raw_df.columns))
    mapping = ColumnMapping(**suggested)

    results, summary, report = run_triage_engine(raw_df, mapping, TriageConfig())

    assert len(results) == len(raw_df) == 24
    assert summary.promote_count + summary.block_count + summary.ignore_count == len(raw_df)
    assert summary.promote_count >= 3
    assert summary.block_count >= 3

    # Verify export matches displayed results
    filtered = filter_and_sort_results(results, sort_by="row_id", ascending=True)
    csv_text = results_to_csv_string(filtered)
    reloaded = pd.read_csv(io.StringIO(csv_text))
    assert len(reloaded) == len(filtered)
    assert list(reloaded["decision"]) == list(filtered["decision"])
    assert list(reloaded["search_term"]) == list(filtered["search_term"])
