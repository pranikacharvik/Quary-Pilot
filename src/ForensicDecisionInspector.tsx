import React, { useState } from 'react';
import type { TriageRowResult } from './triageEngine';
import {
  explainDecision,
  type DecisionExplanation,
  type LogicStep,
} from './decisionExplainer';

interface ForensicDecisionInspectorProps {
  row: TriageRowResult;
  effectiveBlockCostGate?: number;
  alpha?: number;
  minTestClicks?: number;
  minPromoteConv?: number;
  onClose: () => void;
  onSelectAnotherRow?: (rowId: number) => void;
}

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

export const ForensicDecisionInspector: React.FC<ForensicDecisionInspectorProps> = ({
  row,
  effectiveBlockCostGate = 25.0,
  alpha = 0.05,
  minTestClicks = 10,
  minPromoteConv = 2.0,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'explanation' | 'steps' | 'gauges' | 'counterfactual'>('explanation');
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const explanation: DecisionExplanation = explainDecision(
    row,
    effectiveBlockCostGate,
    alpha,
    minTestClicks,
    minPromoteConv
  );

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2500);
  };

  // Visual Gauge Calculation for CVR vs Baseline
  const maxScaleCvr = Math.max(row.observed_cvr * 1.25, row.shrunk_baseline_cvr * 1.5, 0.25);
  const obsCvrPosition = Math.min(100, Math.max(0, (row.observed_cvr / maxScaleCvr) * 100));
  const baseCvrPosition = Math.min(100, Math.max(0, (row.shrunk_baseline_cvr / maxScaleCvr) * 100));
  const ciLeft = Math.min(100, Math.max(0, (row.wilson_ci_lower / maxScaleCvr) * 100));
  const ciRight = Math.min(100, Math.max(0, (row.wilson_ci_upper / maxScaleCvr) * 100));
  const ciWidth = Math.max(2, ciRight - ciLeft);

  // Spend vs CPA Floor
  const spendPctOfGate = effectiveBlockCostGate > 0 ? (row.cost / effectiveBlockCostGate) * 100 : 0;

  return (
    <div className="w-full flex flex-col bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl overflow-hidden animate-[fadeIn_0.2s_ease-out]">
      {/* Top Header Bar */}
      <div className="p-5 bg-surface-container-low/70 border-b border-outline-variant/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider font-bold">
              Query #{row.row_id}
            </span>
            <span className="text-outline-variant">•</span>
            <span className="font-mono text-[11px] text-primary truncate max-w-[200px]" title={row.campaign}>
              {row.campaign}
            </span>
            {row.ad_group && (
              <>
                <span className="text-outline-variant">•</span>
                <span className="font-mono text-[11px] text-on-surface-variant truncate max-w-[150px]">
                  {row.ad_group}
                </span>
              </>
            )}
          </div>
          <h2 className="text-lg font-bold text-on-surface font-mono tracking-tight break-words">
            "{row.search_term}"
          </h2>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center">
          {/* Action Badge */}
          {row.decision === 'PROMOTE' && (
            <span className="px-3 py-1 rounded-lg font-mono text-xs font-bold uppercase bg-[#e6f7ef] text-tertiary border border-tertiary/40 shadow-xs flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-tertiary animate-pulse"></span>
              PROMOTE
            </span>
          )}
          {row.decision === 'BLOCK' && (
            <span className="px-3 py-1 rounded-lg font-mono text-xs font-bold uppercase bg-error-container text-error border border-error/40 shadow-xs flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-error animate-pulse"></span>
              BLOCK
            </span>
          )}
          {row.decision === 'IGNORE' && (
            <span className="px-3 py-1 rounded-lg font-mono text-xs font-bold uppercase bg-surface-container text-on-surface-variant border border-outline-variant/60 shadow-xs flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-outline"></span>
              IGNORE
            </span>
          )}

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors cursor-pointer"
            title="Close inspector"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
      </div>

      {/* Internal Navigation Subtabs */}
      <div className="flex items-center gap-2 px-5 pt-3 bg-surface-container-low/30 border-b border-outline-variant/40 overflow-x-auto">
        {[
          { id: 'explanation', label: 'Executive Rationale', icon: 'psychology' },
          { id: 'steps', label: 'Logic Audit Trail', icon: 'account_tree' },
          { id: 'gauges', label: 'Statistical Gauges', icon: 'speed' },
          { id: 'counterfactual', label: 'Counterfactual FAQ', icon: 'help_outline' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-3 py-2 text-xs font-mono font-medium flex items-center gap-1.5 border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === tab.id
                ? 'border-primary text-primary font-bold'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Body */}
      <div className="p-5 flex flex-col gap-5 overflow-y-auto max-h-[calc(100vh-320px)]">
        {/* ===================================================================
            SUBTAB 1: EXECUTIVE RATIONALE
           =================================================================== */}
        {activeTab === 'explanation' && (
          <div className="space-y-4">
            {/* Verdict Hero Banner */}
            <div
              className={`p-4 rounded-xl border flex flex-col gap-2 ${
                row.decision === 'PROMOTE'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-950 dark:text-emerald-100'
                  : row.decision === 'BLOCK'
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-950 dark:text-rose-100'
                  : 'bg-surface-container-low border-outline-variant/50 text-on-surface'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold flex items-center gap-2">
                  <span className="material-symbols-outlined text-[20px]">
                    {row.decision === 'PROMOTE'
                      ? 'verified'
                      : row.decision === 'BLOCK'
                      ? 'warning'
                      : 'hourglass_empty'}
                  </span>
                  {explanation.headline}
                </span>
                <span className="font-mono text-[11px] opacity-80">
                  {row.confidence_tier}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-on-surface/90">
                {explanation.executiveSummary}
              </p>
            </div>

            {/* Google Ads Action Recommendation Box */}
            <div className="bg-surface-container-low p-4 rounded-xl border border-outline-variant/50 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider font-bold flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-primary text-[16px]">ads_click</span>
                  Recommended Google Ads Action
                </span>
                <span
                  className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                    explanation.googleAdsActionType === 'EXACT_MATCH'
                      ? 'bg-emerald-100 text-emerald-800'
                      : explanation.googleAdsActionType === 'NEGATIVE_EXACT'
                      ? 'bg-rose-100 text-rose-800'
                      : 'bg-surface-container text-on-surface-variant'
                  }`}
                >
                  {explanation.googleAdsActionType.replace(/_/g, ' ')}
                </span>
              </div>

              <p className="text-xs text-on-surface leading-relaxed">
                {explanation.actionRecommendation}
              </p>

              {/* Action Snippet & 1-Click Copy */}
              <div className="bg-surface-container-lowest p-2.5 rounded-lg border border-outline-variant/60 flex items-center justify-between gap-2">
                <div className="font-mono text-xs text-primary font-bold truncate">
                  {explanation.googleAdsActionSnippet}
                </div>
                <button
                  onClick={() => handleCopy(explanation.googleAdsActionSnippet, 'actionSnippet')}
                  className="px-2.5 py-1 rounded bg-primary hover:bg-primary-container text-white text-[11px] font-mono font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-2xs"
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {copiedText === 'actionSnippet' ? 'check' : 'content_copy'}
                  </span>
                  {copiedText === 'actionSnippet' ? 'Copied!' : 'Copy Keyword'}
                </button>
              </div>
            </div>

            {/* Quick Metrics Matrix */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/40">
                <span className="font-mono text-[10px] text-on-surface-variant uppercase block">Clicks</span>
                <span className="font-mono text-base font-bold text-on-surface">{fmtInt(row.clicks)}</span>
              </div>
              <div className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/40">
                <span className="font-mono text-[10px] text-on-surface-variant uppercase block">Spend</span>
                <span className="font-mono text-base font-bold text-on-surface">{fmtCurrency(row.cost)}</span>
              </div>
              <div className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/40">
                <span className="font-mono text-[10px] text-on-surface-variant uppercase block">Conversions</span>
                <span className="font-mono text-base font-bold text-on-surface">{fmt(row.conversions, 1)}</span>
              </div>
              <div className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/40">
                <span className="font-mono text-[10px] text-on-surface-variant uppercase block">Observed CVR</span>
                <span
                  className={`font-mono text-base font-bold ${
                    row.observed_cvr > row.shrunk_baseline_cvr
                      ? 'text-tertiary'
                      : row.observed_cvr < row.shrunk_baseline_cvr
                      ? 'text-error'
                      : 'text-on-surface'
                  }`}
                >
                  {fmtPct(row.observed_cvr)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================
            SUBTAB 2: LOGIC AUDIT TRAIL
           =================================================================== */}
        {activeTab === 'steps' && (
          <div className="space-y-3">
            <div className="text-xs text-on-surface-variant font-mono mb-1">
              Step-by-step decision pathway evaluated against statistical criteria:
            </div>
            {explanation.logicSteps.map((step: LogicStep, idx: number) => (
              <div
                key={idx}
                className="bg-surface-container-low p-3.5 rounded-xl border border-outline-variant/40 flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-on-surface flex items-center gap-1.5">
                    <span className="w-5 h-5 rounded-full bg-surface-container flex items-center justify-center text-[10px] text-on-surface-variant">
                      0{idx + 1}
                    </span>
                    {step.name}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
                      step.verdict === 'PASS'
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                        : step.verdict === 'TRIGGERED'
                        ? 'bg-rose-100 text-rose-800 border border-rose-300'
                        : step.verdict === 'FAILED'
                        ? 'bg-amber-100 text-amber-800 border border-amber-300'
                        : 'bg-surface-container text-on-surface-variant border border-outline-variant/60'
                    }`}
                  >
                    {step.verdict}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-primary font-semibold">
                  {step.summary}
                </div>
                <p className="text-[11px] text-on-surface-variant leading-relaxed">
                  {step.detail}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* ===================================================================
            SUBTAB 3: STATISTICAL GAUGES
           =================================================================== */}
        {activeTab === 'gauges' && (
          <div className="space-y-5">
            {/* Gauge 1: Conversion Rate vs Baseline */}
            <div className="bg-surface-container-low p-4 rounded-xl border border-outline-variant/40 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-on-surface flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-secondary text-[16px]">show_chart</span>
                  CVR vs Shrunk Baseline Comparison
                </span>
                <span className="font-mono text-[11px] text-on-surface-variant">
                  α = {alpha} (95% CI)
                </span>
              </div>

              {/* Visual Scale Bar */}
              <div className="relative pt-6 pb-4">
                {/* Baseline Guide Line */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-primary z-10"
                  style={{ left: `${baseCvrPosition}%` }}
                >
                  <span className="absolute -top-5 -translate-x-1/2 font-mono text-[10px] text-primary font-bold whitespace-nowrap bg-surface-container-lowest px-1 rounded border border-primary/30">
                    Baseline: {fmtPct(row.shrunk_baseline_cvr)}
                  </span>
                </div>

                {/* Track */}
                <div className="h-4 bg-surface-container rounded-full overflow-hidden relative">
                  {/* Wilson Confidence Interval Range Highlight */}
                  <div
                    className="absolute top-0 bottom-0 bg-secondary/30 rounded-full"
                    style={{ left: `${ciLeft}%`, width: `${ciWidth}%` }}
                    title={`95% Wilson CI: [${fmtPct(row.wilson_ci_lower)}, ${fmtPct(row.wilson_ci_upper)}]`}
                  ></div>
                </div>

                {/* Observed CVR Marker Pin */}
                <div
                  className="absolute top-4 -translate-y-1/2 -translate-x-1/2 z-20"
                  style={{ left: `${obsCvrPosition}%` }}
                >
                  <div
                    className={`w-4 h-4 rounded-full border-2 border-white shadow-md ${
                      row.observed_cvr > row.shrunk_baseline_cvr
                        ? 'bg-tertiary'
                        : row.observed_cvr < row.shrunk_baseline_cvr
                        ? 'bg-error'
                        : 'bg-primary'
                    }`}
                  ></div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-1 text-center font-mono text-[11px]">
                <div className="bg-surface-container-lowest p-2 rounded border border-outline-variant/30">
                  <span className="text-on-surface-variant block text-[10px]">Observed CVR</span>
                  <span className="font-bold text-on-surface">{fmtPct(row.observed_cvr)}</span>
                </div>
                <div className="bg-surface-container-lowest p-2 rounded border border-outline-variant/30">
                  <span className="text-on-surface-variant block text-[10px]">Baseline CVR</span>
                  <span className="font-bold text-primary">{fmtPct(row.shrunk_baseline_cvr)}</span>
                </div>
                <div className="bg-surface-container-lowest p-2 rounded border border-outline-variant/30">
                  <span className="text-on-surface-variant block text-[10px]">95% Wilson CI</span>
                  <span className="font-bold text-secondary">
                    [{fmtPct(row.wilson_ci_lower)}, {fmtPct(row.wilson_ci_upper)}]
                  </span>
                </div>
              </div>
            </div>

            {/* Gauge 2: Spend vs Effective CPA Risk Floor */}
            <div className="bg-surface-container-low p-4 rounded-xl border border-outline-variant/40 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-on-surface flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-amber-500 text-[16px]">monetization_on</span>
                  Spend vs CPA Risk Gate
                </span>
                <span className="font-mono text-[11px] text-on-surface-variant">
                  CPA Floor: {fmtCurrency(effectiveBlockCostGate)}
                </span>
              </div>

              {/* Progress Bar */}
              <div className="relative pt-4 pb-2">
                <div className="h-3 bg-surface-container rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      spendPctOfGate >= 100
                        ? 'bg-error'
                        : spendPctOfGate >= 60
                        ? 'bg-amber-500'
                        : 'bg-primary'
                    }`}
                    style={{ width: `${Math.min(100, spendPctOfGate)}%` }}
                  ></div>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-on-surface-variant">
                  Spend: <strong className="text-on-surface">{fmtCurrency(row.cost)}</strong>
                </span>
                <span
                  className={`font-bold ${
                    spendPctOfGate >= 100
                      ? 'text-error'
                      : spendPctOfGate >= 60
                      ? 'text-amber-600'
                      : 'text-tertiary'
                  }`}
                >
                  {spendPctOfGate.toFixed(0)}% of CPA Gate Consumed
                </span>
              </div>
            </div>

            {/* Statistical Proof Box */}
            <div className="bg-surface-container-low p-3.5 rounded-xl border border-outline-variant/40 space-y-2 text-xs font-mono">
              <span className="text-[10px] text-on-surface-variant uppercase tracking-wider font-bold block mb-1">
                Exact Discrete Tail CDF & FDR Multiplicity Proof
              </span>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Exact Binomial p (lower):</span>
                <span className="text-on-surface">{row.p_value_lower?.toFixed(4) ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Exact Binomial p (upper):</span>
                <span className="text-on-surface">{row.p_value_upper?.toFixed(4) ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">BH FDR q-value (upper):</span>
                <span className="text-on-surface">{row.q_value_upper?.toFixed(4) ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">BH FDR q-value (lower):</span>
                <span className="text-on-surface">{row.q_value_lower?.toFixed(4) ?? '—'}</span>
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================
            SUBTAB 4: COUNTERFACTUAL FAQ
           =================================================================== */}
        {activeTab === 'counterfactual' && (
          <div className="space-y-4">
            <div className="bg-surface-container-low p-4 rounded-xl border border-outline-variant/40 flex flex-col gap-2">
              <span className="font-mono text-xs font-bold text-primary flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">live_help</span>
                {explanation.counterfactual.question}
              </span>
              <p className="text-xs text-on-surface leading-relaxed">
                {explanation.counterfactual.explanation}
              </p>
            </div>

            {/* Common PPC Questions */}
            <div className="bg-surface-container-low p-4 rounded-xl border border-outline-variant/40 flex flex-col gap-2 text-xs">
              <span className="font-bold text-on-surface block mb-1">
                Forensic Audit Guarantee
              </span>
              <p className="text-on-surface-variant leading-relaxed">
                QueryPilot’s triage decisions are deterministic and reproducible. Unlike opaque black-box AI algorithms,
                every PROMOTE, BLOCK, or IGNORE decision is bound strictly to verifiable discrete binomial distributions,
                Wilson confidence bounds, and Benjamini-Hochberg multiplicity constraints.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Footer Quick Copy Bar */}
      <div className="p-4 bg-surface-container-low/70 border-t border-outline-variant/50 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={() => handleCopy(row.search_term, 'queryOnly')}
          className="text-xs font-mono text-on-surface-variant hover:text-on-surface flex items-center gap-1 cursor-pointer"
        >
          <span className="material-symbols-outlined text-[14px]">
            {copiedText === 'queryOnly' ? 'check' : 'content_copy'}
          </span>
          {copiedText === 'queryOnly' ? 'Copied Query' : 'Copy Query Text'}
        </button>

        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-mono text-xs font-semibold border border-outline-variant/60 transition-colors cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  );
};
