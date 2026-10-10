"""Configuration and schema mapping definitions for Search Term Triage Engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass(frozen=True)
class TriageConfig:
    """Configurable statistical and business heuristic thresholds.

    Note: These default values are pragmatic operational heuristics,
    not universal statistical truths.
    """

    alpha: float = 0.05
    shrinkage_k: float = 100.0
    min_test_clicks: int = 10
    min_promote_conversions: float = 2.0
    block_cost_cpa_multiplier: float = 1.0
    fallback_block_cost_floor: float = 25.0
    strict_fdr_gate: bool = False

    def validate(self) -> None:
        """Validate configuration bounds."""
        if not (0.0 < self.alpha < 1.0):
            raise ValueError(f"alpha must be strictly between 0 and 1, got {self.alpha}")
        if self.shrinkage_k < 0.0:
            raise ValueError(f"shrinkage_k must be non-negative, got {self.shrinkage_k}")
        if self.min_test_clicks < 1:
            raise ValueError(f"min_test_clicks must be >= 1, got {self.min_test_clicks}")
        if self.min_promote_conversions < 2.0:
            raise ValueError(
                f"min_promote_conversions must be >= 2.0 (never promote a 1-conversion term), "
                f"got {self.min_promote_conversions}"
            )
        if self.block_cost_cpa_multiplier < 0.0:
            raise ValueError(
                f"block_cost_cpa_multiplier must be >= 0.0, got {self.block_cost_cpa_multiplier}"
            )


@dataclass
class ColumnMapping:
    """Configurable mapping from user CSV headers to canonical internal columns.

    Required canonical fields:
    - search_term
    - clicks
    - cost
    - conversions

    Optional canonical fields:
    - campaign (defaults to 'Unassigned Campaign' if not mapped)
    - ad_group
    - match_type
    - impressions
    - conversion_value (informational only; never drives automated triage decisions)
    """

    search_term: str
    clicks: str
    cost: str
    conversions: str
    campaign: Optional[str] = None
    ad_group: Optional[str] = None
    match_type: Optional[str] = None
    impressions: Optional[str] = None
    conversion_value: Optional[str] = None

    def to_dict(self) -> Dict[str, Optional[str]]:
        return {
            "search_term": self.search_term,
            "campaign": self.campaign,
            "ad_group": self.ad_group,
            "match_type": self.match_type,
            "impressions": self.impressions,
            "clicks": self.clicks,
            "cost": self.cost,
            "conversions": self.conversions,
            "conversion_value": self.conversion_value,
        }


# Common candidate aliases for automatic initial column suggestion in the UI/loader.
# The user can always override any of these mappings.
CANDIDATE_ALIASES: Dict[str, List[str]] = {
    "search_term": [
        "search_term",
        "search term",
        "query",
        "search_query",
        "search query",
        "customer_search_term",
        "customer search term",
        "term",
        "keyword_text",
    ],
    "campaign": [
        "campaign",
        "campaign_name",
        "campaign name",
        "campaign id",
        "campaign_id",
    ],
    "ad_group": [
        "ad_group",
        "ad group",
        "ad_group_name",
        "ad group name",
        "adgroup",
    ],
    "match_type": [
        "match_type",
        "match type",
        "query_match_type",
    ],
    "impressions": [
        "impressions",
        "impr.",
        "impr",
        "imps",
    ],
    "clicks": [
        "clicks",
        "click",
        "interactions",
    ],
    "cost": [
        "cost",
        "spend",
        "cost_usd",
        "cost (usd)",
        "cost_inr",
        "amount_spent",
        "total_cost",
    ],
    "conversions": [
        "conversions",
        "conv.",
        "conv",
        "orders",
        "purchases",
        "leads",
    ],
    "conversion_value": [
        "conversion_value",
        "conv. value",
        "conv value",
        "revenue",
        "sales",
        "total_conversion_value",
        "value",
    ],
}
