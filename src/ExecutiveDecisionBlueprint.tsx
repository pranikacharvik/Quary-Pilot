import React, { useState } from 'react';
import type { TriageRowResult, TriageSummary } from './triageEngine';
import {
  explainDecision,
  generateNegativeKeywordsList,
  generatePromotedKeywordsList,
} from './decisionExplainer';

interface ExecutiveDecisionBlueprintProps {
  results: TriageRowResult[];
  summary: TriageSummary;
  effectiveBlockCostGate: number;
  alpha: number;
  onInspectRow: (row: TriageRowResult) => void;
}

const fmtCurrency = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtPct = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
};

export const ExecutiveDecisionBlueprint: React.FC<ExecutiveDecisionBlueprintProps> = ({
  results,
  summary,
  effectiveBlockCostGate,
  alpha,
  onInspectRow,
}) => {
  const [copiedBatch, setCopiedBatch] = useState<string | null>(null);

  // Top 3 Promoted Terms by Conversions
  const topPromoted = [...results]
    .filter(r => r.decision === 'PROMOTE')
    .sort((a, b) => b.conversions - a.conversions)
    .slice(0, 3);

  // Top 3 Blocked Terms by Wasted Spend
  const topBlocked = [...results]
    .filter(r => r.decision === 'BLOCK')
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 3);

  const handleCopyBatch = (type: 'promote' | 'block') => {
    if (type === 'promote') {
      const text = generatePromotedKeywordsList(results);
      navigator.clipboard.writeText(text);
      setCopiedBatch('promote');
    } else {
      const text = generateNegativeKeywordsList(results);
      navigator.clipboard.writeText(text);
      setCopiedBatch('block');
    }
    setTimeout(() => setCopiedBatch(null), 2500);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 3-Column Decision Engine Methodology Guide */}
      <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant shadow-xs flex flex-col gap-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[20px]">psychology</span>
              How QueryPilot Decides: 3-Way Triage Rules
            </h3>
            <p className="text-xs text-on-surface-variant font-mono mt-0.5">
              Deterministic statistical criteria applied automatically to every search query
            </p>
          </div>
          <span className="font-mono text-[11px] text-on-surface-variant bg-surface-container px-2.5 py-1 rounded border border-outline-variant/40 self-start md:self-auto">
            α = {alpha} (95% Significance) • k = 100 Prior
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Card 1: PROMOTE */}
          <div className="bg-emerald-500/5 border border-emerald-500/30 rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-bold text-tertiary flex items-center gap-1.5 uppercase">
                  <span className="w-2 h-2 rounded-full bg-tertiary"></span>
                  01. PROMOTE Rule
                </span>
                <span className="px-2 py-0.5 rounded font-mono text-[10px] font-bold bg-[#e6f7ef] text-tertiary">
                  {summary.promoteCount} Identified
                </span>
              </div>
              <h4 className="text-xs font-bold text-on-surface mb-2">
                Statistically Superior Outperformer
              </h4>
              <ul className="text-[11px] text-on-surface-variant space-y-1.5 font-mono mb-3">
                <li className="flex items-start gap-1">
                  <span className="text-tertiary font-bold">✓</span>
                  <span><strong>Clicks ≥ 10</strong> & <strong>Conversions ≥ 2</strong></span>
                </li>
                <li className="flex items-start gap-1">
                  <span className="text-tertiary font-bold">✓</span>
                  <span>Observed CVR &gt; Shrunk Baseline</span>
                </li>
                <li className="flex items-start gap-1">
                  <span className="text-tertiary font-bold">✓</span>
                  <span>Binomial p<sub>up</sub> ≤ {alpha} & FDR q<sub>up</sub> ≤ {alpha}</span>
                </li>
              </ul>
            </div>
            <div className="pt-2 border-t border-emerald-500/20 text-[11px] font-mono text-tertiary font-semibold flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
              Action: Add as Exact Match Keyword
            </div>
          </div>

          {/* Card 2: BLOCK */}
          <div className="bg-rose-500/5 border border-rose-500/30 rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-bold text-error flex items-center gap-1.5 uppercase">
                  <span className="w-2 h-2 rounded-full bg-error"></span>
                  02. BLOCK Rule
                </span>
                <span className="px-2 py-0.5 rounded font-mono text-[10px] font-bold bg-error-container text-error">
                  {summary.blockCount} Identified
                </span>
              </div>
              <h4 className="text-xs font-bold text-on-surface mb-2">
                High-Cost Zero-Conversion Bleeder
              </h4>
              <ul className="text-[11px] text-on-surface-variant space-y-1.5 font-mono mb-3">
                <li className="flex items-start gap-1">
                  <span className="text-error font-bold">✓</span>
                  <span><strong>Cost ≥ CPA Gate</strong> (${effectiveBlockCostGate.toFixed(2)})</span>
                </li>
                <li className="flex items-start gap-1">
                  <span className="text-error font-bold">✓</span>
                  <span><strong>0 Conversions</strong> recorded</span>
                </li>
                <li className="flex items-start gap-1">
                  <span className="text-error font-bold">✓</span>
                  <span>Binomial p<sub>low</sub> ≤ {alpha} (Not random noise)</span>
                </li>
              </ul>
            </div>
            <div className="pt-2 border-t border-rose-500/20 text-[11px] font-mono text-error font-semibold flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
              Action: Add as Negative Keyword
            </div>
          </div>

          {/* Card 3: IGNORE / HARVEST */}
          <div className="bg-surface-container-low border border-outline-variant/40 rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-bold text-on-surface-variant flex items-center gap-1.5 uppercase">
                  <span className="w-2 h-2 rounded-full bg-outline"></span>
                  03. IGNORE / HARVEST Rule
                </span>
                <span className="px-2 py-0.5 rounded font-mono text-[10px] font-bold bg-surface-container text-on-surface-variant">
                  {summary.ignoreCount} Identified
                </span>
              </div>
              <h4 className="text-xs font-bold text-on-surface mb-2">
                Insufficient Sample / Baseline Variance
              </h4>
              <ul className="text-[11px] text-on-surface-variant space-y-1.5 font-mono mb-3">
                <li className="flex items-start gap-1">
                  <span className="text-outline font-bold">•</span>
                  <span>Cost &lt; CPA Gate (Safe spend margin)</span>
                </li>
                <li className="flex items-start gap-1">
                  <span className="text-outline font-bold">•</span>
                  <span>1-Conversion fluke trap protection</span>
                </li>
                <li className="flex items-start gap-1">
                  <span className="text-outline font-bold">•</span>
                  <span>Normal variance within 95% Wilson CI</span>
                </li>
              </ul>
            </div>
            <div className="pt-2 border-t border-outline-variant/30 text-[11px] font-mono text-on-surface-variant font-semibold flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
              Action: Maintain in Broad Discovery
            </div>
          </div>
        </div>
      </div>

      {/* High-Impact Decision Highlights */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Promoted Opportunities */}
        <div className="bg-surface-container-lowest rounded-xl p-5 border border-outline-variant shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-bold text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-tertiary text-[18px]">trending_up</span>
                Top Expansion Candidates (Exact Match)
              </span>
              <button
                onClick={() => handleCopyBatch('promote')}
                className="text-xs font-mono text-tertiary hover:underline flex items-center gap-1 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">
                  {copiedBatch === 'promote' ? 'check' : 'content_copy'}
                </span>
                {copiedBatch === 'promote' ? 'Copied All!' : 'Copy All Exact'}
              </button>
            </div>

            <div className="space-y-2.5">
              {topPromoted.map(term => (
                <div
                  key={term.row_id}
                  className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/30 flex items-center justify-between gap-3 hover:border-tertiary/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-bold text-on-surface truncate" title={term.search_term}>
                      "{term.search_term}"
                    </div>
                    <div className="font-mono text-[11px] text-on-surface-variant mt-0.5">
                      {term.conversions} conv • CVR {fmtPct(term.observed_cvr)} • CPA {fmtCurrency(term.observed_cpa)}
                    </div>
                  </div>
                  <button
                    onClick={() => onInspectRow(term)}
                    className="px-2.5 py-1 rounded bg-[#e6f7ef] hover:bg-emerald-100 text-tertiary font-mono text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer shrink-0"
                  >
                    <span className="material-symbols-outlined text-[14px]">psychology</span>
                    Explain
                  </button>
                </div>
              ))}
              {topPromoted.length === 0 && (
                <div className="p-4 text-center text-xs text-on-surface-variant font-mono">
                  No terms met the strict statistical criteria for promotion.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Top Blocked Bleeders */}
        <div className="bg-surface-container-lowest rounded-xl p-5 border border-outline-variant shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-bold text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-error text-[18px]">block</span>
                Top Budget Bleeders (Negative List)
              </span>
              <button
                onClick={() => handleCopyBatch('block')}
                className="text-xs font-mono text-error hover:underline flex items-center gap-1 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">
                  {copiedBatch === 'block' ? 'check' : 'content_copy'}
                </span>
                {copiedBatch === 'block' ? 'Copied All!' : 'Copy All Negatives'}
              </button>
            </div>

            <div className="space-y-2.5">
              {topBlocked.map(term => (
                <div
                  key={term.row_id}
                  className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/30 flex items-center justify-between gap-3 hover:border-error/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-bold text-on-surface truncate" title={term.search_term}>
                      "{term.search_term}"
                    </div>
                    <div className="font-mono text-[11px] text-error font-bold mt-0.5">
                      Wasted Spend: {fmtCurrency(term.cost)} ({term.clicks} clicks, 0 conv)
                    </div>
                  </div>
                  <button
                    onClick={() => onInspectRow(term)}
                    className="px-2.5 py-1 rounded bg-error-container hover:bg-rose-100 text-error font-mono text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer shrink-0"
                  >
                    <span className="material-symbols-outlined text-[14px]">psychology</span>
                    Explain
                  </button>
                </div>
              ))}
              {topBlocked.length === 0 && (
                <div className="p-4 text-center text-xs text-on-surface-variant font-mono">
                  No terms breached the CPA risk gate.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
