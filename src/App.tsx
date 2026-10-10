import React, { useState, useCallback, useMemo, useRef } from 'react';
import { PRESET_DATASETS } from './demoDatasets';
import { runTriageEngine, type TriageConfig as ClientTriageConfig } from './triageEngine';

/* ============================================
   Type Definitions
   ============================================ */
interface ColumnMappingType {
  search_term: string | null;
  campaign: string | null;
  ad_group: string | null;
  match_type: string | null;
  impressions: string | null;
  clicks: string | null;
  cost: string | null;
  conversions: string | null;
  conversion_value: string | null;
}

interface TriageResult {
  row_id: number;
  search_term: string;
  campaign: string;
  ad_group: string;
  match_type: string;
  impressions: number | null;
  clicks: number;
  cost: number;
  conversions: number;
  conversion_value_info: number | null;
  observed_cvr: number;
  observed_cpa: number | null;
  campaign_loo_cvr: number;
  account_loo_cvr: number;
  shrunk_baseline_cvr: number;
  wilson_ci_lower: number;
  wilson_ci_upper: number;
  p_value_lower: number;
  p_value_upper: number;
  q_value_lower: number;
  q_value_upper: number;
  decision: 'PROMOTE' | 'BLOCK' | 'IGNORE';
  confidence_tier: string;
  review_flag: boolean;
  quality_flags: string;
  reason: string;
}

interface TriageSummary {
  total_rows: number;
  promote_count: number;
  block_count: number;
  ignore_count: number;
  review_flagged_count: number;
  account_valid_clicks: number;
  account_valid_conversions: number;
  account_valid_cost: number;
  account_baseline_cvr: number;
  account_cpa: number | null;
  effective_block_cost_gate: number;
}

interface QualityReport {
  total_rows: number;
  total_columns: number;
  unique_search_terms: number;
  duplicate_query_row_count: number;
  missing_required_row_count: number;
  zero_click_row_count: number;
  negative_metric_row_count?: number;
  conversions_exceed_clicks_row_count?: number;
  fractional_conversion_row_count?: number;
}

interface CampaignSummaryItem {
  campaign: string;
  total: number;
  promote: number;
  block: number;
  ignore: number;
  total_cost: number;
  total_clicks: number;
  total_conversions: number;
}

interface AnalysisResponse {
  results: TriageResult[];
  summary: TriageSummary;
  quality_report: QualityReport;
  decision_counts: Record<string, number>;
  campaign_summary: CampaignSummaryItem[];
}

interface ConfigSettings {
  alpha: number;
  shrinkage_k: number;
  min_test_clicks: number;
  min_promote_conversions: number;
  block_cost_cpa_multiplier: number;
  fallback_block_cost_floor: number;
  strict_fdr_gate: boolean;
}

type ScreenTab = 'overview' | 'data' | 'campaigns' | 'calibration';

/* ============================================
   Formatting Helpers
   ============================================ */
const fmt = (n: number | null | undefined, decimals = 2): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

const fmtPct = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
};

const fmtCurrency = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtInt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
};

/* ============================================
   Decision Badge Component (PlacementOS style)
   ============================================ */
const DecisionBadge: React.FC<{ decision: string; size?: 'sm' | 'md' }> = ({ decision, size = 'sm' }) => {
  if (decision === 'PROMOTE') {
    return (
      <span className={`inline-flex items-center gap-1 font-mono font-bold uppercase rounded ${size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'} bg-[#e6f7ef] text-tertiary border border-tertiary/30`}>
        <span className="w-1.5 h-1.5 rounded-full bg-tertiary"></span>
        PROMOTE
      </span>
    );
  }
  if (decision === 'BLOCK') {
    return (
      <span className={`inline-flex items-center gap-1 font-mono font-bold uppercase rounded ${size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'} bg-error-container text-error border border-error/30`}>
        <span className="w-1.5 h-1.5 rounded-full bg-error"></span>
        BLOCK
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1 font-mono font-bold uppercase rounded ${size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'} bg-surface-container text-on-surface-variant border border-outline-variant/60`}>
      <span className="w-1.5 h-1.5 rounded-full bg-outline"></span>
      IGNORE
    </span>
  );
};

/* ============================================
   Main Application
   ============================================ */
export default function App() {
  const [currentScreen, setCurrentScreen] = useState<'intake' | 'mapping' | 'analyzing' | 'dashboard'>('intake');
  const [activeTab, setActiveTab] = useState<ScreenTab>('overview');

  const [file, setFile] = useState<File | null>(null);
  const [datasetName, setDatasetName] = useState<string>('Synthetic Benchmark');
  const [rawCsvText, setRawCsvText] = useState<string>('');
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMappingType>({
    search_term: null, campaign: null, ad_group: null, match_type: null,
    impressions: null, clicks: null, cost: null, conversions: null, conversion_value: null,
  });
  const [sampleRows, setSampleRows] = useState<Record<string, string>[]>([]);
  const [results, setResults] = useState<TriageResult[]>([]);
  const [summary, setSummary] = useState<TriageSummary | null>(null);
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);
  const [campaignSummary, setCampaignSummary] = useState<CampaignSummaryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [engineSource, setEngineSource] = useState<'fastapi' | 'client'>('fastapi');

  // Configurable Hyperparameters
  const [configSettings, setConfigSettings] = useState<ConfigSettings>({
    alpha: 0.05,
    shrinkage_k: 100.0,
    min_test_clicks: 10,
    min_promote_conversions: 2.0,
    block_cost_cpa_multiplier: 1.0,
    fallback_block_cost_floor: 25.0,
    strict_fdr_gate: false,
  });
  const [showConfigDrawer, setShowConfigDrawer] = useState(false);

  // Filters & Sorting
  const [searchQuery, setSearchQuery] = useState('');
  const [decisionFilter, setDecisionFilter] = useState<string[]>([]);
  const [campaignFilter, setCampaignFilter] = useState<string[]>([]);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sortField, setSortField] = useState<string>('row_id');
  const [sortAsc, setSortAsc] = useState(true);

  // Detail Drawer
  const [selectedRow, setSelectedRow] = useState<TriageResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---- CSV Parsing Helper ---- */
  const parseCsvLinesLocally = (text: string) => {
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
    const rows = lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        obj[h] = vals[idx] ?? '';
      });
      return obj;
    });
    return { headers, rows };
  };

  /* ---- File Select Handler ---- */
  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setDatasetName(selectedFile.name.replace('.csv', ''));
    setError(null);
    setIsLoading(true);

    try {
      const text = await selectedFile.text();
      setRawCsvText(text);

      const formData = new FormData();
      formData.append('file', selectedFile);

      // Try FastAPI backend preview
      try {
        const resp = await fetch('/api/preview', { method: 'POST', body: formData });
        if (resp.ok) {
          const data = await resp.json();
          setColumns(data.columns);
          setMapping(data.suggested_mapping);
          setSampleRows(data.sample_rows);
          setEngineSource('fastapi');
          setCurrentScreen('mapping');
          return;
        }
      } catch (backendErr) {
        console.warn('FastAPI preview unavailable, using client CSV parser:', backendErr);
      }

      // Local fallback parsing
      const { headers, rows } = parseCsvLinesLocally(text);
      if (headers.length === 0) throw new Error('Uploaded CSV file appears to be empty.');

      const suggested: ColumnMappingType = {
        search_term: headers.find(h => /search[_\s]?term|query|keyword/i.test(h)) || headers[0],
        campaign: headers.find(h => /campaign/i.test(h)) || null,
        ad_group: headers.find(h => /ad[_\s]?group/i.test(h)) || null,
        match_type: headers.find(h => /match[_\s]?type/i.test(h)) || null,
        impressions: headers.find(h => /impressions?|impr/i.test(h)) || null,
        clicks: headers.find(h => /^clicks?$/i.test(h)) || null,
        cost: headers.find(h => /^cost|spend$/i.test(h)) || null,
        conversions: headers.find(h => /conv|conversions?/i.test(h)) || null,
        conversion_value: headers.find(h => /conversion[_\s]?value|revenue/i.test(h)) || null,
      };

      setColumns(headers);
      setMapping(suggested);
      setSampleRows(rows.slice(0, 5));
      setEngineSource('client');
      setCurrentScreen('mapping');
    } catch (e: any) {
      setError(e.message || 'Failed to inspect dataset');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /* ---- Run Analysis ---- */
  const runAnalysis = useCallback(async () => {
    if (!file && !rawCsvText) return;

    const requiredFields: (keyof ColumnMappingType)[] = ['search_term', 'clicks', 'cost', 'conversions'];
    const missing = requiredFields.filter(f => !mapping[f]);
    if (missing.length > 0) {
      setError(`Required column mappings missing: ${missing.join(', ')}`);
      return;
    }

    setIsLoading(true);
    setError(null);
    setCurrentScreen('analyzing');

    try {
      // 1. Try FastAPI backend execution
      try {
        const formData = new FormData();
        if (file) {
          formData.append('file', file);
        } else {
          const blob = new Blob([rawCsvText], { type: 'text/csv' });
          formData.append('file', new File([blob], 'dataset.csv', { type: 'text/csv' }));
        }
        formData.append('column_mapping', JSON.stringify(mapping));
        formData.append('config', JSON.stringify(configSettings));

        const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
        if (resp.ok) {
          const data: AnalysisResponse = await resp.json();
          setResults(data.results);
          setSummary(data.summary);
          setQualityReport(data.quality_report);
          setCampaignSummary(data.campaign_summary);
          setEngineSource('fastapi');
          setCurrentScreen('dashboard');
          setActiveTab('overview');
          return;
        }
      } catch (backendErr) {
        console.warn('FastAPI backend failed, falling back to client-side engine:', backendErr);
      }

      // 2. Client-side engine mirror fallback
      const { rows } = parseCsvLinesLocally(rawCsvText);
      const clientConfig: ClientTriageConfig = {
        alpha: configSettings.alpha,
        shrinkageK: configSettings.shrinkage_k,
        minTestClicks: configSettings.min_test_clicks,
        minPromoteConversions: configSettings.min_promote_conversions,
        blockCostCpaMultiplier: configSettings.block_cost_cpa_multiplier,
        fallbackBlockCostFloor: configSettings.fallback_block_cost_floor,
        strictFdrGate: configSettings.strict_fdr_gate,
      };

      const localAnalysis = runTriageEngine(
        rows,
        {
          search_term: mapping.search_term!,
          clicks: mapping.clicks!,
          cost: mapping.cost!,
          conversions: mapping.conversions!,
          campaign: mapping.campaign || undefined,
          ad_group: mapping.ad_group || undefined,
          match_type: mapping.match_type || undefined,
          impressions: mapping.impressions || undefined,
          conversion_value: mapping.conversion_value || undefined,
        },
        clientConfig
      );

      const campMap: Record<string, CampaignSummaryItem> = {};
      localAnalysis.results.forEach((r: any) => {
        const c = r.campaign || 'ALL_CAMPAIGNS';
        if (!campMap[c]) {
          campMap[c] = {
            campaign: c,
            total: 0,
            promote: 0,
            block: 0,
            ignore: 0,
            total_cost: 0,
            total_clicks: 0,
            total_conversions: 0,
          };
        }
        campMap[c].total++;
        if (r.decision === 'PROMOTE') campMap[c].promote++;
        if (r.decision === 'BLOCK') campMap[c].block++;
        if (r.decision === 'IGNORE') campMap[c].ignore++;
        campMap[c].total_cost += r.cost || 0;
        campMap[c].total_clicks += r.clicks || 0;
        campMap[c].total_conversions += r.conversions || 0;
      });

      const clientSummary: TriageSummary = {
        total_rows: localAnalysis.summary.totalRows,
        promote_count: localAnalysis.summary.promoteCount,
        block_count: localAnalysis.summary.blockCount,
        ignore_count: localAnalysis.summary.ignoreCount,
        review_flagged_count: localAnalysis.summary.reviewFlaggedCount,
        account_valid_clicks: localAnalysis.summary.accountValidClicks,
        account_valid_conversions: localAnalysis.summary.accountValidConversions,
        account_valid_cost: localAnalysis.summary.accountValidCost,
        account_baseline_cvr: localAnalysis.summary.accountBaselineCvr,
        account_cpa: localAnalysis.summary.accountCpa,
        effective_block_cost_gate: localAnalysis.summary.effectiveBlockCostGate,
      };

      const clientQuality: QualityReport = {
        total_rows: localAnalysis.qualityReport.totalRows,
        total_columns: localAnalysis.qualityReport.totalColumns,
        unique_search_terms: localAnalysis.qualityReport.uniqueSearchTerms,
        duplicate_query_row_count: localAnalysis.qualityReport.duplicateQueryRowCount,
        missing_required_row_count: localAnalysis.qualityReport.missingRequiredRowCount,
        zero_click_row_count: localAnalysis.qualityReport.zeroClickRowCount,
        negative_metric_row_count: localAnalysis.qualityReport.negativeMetricRowCount,
        conversions_exceed_clicks_row_count: localAnalysis.qualityReport.conversionsExceedClicksRowCount,
        fractional_conversion_row_count: localAnalysis.qualityReport.fractionalConversionRowCount,
      };

      setResults(localAnalysis.results as any);
      setSummary(clientSummary);
      setQualityReport(clientQuality);
      setCampaignSummary(Object.values(campMap));
      setEngineSource('client');
      setCurrentScreen('dashboard');
      setActiveTab('overview');
    } catch (e: any) {
      setError(e.message || 'Analysis failed');
      setCurrentScreen('mapping');
    } finally {
      setIsLoading(false);
    }
  }, [file, rawCsvText, mapping, configSettings]);

  /* ---- Filtered and Sorted Rows ---- */
  const filteredResults = useMemo(() => {
    let data = [...results];

    if (decisionFilter.length > 0) {
      data = data.filter(r => decisionFilter.includes(r.decision));
    }
    if (campaignFilter.length > 0) {
      data = data.filter(r => campaignFilter.includes(r.campaign));
    }
    if (reviewOnly) {
      data = data.filter(r => r.review_flag);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      data = data.filter(r =>
        r.search_term.toLowerCase().includes(q) ||
        r.campaign.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q)
      );
    }

    data.sort((a: any, b: any) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      if (typeof aVal === 'string') {
        return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortAsc ? aVal - bVal : bVal - aVal;
    });

    return data;
  }, [results, decisionFilter, campaignFilter, reviewOnly, searchQuery, sortField, sortAsc]);

  const uniqueCampaigns = useMemo(() => [...new Set(results.map(r => r.campaign))], [results]);

  /* ---- Export Handler ---- */
  const handleExport = useCallback(async () => {
    try {
      try {
        const formData = new FormData();
        formData.append('results', JSON.stringify(filteredResults));

        const resp = await fetch('/api/export', { method: 'POST', body: formData });
        if (resp.ok) {
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `querypilot_triage_${datasetName}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          return;
        }
      } catch (err) {
        console.warn('Backend export failed, falling back to browser CSV export:', err);
      }

      if (filteredResults.length === 0) {
        setError('No rows available to export.');
        return;
      }

      const exportKeys: (keyof TriageResult)[] = [
        'row_id', 'search_term', 'campaign', 'ad_group', 'match_type',
        'impressions', 'clicks', 'cost', 'conversions', 'observed_cvr',
        'observed_cpa', 'shrunk_baseline_cvr', 'wilson_ci_lower', 'wilson_ci_upper',
        'p_value_lower', 'p_value_upper', 'q_value_lower', 'q_value_upper',
        'decision', 'confidence_tier', 'review_flag', 'quality_flags', 'reason'
      ];

      const header = exportKeys.join(',');
      const rows = filteredResults.map(r =>
        exportKeys.map(k => {
          const val = r[k];
          if (val === null || val === undefined) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        }).join(',')
      );

      const csvContent = [header, ...rows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `querypilot_triage_${datasetName}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message || 'Export failed');
    }
  }, [filteredResults, datasetName]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const resetAll = () => {
    setCurrentScreen('intake');
    setFile(null);
    setRawCsvText('');
    setColumns([]);
    setResults([]);
    setSummary(null);
    setQualityReport(null);
    setCampaignSummary([]);
    setError(null);
    setSelectedRow(null);
    setSearchQuery('');
    setDecisionFilter([]);
    setCampaignFilter([]);
    setReviewOnly(false);
  };

  /* ==========================================================================
     PLACEMENTOS TOP HEADER
     ========================================================================== */
  const renderHeader = () => (
    <header className="fixed top-0 left-0 right-0 z-50 bg-inverse-surface text-inverse-on-surface shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
      <div className="h-16 w-full px-4 sm:px-8 flex items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCurrentScreen('intake')}
            className="flex items-center gap-2.5 text-left focus:outline-none cursor-pointer"
          >
            <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-white font-bold text-base shadow-sm">
              Q
            </div>
            <span className="text-[18px] text-surface-container-lowest font-bold tracking-tight">
              QueryPilot
            </span>
          </button>

          {/* Context Chip */}
          <div className="hidden xl:flex items-center px-2.5 py-1 bg-on-surface/40 rounded border border-outline-variant/30 text-surface-container-low font-mono text-[11px] tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-tertiary-fixed mr-2 animate-pulse" />
            Target: PS-01 Search Term Triage Engine
          </div>
        </div>

        {/* Navigation Tabs (PlacementOS style) */}
        {results.length > 0 && currentScreen === 'dashboard' && (
          <nav className="hidden lg:flex items-center gap-1">
            {[
              { id: 'overview', label: 'Triage Dashboard' },
              { id: 'data', label: `Search Terms (${results.length})` },
              { id: 'campaigns', label: 'Campaign Calibration' },
              { id: 'calibration', label: 'Statistical Methodology' },
            ].map(tab => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as ScreenTab)}
                  className={`px-3 py-1.5 text-[13px] rounded transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-inverse-on-surface/15 text-surface-container-lowest font-semibold'
                      : 'text-surface-container-high hover:text-surface-container-lowest'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>
        )}

        {/* Right Status Indicators & Action Buttons */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-surface-container-highest/20 rounded border border-outline/30">
            <span className="text-[11px] text-surface-container-highest uppercase tracking-wider font-mono">
              Engine:
            </span>
            <span className="text-[11px] text-tertiary-fixed font-semibold font-mono flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-tertiary-fixed inline-block"></span>
              {engineSource === 'fastapi' ? 'FastAPI Online' : 'Client Mirror'}
            </span>
          </div>

          {results.length > 0 && currentScreen === 'dashboard' && (
            <button
              onClick={handleExport}
              className="bg-primary hover:bg-primary-container text-white px-3 py-1.5 rounded font-mono text-[11px] font-bold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px]">download</span>
              Export CSV
            </button>
          )}

          {currentScreen !== 'intake' && (
            <button
              onClick={resetAll}
              className="bg-surface-container text-on-surface hover:bg-surface-container-high px-3 py-1.5 rounded font-mono text-[11px] flex items-center gap-1.5 transition-colors border border-outline-variant/40 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px] text-primary">restart_alt</span>
              New Run
            </button>
          )}
        </div>
      </div>
    </header>
  );

  /* ==========================================================================
     SCREEN 1: INTAKE & BENCHMARK SELECTION (PlacementOS Style)
     ========================================================================== */
  if (currentScreen === 'intake') {
    return (
      <div className="min-h-screen pt-16 bg-surface flex flex-col justify-between">
        {renderHeader()}

        <main className="max-w-[1200px] w-full mx-auto px-4 sm:px-8 py-10 flex flex-col gap-8 animate-[fadeIn_0.3s_ease-out]">
          {/* Header Banner */}
          <div className="bg-surface-container-lowest rounded-xl p-8 border border-outline-variant/40 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[24px]">troubleshoot</span>
                <span className="font-mono text-xs uppercase tracking-wider text-on-surface-variant font-bold">
                  Forensic Paid Search Intelligence
                </span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-on-surface tracking-tight">
                Search Term Triage Engine
              </h1>
              <p className="text-sm text-on-surface-variant max-w-2xl leading-relaxed">
                Statistical search query evaluation replacing blunt CTR thresholds with Empirical Bayes baseline shrinkage, exact binomial hypothesis testing, and Benjamini-Hochberg FDR multiplicity control.
              </p>
            </div>

            <div className="flex flex-col gap-2 min-w-[220px] bg-surface-container-low p-4 rounded-lg border border-outline-variant/30">
              <span className="font-mono text-[11px] text-on-surface-variant uppercase font-semibold">Triage Guardrails</span>
              <div className="text-xs text-on-surface flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-tertiary">check_circle</span>
                2-Click Trap Defense
              </div>
              <div className="text-xs text-on-surface flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-tertiary">check_circle</span>
                CPA Spend Floor Gate
              </div>
              <div className="text-xs text-on-surface flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-tertiary">check_circle</span>
                Wilson 95% Confidence
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Custom Upload Area (5 cols) */}
            <div className="lg:col-span-6 bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/40 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-on-surface flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[20px]">cloud_upload</span>
                    Upload Search Term Report
                  </h2>
                  <span className="font-mono text-[11px] text-on-surface-variant uppercase">CSV Intake</span>
                </div>

                <div
                  className="border-2 border-dashed border-outline-variant rounded-xl p-8 text-center cursor-pointer bg-surface-container-low/40 hover:bg-surface-container-low hover:border-primary transition-all group"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dropped = e.dataTransfer.files[0];
                    if (dropped && dropped.name.endsWith('.csv')) handleFileSelect(dropped);
                    else setError('Please upload a valid .csv file.');
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                  />

                  <div className="w-14 h-14 mx-auto mb-3 rounded-lg bg-surface-container flex items-center justify-center text-primary group-hover:scale-105 transition-transform shadow-sm">
                    {isLoading ? (
                      <span className="material-symbols-outlined animate-spin text-[28px]">progress_activity</span>
                    ) : (
                      <span className="material-symbols-outlined text-[28px]">upload_file</span>
                    )}
                  </div>

                  <h3 className="text-sm font-bold text-on-surface mb-1">Select or Drop CSV File</h3>
                  <p className="text-xs text-on-surface-variant mb-3">
                    Google Ads search query performance export
                  </p>
                  <span className="inline-block px-2.5 py-1 bg-surface-container-lowest border border-outline-variant/40 rounded text-[11px] font-mono text-on-surface-variant">
                    Required: search_term, clicks, cost, conversions
                  </span>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-outline-variant/30 flex items-center justify-between text-xs text-on-surface-variant">
                <span>Flexible Header Detection</span>
                <span className="font-mono text-[11px] text-primary font-bold">Auto-Aligned</span>
              </div>
            </div>

            {/* Benchmark Datasets (6 cols) */}
            <div className="lg:col-span-6 bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/40 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-on-surface flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[20px]">dataset</span>
                    Pre-Calibrated Benchmarks
                  </h2>
                  <span className="font-mono text-[11px] text-on-surface-variant uppercase">1-Click Test</span>
                </div>

                <div className="space-y-3">
                  {PRESET_DATASETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => {
                        const blob = new Blob([preset.csvContent], { type: 'text/csv' });
                        const demoFile = new File([blob], `${preset.id}.csv`, { type: 'text/csv' });
                        handleFileSelect(demoFile);
                      }}
                      className="w-full text-left p-4 rounded-lg bg-surface-container-low hover:bg-surface-container hover:border-primary/50 transition-all border border-outline-variant/30 flex flex-col gap-1 cursor-pointer group"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-on-surface group-hover:text-primary transition-colors flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-[16px] text-primary">analytics</span>
                          {preset.name}
                        </span>
                        <span className="font-mono text-[10px] bg-secondary-fixed text-on-secondary-fixed px-2 py-0.5 rounded font-bold">
                          {preset.rowCount} Terms
                        </span>
                      </div>
                      <p className="text-[11px] text-on-surface-variant leading-relaxed">
                        {preset.description}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-outline-variant/30 flex items-center justify-between text-xs text-on-surface-variant">
                <span>Instant Evaluation</span>
                <span className="font-mono text-[11px] text-tertiary font-bold">No Upload Required</span>
              </div>
            </div>
          </div>

          {error && (
            <div className="p-4 bg-error-container text-error rounded-lg border border-error/30 flex items-center gap-3">
              <span className="material-symbols-outlined text-[20px]">error</span>
              <p className="text-xs font-medium">{error}</p>
            </div>
          )}
        </main>

        <footer className="w-full py-4 border-t border-outline-variant/30 bg-surface-container-low text-center text-xs text-on-surface-variant font-mono">
          QueryPilot PS-01 • PlacementOS Architectural & Design Standard • Empirical Bayes Statistical Engine
        </footer>
      </div>
    );
  }

  /* ==========================================================================
     SCREEN 2: SCHEMA ALIGNMENT & CALIBRATION (PlacementOS Style)
     ========================================================================== */
  if (currentScreen === 'mapping') {
    const requiredFields = ['search_term', 'clicks', 'cost', 'conversions'];
    const optionalFields = ['campaign', 'ad_group', 'match_type', 'impressions', 'conversion_value'];
    const canProceed = requiredFields.every(f => mapping[f as keyof ColumnMappingType]);

    return (
      <div className="min-h-screen pt-16 bg-surface">
        {renderHeader()}

        {/* Sub-Header Context Bar */}
        <div className="w-full bg-surface-container-low py-3 border-b border-outline-variant/30">
          <div className="max-w-[1440px] mx-auto px-4 sm:px-8 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider">
                Telemetry Schema Verification
              </span>
              <span className="text-outline-variant font-mono">•</span>
              <span className="text-xs font-bold text-on-surface font-mono">{file?.name || 'Dataset'}</span>
            </div>
            <button
              onClick={() => setCurrentScreen('intake')}
              className="text-xs text-on-surface-variant hover:text-on-surface font-mono flex items-center gap-1 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">arrow_back</span>
              Back to Intake
            </button>
          </div>
        </div>

        <main className="max-w-[1440px] mx-auto px-4 sm:px-8 py-6 flex flex-col gap-6 animate-[fadeIn_0.3s_ease-out]">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Column Mapping Form (5 cols) */}
            <div className="lg:col-span-5 flex flex-col gap-5">
              <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-bold text-on-surface flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[18px]">tune</span>
                    Column Alignment
                  </h2>
                  <span className="font-mono text-[11px] text-tertiary font-bold bg-[#e6f7ef] px-2 py-0.5 rounded">
                    {requiredFields.filter(f => mapping[f as keyof ColumnMappingType]).length}/{requiredFields.length} Mandatory Ready
                  </span>
                </div>

                {/* Mandatory Fields */}
                <div className="space-y-3 mb-5">
                  <span className="font-mono text-[10px] text-on-surface-variant uppercase tracking-wider font-bold block">
                    Mandatory Attributes
                  </span>
                  {requiredFields.map(field => (
                    <div key={field} className="flex items-center gap-3">
                      <label className="w-32 text-xs font-medium text-on-surface flex items-center gap-1">
                        {mapping[field as keyof ColumnMappingType] ? (
                          <span className="material-symbols-outlined text-tertiary text-[14px]">check_circle</span>
                        ) : (
                          <span className="material-symbols-outlined text-amber-500 text-[14px]">warning</span>
                        )}
                        {field.replace(/_/g, ' ')}
                      </label>
                      <select
                        value={mapping[field as keyof ColumnMappingType] || ''}
                        onChange={(e) => setMapping(prev => ({ ...prev, [field]: e.target.value || null }))}
                        className="flex-1 bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 text-xs text-on-surface font-mono focus:border-primary focus:outline-none"
                      >
                        <option value="">— Select Column —</option>
                        {columns.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  ))}
                </div>

                {/* Optional Fields */}
                <div className="space-y-3">
                  <span className="font-mono text-[10px] text-on-surface-variant uppercase tracking-wider font-bold block">
                    Optional Categorical Attributes
                  </span>
                  {optionalFields.map(field => (
                    <div key={field} className="flex items-center gap-3">
                      <label className="w-32 text-xs text-on-surface-variant">
                        {field.replace(/_/g, ' ')}
                      </label>
                      <select
                        value={mapping[field as keyof ColumnMappingType] || ''}
                        onChange={(e) => setMapping(prev => ({ ...prev, [field]: e.target.value || null }))}
                        className="flex-1 bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 text-xs text-on-surface font-mono focus:border-primary focus:outline-none"
                      >
                        <option value="">— Not Mapped —</option>
                        {columns.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* Statistical Calibration Settings Card */}
              <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                <button
                  type="button"
                  onClick={() => setShowConfigDrawer(!showConfigDrawer)}
                  className="w-full flex items-center justify-between text-xs font-bold text-on-surface font-mono cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-primary text-[16px]">psychology</span>
                    Statistical Engine Hyperparameters
                  </span>
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant">
                    {showConfigDrawer ? 'expand_less' : 'expand_more'}
                  </span>
                </button>

                {showConfigDrawer && (
                  <div className="mt-4 pt-3 border-t border-outline-variant/30 space-y-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Significance Alpha (α):</span>
                      <select
                        value={configSettings.alpha}
                        onChange={(e) => setConfigSettings(prev => ({ ...prev, alpha: parseFloat(e.target.value) }))}
                        className="bg-surface-container-low border border-outline-variant/60 rounded px-2 py-1 font-mono text-xs"
                      >
                        <option value={0.01}>0.01 (99% conf)</option>
                        <option value={0.05}>0.05 (95% conf)</option>
                        <option value={0.10}>0.10 (90% conf)</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Shrinkage Constant (k):</span>
                      <input
                        type="number"
                        value={configSettings.shrinkage_k}
                        onChange={(e) => setConfigSettings(prev => ({ ...prev, shrinkage_k: parseFloat(e.target.value) || 100 }))}
                        className="w-20 bg-surface-container-low border border-outline-variant/60 rounded px-2 py-1 font-mono text-xs text-right"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Min Test Clicks:</span>
                      <input
                        type="number"
                        value={configSettings.min_test_clicks}
                        onChange={(e) => setConfigSettings(prev => ({ ...prev, min_test_clicks: parseInt(e.target.value) || 10 }))}
                        className="w-20 bg-surface-container-low border border-outline-variant/60 rounded px-2 py-1 font-mono text-xs text-right"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Min Promote Conversions:</span>
                      <input
                        type="number"
                        step="0.5"
                        value={configSettings.min_promote_conversions}
                        onChange={(e) => setConfigSettings(prev => ({ ...prev, min_promote_conversions: parseFloat(e.target.value) || 2.0 }))}
                        className="w-20 bg-surface-container-low border border-outline-variant/60 rounded px-2 py-1 font-mono text-xs text-right"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Fallback Block Floor ($):</span>
                      <input
                        type="number"
                        value={configSettings.fallback_block_cost_floor}
                        onChange={(e) => setConfigSettings(prev => ({ ...prev, fallback_block_cost_floor: parseFloat(e.target.value) || 25 }))}
                        className="w-20 bg-surface-container-low border border-outline-variant/60 rounded px-2 py-1 font-mono text-xs text-right"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Strict FDR Gate:</span>
                      <input
                        type="checkbox"
                        checked={configSettings.strict_fdr_gate}
                        onChange={(e) => setConfigSettings(prev => ({ ...prev, strict_fdr_gate: e.target.checked }))}
                        className="w-4 h-4 accent-primary rounded cursor-pointer"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Action Button */}
              <button
                onClick={runAnalysis}
                disabled={!canProceed || isLoading}
                className={`w-full py-3 rounded-lg font-mono text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer ${
                  canProceed
                    ? 'bg-primary hover:bg-primary-container text-white'
                    : 'bg-surface-container text-outline cursor-not-allowed border border-outline-variant/30'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                Execute Statistical Triage
              </button>
            </div>

            {/* Raw Data Preview (7 cols) */}
            <div className="lg:col-span-7 bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-bold text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[18px]">table_rows</span>
                  Raw Sample Intake Preview
                </h2>
                <span className="font-mono text-[11px] text-on-surface-variant">5 of {sampleRows.length} Rows</span>
              </div>

              <div className="overflow-auto border border-outline-variant/30 rounded flex-1 max-h-[500px]">
                <table className="w-full text-xs">
                  <thead className="bg-surface-container-low sticky top-0">
                    <tr className="border-b border-outline-variant/40">
                      {columns.map(c => (
                        <th key={c} className="text-left py-2 px-3 font-mono text-[11px] text-on-surface-variant font-semibold whitespace-nowrap">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sampleRows.map((row, i) => (
                      <tr key={i} className="border-b border-outline-variant/20 hover:bg-surface-container-low/50">
                        {columns.map(c => (
                          <td key={c} className="py-2 px-3 font-mono text-[11px] text-on-surface whitespace-nowrap">
                            {String(row[c] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  /* ==========================================================================
     SCREEN 3: ANALYZING STATE
     ========================================================================== */
  if (currentScreen === 'analyzing') {
    return (
      <div className="min-h-screen pt-16 bg-surface flex flex-col justify-center items-center">
        {renderHeader()}
        <div className="bg-surface-container-lowest rounded-xl p-8 border border-outline-variant/40 shadow-sm max-w-md w-full text-center space-y-4 animate-[fadeIn_0.3s_ease-out]">
          <div className="w-12 h-12 mx-auto rounded-full bg-surface-container flex items-center justify-center text-primary">
            <span className="material-symbols-outlined animate-spin text-[28px]">autorenew</span>
          </div>
          <h2 className="text-base font-bold text-on-surface">Computing Statistical Triage</h2>
          <p className="text-xs text-on-surface-variant leading-relaxed">
            Running Empirical Bayes baseline shrinkage, exact binomial hypothesis tests, and Benjamini-Hochberg FDR adjustments...
          </p>
        </div>
      </div>
    );
  }

  /* ==========================================================================
     SCREEN 4: READINESS DASHBOARD (Full PlacementOS Style)
     ========================================================================== */
  return (
    <div className="min-h-screen pt-16 bg-surface">
      {renderHeader()}

      {/* Top Banner Context Bar (PlacementOS signature) */}
      <div className="w-full bg-surface-container-low py-3 border-b border-outline-variant/30">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-8 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex flex-col">
              <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider">
                Evaluation Profile
              </span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-base text-on-surface font-bold font-mono">
                  {datasetName}
                </span>
                <span className="text-outline-variant font-mono">•</span>
                <span className="text-[13px] text-on-surface-variant font-mono">
                  {summary ? `${fmtInt(summary.total_rows)} Evaluated Search Terms` : 'Triage Run'}
                </span>
              </div>
            </div>

            <div className="h-8 w-px bg-outline-variant/40 hidden sm:block"></div>

            <div className="flex items-center gap-2">
              <div className="bg-secondary-fixed text-on-secondary-fixed px-3 py-1 rounded flex items-center gap-1.5 shadow-sm">
                <span className="w-2 h-2 rounded-full bg-secondary animate-pulse"></span>
                <span className="font-mono text-[11px] font-bold tracking-wider uppercase">
                  TRIAGE COVERAGE: 100% COMPLETE
                </span>
              </div>
              <div className="bg-surface-container-lowest text-on-surface px-3 py-1 rounded border border-outline-variant/40 shadow-sm flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-tertiary">verified_user</span>
                <span className="font-mono text-[11px]">
                  Rigor: <strong className="text-tertiary font-bold">HIGH (α = {configSettings.alpha})</strong>
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('calibration')}
              className="bg-surface-container text-on-surface hover:bg-surface-container-high px-3 py-1.5 rounded font-mono text-[11px] flex items-center gap-1.5 transition-colors border border-outline-variant/40 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px] text-primary">analytics</span>
              Methodology Proof
            </button>
            <button
              onClick={handleExport}
              className="bg-primary text-white hover:bg-primary-container px-3 py-1.5 rounded font-mono text-[11px] font-bold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px]">download</span>
              Download CSV
            </button>
          </div>
        </div>
      </div>

      <main className="max-w-[1440px] w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-6 animate-[fadeIn_0.3s_ease-out]">
        {/* Navigation Tabs Bar for Mobile/Tablet */}
        <div className="flex lg:hidden gap-1 bg-surface-container-lowest p-1 rounded border border-outline-variant/40 overflow-x-auto">
          {[
            { id: 'overview', label: 'Dashboard' },
            { id: 'data', label: `Search Terms (${results.length})` },
            { id: 'campaigns', label: 'Campaigns' },
            { id: 'calibration', label: 'Methodology' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as ScreenTab)}
              className={`px-3 py-1.5 text-xs font-mono rounded whitespace-nowrap cursor-pointer ${
                activeTab === tab.id ? 'bg-primary text-white font-bold' : 'text-on-surface-variant'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ====================================================================
           TAB 1: READINESS DASHBOARD OVERVIEW
           ==================================================================== */}
        {activeTab === 'overview' && summary && (
          <div className="flex flex-col gap-6">
            {/* 5-Column Telemetry Calibration Pipeline Strip (PlacementOS style) */}
            <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm flex flex-col gap-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">account_tree</span>
                  <span className="text-base text-on-surface font-bold">
                    Search Term Triage Pipeline
                  </span>
                  <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider ml-1">
                    | Empirical Decision Path
                  </span>
                </div>
                <span className="font-mono text-[11px] text-on-surface-variant">
                  Methodology: Empirical Bayes + Binomial Tail Tests
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-1">
                {/* 01. Total */}
                <div className="bg-surface-container-low p-4 rounded border border-outline-variant/30 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-on-surface-variant font-mono text-[11px]">
                    <span>01. EVALUATED</span>
                    <span className="material-symbols-outlined text-[16px]">manage_search</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-on-surface">
                      {fmtInt(summary.total_rows)}
                    </span>
                    <span className="font-mono text-[11px] text-on-surface-variant"> Terms</span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Total search terms audited
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-surface-variant"></div>
                </div>

                {/* 02. Promote */}
                <div className="bg-surface-container-low p-4 rounded border border-outline-variant/30 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-tertiary font-mono text-[11px] font-bold">
                    <span>02. PROMOTE</span>
                    <span className="material-symbols-outlined text-[16px]">trending_up</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-tertiary">
                      {fmtInt(summary.promote_count)}
                    </span>
                    <span className="font-mono text-[11px] text-tertiary"> ({((summary.promote_count / summary.total_rows) * 100).toFixed(0)}%)</span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Statistically proven outperformers
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-tertiary"></div>
                </div>

                {/* 03. Block */}
                <div className="bg-surface-container-low p-4 rounded border border-outline-variant/30 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-error font-mono text-[11px] font-bold">
                    <span>03. BLOCK</span>
                    <span className="material-symbols-outlined text-[16px]">block</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-error">
                      {fmtInt(summary.block_count)}
                    </span>
                    <span className="font-mono text-[11px] text-error"> ({((summary.block_count / summary.total_rows) * 100).toFixed(0)}%)</span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Breached cost CPA with 0 conversions
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-error"></div>
                </div>

                {/* 04. Ignore */}
                <div className="bg-surface-container-low p-4 rounded border border-outline-variant/30 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-on-surface-variant font-mono text-[11px]">
                    <span>04. IGNORE / MAINTAIN</span>
                    <span className="material-symbols-outlined text-[16px]">horizontal_rule</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-on-surface">
                      {fmtInt(summary.ignore_count)}
                    </span>
                    <span className="font-mono text-[11px] text-on-surface-variant"> ({((summary.ignore_count / summary.total_rows) * 100).toFixed(0)}%)</span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Insufficient volume / ambiguous
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-outline"></div>
                </div>

                {/* 05. Baseline */}
                <div className="bg-surface-container-low p-4 rounded border border-outline-variant/30 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-secondary font-mono text-[11px] font-bold">
                    <span>05. BASELINE CVR</span>
                    <span className="material-symbols-outlined text-[16px]">query_stats</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-secondary">
                      {fmtPct(summary.account_baseline_cvr)}
                    </span>
                    <span className="font-mono text-[11px] text-on-surface-variant"> CPA: {fmtCurrency(summary.account_cpa)}</span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Account-wide pooled benchmark
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-secondary"></div>
                </div>
              </div>
            </div>

            {/* Distribution Bar */}
            <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-on-surface">Triage Decision Composition</span>
                <span className="font-mono text-xs text-on-surface-variant">100% Account Allocation</span>
              </div>
              <div className="flex gap-1 h-6 rounded overflow-hidden bg-surface-container">
                {summary.promote_count > 0 && (
                  <div
                    className="bg-tertiary flex items-center justify-center text-[10px] font-bold text-white font-mono"
                    style={{ width: `${(summary.promote_count / summary.total_rows) * 100}%` }}
                    title={`PROMOTE: ${summary.promote_count}`}
                  >
                    {((summary.promote_count / summary.total_rows) * 100).toFixed(0)}% PROMOTE
                  </div>
                )}
                {summary.block_count > 0 && (
                  <div
                    className="bg-error flex items-center justify-center text-[10px] font-bold text-white font-mono"
                    style={{ width: `${(summary.block_count / summary.total_rows) * 100}%` }}
                    title={`BLOCK: ${summary.block_count}`}
                  >
                    {((summary.block_count / summary.total_rows) * 100).toFixed(0)}% BLOCK
                  </div>
                )}
                {summary.ignore_count > 0 && (
                  <div
                    className="bg-outline flex items-center justify-center text-[10px] font-bold text-white font-mono"
                    style={{ width: `${(summary.ignore_count / summary.total_rows) * 100}%` }}
                    title={`IGNORE: ${summary.ignore_count}`}
                  >
                    {((summary.ignore_count / summary.total_rows) * 100).toFixed(0)}% IGNORE
                  </div>
                )}
              </div>
            </div>

            {/* 3 Analytics Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {/* Card 1: Traffic & Spend Totals */}
              <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider font-bold block mb-3">
                  Traffic & Ad Spend Telemetry
                </span>
                <div className="space-y-2.5 text-xs">
                  <div className="flex justify-between"><span className="text-on-surface-variant">Total Valid Clicks</span><span className="font-mono font-bold text-on-surface">{fmtInt(summary.account_valid_clicks)}</span></div>
                  <div className="flex justify-between"><span className="text-on-surface-variant">Total Conversions</span><span className="font-mono font-bold text-on-surface">{fmt(summary.account_valid_conversions)}</span></div>
                  <div className="flex justify-between"><span className="text-on-surface-variant">Total Ad Spend</span><span className="font-mono font-bold text-on-surface">{fmtCurrency(summary.account_valid_cost)}</span></div>
                  <div className="flex justify-between"><span className="text-on-surface-variant">Effective Block Floor</span><span className="font-mono font-bold text-on-surface">{fmtCurrency(summary.effective_block_cost_gate)}</span></div>
                </div>
              </div>

              {/* Card 2: Integrity & Data Quality */}
              {qualityReport && (
                <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                  <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider font-bold block mb-3">
                    Data Integrity Audit
                  </span>
                  <div className="space-y-2.5 text-xs">
                    <div className="flex justify-between"><span className="text-on-surface-variant">Unique Search Terms</span><span className="font-mono font-bold text-on-surface">{fmtInt(qualityReport.unique_search_terms)}</span></div>
                    <div className="flex justify-between"><span className="text-on-surface-variant">Duplicate Queries</span><span className={`font-mono font-bold ${qualityReport.duplicate_query_row_count > 0 ? 'text-amber-600' : 'text-on-surface'}`}>{fmtInt(qualityReport.duplicate_query_row_count)}</span></div>
                    <div className="flex justify-between"><span className="text-on-surface-variant">Zero-Click Terms</span><span className="font-mono font-bold text-on-surface">{fmtInt(qualityReport.zero_click_row_count)}</span></div>
                    <div className="flex justify-between"><span className="text-on-surface-variant">Flagged for Review</span><span className={`font-mono font-bold ${summary.review_flagged_count > 0 ? 'text-amber-600' : 'text-on-surface'}`}>{fmtInt(summary.review_flagged_count)}</span></div>
                  </div>
                </div>
              )}

              {/* Card 3: Confidence Tiers */}
              <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider font-bold block mb-3">
                  Confidence Tier Distribution
                </span>
                <div className="space-y-2.5 text-xs">
                  {(() => {
                    const tierCounts: Record<string, number> = {};
                    results.forEach(r => {
                      const tier = r.confidence_tier.split(':')[0] || r.confidence_tier;
                      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
                    });
                    return Object.entries(tierCounts).sort((a, b) => b[1] - a[1]).map(([tier, count]) => (
                      <div key={tier} className="flex justify-between">
                        <span className="text-on-surface-variant truncate mr-2">{tier}</span>
                        <span className="font-mono font-bold text-on-surface">{count}</span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ====================================================================
           TAB 2: SEARCH TERMS (Triage Table + Forensic Side Drawer)
           ==================================================================== */}
        {activeTab === 'data' && (
          <div className="flex flex-col gap-4">
            {/* Filter Toolbar */}
            <div className="bg-surface-container-lowest rounded-lg p-4 border border-outline-variant/40 shadow-sm flex flex-wrap gap-3 items-center justify-between">
              {/* Search Box */}
              <div className="relative flex-1 min-w-[240px]">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">
                  search
                </span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter query, campaign, or decision rationale..."
                  className="w-full pl-9 pr-3 py-1.5 bg-surface-container-low border border-outline-variant/60 rounded text-xs text-on-surface font-mono placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
                />
              </div>

              {/* Pill Filters */}
              <div className="flex items-center gap-1.5">
                {(['PROMOTE', 'BLOCK', 'IGNORE'] as const).map(d => (
                  <button
                    key={d}
                    onClick={() => setDecisionFilter(prev =>
                      prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
                    )}
                    className={`px-2.5 py-1 rounded text-xs font-mono font-bold border transition-colors cursor-pointer ${
                      decisionFilter.includes(d)
                        ? d === 'PROMOTE' ? 'bg-[#e6f7ef] text-tertiary border-tertiary'
                        : d === 'BLOCK' ? 'bg-error-container text-error border-error'
                        : 'bg-surface-container text-on-surface border-outline'
                        : 'bg-surface-container-low text-on-surface-variant border-outline-variant/60 hover:border-outline'
                    }`}
                  >
                    {d}
                  </button>
                ))}

                <button
                  onClick={() => setReviewOnly(!reviewOnly)}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-bold border transition-colors flex items-center gap-1 cursor-pointer ${
                    reviewOnly
                      ? 'bg-amber-100 text-amber-900 border-amber-400'
                      : 'bg-surface-container-low text-on-surface-variant border-outline-variant/60 hover:border-outline'
                  }`}
                >
                  <span className="material-symbols-outlined text-[14px]">flag</span>
                  Review Flags
                </button>
              </div>

              {/* Campaign Filter */}
              {uniqueCampaigns.length > 1 && (
                <select
                  value={campaignFilter.length === 1 ? campaignFilter[0] : ''}
                  onChange={(e) => setCampaignFilter(e.target.value ? [e.target.value] : [])}
                  className="bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1 text-xs text-on-surface font-mono focus:border-primary focus:outline-none max-w-[200px]"
                >
                  <option value="">All Campaigns</option>
                  {uniqueCampaigns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              )}

              <span className="font-mono text-xs text-on-surface-variant">
                {filteredResults.length} of {results.length} terms
              </span>
            </div>

            {/* Table & Forensic Detail Side Panel */}
            <div className="flex gap-4">
              <div className={`bg-surface-container-lowest rounded-lg border border-outline-variant/40 shadow-sm overflow-hidden ${selectedRow ? 'flex-1' : 'w-full'}`}>
                <div className="overflow-auto max-h-[calc(100vh-270px)]">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-container-low sticky top-0 z-10">
                      <tr className="border-b border-outline-variant/40">
                        {[
                          { key: 'row_id', label: '#', w: 'w-10 text-left' },
                          { key: 'search_term', label: 'Search Query', w: 'min-w-[220px] text-left' },
                          { key: 'campaign', label: 'Campaign', w: 'min-w-[130px] text-left' },
                          { key: 'clicks', label: 'Clicks', w: 'w-16 text-right' },
                          { key: 'cost', label: 'Spend', w: 'w-20 text-right' },
                          { key: 'conversions', label: 'Conv', w: 'w-16 text-right' },
                          { key: 'observed_cvr', label: 'Obs. CVR', w: 'w-20 text-right' },
                          { key: 'shrunk_baseline_cvr', label: 'Baseline', w: 'w-20 text-right' },
                          { key: 'decision', label: 'Decision', w: 'w-24 text-left' },
                          { key: 'confidence_tier', label: 'Confidence Tier', w: 'min-w-[120px] text-left' },
                        ].map(col => (
                          <th
                            key={col.key}
                            onClick={() => handleSort(col.key)}
                            className={`py-2.5 px-3 font-mono text-[11px] text-on-surface-variant font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer hover:text-on-surface select-none ${col.w}`}
                          >
                            <span className="flex items-center gap-1">
                              {col.label}
                              {sortField === col.key && (
                                <span className="material-symbols-outlined text-[14px] text-primary">
                                  {sortAsc ? 'arrow_upward' : 'arrow_downward'}
                                </span>
                              )}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredResults.map(row => (
                        <tr
                          key={row.row_id}
                          onClick={() => setSelectedRow(row)}
                          className={`border-b border-outline-variant/20 cursor-pointer transition-colors ${
                            selectedRow?.row_id === row.row_id
                              ? 'bg-primary-fixed/20 border-l-4 border-l-primary'
                              : 'hover:bg-surface-container-low/60'
                          } ${row.review_flag ? 'border-l-4 border-l-amber-500' : ''}`}
                        >
                          <td className="py-2.5 px-3 font-mono text-on-surface-variant">{row.row_id}</td>
                          <td className="py-2.5 px-3 font-medium text-on-surface truncate max-w-[240px]" title={row.search_term}>{row.search_term}</td>
                          <td className="py-2.5 px-3 font-mono text-[11px] text-on-surface-variant truncate max-w-[140px]" title={row.campaign}>{row.campaign}</td>
                          <td className="py-2.5 px-3 font-mono text-right text-on-surface">{fmtInt(row.clicks)}</td>
                          <td className="py-2.5 px-3 font-mono text-right text-on-surface">{fmtCurrency(row.cost)}</td>
                          <td className="py-2.5 px-3 font-mono text-right text-on-surface">{fmt(row.conversions, 1)}</td>
                          <td className="py-2.5 px-3 font-mono text-right">
                            <span className={row.observed_cvr > row.shrunk_baseline_cvr ? 'text-tertiary font-bold' : row.observed_cvr < row.shrunk_baseline_cvr ? 'text-error font-bold' : 'text-on-surface-variant'}>
                              {fmtPct(row.observed_cvr)}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-right text-on-surface-variant">{fmtPct(row.shrunk_baseline_cvr)}</td>
                          <td className="py-2.5 px-3"><DecisionBadge decision={row.decision} /></td>
                          <td className="py-2.5 px-3 font-mono text-[11px] text-on-surface-variant truncate max-w-[130px]" title={row.confidence_tier}>
                            {row.confidence_tier.split(':')[0]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredResults.length === 0 && (
                    <div className="p-12 text-center text-xs text-on-surface-variant font-mono">
                      No search terms matched your filter criteria.
                    </div>
                  )}
                </div>
              </div>

              {/* Forensic Diagnostic Side Panel (PlacementOS style) */}
              {selectedRow && (
                <div className="w-[390px] flex-shrink-0 bg-surface-container-lowest border border-outline-variant/40 rounded-lg p-5 overflow-auto max-h-[calc(100vh-270px)] shadow-md animate-[fadeIn_0.2s_ease-out]">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="text-sm font-bold text-on-surface leading-tight">{selectedRow.search_term}</h3>
                      <p className="font-mono text-[11px] text-on-surface-variant mt-0.5">{selectedRow.campaign}</p>
                    </div>
                    <button
                      onClick={() => setSelectedRow(null)}
                      className="text-on-surface-variant hover:text-on-surface cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2 mb-4">
                    <DecisionBadge decision={selectedRow.decision} size="md" />
                    {selectedRow.review_flag && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-100 text-amber-900 border border-amber-300">
                        FLAGGED FOR REVIEW
                      </span>
                    )}
                  </div>

                  {/* 4 Metric Boxes */}
                  <div className="grid grid-cols-2 gap-2 mb-4">
                    <div className="bg-surface-container-low p-2.5 rounded border border-outline-variant/30">
                      <span className="font-mono text-[10px] text-on-surface-variant uppercase block">Clicks</span>
                      <span className="font-mono text-sm font-bold text-on-surface">{fmtInt(selectedRow.clicks)}</span>
                    </div>
                    <div className="bg-surface-container-low p-2.5 rounded border border-outline-variant/30">
                      <span className="font-mono text-[10px] text-on-surface-variant uppercase block">Spend</span>
                      <span className="font-mono text-sm font-bold text-on-surface">{fmtCurrency(selectedRow.cost)}</span>
                    </div>
                    <div className="bg-surface-container-low p-2.5 rounded border border-outline-variant/30">
                      <span className="font-mono text-[10px] text-on-surface-variant uppercase block">Conversions</span>
                      <span className="font-mono text-sm font-bold text-on-surface">{fmt(selectedRow.conversions, 1)}</span>
                    </div>
                    <div className="bg-surface-container-low p-2.5 rounded border border-outline-variant/30">
                      <span className="font-mono text-[10px] text-on-surface-variant uppercase block">Observed CPA</span>
                      <span className="font-mono text-sm font-bold text-on-surface">{fmtCurrency(selectedRow.observed_cpa)}</span>
                    </div>
                  </div>

                  {/* Statistical Rigor Table */}
                  <div className="mb-4">
                    <span className="font-mono text-[10px] text-on-surface-variant uppercase tracking-wider font-bold block mb-2">
                      Statistical Calibration Metrics
                    </span>
                    <div className="bg-surface-container-low p-3 rounded border border-outline-variant/30 space-y-1.5 text-xs font-mono">
                      <div className="flex justify-between"><span className="text-on-surface-variant">Observed CVR:</span><span className="font-bold text-on-surface">{fmtPct(selectedRow.observed_cvr)}</span></div>
                      <div className="flex justify-between"><span className="text-on-surface-variant">Shrunk Baseline CVR:</span><span className="text-on-surface">{fmtPct(selectedRow.shrunk_baseline_cvr)}</span></div>
                      <div className="flex justify-between"><span className="text-on-surface-variant">Wilson 95% CI:</span><span className="text-on-surface">[{fmtPct(selectedRow.wilson_ci_lower)}, {fmtPct(selectedRow.wilson_ci_upper)}]</span></div>
                      <div className="flex justify-between"><span className="text-on-surface-variant">Exact Binomial p (lower):</span><span className="text-on-surface">{selectedRow.p_value_lower?.toFixed(4) ?? '—'}</span></div>
                      <div className="flex justify-between"><span className="text-on-surface-variant">Exact Binomial p (upper):</span><span className="text-on-surface">{selectedRow.p_value_upper?.toFixed(4) ?? '—'}</span></div>
                      <div className="flex justify-between"><span className="text-on-surface-variant">FDR q-value (upper):</span><span className="text-on-surface">{selectedRow.q_value_upper?.toFixed(4) ?? '—'}</span></div>
                    </div>
                  </div>

                  {/* Classification Reason */}
                  <div className="mb-2">
                    <span className="font-mono text-[10px] text-on-surface-variant uppercase tracking-wider font-bold block mb-1">
                      Deterministic Rationale
                    </span>
                    <p className="bg-surface-container-low p-3 rounded border border-outline-variant/30 text-xs font-mono text-on-surface leading-relaxed">
                      {selectedRow.reason}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ====================================================================
           TAB 3: CAMPAIGNS CALIBRATION
           ==================================================================== */}
        {activeTab === 'campaigns' && (
          <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/40 shadow-sm overflow-hidden">
            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-surface-container-low">
                  <tr className="border-b border-outline-variant/40 font-mono text-[11px] text-on-surface-variant font-bold uppercase tracking-wider">
                    <th className="text-left py-3 px-4">Campaign</th>
                    <th className="text-right py-3 px-4">Total Terms</th>
                    <th className="text-right py-3 px-4 text-tertiary">PROMOTE</th>
                    <th className="text-right py-3 px-4 text-error">BLOCK</th>
                    <th className="text-right py-3 px-4 text-on-surface-variant">IGNORE</th>
                    <th className="text-right py-3 px-4">Clicks</th>
                    <th className="text-right py-3 px-4">Spend</th>
                    <th className="text-right py-3 px-4">Conversions</th>
                    <th className="text-right py-3 px-4">Triage Ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignSummary.map(camp => (
                    <tr key={camp.campaign} className="border-b border-outline-variant/20 hover:bg-surface-container-low/50">
                      <td className="py-3 px-4 font-mono font-bold text-on-surface">{camp.campaign}</td>
                      <td className="py-3 px-4 font-mono text-right text-on-surface">{camp.total}</td>
                      <td className="py-3 px-4 font-mono text-right text-tertiary font-bold">{camp.promote}</td>
                      <td className="py-3 px-4 font-mono text-right text-error font-bold">{camp.block}</td>
                      <td className="py-3 px-4 font-mono text-right text-on-surface-variant">{camp.ignore}</td>
                      <td className="py-3 px-4 font-mono text-right text-on-surface">{fmtInt(camp.total_clicks)}</td>
                      <td className="py-3 px-4 font-mono text-right text-on-surface">{fmtCurrency(camp.total_cost)}</td>
                      <td className="py-3 px-4 font-mono text-right text-on-surface">{fmt(camp.total_conversions, 1)}</td>
                      <td className="py-3 px-4 font-mono text-right">
                        <span className="px-2 py-0.5 rounded bg-surface-container font-mono text-[11px]">
                          {camp.promote}P / {camp.block}B
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ====================================================================
           TAB 4: STATISTICAL CALIBRATION & METHODOLOGY
           ==================================================================== */}
        {activeTab === 'calibration' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Card 1 */}
              <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">functions</span>
                  <h3 className="text-sm font-bold text-on-surface">Empirical Bayes Baseline Shrinkage</h3>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Pulls low-sample campaign conversion rates toward the account-wide prior using a leave-one-out shrinkage estimator.
                </p>
                <div className="bg-surface-container-low p-3 rounded font-mono text-[11px] text-primary border border-outline-variant/30">
                  {"CVR_shrunk = (CVR_campaign × N + CVR_account × k) / (N + k)"}
                </div>
                <p className="font-mono text-[11px] text-on-surface-variant mt-2">
                  Shrinkage constant k = {configSettings.shrinkage_k}. Prevents small-traffic search terms from triggering false positives.
                </p>
              </div>

              {/* Card 2 */}
              <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-tertiary text-[20px]">verified</span>
                  <h3 className="text-sm font-bold text-on-surface">Wilson Score Confidence Interval</h3>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Traditional normal approximation intervals fail when conversion rates are near 0 or 1. Wilson score intervals guarantee asymmetric, robust coverage across all click volumes.
                </p>
                <div className="bg-surface-container-low p-3 rounded font-mono text-[11px] text-tertiary border border-outline-variant/30">
                  {"p̂ ± z √(p̂(1 - p̂)/n + z²/(4n²)) / (1 + z²/n)"}
                </div>
                <p className="font-mono text-[11px] text-on-surface-variant mt-2">
                  Evaluated at α = {configSettings.alpha} (95% confidence).
                </p>
              </div>

              {/* Card 3 */}
              <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-secondary text-[20px]">science</span>
                  <h3 className="text-sm font-bold text-on-surface">Exact Two-Sided Binomial CDF Testing</h3>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Direct tail tests compare observed conversions against the shrunk baseline CVR:
                </p>
                <div className="bg-surface-container-low p-3 rounded font-mono text-[11px] text-secondary border border-outline-variant/30 space-y-1">
                  <div>{"p_upper = P(X ≥ c | N, CVR_baseline)  [Outperformer test]"}</div>
                  <div>{"p_lower = P(X ≤ c | N, CVR_baseline)  [Underperformer test]"}</div>
                </div>
                <p className="font-mono text-[11px] text-on-surface-variant mt-2">
                  Calculated via the regularized incomplete beta function I_x(a, b).
                </p>
              </div>

              {/* Card 4 */}
              <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">checklist_rtl</span>
                  <h3 className="text-sm font-bold text-on-surface">Benjamini-Hochberg Multiplicity Control</h3>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Adjusts raw p-values into False Discovery Rate (FDR) q-values to prevent spurious false discoveries across multiple hypotheses.
                </p>
                <div className="bg-surface-container-low p-3 rounded font-mono text-[11px] text-primary border border-outline-variant/30">
                  {"q_(i) = min_{j ≥ i} [ p_(j) × m / j ]"}
                </div>
                <p className="font-mono text-[11px] text-on-surface-variant mt-2">
                  Controls the false discovery rate at α = {configSettings.alpha}.
                </p>
              </div>
            </div>

            {/* Guardrails Card */}
            <div className="bg-surface-container-lowest rounded-lg p-5 border border-outline-variant/40 shadow-sm">
              <h3 className="text-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                <span className="material-symbols-outlined text-amber-500 text-[20px]">shield</span>
                Anti-Trap Guardrails Summary
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="bg-surface-container-low p-3.5 rounded border border-outline-variant/30">
                  <span className="font-bold text-on-surface block mb-1 font-mono">2-Click Trap Defense</span>
                  <p className="text-on-surface-variant leading-relaxed">
                    Mandates at least <strong>{configSettings.min_test_clicks} clicks</strong> and <strong>{configSettings.min_promote_conversions} conversions</strong> before granting PROMOTE.
                  </p>
                </div>
                <div className="bg-surface-container-low p-3.5 rounded border border-outline-variant/30">
                  <span className="font-bold text-on-surface block mb-1 font-mono">CPA Spend Floor Gate</span>
                  <p className="text-on-surface-variant leading-relaxed">
                    Terms with 0 conversions cannot be blocked unless spend exceeds the effective CPA floor (<strong>${configSettings.fallback_block_cost_floor.toFixed(2)}</strong>).
                  </p>
                </div>
                <div className="bg-surface-container-low p-3.5 rounded border border-outline-variant/30">
                  <span className="font-bold text-on-surface block mb-1 font-mono">Automated Anomaly Audit</span>
                  <p className="text-on-surface-variant leading-relaxed">
                    Inspects duplicates, negative values, fractional conversions, and zero-click terms before running statistical inference.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Global Error Banner */}
      {error && (
        <div className="fixed bottom-4 right-4 z-50 max-w-md p-4 bg-error-container text-error border border-error/30 rounded-lg shadow-xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="cursor-pointer font-bold text-xs">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
