"""Search Term Triage Engine package."""

from .config import CANDIDATE_ALIASES, ColumnMapping, TriageConfig
from .engine import VALID_DECISIONS, TriageSummary, run_triage_engine
from .export import EXPORT_COLUMNS, filter_and_sort_results, results_to_csv_string
from .loader import (
    ColumnProfile,
    DataQualityReport,
    load_csv_flexible,
    prepare_and_inspect_dataframe,
    suggest_column_mapping,
)
from .stats import (
    benjamini_hochberg,
    compute_leave_one_out_shrunk_baseline,
    exact_binomial_tails,
    wilson_interval,
)

__all__ = [
    "CANDIDATE_ALIASES",
    "ColumnMapping",
    "TriageConfig",
    "VALID_DECISIONS",
    "TriageSummary",
    "run_triage_engine",
    "EXPORT_COLUMNS",
    "filter_and_sort_results",
    "results_to_csv_string",
    "ColumnProfile",
    "DataQualityReport",
    "load_csv_flexible",
    "prepare_and_inspect_dataframe",
    "suggest_column_mapping",
    "benjamini_hochberg",
    "compute_leave_one_out_shrunk_baseline",
    "exact_binomial_tails",
    "wilson_interval",
]
