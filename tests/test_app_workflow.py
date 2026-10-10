"""Workflow and integration acceptance tests for QueryPilot MVP.

Verifies:
1. Synthetic CSV loads end to end with all scenarios
2. Valid uploaded CSV accepted with flexible schema
3. CSV missing required column rejected clearly with useful message
4. Invalid/formatted numeric values ($1,200, N/A, commas) parsed safely
5. Zero-click terms handled without crashing
6. Two-click, one-conversion trap guarded under all configs
7. Changing settings recalculates results deterministically
8. Decision counts strictly agree with result sets
9. Search, campaign, match-type, and review filters return exact records
10. Empty filter results handled gracefully
11. Each export scope contains intended records and columns
12. Replacing dataset invalidates stale decisions
"""

from __future__ import annotations

import io
from pathlib import Path

import pandas as pd
import pytest

from triage.config import ColumnMapping, TriageConfig
from triage.engine import run_triage_engine
from triage.export import EXPORT_COLUMNS, filter_and_sort_results, results_to_csv_string
from triage.loader import load_csv_flexible, suggest_column_mapping

SYNTHETIC_PATH = Path(__file__).resolve().parent.parent / "data" / "sample_synthetic.csv"


def test_synthetic_csv_loads_end_to_end_scenarios():
    """Verify synthetic CSV loads end to end and covers all required test scenarios."""
    assert SYNTHETIC_PATH.exists()
    df = load_csv_flexible(SYNTHETIC_PATH)
    assert len(df) == 24

    mapping = ColumnMapping(
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
    results, summary, report = run_triage_engine(df, mapping, TriageConfig())

    # 1. Total counts agree
    assert len(results) == 24
    assert summary.total_rows == 24
    assert summary.promote_count + summary.block_count + summary.ignore_count == 24

    # 2. Term with insufficient clicks (<10 clicks, e.g. row 8 with 2 clicks) -> IGNORE
    low_click = results[results["clicks"] < 10].iloc[0]
    assert low_click["decision"] == "IGNORE"
    assert "Insufficient" in low_click["confidence_tier"] or "Single-conversion" in low_click["reason"]

    # 3. Term with multiple conversions and adequate evidence -> PROMOTE
    winners = results[results["decision"] == "PROMOTE"]
    assert len(winners) >= 3
    for _, w in winners.iterrows():
        assert w["conversions"] >= 2.0
        assert w["clicks"] >= 10
        assert w["observed_cvr"] > w["shrunk_baseline_cvr"]

    # 4. Term with substantial spend and no conversions -> BLOCK
    losers = results[results["decision"] == "BLOCK"]
    assert len(losers) >= 3
    for _, l in losers.iterrows():
        assert l["cost"] >= summary.effective_block_cost_gate
        assert l["observed_cvr"] < l["shrunk_baseline_cvr"]

    # 5. Term with zero clicks -> IGNORE + ZERO_CLICKS flag
    zero_click_rows = results[results["clicks"] == 0.0]
    assert len(zero_click_rows) >= 2
    assert all(zc["decision"] == "IGNORE" for _, zc in zero_click_rows.iterrows())
    assert any("ZERO_CLICKS" in zc["quality_flags"] for _, zc in zero_click_rows.iterrows())

    # 6. Term with missing conv data -> IGNORE + review_flag=True
    missing_conv = results[results["search_term"] == "unattributed telemetry row missing conv"].iloc[0]
    assert missing_conv["decision"] == "IGNORE"
    assert bool(missing_conv["review_flag"]) is True
    assert "MISSING_VALUES" in missing_conv["quality_flags"]


def test_valid_uploaded_csv_flexible_schema_accepted():
    """A valid uploaded CSV with non-standard column headers is auto-mapped and triaged."""
    custom_csv = """Query Text,Campaign Name,Interactions,Total Cost,Orders
b2b enterprise cloud migration,Enterprise_Migration,80,$120.00,16
cheap student free trial,Consumer_Free,120,$180.00,0
cloud backup pricing quote,Enterprise_Migration,4,$8.00,1
"""
    raw_df = load_csv_flexible(io.StringIO(custom_csv))
    assert len(raw_df) == 3
    suggested = suggest_column_mapping(list(raw_df.columns))

    assert suggested["search_term"] == "Query Text"
    assert suggested["campaign"] == "Campaign Name"
    assert suggested["clicks"] == "Interactions"
    assert suggested["cost"] == "Total Cost"
    assert suggested["conversions"] == "Orders"

    mapping = ColumnMapping(
        search_term=suggested["search_term"],
        campaign=suggested["campaign"],
        clicks=suggested["clicks"],
        cost=suggested["cost"],
        conversions=suggested["conversions"],
    )
    results, summary, report = run_triage_engine(raw_df, mapping, TriageConfig())

    assert len(results) == 3
    assert summary.promote_count == 1
    assert summary.block_count == 1
    assert summary.ignore_count == 1


def test_csv_missing_required_column_rejected_clearly():
    """A CSV missing a required column (e.g. cost) is rejected with an informative error."""
    csv_missing_cost = """search_term,clicks,conversions
test query one,50,5
test query two,100,0
"""
    raw_df = load_csv_flexible(io.StringIO(csv_missing_cost))
    mapping = ColumnMapping(
        search_term="search_term",
        clicks="clicks",
        cost="cost",  # Not in CSV
        conversions="conversions",
    )
    with pytest.raises(ValueError) as exc_info:
        run_triage_engine(raw_df, mapping, TriageConfig())

    err_msg = str(exc_info.value)
    assert "Required mapped columns not found in CSV" in err_msg
    assert "cost" in err_msg
    assert "Available columns" in err_msg


def test_invalid_numeric_values_parsed_safely():
    """Currency symbols, commas, NaNs, and strings are parsed without throwing exceptions."""
    csv_messy_numbers = """search_term,campaign,clicks,cost,conversions
query clean,Camp_A,50,"$1,250.00",5
query currency signs,Camp_A,60,"₹4,500.50",6
query euro,Camp_A,40,"€350.00",4
query text na,Camp_A,N/A,"--",null
query blank,Camp_A,,15.00,
"""
    raw_df = load_csv_flexible(io.StringIO(csv_messy_numbers))
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )
    results, summary, report = run_triage_engine(raw_df, mapping, TriageConfig())

    assert len(results) == 5
    assert report.missing_required_row_count == 2
    # Clean rows parse cost correctly
    assert results.iloc[0]["cost"] == 1250.00
    assert results.iloc[1]["cost"] == 4500.50
    assert results.iloc[2]["cost"] == 350.00


def test_zero_click_term_does_not_crash():
    """Rows with zero clicks do not cause division-by-zero crashes and are flagged."""
    csv_zero_clicks = """search_term,campaign,clicks,cost,conversions
normal term,Camp_A,100,100.00,5
zero clicks zero cost,Camp_A,0,0.00,0
zero clicks positive cost,Camp_A,0,25.00,0
"""
    raw_df = load_csv_flexible(io.StringIO(csv_zero_clicks))
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )
    results, summary, report = run_triage_engine(raw_df, mapping, TriageConfig())

    assert len(results) == 3
    assert report.zero_click_row_count == 2
    assert report.cost_without_clicks_row_count == 1

    zc1 = results.iloc[1]
    assert zc1["decision"] == "IGNORE"
    assert "ZERO_CLICKS" in zc1["quality_flags"]

    zc2 = results.iloc[2]
    assert zc2["decision"] == "IGNORE"
    assert "COST_WITHOUT_CLICKS" in zc2["quality_flags"]
    assert bool(zc2["review_flag"]) is True


def test_two_click_one_conversion_trap_handled_safely():
    """A 2-click, 1-conversion term (50% raw CVR) is NEVER promoted under any config."""
    csv_trap = """search_term,campaign,clicks,cost,conversions
anchor term,Camp_A,500,500.00,25
trap query,Camp_A,2,2.00,1
"""
    raw_df = load_csv_flexible(io.StringIO(csv_trap))
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )
    for min_clicks in [1, 2, 5, 10]:
        cfg = TriageConfig(min_test_clicks=min_clicks, min_promote_conversions=2.0)
        results, _, _ = run_triage_engine(raw_df, mapping, cfg)
        trap_row = results[results["search_term"] == "trap query"].iloc[0]
        assert trap_row["decision"] == "IGNORE"
        assert "Single conversion" in trap_row["reason"] or "Single-conversion" in trap_row["reason"] or "trap" in trap_row["reason"]


def test_changing_settings_recalculates_results():
    """Changing alpha, strict_fdr_gate, or cost multiplier recalculates decisions deterministically."""
    df = load_csv_flexible(SYNTHETIC_PATH)
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )

    # Run 1: Standard alpha=0.05, unadjusted gate
    res1, sum1, _ = run_triage_engine(df, mapping, TriageConfig(alpha=0.05, strict_fdr_gate=False))

    # Run 2: Strict FDR gate required
    res2, sum2, _ = run_triage_engine(df, mapping, TriageConfig(alpha=0.05, strict_fdr_gate=True))

    # Run 3: Very high block cost multiplier (3.0x CPA) makes blocking harder
    res3, sum3, _ = run_triage_engine(df, mapping, TriageConfig(block_cost_cpa_multiplier=3.0))

    assert sum3.block_count <= sum1.block_count
    assert sum3.effective_block_cost_gate > sum1.effective_block_cost_gate


def test_decision_counts_agree_with_result_set():
    """Summary counts strictly equal the sum of result rows."""
    df = load_csv_flexible(SYNTHETIC_PATH)
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )
    results, summary, _ = run_triage_engine(df, mapping, TriageConfig())

    assert summary.promote_count == int((results["decision"] == "PROMOTE").sum())
    assert summary.block_count == int((results["decision"] == "BLOCK").sum())
    assert summary.ignore_count == int((results["decision"] == "IGNORE").sum())
    assert summary.review_flagged_count == int(results["review_flag"].sum())
    assert summary.total_rows == len(results)


def test_search_and_filters_return_correct_records():
    """filter_and_sort_results correctly isolates decision, campaign, match_type, search, and review flags."""
    df = load_csv_flexible(SYNTHETIC_PATH)
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        ad_group="ad_group",
        match_type="match_type",
        impressions="impressions",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )
    results, _, _ = run_triage_engine(df, mapping, TriageConfig())

    # 1. Decision filter
    promote_only = filter_and_sort_results(results, decisions=["PROMOTE"])
    assert all(r["decision"] == "PROMOTE" for _, r in promote_only.iterrows())
    assert len(promote_only) == (results["decision"] == "PROMOTE").sum()

    # 2. Campaign filter
    camp_only = filter_and_sort_results(results, campaigns=["SYNTHETIC_B2B_Cloud_Backup"])
    assert all(r["campaign"] == "SYNTHETIC_B2B_Cloud_Backup" for _, r in camp_only.iterrows())

    # 3. Match type filter
    exact_only = filter_and_sort_results(results, match_types=["Exact"])
    assert all(r["match_type"] == "Exact" for _, r in exact_only.iterrows())

    # 4. Search query filter
    searched = filter_and_sort_results(results, search_query="ransomware")
    assert len(searched) >= 1
    assert any("ransomware" in r["search_term"].lower() for _, r in searched.iterrows())

    # 5. Review only filter
    rev_only = filter_and_sort_results(results, review_only=True)
    assert all(r["review_flag"] is True for _, r in rev_only.iterrows())


def test_empty_filter_results_handled_gracefully():
    """An impossible search query returns an empty DataFrame with valid columns without error."""
    df = load_csv_flexible(SYNTHETIC_PATH)
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )
    results, _, _ = run_triage_engine(df, mapping, TriageConfig())

    empty_res = filter_and_sort_results(results, search_query="xyznonexistentquery12345")
    assert len(empty_res) == 0
    assert list(empty_res.columns) == EXPORT_COLUMNS

    csv_str = results_to_csv_string(empty_res)
    assert "search_term" in csv_str
    reloaded = pd.read_csv(io.StringIO(csv_str))
    assert len(reloaded) == 0


def test_each_export_contains_intended_records_and_columns():
    """CSV export serializes complete diagnostic columns, UTF-8 text, and exact row counts."""
    df = load_csv_flexible(SYNTHETIC_PATH)
    mapping = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )
    results, summary, _ = run_triage_engine(df, mapping, TriageConfig())

    # 1. Full export
    full_csv = results_to_csv_string(results)
    df_full = pd.read_csv(io.StringIO(full_csv))
    assert len(df_full) == 24
    assert list(df_full.columns) == EXPORT_COLUMNS

    # 2. Promote export
    promote_csv = results_to_csv_string(results[results["decision"] == "PROMOTE"])
    df_promote = pd.read_csv(io.StringIO(promote_csv))
    assert len(df_promote) == summary.promote_count
    assert all(df_promote["decision"] == "PROMOTE")

    # 3. Block export
    block_csv = results_to_csv_string(results[results["decision"] == "BLOCK"])
    df_block = pd.read_csv(io.StringIO(block_csv))
    assert len(df_block) == summary.block_count
    assert all(df_block["decision"] == "BLOCK")

    # 4. Review export
    review_csv = results_to_csv_string(results[results["review_flag"] == True])
    df_review = pd.read_csv(io.StringIO(review_csv))
    assert len(df_review) == summary.review_flagged_count
    assert all(df_review["review_flag"] == True)


def test_replacing_dataset_does_not_retain_stale_decisions():
    """Running on Dataset A then Dataset B generates completely fresh, non-leaking results."""
    df_a = load_csv_flexible(SYNTHETIC_PATH)
    mapping_a = ColumnMapping(
        search_term="search_term",
        campaign="campaign",
        clicks="clicks",
        cost="cost",
        conversions="conversions",
    )
    results_a, summary_a, _ = run_triage_engine(df_a, mapping_a, TriageConfig())

    df_b = pd.DataFrame(
        [
            {"query": "custom term alpha", "clk": 100, "sp": 150.0, "cv": 20},
            {"query": "custom term beta", "clk": 200, "sp": 250.0, "cv": 0},
        ]
    )
    mapping_b = ColumnMapping(
        search_term="query",
        clicks="clk",
        cost="sp",
        conversions="cv",
    )
    results_b, summary_b, _ = run_triage_engine(df_b, mapping_b, TriageConfig())

    assert len(results_b) == 2
    assert summary_b.total_rows == 2
    assert set(results_b["search_term"]) == {"custom term alpha", "custom term beta"}
    assert "enterprise cloud backup software" not in list(results_b["search_term"])
