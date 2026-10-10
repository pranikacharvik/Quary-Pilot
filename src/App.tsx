import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { PRESET_DATASETS } from './demoDatasets';
import {
  parseCsvFlexible,
  runTriageEngine,
  suggestColumnMapping,
  type TriageConfig as ClientTriageConfig,
} from './triageEngine';
import { ForensicDecisionInspector } from './ForensicDecisionInspector';
import { ExecutiveDecisionBlueprint } from './ExecutiveDecisionBlueprint';
import {
  explainDecision,
  generateNegativeKeywordsList,
  generatePromotedKeywordsList,
} from './decisionExplainer';

/* ==========================================================================
   Type Definitions
   ========================================================================== */
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

type ScreenStep = 'intake' | 'mapping' | 'dashboard';
type DashboardTab = 'overview' | 'data' | 'campaigns' | 'calibration';

/* ==========================================================================
   Formatting Utilities
   ========================================================================== */
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

/* ==========================================================================
   PlacementOS Decision Badge Component
   ========================================================================== */
const DecisionBadge: React.FC<{ decision: string; size?: 'sm' | 'md' }> = ({ decision, size = 'sm' }) => {
  if (decision === 'PROMOTE') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 font-mono font-bold uppercase rounded ${
          size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'
        } bg-[#e6f7ef] text-tertiary border border-tertiary/30 shadow-xs`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-tertiary"></span>
        PROMOTE
      </span>
    );
  }
  if (decision === 'BLOCK') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 font-mono font-bold uppercase rounded ${
          size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'
        } bg-error-container text-error border border-error/30 shadow-xs`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-error"></span>
        BLOCK
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono font-bold uppercase rounded ${
        size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'
      } bg-surface-container text-on-surface-variant border border-outline-variant/60 shadow-xs`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-outline"></span>
      IGNORE
    </span>
  );
};

/* ==========================================================================
   Main QueryPilot Application
   ========================================================================== */
export default function App() {
  const [currentScreen, setCurrentScreen] = useState<ScreenStep>('intake');
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');

  const [file, setFile] = useState<File | null>(null);
  const [datasetName, setDatasetName] = useState<string>('Enterprise Audit (50 Terms)');
  const [rawCsvText, setRawCsvText] = useState<string>('');
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMappingType>({
    search_term: null,
    campaign: null,
    ad_group: null,
    match_type: null,
    impressions: null,
    clicks: null,
    cost: null,
    conversions: null,
    conversion_value: null,
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
  const [showConfigModal, setShowConfigModal] = useState(false);

  // Filters & Sorting
  const [searchQuery, setSearchQuery] = useState('');
  const [decisionFilter, setDecisionFilter] = useState<string[]>([]);
  const [campaignFilter, setCampaignFilter] = useState<string[]>([]);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sortField, setSortField] = useState<string>('row_id');
  const [sortAsc, setSortAsc] = useState(true);

  // Forensic Detail Drawer & Copy State
  const [selectedRow, setSelectedRow] = useState<TriageResult | null>(null);
  const [copiedQuery, setCopiedQuery] = useState<string | null>(null);
  const [batchCopiedNotice, setBatchCopiedNotice] = useState<string | null>(null);

  const handleBatchCopy = useCallback((type: 'promote' | 'block') => {
    if (type === 'promote') {
      const text = generatePromotedKeywordsList(results as any);
      navigator.clipboard.writeText(text);
      setBatchCopiedNotice(`Copied ${results.filter(r => r.decision === 'PROMOTE').length} Exact Match keywords to clipboard!`);
    } else {
      const text = generateNegativeKeywordsList(results as any);
      navigator.clipboard.writeText(text);
      setBatchCopiedNotice(`Copied ${results.filter(r => r.decision === 'BLOCK').length} Negative keywords to clipboard!`);
    }
    setTimeout(() => setBatchCopiedNotice(null), 3000);
  }, [results]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check backend health on load
  useEffect(() => {
    fetch('/api/health')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data && data.status === 'ok') {
          setEngineSource('fastapi');
        } else {
          setEngineSource('client');
        }
      })
      .catch(() => setEngineSource('client'));
  }, []);

  /* ---- Execute Core Statistical Triage ---- */
  const executeTriage = useCallback(
    async (
      csvText: string,
      targetCols: string[],
      targetMapping: ColumnMappingType,
      cfg: ConfigSettings
    ) => {
      setIsLoading(true);
      setError(null);

      // 1. Try FastAPI backend execution
      try {
        const formData = new FormData();
        const blob = new Blob([csvText], { type: 'text/csv' });
        formData.append('file', new File([blob], 'dataset.csv', { type: 'text/csv' }));
        formData.append(
          'column_mapping',
          JSON.stringify({
            search_term: targetMapping.search_term,
            clicks: targetMapping.clicks,
            cost: targetMapping.cost,
            conversions: targetMapping.conversions,
            campaign: targetMapping.campaign || null,
            ad_group: targetMapping.ad_group || null,
            match_type: targetMapping.match_type || null,
            impressions: targetMapping.impressions || null,
            conversion_value: targetMapping.conversion_value || null,
          })
        );
        formData.append(
          'config',
          JSON.stringify({
            alpha: cfg.alpha,
            shrinkage_k: cfg.shrinkage_k,
            min_test_clicks: cfg.min_test_clicks,
            min_promote_conversions: cfg.min_promote_conversions,
            block_cost_cpa_multiplier: cfg.block_cost_cpa_multiplier,
            fallback_block_cost_floor: cfg.fallback_block_cost_floor,
            strict_fdr_gate: cfg.strict_fdr_gate,
          })
        );

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
          setIsLoading(false);
          return;
        }
      } catch (backendErr) {
        console.warn('FastAPI backend not reachable, using client engine mirror:', backendErr);
      }

      // 2. Client-side deterministic mirror fallback
      try {
        const { headers: localHeaders, rows } = parseCsvFlexible(csvText);
        const effectiveHeaders = targetCols.length > 0 ? targetCols : localHeaders;

        const clientConfig: ClientTriageConfig = {
          alpha: cfg.alpha,
          shrinkageK: cfg.shrinkage_k,
          minTestClicks: cfg.min_test_clicks,
          minPromoteConversions: cfg.min_promote_conversions,
          blockCostCpaMultiplier: cfg.block_cost_cpa_multiplier,
          fallbackBlockCostFloor: cfg.fallback_block_cost_floor,
          strictFdrGate: cfg.strict_fdr_gate,
        };

        const localAnalysis = runTriageEngine(
          effectiveHeaders,
          rows,
          {
            search_term: targetMapping.search_term!,
            clicks: targetMapping.clicks!,
            cost: targetMapping.cost!,
            conversions: targetMapping.conversions!,
            campaign: targetMapping.campaign || undefined,
            ad_group: targetMapping.ad_group || undefined,
            match_type: targetMapping.match_type || undefined,
            impressions: targetMapping.impressions || undefined,
            conversion_value: targetMapping.conversion_value || undefined,
          },
          clientConfig
        );

        // Aggregate by campaign
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
        setError(e.message || 'Execution error during statistical inference.');
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  /* ---- Quick Launch Preset Helper ---- */
  const launchBenchmark = useCallback(
    async (presetId: string) => {
      const preset = PRESET_DATASETS.find(p => p.id === presetId) || PRESET_DATASETS[0];
      const blob = new Blob([preset.csvContent], { type: 'text/csv' });
      const demoFile = new File([blob], `${preset.id}.csv`, { type: 'text/csv' });

      setFile(demoFile);
      setDatasetName(preset.name);
      setRawCsvText(preset.csvContent);

      const { headers, rows } = parseCsvFlexible(preset.csvContent);
      const suggested = suggestColumnMapping(headers);
      const effectiveMapping: ColumnMappingType = {
        search_term: suggested.search_term || headers[0] || null,
        campaign: suggested.campaign || null,
        ad_group: suggested.ad_group || null,
        match_type: suggested.match_type || null,
        impressions: suggested.impressions || null,
        clicks: suggested.clicks || null,
        cost: suggested.cost || null,
        conversions: suggested.conversions || null,
        conversion_value: suggested.conversion_value || null,
      };

      setColumns(headers);
      setMapping(effectiveMapping);
      setSampleRows(rows.slice(0, 5));

      await executeTriage(preset.csvContent, headers, effectiveMapping, configSettings);
    },
    [executeTriage, configSettings]
  );

  /* ---- File Select Handler ---- */
  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setDatasetName(selectedFile.name.replace('.csv', ''));
    setError(null);
    setResults([]);
    setSummary(null);
    setQualityReport(null);
    setSelectedRow(null);
    setIsLoading(true);

    try {
      const text = await selectedFile.text();
      setRawCsvText(text);

      // Try FastAPI preview first
      try {
        const formData = new FormData();
        formData.append('file', selectedFile);
        const resp = await fetch('/api/preview', { method: 'POST', body: formData });
        if (resp.ok) {
          const data = await resp.json();
          setColumns(data.columns);
          setMapping(data.suggested_mapping);
          setSampleRows(data.sample_rows);
          setEngineSource('fastapi');
          setCurrentScreen('mapping');
          setIsLoading(false);
          return;
        }
      } catch (previewErr) {
        console.warn('FastAPI preview unavailable, using client parser:', previewErr);
      }

      // Local parser fallback
      const { headers, rows } = parseCsvFlexible(text);
      if (headers.length === 0) throw new Error('Uploaded CSV file appears to be empty.');
      const suggested = suggestColumnMapping(headers);

      setColumns(headers);
      setMapping({
        search_term: suggested.search_term || headers[0] || null,
        campaign: suggested.campaign || null,
        ad_group: suggested.ad_group || null,
        match_type: suggested.match_type || null,
        impressions: suggested.impressions || null,
        clicks: suggested.clicks || null,
        cost: suggested.cost || null,
        conversions: suggested.conversions || null,
        conversion_value: suggested.conversion_value || null,
      });
      setSampleRows(rows.slice(0, 5));
      setEngineSource('client');
      setCurrentScreen('mapping');
    } catch (e: any) {
      setError(e.message || 'Failed to inspect dataset schema.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /* ---- Run Analysis From Schema Mapping ---- */
  const runAnalysis = useCallback(() => {
    if (!rawCsvText) return;

    const requiredFields: (keyof ColumnMappingType)[] = ['search_term', 'clicks', 'cost', 'conversions'];
    const missing = requiredFields.filter(f => !mapping[f]);
    if (missing.length > 0) {
      setError(`Required column mappings missing: ${missing.join(', ')}`);
      return;
    }

    executeTriage(rawCsvText, columns, mapping, configSettings);
  }, [rawCsvText, columns, mapping, configSettings, executeTriage]);

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
      data = data.filter(
        r =>
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
      if (filteredResults.length === 0) {
        setError('No rows available to export.');
        return;
      }

      // 1. Try FastAPI backend export
      try {
        const formData = new FormData();
        formData.append('results', JSON.stringify(filteredResults));

        const resp = await fetch('/api/export', { method: 'POST', body: formData });
        if (resp.ok) {
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `querypilot_triage_${datasetName.replace(/\s+/g, '_')}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          return;
        }
      } catch (backendErr) {
        console.warn('Backend export unavailable, using client CSV generator:', backendErr);
      }

      // 2. Client-side CSV generation fallback
      const exportKeys: (keyof TriageResult)[] = [
        'row_id',
        'search_term',
        'campaign',
        'ad_group',
        'match_type',
        'impressions',
        'clicks',
        'cost',
        'conversions',
        'observed_cvr',
        'observed_cpa',
        'shrunk_baseline_cvr',
        'wilson_ci_lower',
        'wilson_ci_upper',
        'p_value_lower',
        'p_value_upper',
        'q_value_lower',
        'q_value_upper',
        'decision',
        'confidence_tier',
        'review_flag',
        'quality_flags',
        'reason',
      ];

      const header = exportKeys.join(',');
      const rows = filteredResults.map(r =>
        exportKeys
          .map(k => {
            const val = r[k];
            if (val === null || val === undefined) return '';
            let str = String(val);
            if (typeof val === 'string' && /^[=+\-@\t\r]/.test(str)) {
              str = `'${str}`;
            }
            return str.includes(',') || str.includes('"') || str.includes('\n')
              ? `"${str.replace(/"/g, '""')}"`
              : str;
          })
          .join(',')
      );

      const csvContent = [header, ...rows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `querypilot_triage_${datasetName.replace(/\s+/g, '_')}.csv`;
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

  const copyQuery = (query: string) => {
    navigator.clipboard.writeText(query);
    setCopiedQuery(query);
    setTimeout(() => setCopiedQuery(null), 2000);
  };

  const resetAll = () => {
    setCurrentScreen('intake');
    setActiveTab('overview');
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
     TOP HEADER (PlacementOS Standard)
     ========================================================================== */
  const renderHeader = () => (
    <header className="fixed top-0 left-0 right-0 z-50 bg-inverse-surface text-inverse-on-surface border-b border-outline/30 shadow-md">
      <div className="h-16 w-full max-w-[1536px] mx-auto px-4 sm:px-6 flex items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-4 min-w-0">
          <button
            onClick={() => setCurrentScreen('intake')}
            className="flex items-center gap-2.5 text-left focus:outline-none cursor-pointer group"
          >
            <div className="w-8 h-8 rounded bg-primary-container flex items-center justify-center text-white font-bold text-base shadow-xs group-hover:bg-primary transition-colors">
              Q
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-base font-bold text-inverse-on-surface tracking-tight">
                  QueryPilot
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 bg-primary/40 rounded text-inverse-primary font-semibold">
                  PS-01
                </span>
              </div>
              <span className="text-[10px] text-inverse-on-surface/60 font-mono hidden sm:block">
                Search Term Triage Engine
              </span>
            </div>
          </button>
        </div>

        {/* Global Navigation Tabs */}
        <nav className="hidden md:flex items-center gap-6 h-full flex-1 justify-center">
          {[
            { id: 'overview', label: 'Triage Dashboard', icon: 'dashboard' },
            { id: 'data', label: `Search Terms (${results.length || '0'})`, icon: 'table_rows' },
            { id: 'campaigns', label: 'Campaign Breakdown', icon: 'bar_chart' },
            { id: 'calibration', label: 'Statistical Methodology', icon: 'functions' },
          ].map(tab => {
            const hasData = results.length > 0;
            const isActive = currentScreen === 'dashboard' && activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  if (tab.id === 'calibration') {
                    setCurrentScreen('dashboard');
                    setActiveTab('calibration');
                  } else if (hasData) {
                    setCurrentScreen('dashboard');
                    setActiveTab(tab.id as DashboardTab);
                  } else {
                    launchBenchmark('enterprise_core');
                  }
                }}
                className={`h-full border-b-2 px-1 text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  isActive
                    ? 'border-primary-container text-white'
                    : 'border-transparent text-outline-variant hover:text-white'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">{tab.icon}</span>
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Right Actions & Status */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-on-surface/20 rounded border border-outline/30 text-inverse-primary font-mono text-[11px]">
            <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-pulse"></span>
            <span>FastAPI & Client Mirror</span>
          </div>

          {results.length > 0 && currentScreen === 'dashboard' && (
            <>
              <button
                onClick={() => setShowConfigModal(true)}
                title="Tune hyperparameters"
                className="h-8 bg-surface-container text-on-surface hover:bg-surface-container-high px-2.5 rounded font-mono text-xs flex items-center gap-1 border border-outline-variant/40 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px] text-primary">tune</span>
                <span className="hidden sm:inline">Calibrate</span>
              </button>
              <button
                onClick={handleExport}
                className="h-8 bg-primary hover:bg-primary-container text-white px-3 rounded font-mono text-xs font-bold flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">download</span>
                <span className="hidden sm:inline">Export CSV</span>
              </button>
            </>
          )}

          {currentScreen !== 'intake' && (
            <button
              onClick={resetAll}
              title="Start a new evaluation run"
              className="h-8 bg-surface-container-lowest text-on-surface hover:bg-surface-container-low px-2.5 rounded font-mono text-xs flex items-center gap-1 border border-outline-variant transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px] text-primary">restart_alt</span>
              <span className="hidden sm:inline">Reset</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );

  /* ==========================================================================
     WORKFLOW PIPELINE STEPPER BAR
     ========================================================================== */
  const renderWorkflowStepper = () => (
    <div className="w-full bg-surface-container-low border-b border-outline-variant/30 py-2.5 px-4 sm:px-6">
      <div className="max-w-[1536px] mx-auto flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 sm:gap-4 text-xs font-mono">
          {/* Step 1 */}
          <button
            onClick={() => setCurrentScreen('intake')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors cursor-pointer ${
              currentScreen === 'intake'
                ? 'bg-primary text-white font-bold'
                : 'bg-surface-container-lowest text-on-surface hover:bg-surface-container'
            }`}
          >
            <span className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[10px]">1</span>
            Data Intake & Benchmarks
          </button>

          <span className="text-outline-variant">→</span>

          {/* Step 2 */}
          <button
            onClick={() => (rawCsvText ? setCurrentScreen('mapping') : null)}
            disabled={!rawCsvText}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors ${
              currentScreen === 'mapping'
                ? 'bg-primary text-white font-bold'
                : rawCsvText
                ? 'bg-surface-container-lowest text-on-surface hover:bg-surface-container cursor-pointer'
                : 'text-outline/60 cursor-not-allowed'
            }`}
          >
            <span className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[10px]">2</span>
            Schema Alignment
          </button>

          <span className="text-outline-variant">→</span>

          {/* Step 3 */}
          <button
            onClick={() => (results.length > 0 ? setCurrentScreen('dashboard') : null)}
            disabled={results.length === 0}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors ${
              currentScreen === 'dashboard'
                ? 'bg-primary text-white font-bold'
                : results.length > 0
                ? 'bg-surface-container-lowest text-on-surface hover:bg-surface-container cursor-pointer'
                : 'text-outline/60 cursor-not-allowed'
            }`}
          >
            <span className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[10px]">3</span>
            Forensic Dashboard
          </button>
        </div>

        {/* Current Active Dataset Pill */}
        <div className="flex items-center gap-2 text-xs font-mono text-on-surface-variant">
          <span className="text-outline-variant">Active Target:</span>
          <span className="font-bold text-on-surface bg-surface-container px-2 py-0.5 rounded">
            {datasetName}
          </span>
          {results.length > 0 && (
            <span className="text-[11px] text-tertiary font-bold bg-[#e6f7ef] px-2 py-0.5 rounded border border-tertiary/20">
              {results.length} Terms Audited
            </span>
          )}
        </div>
      </div>
    </div>
  );

  /* ==========================================================================
     SCREEN 1: INTAKE & BENCHMARKS
     ========================================================================== */
  if (currentScreen === 'intake') {
    return (
      <div className="min-h-screen pt-16 bg-surface flex flex-col justify-between">
        {renderHeader()}
        {renderWorkflowStepper()}

        <main className="max-w-[1536px] w-full mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6 animate-[fadeIn_0.2s_ease-out]">
          {/* Hero Banner with Instant 1-Click Launch */}
          <section className="bg-surface-container-lowest rounded-xl p-6 sm:p-8 border border-outline-variant shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="space-y-3 max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2.5 py-0.5 bg-tertiary-fixed text-tertiary-container border border-tertiary-container font-mono text-xs uppercase rounded font-bold">
                  PS-01 Active Specification
                </span>
                <span className="font-mono text-xs text-on-surface-variant">
                  Deterministic Forensic Intelligence
                </span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-on-surface tracking-tight">
                Statistical Search Term Triage Engine
              </h1>
              <p className="text-sm sm:text-[15px] leading-relaxed text-on-surface-variant max-w-3xl">
                Replaces blunt CTR rules with <strong>Leave-One-Out Empirical Bayes shrinkage</strong>,{' '}
                <strong>exact binomial tail tests</strong>, and <strong>Benjamini-Hochberg FDR multiplicity control</strong>.
                Neutralizes sparse query volatility while strictly defending against the 2-click / 1-conversion sample trap.
              </p>

              {/* Instant Call-to-Actions */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  onClick={() => launchBenchmark('enterprise_core')}
                  className="px-5 py-2.5 rounded-lg bg-primary hover:bg-primary-container text-white font-mono text-xs font-bold flex items-center gap-2 transition-all shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">bolt</span>
                  ⚡ 1-Click Live Demo (Enterprise 50 Terms)
                </button>
                <button
                  onClick={() => {
                    launchBenchmark('enterprise_core');
                    setActiveTab('calibration');
                  }}
                  className="px-4 py-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-mono text-xs font-semibold flex items-center gap-1.5 border border-outline-variant transition-all cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px] text-primary">functions</span>
                  View Statistical Methodology
                </button>
              </div>
            </div>

            {/* 4 Feature Badges */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 min-w-full lg:min-w-[420px]">
              {[
                ['shield', '2-Click Trap Defense', 'Strict minimum volume & conversions'],
                ['functions', 'Exact Tail Testing', 'SciPy-grade binomial p-values'],
                ['verified', 'FDR Multiplicity Control', 'Benjamini-Hochberg q-values'],
                ['monitoring', 'CPA Waste Gate', `$${configSettings.fallback_block_cost_floor.toFixed(0)} fallback spend floor`],
              ].map(([icon, title, desc]) => (
                <div
                  key={title}
                  className="bg-surface-container-low border border-outline-variant/60 rounded-lg p-3 hover:border-primary/40 transition-colors"
                >
                  <div className="flex items-center gap-2 text-on-surface">
                    <span className="material-symbols-outlined text-primary text-[18px]">{icon}</span>
                    <span className="font-mono text-xs font-bold uppercase">{title}</span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-on-surface-variant">{desc}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Main Intake Area: Upload vs Pre-Calibrated Benchmarks */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Upload Area (5 Cols) */}
            <section className="lg:col-span-5 bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-on-surface flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[20px]">cloud_upload</span>
                    Upload Custom Report
                  </h2>
                  <span className="font-mono text-[11px] text-on-surface-variant uppercase bg-surface-container px-2 py-0.5 rounded">
                    CSV Intake
                  </span>
                </div>

                <div
                  className="border-2 border-dashed border-outline-variant rounded-xl p-8 text-center cursor-pointer bg-surface-container-low/40 hover:bg-surface-container-low hover:border-primary transition-all group"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => {
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
                    onChange={e => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                  />

                  <div className="w-14 h-14 mx-auto mb-3 rounded-xl bg-surface-container flex items-center justify-center text-primary group-hover:scale-105 transition-transform shadow-xs">
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
                  <span className="inline-block px-2.5 py-1 bg-surface-container-lowest border border-outline-variant/60 rounded text-[11px] font-mono text-on-surface-variant">
                    Required: search_term, clicks, cost, conversions
                  </span>
                </div>

                {/* Auto Detection Indicators */}
                <div className="grid grid-cols-2 gap-2 mt-4">
                  {[
                    ['Schema Detection', 'Auto-Profiled'],
                    ['Preview Window', '5-Row Profiling'],
                    ['Engine Runtime', 'Deterministic Hybrid'],
                    ['Export Capability', 'Clean Forensic CSV'],
                  ].map(([label, value]) => (
                    <div key={label} className="border border-outline-variant/50 bg-surface-container-low p-2.5 rounded">
                      <span className="block font-mono text-[10px] uppercase text-on-surface-variant">{label}</span>
                      <span className="block font-mono text-[12px] font-bold text-on-surface mt-0.5">{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-outline-variant/30 flex items-center justify-between text-xs text-on-surface-variant font-mono">
                <span>Flexible Header Normalization</span>
                <span className="text-primary font-bold">Ready</span>
              </div>
            </section>

            {/* Pre-Calibrated Benchmark Scenarios (7 Cols) */}
            <section className="lg:col-span-7 bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-on-surface flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[20px]">dataset</span>
                    Pre-Calibrated Test Scenarios
                  </h2>
                  <span className="font-mono text-[11px] text-tertiary font-bold bg-[#e6f7ef] px-2 py-0.5 rounded">
                    1-Click Evaluation
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {PRESET_DATASETS.map(preset => (
                    <div
                      key={preset.id}
                      className="p-4 rounded-lg bg-surface-container-low hover:bg-surface-container hover:border-primary/60 transition-all border border-outline-variant/50 flex flex-col justify-between gap-3 group"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
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
                      </div>

                      <button
                        onClick={() => launchBenchmark(preset.id)}
                        className="w-full py-1.5 px-3 bg-surface-container-lowest hover:bg-primary hover:text-white text-on-surface font-mono text-[11px] font-bold rounded border border-outline-variant/60 transition-all flex items-center justify-center gap-1 cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[14px]">play_arrow</span>
                        Run Evaluation
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-outline-variant/30 flex items-center justify-between text-xs text-on-surface-variant font-mono">
                <span>Deterministic Scientific Engine</span>
                <span className="text-tertiary font-bold">Zero Sampling Bias</span>
              </div>
            </section>
          </div>

          {error && (
            <div className="p-4 bg-error-container text-error rounded-xl border border-error/30 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-medium">
                <span className="material-symbols-outlined text-[20px]">error</span>
                <span>{error}</span>
              </div>
              <button onClick={() => setError(null)} className="font-bold text-xs cursor-pointer">
                ✕
              </button>
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
     SCREEN 2: SCHEMA ALIGNMENT & CALIBRATION
     ========================================================================== */
  if (currentScreen === 'mapping') {
    const requiredFields = ['search_term', 'clicks', 'cost', 'conversions'];
    const optionalFields = ['campaign', 'ad_group', 'match_type', 'impressions', 'conversion_value'];
    const canProceed = requiredFields.every(f => mapping[f as keyof ColumnMappingType]);

    return (
      <div className="min-h-screen pt-16 bg-surface">
        {renderHeader()}
        {renderWorkflowStepper()}

        <main className="max-w-[1536px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6 animate-[fadeIn_0.2s_ease-out]">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Column Mapping Form (5 cols) */}
            <div className="lg:col-span-5 flex flex-col gap-5">
              <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-bold text-on-surface flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[18px]">tune</span>
                    Telemetry Column Alignment
                  </h2>
                  <span className="font-mono text-[11px] text-tertiary font-bold bg-[#e6f7ef] px-2 py-0.5 rounded">
                    {requiredFields.filter(f => mapping[f as keyof ColumnMappingType]).length}/{requiredFields.length}{' '}
                    Mandatory Aligned
                  </span>
                </div>

                {/* Mandatory Fields */}
                <div className="space-y-3 mb-5">
                  <span className="font-mono text-[10px] text-on-surface-variant uppercase tracking-wider font-bold block">
                    Mandatory Attributes
                  </span>
                  {requiredFields.map(field => (
                    <div key={field} className="flex items-center gap-3">
                      <label className="w-32 text-xs font-medium text-on-surface flex items-center gap-1.5">
                        {mapping[field as keyof ColumnMappingType] ? (
                          <span className="material-symbols-outlined text-tertiary text-[15px]">check_circle</span>
                        ) : (
                          <span className="material-symbols-outlined text-amber-500 text-[15px]">warning</span>
                        )}
                        {field.replace(/_/g, ' ')}
                      </label>
                      <select
                        value={mapping[field as keyof ColumnMappingType] || ''}
                        onChange={e => setMapping(prev => ({ ...prev, [field]: e.target.value || null }))}
                        className="flex-1 bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 text-xs text-on-surface font-mono focus:border-primary focus:outline-none"
                      >
                        <option value="">— Select Column —</option>
                        {columns.map(c => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>

                {/* Optional Fields */}
                <div className="space-y-3 pt-3 border-t border-outline-variant/30">
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
                        onChange={e => setMapping(prev => ({ ...prev, [field]: e.target.value || null }))}
                        className="flex-1 bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 text-xs text-on-surface font-mono focus:border-primary focus:outline-none"
                      >
                        <option value="">— Not Mapped —</option>
                        {columns.map(c => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setCurrentScreen('intake')}
                  className="py-3 px-4 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-mono text-xs font-semibold border border-outline-variant transition-colors cursor-pointer"
                >
                  ← Back
                </button>
                <button
                  onClick={runAnalysis}
                  disabled={!canProceed || isLoading}
                  className={`flex-1 py-3 rounded-lg font-mono text-xs font-bold transition-all shadow-xs flex items-center justify-center gap-2 cursor-pointer ${
                    canProceed
                      ? 'bg-primary hover:bg-primary-container text-white'
                      : 'bg-surface-container text-outline cursor-not-allowed border border-outline-variant/40'
                  }`}
                >
                  <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                  Execute Statistical Triage
                </button>
              </div>
            </div>

            {/* Raw Data Preview (7 cols) */}
            <div className="lg:col-span-7 bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-bold text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[18px]">table_rows</span>
                  Raw Sample Intake Preview
                </h2>
                <span className="font-mono text-[11px] text-on-surface-variant">
                  Showing 5 of {sampleRows.length} Rows
                </span>
              </div>

              <div className="overflow-auto border border-outline-variant/40 rounded-lg flex-1 max-h-[520px]">
                <table className="w-full text-xs">
                  <thead className="bg-surface-container-low sticky top-0 z-10">
                    <tr className="border-b border-outline-variant/40">
                      {columns.map(c => (
                        <th
                          key={c}
                          className="text-left py-2.5 px-3 font-mono text-[11px] text-on-surface-variant font-semibold whitespace-nowrap"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sampleRows.map((row, i) => (
                      <tr key={i} className="border-b border-outline-variant/20 hover:bg-surface-container-low/50">
                        {columns.map(c => (
                          <td key={c} className="py-2.5 px-3 font-mono text-[11px] text-on-surface whitespace-nowrap">
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
     SCREEN 3: FORENSIC DASHBOARD
     ========================================================================== */
  return (
    <div className="min-h-screen pt-16 bg-surface">
      {renderHeader()}
      {renderWorkflowStepper()}

      {/* Top Banner Context Bar (PlacementOS signature) */}
      <div className="w-full bg-surface-container-low py-3 border-b border-outline-variant/30">
        <div className="max-w-[1536px] mx-auto px-4 sm:px-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-base text-on-surface font-bold font-mono">
                {datasetName}
              </span>
              <span className="text-outline-variant font-mono">•</span>
              <span className="text-xs text-on-surface-variant font-mono">
                {summary ? `${fmtInt(summary.total_rows)} Evaluated Terms` : 'Triage Run'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="bg-secondary-fixed text-on-secondary-fixed px-2.5 py-0.5 rounded font-mono text-[11px] font-bold">
                100% COVERAGE
              </span>
              <span className="bg-surface-container-lowest text-on-surface px-2.5 py-0.5 rounded border border-outline-variant/40 font-mono text-[11px]">
                α = {configSettings.alpha} (95% CI)
              </span>
            </div>
          </div>

          {/* Tab Switcher Pills */}
          <div className="flex items-center gap-1 bg-surface-container-lowest p-1 rounded-lg border border-outline-variant/40">
            {[
              { id: 'overview', label: 'Overview', icon: 'dashboard' },
              { id: 'data', label: `Search Terms (${results.length})`, icon: 'table_rows' },
              { id: 'campaigns', label: 'Campaigns', icon: 'bar_chart' },
              { id: 'calibration', label: 'Methodology', icon: 'functions' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as DashboardTab)}
                className={`px-3 py-1 text-xs font-mono rounded flex items-center gap-1 transition-all cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-primary text-white font-bold shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="max-w-[1536px] w-full mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6 animate-[fadeIn_0.2s_ease-out]">
        {/* ====================================================================
           TAB 1: READINESS DASHBOARD OVERVIEW
           ==================================================================== */}
        {activeTab === 'overview' && summary && (
          <div className="flex flex-col gap-6">
            {/* 5-Column Telemetry Calibration Pipeline Strip */}
            <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs flex flex-col gap-4">
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
                  Empirical Bayes Shrinkage + Binomial Tail Tests
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5 pt-1">
                {/* 01. Total */}
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/40 flex flex-col justify-between relative overflow-hidden">
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
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/40 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-tertiary font-mono text-[11px] font-bold">
                    <span>02. PROMOTE</span>
                    <span className="material-symbols-outlined text-[16px]">trending_up</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-tertiary">
                      {fmtInt(summary.promote_count)}
                    </span>
                    <span className="font-mono text-[11px] text-tertiary">
                      {' '}
                      ({((summary.promote_count / (summary.total_rows || 1)) * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Statistically proven outperformers
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-tertiary"></div>
                </div>

                {/* 03. Block */}
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/40 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-error font-mono text-[11px] font-bold">
                    <span>03. BLOCK</span>
                    <span className="material-symbols-outlined text-[16px]">block</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-error">
                      {fmtInt(summary.block_count)}
                    </span>
                    <span className="font-mono text-[11px] text-error">
                      {' '}
                      ({((summary.block_count / (summary.total_rows || 1)) * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Cost exceeds CPA with 0 conv
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-error"></div>
                </div>

                {/* 04. Ignore */}
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/40 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-on-surface-variant font-mono text-[11px]">
                    <span>04. IGNORE / MAINTAIN</span>
                    <span className="material-symbols-outlined text-[16px]">horizontal_rule</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-on-surface">
                      {fmtInt(summary.ignore_count)}
                    </span>
                    <span className="font-mono text-[11px] text-on-surface-variant">
                      {' '}
                      ({((summary.ignore_count / (summary.total_rows || 1)) * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Insufficient volume / ambiguous
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-outline"></div>
                </div>

                {/* 05. Baseline */}
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/40 flex flex-col justify-between relative overflow-hidden">
                  <div className="flex justify-between items-center text-secondary font-mono text-[11px] font-bold">
                    <span>05. BASELINE CVR</span>
                    <span className="material-symbols-outlined text-[16px]">query_stats</span>
                  </div>
                  <div className="mt-3">
                    <span className="text-2xl font-bold font-mono text-secondary">
                      {fmtPct(summary.account_baseline_cvr)}
                    </span>
                    <span className="font-mono text-[11px] text-on-surface-variant">
                      {' '}
                      CPA: {fmtCurrency(summary.account_cpa)}
                    </span>
                  </div>
                  <span className="text-[12px] text-on-surface-variant mt-1">
                    Account-wide pooled benchmark
                  </span>
                  <div className="absolute right-0 top-0 bottom-0 w-1 bg-secondary"></div>
                </div>
              </div>
            </div>

            {/* Distribution Bar */}
            <div className="bg-surface-container-lowest rounded-xl p-5 border border-outline-variant shadow-xs flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-on-surface">Triage Decision Composition</span>
                <span className="font-mono text-xs text-on-surface-variant">100% Account Allocation</span>
              </div>
              <div className="flex gap-1 h-6 rounded-md overflow-hidden bg-surface-container">
                {summary.promote_count > 0 && (
                  <div
                    className="bg-tertiary flex items-center justify-center text-[10px] font-bold text-white font-mono"
                    style={{ width: `${(summary.promote_count / (summary.total_rows || 1)) * 100}%` }}
                    title={`PROMOTE: ${summary.promote_count}`}
                  >
                    {((summary.promote_count / summary.total_rows) * 100).toFixed(0)}% PROMOTE
                  </div>
                )}
                {summary.block_count > 0 && (
                  <div
                    className="bg-error flex items-center justify-center text-[10px] font-bold text-white font-mono"
                    style={{ width: `${(summary.block_count / (summary.total_rows || 1)) * 100}%` }}
                    title={`BLOCK: ${summary.block_count}`}
                  >
                    {((summary.block_count / summary.total_rows) * 100).toFixed(0)}% BLOCK
                  </div>
                )}
                {summary.ignore_count > 0 && (
                  <div
                    className="bg-outline flex items-center justify-center text-[10px] font-bold text-white font-mono"
                    style={{ width: `${(summary.ignore_count / (summary.total_rows || 1)) * 100}%` }}
                    title={`IGNORE: ${summary.ignore_count}`}
                  >
                    {((summary.ignore_count / summary.total_rows) * 100).toFixed(0)}% IGNORE
                  </div>
                )}
              </div>
            </div>

            {/* 3 Analytics KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {/* Card 1: Traffic & Spend Totals */}
              <div className="bg-surface-container-lowest rounded-xl p-5 border border-outline-variant shadow-xs">
                <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider font-bold block mb-3">
                  Traffic & Ad Spend Telemetry
                </span>
                <div className="space-y-2.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">Total Valid Clicks</span>
                    <span className="font-mono font-bold text-on-surface">{fmtInt(summary.account_valid_clicks)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">Total Conversions</span>
                    <span className="font-mono font-bold text-on-surface">{fmt(summary.account_valid_conversions)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">Total Ad Spend</span>
                    <span className="font-mono font-bold text-on-surface">{fmtCurrency(summary.account_valid_cost)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">Effective Block Floor</span>
                    <span className="font-mono font-bold text-on-surface">{fmtCurrency(summary.effective_block_cost_gate)}</span>
                  </div>
                </div>
              </div>

              {/* Card 2: Integrity & Data Quality */}
              {qualityReport && (
                <div className="bg-surface-container-lowest rounded-xl p-5 border border-outline-variant shadow-xs">
                  <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider font-bold block mb-3">
                    Data Integrity Audit
                  </span>
                  <div className="space-y-2.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-on-surface-variant">Unique Search Terms</span>
                      <span className="font-mono font-bold text-on-surface">{fmtInt(qualityReport.unique_search_terms)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-on-surface-variant">Duplicate Queries</span>
                      <span className={`font-mono font-bold ${qualityReport.duplicate_query_row_count > 0 ? 'text-amber-600' : 'text-on-surface'}`}>
                        {fmtInt(qualityReport.duplicate_query_row_count)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-on-surface-variant">Zero-Click Terms</span>
                      <span className="font-mono font-bold text-on-surface">{fmtInt(qualityReport.zero_click_row_count)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-on-surface-variant">Flagged for Review</span>
                      <span className={`font-mono font-bold ${summary.review_flagged_count > 0 ? 'text-amber-600' : 'text-on-surface'}`}>
                        {fmtInt(summary.review_flagged_count)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Card 3: Confidence Tiers */}
              <div className="bg-surface-container-lowest rounded-xl p-5 border border-outline-variant shadow-xs">
                <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider font-bold block mb-3">
                  Confidence Tier Breakdown
                </span>
                <div className="space-y-2.5 text-xs">
                  {(() => {
                    const tierCounts: Record<string, number> = {};
                    results.forEach(r => {
                      const tier = r.confidence_tier.split(':')[0] || r.confidence_tier;
                      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
                    });
                    return Object.entries(tierCounts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([tier, count]) => (
                        <div key={tier} className="flex justify-between">
                          <span className="text-on-surface-variant truncate mr-2">{tier}</span>
                          <span className="font-mono font-bold text-on-surface">{count}</span>
                        </div>
                      ));
                  })()}
                </div>
              </div>
            </div>

            {/* Executive Decision Blueprint: Methodology Rules + Top Highlights */}
            <ExecutiveDecisionBlueprint
              results={results as any}
              summary={{
                totalRows: summary.total_rows,
                promoteCount: summary.promote_count,
                blockCount: summary.block_count,
                ignoreCount: summary.ignore_count,
                reviewFlaggedCount: summary.review_flagged_count,
                accountValidClicks: summary.account_valid_clicks,
                accountValidConversions: summary.account_valid_conversions,
                accountValidCost: summary.account_valid_cost,
                accountBaselineCvr: summary.account_baseline_cvr,
                accountCpa: summary.account_cpa,
                effectiveBlockCostGate: summary.effective_block_cost_gate,
              }}
              effectiveBlockCostGate={summary.effective_block_cost_gate}
              alpha={configSettings.alpha}
              onInspectRow={term => {
                setSelectedRow(term as any);
                setActiveTab('data');
              }}
            />
          </div>
        )}

        {/* ====================================================================
           TAB 2: SEARCH TERMS (Triage Table + Forensic Side Drawer)
           ==================================================================== */}
        {activeTab === 'data' && (
          <div className="flex flex-col gap-4">
            {/* Filter Toolbar */}
            <div className="bg-surface-container-lowest rounded-xl p-4 border border-outline-variant shadow-xs flex flex-wrap gap-3 items-center justify-between">
              {/* Search Box */}
              <div className="relative flex-1 min-w-[260px]">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">
                  search
                </span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Filter query, campaign, or decision reason..."
                  className="w-full pl-9 pr-8 py-2 bg-surface-container-low border border-outline-variant/60 rounded text-xs text-on-surface font-mono placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface text-xs cursor-pointer"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Pill Filters */}
              <div className="flex items-center gap-1.5">
                {(['PROMOTE', 'BLOCK', 'IGNORE'] as const).map(d => {
                  const count = results.filter(r => r.decision === d).length;
                  const isSelected = decisionFilter.includes(d);
                  return (
                    <button
                      key={d}
                      onClick={() =>
                        setDecisionFilter(prev =>
                          prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
                        )
                      }
                      className={`px-2.5 py-1 rounded text-xs font-mono font-bold border transition-colors cursor-pointer flex items-center gap-1.5 ${
                        isSelected
                          ? d === 'PROMOTE'
                            ? 'bg-[#e6f7ef] text-tertiary border-tertiary'
                            : d === 'BLOCK'
                            ? 'bg-error-container text-error border-error'
                            : 'bg-surface-container text-on-surface border-outline'
                          : 'bg-surface-container-low text-on-surface-variant border-outline-variant/60 hover:border-outline'
                      }`}
                    >
                      <span>{d}</span>
                      <span className="text-[10px] opacity-75">({count})</span>
                    </button>
                  );
                })}

                <button
                  onClick={() => setReviewOnly(!reviewOnly)}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-bold border transition-colors flex items-center gap-1.5 cursor-pointer ${
                    reviewOnly
                      ? 'bg-amber-100 text-amber-900 border-amber-400'
                      : 'bg-surface-container-low text-on-surface-variant border-outline-variant/60 hover:border-outline'
                  }`}
                >
                  <span className="material-symbols-outlined text-[14px]">flag</span>
                  Review Flags ({results.filter(r => r.review_flag).length})
                </button>
              </div>

              {/* Campaign Filter */}
              {uniqueCampaigns.length > 1 && (
                <select
                  value={campaignFilter.length === 1 ? campaignFilter[0] : ''}
                  onChange={e => setCampaignFilter(e.target.value ? [e.target.value] : [])}
                  className="bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 text-xs text-on-surface font-mono focus:border-primary focus:outline-none max-w-[200px]"
                >
                  <option value="">All Campaigns</option>
                  {uniqueCampaigns.map(c => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}

              <span className="font-mono text-xs text-on-surface-variant font-semibold">
                Showing {filteredResults.length} of {results.length} terms
              </span>

              {/* Fast Batch Actions */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => handleBatchCopy('promote')}
                  className="px-2.5 py-1.5 rounded bg-[#e6f7ef] hover:bg-emerald-100 text-tertiary font-mono text-xs font-bold flex items-center gap-1 border border-tertiary/30 transition-colors cursor-pointer shadow-2xs"
                  title="Copy all promoted terms as [Exact Match] keywords for Google Ads"
                >
                  <span className="material-symbols-outlined text-[14px]">content_copy</span>
                  Copy Promotes ({results.filter(r => r.decision === 'PROMOTE').length})
                </button>
                <button
                  onClick={() => handleBatchCopy('block')}
                  className="px-2.5 py-1.5 rounded bg-error-container hover:bg-rose-100 text-error font-mono text-xs font-bold flex items-center gap-1 border border-error/30 transition-colors cursor-pointer shadow-2xs"
                  title="Copy all blocked terms as -[Negative Exact] keywords for Google Ads"
                >
                  <span className="material-symbols-outlined text-[14px]">content_copy</span>
                  Copy Negatives ({results.filter(r => r.decision === 'BLOCK').length})
                </button>
              </div>
            </div>

            {/* Table & Forensic Detail Side Panel */}
            <div className="flex flex-col lg:flex-row gap-4 items-start">
              <div
                className={`bg-surface-container-lowest rounded-xl border border-outline-variant shadow-xs overflow-hidden transition-all ${
                  selectedRow ? 'w-full lg:flex-1' : 'w-full'
                }`}
              >
                <div className="overflow-auto max-h-[calc(100vh-270px)]">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-container-low sticky top-0 z-10">
                      <tr className="border-b border-outline-variant/40">
                        {[
                          { key: 'row_id', label: '#', w: 'w-10 text-left' },
                          { key: 'search_term', label: 'Search Query', w: 'min-w-[190px] text-left' },
                          { key: 'campaign', label: 'Campaign', w: 'min-w-[120px] text-left' },
                          { key: 'clicks', label: 'Clicks', w: 'w-16 text-right' },
                          { key: 'cost', label: 'Spend', w: 'w-20 text-right' },
                          { key: 'conversions', label: 'Conv', w: 'w-16 text-right' },
                          { key: 'observed_cvr', label: 'Obs. CVR', w: 'w-20 text-right' },
                          { key: 'shrunk_baseline_cvr', label: 'Baseline', w: 'w-20 text-right' },
                          { key: 'decision', label: 'Decision & Audit', w: 'min-w-[155px] text-left' },
                          { key: 'reason', label: 'Decision Explanation & Why', w: 'min-w-[270px] text-left' },
                        ].map(col => (
                          <th
                            key={col.key}
                            onClick={() => handleSort(col.key)}
                            className={`py-3 px-3.5 font-mono text-[11px] text-on-surface-variant font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer hover:text-on-surface select-none ${col.w}`}
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
                      {filteredResults.map(row => {
                        const expl = explainDecision(
                          row as any,
                          summary?.effective_block_cost_gate,
                          configSettings.alpha,
                          configSettings.min_test_clicks,
                          configSettings.min_promote_conversions
                        );

                        return (
                          <tr
                            key={row.row_id}
                            onClick={() => setSelectedRow(row)}
                            className={`border-b border-outline-variant/20 cursor-pointer transition-colors ${
                              selectedRow?.row_id === row.row_id
                                ? 'bg-primary-fixed/20 border-l-4 border-l-primary'
                                : 'hover:bg-surface-container-low/60'
                            } ${row.review_flag ? 'border-l-4 border-l-amber-500' : ''}`}
                          >
                            <td className="py-2.5 px-3.5 font-mono text-on-surface-variant">{row.row_id}</td>
                            <td className="py-2.5 px-3.5 font-medium text-on-surface truncate max-w-[220px]" title={row.search_term}>
                              {row.search_term}
                            </td>
                            <td className="py-2.5 px-3.5 font-mono text-[11px] text-on-surface-variant truncate max-w-[130px]" title={row.campaign}>
                              {row.campaign}
                            </td>
                            <td className="py-2.5 px-3.5 font-mono text-right text-on-surface">{fmtInt(row.clicks)}</td>
                            <td className="py-2.5 px-3.5 font-mono text-right text-on-surface">{fmtCurrency(row.cost)}</td>
                            <td className="py-2.5 px-3.5 font-mono text-right text-on-surface">{fmt(row.conversions, 1)}</td>
                            <td className="py-2.5 px-3.5 font-mono text-right">
                              <span
                                className={
                                  row.observed_cvr > row.shrunk_baseline_cvr
                                    ? 'text-tertiary font-bold'
                                    : row.observed_cvr < row.shrunk_baseline_cvr
                                    ? 'text-error font-bold'
                                    : 'text-on-surface-variant'
                                }
                              >
                                {fmtPct(row.observed_cvr)}
                              </span>
                            </td>
                            <td className="py-2.5 px-3.5 font-mono text-right text-on-surface-variant">
                              {fmtPct(row.shrunk_baseline_cvr)}
                            </td>
                            <td className="py-2.5 px-3.5">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <DecisionBadge decision={row.decision} />
                                <button
                                  onClick={e => {
                                    e.stopPropagation();
                                    setSelectedRow(row);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary font-mono text-[11px] font-semibold transition-colors cursor-pointer"
                                  title="Inspect decision logic and explanation"
                                >
                                  <span className="material-symbols-outlined text-[13px]">psychology</span>
                                  Explain
                                </button>
                              </div>
                            </td>
                            <td className="py-2.5 px-3.5 font-mono text-[11px]">
                              <div
                                className="truncate max-w-[280px] text-on-surface/90"
                                title={expl.shortSummary}
                              >
                                {expl.shortSummary}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filteredResults.length === 0 && (
                    <div className="p-12 text-center text-xs text-on-surface-variant font-mono">
                      No search terms matched your current filter criteria.
                    </div>
                  )}
                </div>
              </div>

              {/* Forensic Diagnostic Side Inspector */}
              {selectedRow && (
                <div className="w-full lg:w-[480px] xl:w-[540px] flex-shrink-0 animate-[fadeIn_0.2s_ease-out]">
                  <ForensicDecisionInspector
                    row={selectedRow as any}
                    effectiveBlockCostGate={summary?.effective_block_cost_gate}
                    alpha={configSettings.alpha}
                    minTestClicks={configSettings.min_test_clicks}
                    minPromoteConv={configSettings.min_promote_conversions}
                    onClose={() => setSelectedRow(null)}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* ====================================================================
           TAB 3: CAMPAIGNS BREAKDOWN
           ==================================================================== */}
        {activeTab === 'campaigns' && (
          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant shadow-xs overflow-hidden">
            <div className="p-4 bg-surface-container-low border-b border-outline-variant/40 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-on-surface">Campaign-Level Aggregation</h3>
                <p className="text-xs text-on-surface-variant font-mono mt-0.5">
                  Portfolio triage ratio across {campaignSummary.length} campaigns
                </p>
              </div>
              <span className="font-mono text-xs text-on-surface-variant">
                Total Spend: {fmtCurrency(summary?.account_valid_cost)}
              </span>
            </div>

            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-surface-container-low/50">
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
           TAB 4: STATISTICAL METHODOLOGY PROOF
           ==================================================================== */}
        {activeTab === 'calibration' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Card 1 */}
              <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">functions</span>
                  <h3 className="text-sm font-bold text-on-surface">1. Leave-One-Out Empirical Bayes Shrinkage</h3>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Pulls low-sample campaign conversion rates toward the account-wide baseline prior using a leave-one-out shrinkage estimator.
                </p>
                <div className="bg-surface-container-low p-3 rounded-lg font-mono text-[11px] text-primary border border-outline-variant/30">
                  {'CVR_shrunk = (CVR_campaign × N + CVR_account × k) / (N + k)'}
                </div>
                <p className="font-mono text-[11px] text-on-surface-variant mt-2">
                  Shrinkage constant k = {configSettings.shrinkage_k}. Prevents sparse, low-volume queries from skewing priors.
                </p>
              </div>

              {/* Card 2 */}
              <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-tertiary text-[20px]">verified</span>
                  <h3 className="text-sm font-bold text-on-surface">2. Wilson Score Confidence Interval</h3>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Traditional Wald normal approximation intervals fail near 0 or 1. Wilson score intervals guarantee asymmetric, robust coverage across all click volumes.
                </p>
                <div className="bg-surface-container-low p-3 rounded-lg font-mono text-[11px] text-tertiary border border-outline-variant/30">
                  {'p̂ ± z √(p̂(1 - p̂)/n + z²/(4n²)) / (1 + z²/n)'}
                </div>
                <p className="font-mono text-[11px] text-on-surface-variant mt-2">
                  Evaluated at α = {configSettings.alpha} (95% confidence).
                </p>
              </div>

              {/* Card 3 */}
              <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-secondary text-[20px]">science</span>
                  <h3 className="text-sm font-bold text-on-surface">3. Exact Binomial CDF Hypothesis Testing</h3>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Direct discrete tail tests compare observed conversions against the shrunk baseline CVR:
                </p>
                <div className="bg-surface-container-low p-3 rounded-lg font-mono text-[11px] text-secondary border border-outline-variant/30 space-y-1">
                  <div>{'p_upper = P(X ≥ c | N, CVR_baseline)  [Outperformer test]'}</div>
                  <div>{'p_lower = P(X ≤ c | N, CVR_baseline)  [Underperformer test]'}</div>
                </div>
                <p className="font-mono text-[11px] text-on-surface-variant mt-2">
                  Calculated via the regularized incomplete beta function I_x(a, b).
                </p>
              </div>

              {/* Card 4 */}
              <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">checklist_rtl</span>
                  <h3 className="text-sm font-bold text-on-surface">4. Benjamini-Hochberg Multiplicity Control</h3>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  Adjusts raw p-values into False Discovery Rate (FDR) q-values to prevent spurious false positives when auditing hundreds of keywords.
                </p>
                <div className="bg-surface-container-low p-3 rounded-lg font-mono text-[11px] text-primary border border-outline-variant/30">
                  {'q_(i) = min_{j ≥ i} [ p_(j) × m / j ]'}
                </div>
                <p className="font-mono text-[11px] text-on-surface-variant mt-2">
                  Controls the false discovery rate at α = {configSettings.alpha}.
                </p>
              </div>
            </div>

            {/* Anti-Trap Guardrails Card */}
            <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs">
              <h3 className="text-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                <span className="material-symbols-outlined text-amber-500 text-[20px]">shield</span>
                Deterministic Anti-Trap Guardrails
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/30">
                  <span className="font-bold text-on-surface block mb-1 font-mono">2-Click Trap Defense</span>
                  <p className="text-on-surface-variant leading-relaxed">
                    Mandates at least <strong>{configSettings.min_test_clicks} clicks</strong> and{' '}
                    <strong>{configSettings.min_promote_conversions} conversions</strong> before granting PROMOTE.
                  </p>
                </div>
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/30">
                  <span className="font-bold text-on-surface block mb-1 font-mono">CPA Spend Floor Gate</span>
                  <p className="text-on-surface-variant leading-relaxed">
                    Queries with 0 conversions cannot be blocked unless spend exceeds the effective CPA floor ($
                    {configSettings.fallback_block_cost_floor.toFixed(2)}).
                  </p>
                </div>
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/30">
                  <span className="font-bold text-on-surface block mb-1 font-mono">Automated Anomaly Audit</span>
                  <p className="text-on-surface-variant leading-relaxed">
                    Inspects duplicate queries, negative values, fractional conversions, and zero-click rows prior to inference.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Hyperparameter Calibration Modal */}
      {showConfigModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-xl max-w-lg w-full p-6 border border-outline-variant shadow-2xl animate-[fadeIn_0.2s_ease-out]">
            <div className="flex items-center justify-between pb-3 border-b border-outline-variant/40 mb-4">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
                <h3 className="text-sm font-bold text-on-surface">Statistical Hyperparameters</h3>
              </div>
              <button
                onClick={() => setShowConfigModal(false)}
                className="text-on-surface-variant hover:text-on-surface p-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-on-surface block">Significance Alpha (α)</span>
                  <span className="text-on-surface-variant text-[11px]">Hypothesis test confidence threshold</span>
                </div>
                <select
                  value={configSettings.alpha}
                  onChange={e =>
                    setConfigSettings(prev => ({ ...prev, alpha: parseFloat(e.target.value) }))
                  }
                  className="bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 font-mono text-xs"
                >
                  <option value={0.01}>0.01 (99% conf)</option>
                  <option value={0.05}>0.05 (95% conf)</option>
                  <option value={0.1}>0.10 (90% conf)</option>
                </select>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-on-surface block">Shrinkage Constant (k)</span>
                  <span className="text-on-surface-variant text-[11px]">Priors weight in clicks</span>
                </div>
                <input
                  type="number"
                  value={configSettings.shrinkage_k}
                  onChange={e =>
                    setConfigSettings(prev => ({
                      ...prev,
                      shrinkage_k: parseFloat(e.target.value) || 100,
                    }))
                  }
                  className="w-24 bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 font-mono text-xs text-right"
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-on-surface block">Min Test Clicks</span>
                  <span className="text-on-surface-variant text-[11px]">Minimum clicks to evaluate</span>
                </div>
                <input
                  type="number"
                  value={configSettings.min_test_clicks}
                  onChange={e =>
                    setConfigSettings(prev => ({
                      ...prev,
                      min_test_clicks: parseInt(e.target.value) || 10,
                    }))
                  }
                  className="w-24 bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 font-mono text-xs text-right"
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-on-surface block">Min Promote Conversions</span>
                  <span className="text-on-surface-variant text-[11px]">2-click trap guardrail floor</span>
                </div>
                <input
                  type="number"
                  step="0.5"
                  value={configSettings.min_promote_conversions}
                  onChange={e =>
                    setConfigSettings(prev => ({
                      ...prev,
                      min_promote_conversions: parseFloat(e.target.value) || 2.0,
                    }))
                  }
                  className="w-24 bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 font-mono text-xs text-right"
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-on-surface block">Fallback Block Cost Floor ($)</span>
                  <span className="text-on-surface-variant text-[11px]">Minimum spend before block</span>
                </div>
                <input
                  type="number"
                  value={configSettings.fallback_block_cost_floor}
                  onChange={e =>
                    setConfigSettings(prev => ({
                      ...prev,
                      fallback_block_cost_floor: parseFloat(e.target.value) || 25,
                    }))
                  }
                  className="w-24 bg-surface-container-low border border-outline-variant/60 rounded px-2.5 py-1.5 font-mono text-xs text-right"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <div>
                  <span className="font-bold text-on-surface block">Strict FDR Multiplicity Gate</span>
                  <span className="text-on-surface-variant text-[11px]">Require q-value &lt; α</span>
                </div>
                <input
                  type="checkbox"
                  checked={configSettings.strict_fdr_gate}
                  onChange={e =>
                    setConfigSettings(prev => ({ ...prev, strict_fdr_gate: e.target.checked }))
                  }
                  className="w-4 h-4 accent-primary rounded cursor-pointer"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-5 mt-4 border-t border-outline-variant/40">
              <button
                onClick={() => setShowConfigModal(false)}
                className="px-4 py-2 bg-surface-container text-on-surface font-mono text-xs rounded hover:bg-surface-container-high transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={() => {
                  setShowConfigModal(false);
                  if (rawCsvText) {
                    executeTriage(rawCsvText, columns, mapping, configSettings);
                  }
                }}
                className="px-4 py-2 bg-primary hover:bg-primary-container text-white font-mono text-xs font-bold rounded transition-colors shadow-xs cursor-pointer"
              >
                Apply & Recalculate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Error Toast */}
      {error && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md p-4 bg-error-container text-error border border-error/30 rounded-xl shadow-2xl flex items-center justify-between gap-3 animate-[slideUp_0.2s_ease-out]">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="cursor-pointer font-bold text-xs p-1">
            ✕
          </button>
        </div>
      )}

      {/* Fast Batch Copy Notification Toast */}
      {batchCopiedNotice && (
        <div className="fixed bottom-5 left-5 z-50 p-3.5 px-5 bg-surface-container-high text-on-surface border border-primary/40 rounded-xl shadow-2xl flex items-center gap-2.5 font-mono text-xs animate-[slideUp_0.2s_ease-out]">
          <span className="material-symbols-outlined text-primary text-[18px]">check_circle</span>
          <span>{batchCopiedNotice}</span>
        </div>
      )}
    </div>
  );
}
