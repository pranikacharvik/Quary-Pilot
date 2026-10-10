import type { TriageRowResult } from './triageEngine';

export interface LogicStep {
  name: string;
  verdict: 'PASS' | 'TRIGGERED' | 'FAILED' | 'SKIPPED' | 'PENDING';
  summary: string;
  detail: string;
  badgeColor: 'emerald' | 'rose' | 'amber' | 'slate';
}

export interface DecisionExplanation {
  headline: string;
  executiveSummary: string;
  shortSummary: string; // 1-sentence for compact tables
  confidenceTier: string;
  actionRecommendation: string;
  googleAdsActionSnippet: string;
  googleAdsActionType: 'EXACT_MATCH' | 'NEGATIVE_EXACT' | 'CONTINUE_OBSERVING' | 'MANUAL_AUDIT';
  logicSteps: LogicStep[];
  counterfactual: {
    question: string;
    explanation: string;
  };
  metrics: {
    observedCvr: number;
    shrunkBaselineCvr: number;
    wilsonCiLower: number;
    wilsonCiUpper: number;
    spend: number;
    cpaGate: number;
    clicks: number;
    conversions: number;
    pValue: number;
    qValue: number;
  };
}

/**
 * Generate a comprehensive, plain-English forensic explanation for a triage decision.
 */
export function explainDecision(
  row: TriageRowResult,
  effectiveBlockCostGate: number = 25.0,
  alpha: number = 0.05,
  minTestClicks: number = 10,
  minPromoteConv: number = 2.0
): DecisionExplanation {
  const obsCvrPct = (row.observed_cvr * 100).toFixed(1);
  const baselineCvrPct = (row.shrunk_baseline_cvr * 100).toFixed(1);
  const wilsonLowPct = (row.wilson_ci_lower * 100).toFixed(1);
  const wilsonHighPct = (row.wilson_ci_upper * 100).toFixed(1);
  const pValUp = row.p_value_upper ?? 1.0;
  const qValUp = row.q_value_upper ?? 1.0;
  const pValLow = row.p_value_lower ?? 1.0;
  const qValLow = row.q_value_lower ?? 1.0;

  // 1. PROMOTE DECISION
  if (row.decision === 'PROMOTE') {
    const isSuperStar = row.observed_cvr >= row.shrunk_baseline_cvr * 2;
    const headline = isSuperStar
      ? '🚀 High-Impact Scalable Winner'
      : '✅ Statistically Proven Outperformer';

    const executiveSummary =
      `Query "${row.search_term}" is delivering exceptional commercial returns. With ${row.conversions} conversions ` +
      `across ${row.clicks} clicks (${obsCvrPct}% CVR vs ${baselineCvrPct}% baseline), rigorous statistical testing ` +
      `confirms with ${(100 - alpha * 100).toFixed(0)}%+ confidence that this conversion rate is genuine intent, ` +
      `not random luck. False Discovery Rate (FDR) multiplicity control verifies no spurious anomaly.`;

    const shortSummary = `CVR ${obsCvrPct}% vs ${baselineCvrPct}% Base • ${row.conversions} Conv • 95%+ Confirmed Outperformer`;

    const actionRecommendation =
      `Isolate into an Exact Match keyword group with dedicated budget and top-of-page target bidding. ` +
      `Optionally add as a negative in the broad discovery campaign to eliminate cannibalization.`;

    const googleAdsActionSnippet = `[${row.search_term}]`;

    const logicSteps: LogicStep[] = [
      {
        name: 'Step 1: Click Volume Gate',
        verdict: 'PASS',
        summary: `${row.clicks} clicks collected (Threshold: ≥ ${minTestClicks})`,
        detail: `Sufficient sample volume to evaluate binomial distribution without small-sample distortion.`,
        badgeColor: 'emerald',
      },
      {
        name: 'Step 2: 2-Click Anti-Trap Defense',
        verdict: 'PASS',
        summary: `${row.conversions} conversions recorded (Guardrail: ≥ ${minPromoteConv})`,
        detail: `Satisfies anti-trap guardrail. Single-click flukes are never promoted.`,
        badgeColor: 'emerald',
      },
      {
        name: 'Step 3: Discrete Binomial Tail Test',
        verdict: 'PASS',
        summary: `Exact binomial upper p = ${pValUp.toFixed(4)} (Threshold: ≤ ${alpha})`,
        detail: `Probability of achieving ${row.conversions}+ conversions under the account baseline is ${(pValUp * 100).toFixed(2)}% (statistically significant).`,
        badgeColor: 'emerald',
      },
      {
        name: 'Step 4: Benjamini-Hochberg FDR Control',
        verdict: 'PASS',
        summary: `FDR adjusted q-value = ${qValUp.toFixed(4)} (Threshold: ≤ ${alpha})`,
        detail: `Controls the False Discovery Rate across all searched queries. Confirms this keyword is not a false positive.`,
        badgeColor: 'emerald',
      },
    ];

    return {
      headline,
      executiveSummary,
      shortSummary,
      confidenceTier: row.confidence_tier,
      actionRecommendation,
      googleAdsActionSnippet,
      googleAdsActionType: 'EXACT_MATCH',
      logicSteps,
      counterfactual: {
        question: 'Why not IGNORE or keep in Broad Match?',
        explanation:
          `Broad match leaves bid management and query routing to automated algorithms that spread budget thinly. ` +
          `Promoting to Exact Match guarantees impression share capture and prevents cheaper, less targeted ad variants from stealing traffic.`,
      },
      metrics: {
        observedCvr: row.observed_cvr,
        shrunkBaselineCvr: row.shrunk_baseline_cvr,
        wilsonCiLower: row.wilson_ci_lower,
        wilsonCiUpper: row.wilson_ci_upper,
        spend: row.cost,
        cpaGate: effectiveBlockCostGate,
        clicks: row.clicks,
        conversions: row.conversions,
        pValue: pValUp,
        qValue: qValUp,
      },
    };
  }

  // 2. BLOCK DECISION
  if (row.decision === 'BLOCK') {
    const headline = '🚫 Confirmed Budget Drain / Negative Keyword';

    const executiveSummary =
      `Query "${row.search_term}" is leaking ad spend without generating results. It has accumulated $${row.cost.toFixed(2)} ` +
      `in cost across ${row.clicks} clicks with ${row.conversions} conversions. Total expenditure has exceeded the ` +
      `effective CPA gate of $${effectiveBlockCostGate.toFixed(2)}, and exact binomial testing confirms ` +
      `systematic underperformance rather than random statistical fluctuation.`;

    const shortSummary = `Spent $${row.cost.toFixed(2)} (Exceeds $${effectiveBlockCostGate.toFixed(2)} CPA Gate) • 0 Conv • Budget Drain`;

    const actionRecommendation =
      `Add as a Negative Keyword at the campaign or ad group level immediately to stop ongoing budget waste ` +
      `and preserve capital for high-converting queries.`;

    const googleAdsActionSnippet = `-[${row.search_term}]`;

    const logicSteps: LogicStep[] = [
      {
        name: 'Step 1: Cost Risk Gate',
        verdict: 'TRIGGERED',
        summary: `Spend $${row.cost.toFixed(2)} exceeds CPA floor $${effectiveBlockCostGate.toFixed(2)}`,
        detail: `Economic loss threshold breached: query has consumed more than a full acquisition target without return.`,
        badgeColor: 'rose',
      },
      {
        name: 'Step 2: Zero / Deficient Conversions',
        verdict: 'TRIGGERED',
        summary: `${row.conversions} conversions recorded across ${row.clicks} clicks`,
        detail: `Observed CVR is 0.00% compared to account baseline of ${baselineCvrPct}%.`,
        badgeColor: 'rose',
      },
      {
        name: 'Step 3: Binomial Underperformance Test',
        verdict: 'PASS',
        summary: `Exact binomial lower p = ${pValLow.toFixed(4)} (Threshold: ≤ ${alpha})`,
        detail: `The probability of observing 0 conversions across ${row.clicks} clicks by chance under baseline is under ${(pValLow * 100).toFixed(2)}%.`,
        badgeColor: 'rose',
      },
      {
        name: 'Step 4: Benjamini-Hochberg FDR Control',
        verdict: 'PASS',
        summary: `FDR adjusted q-value = ${qValLow.toFixed(4)} (Threshold: ≤ ${alpha})`,
        detail: `Multiplicity correction proves this is a statistically validated bleeder, not a false discovery.`,
        badgeColor: 'rose',
      },
    ];

    return {
      headline,
      executiveSummary,
      shortSummary,
      confidenceTier: row.confidence_tier,
      actionRecommendation,
      googleAdsActionSnippet,
      googleAdsActionType: 'NEGATIVE_EXACT',
      logicSteps,
      counterfactual: {
        question: 'Why not wait longer (IGNORE)?',
        explanation:
          `The term has already cost more than the average CPA target ($${effectiveBlockCostGate.toFixed(2)}) without converting. ` +
          `Statistically, the chance of this term achieving the target return is under 5%. Continuing to run it would be pure unhedged budget waste.`,
      },
      metrics: {
        observedCvr: row.observed_cvr,
        shrunkBaselineCvr: row.shrunk_baseline_cvr,
        wilsonCiLower: row.wilson_ci_lower,
        wilsonCiUpper: row.wilson_ci_upper,
        spend: row.cost,
        cpaGate: effectiveBlockCostGate,
        clicks: row.clicks,
        conversions: row.conversions,
        pValue: pValLow,
        qValue: qValLow,
      },
    };
  }

  // 3. IGNORE DECISION (Sub-Archetypes)
  const isZeroClicks = row.clicks === 0;
  const isUnderMinClicks = row.clicks > 0 && row.clicks < minTestClicks;
  const isSingleConvTrap = row.conversions === 1 && (row.clicks < minTestClicks || row.conversions < minPromoteConv);
  const isCostBelowGate = row.conversions === 0 && row.cost < effectiveBlockCostGate;
  const isFdrFiltered = (pValUp <= alpha && qValUp > alpha) || (pValLow <= alpha && qValLow > alpha);

  let headline = '⏸️ Gathering Sample Volume (Maintain & Observe)';
  let executiveSummary = '';
  let shortSummary = '';
  let actionRecommendation = 'Maintain current ad group presence. Do not block or promote until statistical certainty is reached.';
  let counterQuestion = 'Why was this query neither Promoted nor Blocked?';
  let counterExplanation = '';

  const logicSteps: LogicStep[] = [];

  if (row.review_flag || row.quality_flags) {
    headline = '⚠️ Data Quality Anomaly (Manual Audit Flagged)';
    executiveSummary =
      `Query "${row.search_term}" was flagged during ingestion: "${row.quality_flags || 'Unusual telemetry pattern'}". ` +
      `Automated mathematical decisions are withheld to prevent corrupted decisions based on erroneous conversion or tracking data.`;
    shortSummary = `Telemetry Anomaly [${row.quality_flags}] • Manual Review Required`;
    actionRecommendation = 'Check conversion tracking tag fires and URL attribution in Google Ads before taking bidding actions.';
    counterQuestion = 'Why wasn’t an automated decision made?';
    counterExplanation = 'When raw data exhibits anomalies (zero clicks with spend, conversions exceeding clicks, negative values), safety guardrails prevent automated bidding errors.';

    logicSteps.push({
      name: 'Integrity Check: Data Quality Filter',
      verdict: 'FAILED',
      summary: `Anomaly flagged: ${row.quality_flags || 'Inconsistent tracking data'}`,
      detail: `Telemetry must be cleanly validated before statistical inference is applied.`,
      badgeColor: 'amber',
    });
  } else if (isZeroClicks) {
    headline = '💤 Zero-Click Impression (No Action Needed)';
    executiveSummary =
      `Query "${row.search_term}" has received impressions but zero clicks ($${row.cost.toFixed(2)} cost). ` +
      `Without click interactions, conversion rates cannot be calculated.`;
    shortSummary = `0 Clicks • No Click Telemetry • Hold Observation`;
    counterQuestion = 'Why not block zero-click queries?';
    counterExplanation = 'Impressions without clicks do not consume budget (on CPC bidding). Blocking them would prematurely clutter negative keyword lists.';

    logicSteps.push({
      name: 'Volume Gate: Click Sufficiency',
      verdict: 'SKIPPED',
      summary: `0 clicks recorded (Minimum: ${minTestClicks} clicks)`,
      detail: `Cannot compute conversion rate without denominator.`,
      badgeColor: 'slate',
    });
  } else if (isSingleConvTrap) {
    headline = '🛡️ Single-Conversion Anti-Trap Guardrail';
    executiveSummary =
      `Query "${row.search_term}" generated 1 conversion across ${row.clicks} clicks (apparent CVR of ${obsCvrPct}%). ` +
      `However, our strict 2-click guardrail blocks promotion on single conversions to protect your budget against lucky, non-replicable one-off sales.`;
    shortSummary = `1 Conv / ${row.clicks} Clicks • 2-Click Anti-Trap Guardrail Protected • Hold for 2nd Conv`;
    actionRecommendation = 'Leave running in broad exploration. If it achieves a 2nd conversion and maintains CVR, it will be automatically promoted.';
    counterQuestion = 'Why not promote a term with 1 conversion?';
    counterExplanation = 'Single-conversion terms represent high variance: a random impulse purchase or accidentally clicked ad can show a 50% or 100% CVR that crashes to zero upon scaling. Requiring ≥2 conversions ensures intent reproducibility.';

    logicSteps.push({
      name: 'Volume Gate: Click Sufficiency',
      verdict: isUnderMinClicks ? 'PENDING' : 'PASS',
      summary: `${row.clicks} clicks (Minimum: ${minTestClicks})`,
      detail: isUnderMinClicks ? `Click sample still building.` : `Click volume sufficient.`,
      badgeColor: isUnderMinClicks ? 'amber' : 'emerald',
    });
    logicSteps.push({
      name: 'Guardrail: 2-Click Anti-Trap Defense',
      verdict: 'FAILED',
      summary: `1 conversion recorded (Mandatory Floor: ≥ ${minPromoteConv})`,
      detail: `Protected against single-conversion false positives. Requires repeat conversion.`,
      badgeColor: 'amber',
    });
  } else if (isCostBelowGate) {
    headline = '⏳ Under Budget CPA Gate (Harvesting Traffic)';
    executiveSummary =
      `Query "${row.search_term}" has 0 conversions across ${row.clicks} clicks, but total spend is only $${row.cost.toFixed(2)}. ` +
      `Because this cost is well below the account CPA risk floor ($${effectiveBlockCostGate.toFixed(2)}), blocking now would be premature knee-jerk penalization.`;
    shortSummary = `Spend $${row.cost.toFixed(2)} < $${effectiveBlockCostGate.toFixed(2)} CPA Gate • 0 Conv • Continue Observation`;
    counterQuestion = 'Why not block a term with 0 conversions?';
    counterExplanation = `Every conversion funnel requires sufficient spend to discover buyers. Blocking before reaching the target CPA floor ($${effectiveBlockCostGate.toFixed(2)}) cuts off viable terms before giving them a statistically fair chance to convert.`;

    logicSteps.push({
      name: 'Financial Gate: CPA Spend Floor',
      verdict: 'PENDING',
      summary: `Spend $${row.cost.toFixed(2)} < CPA Gate $${effectiveBlockCostGate.toFixed(2)}`,
      detail: `Safe spend margin remains: query has not consumed enough budget to justify a permanent negative block.`,
      badgeColor: 'slate',
    });
    logicSteps.push({
      name: 'Statistical Underperformance Test',
      verdict: 'SKIPPED',
      summary: `Negative block deferred until spend breaches risk threshold`,
      detail: `Protects exploration efficiency.`,
      badgeColor: 'slate',
    });
  } else if (isFdrFiltered) {
    headline = '🔬 Multiplicity Screened (FDR False Positive Filter)';
    executiveSummary =
      `Query "${row.search_term}" passed an unadjusted p-value check, but failed Benjamini-Hochberg False Discovery Rate ` +
      `(FDR) control at α = ${alpha}. When testing hundreds of terms simultaneously, this correction prevents spurious false alarms.`;
    shortSummary = `Unadjusted p ≤ α, but FDR q > α • Screened Against False Discovery`;
    counterQuestion = 'What is FDR Multiplicity Screening?';
    counterExplanation = `If you evaluate 100 search queries at a 95% confidence level, on average 5 will appear significant purely by random luck. The Benjamini-Hochberg procedure dynamically adjusts thresholds so you never waste money on false alarms.`;

    logicSteps.push({
      name: 'Unadjusted Significance Test',
      verdict: 'TRIGGERED',
      summary: `Unadjusted p-value ≤ ${alpha}`,
      detail: `Passed standard two-tailed test.`,
      badgeColor: 'slate',
    });
    logicSteps.push({
      name: 'Benjamini-Hochberg Multiplicity Screen',
      verdict: 'FAILED',
      summary: `Adjusted q-value > ${alpha} (Screened Out)`,
      detail: `Safeguards your budget from false discovery when multiple hypotheses are tested in parallel.`,
      badgeColor: 'amber',
    });
  } else {
    headline = '⚖️ Expected Baseline Performance (Neutral)';
    executiveSummary =
      `Query "${row.search_term}" is tracking within the expected natural variance of your account. ` +
      `With ${row.clicks} clicks and ${row.conversions} conversions (${obsCvrPct}% CVR vs ${baselineCvrPct}% baseline), ` +
      `it is neither statistically superior nor an economic bleeder.`;
    shortSummary = `CVR ${obsCvrPct}% vs ${baselineCvrPct}% Base • Consistent with Expected Variance`;
    counterQuestion = 'Why no promotion or block?';
    counterExplanation = `Healthy PPC accounts have a broad middle band of keywords that perform at baseline. They generate steady traffic without requiring custom bids or negative restrictions.`;

    logicSteps.push({
      name: 'Volume Gate: Click Sufficiency',
      verdict: 'PASS',
      summary: `${row.clicks} clicks (Threshold: ≥ ${minTestClicks})`,
      detail: `Sufficient sample volume evaluated.`,
      badgeColor: 'emerald',
    });
    logicSteps.push({
      name: 'Hypothesis Deviations',
      verdict: 'PENDING',
      summary: `Within 95% Wilson confidence band [${wilsonLowPct}%, ${wilsonHighPct}%]`,
      detail: `Baseline CVR (${baselineCvrPct}%) falls comfortably within observed confidence intervals.`,
      badgeColor: 'slate',
    });
  }

  return {
    headline,
    executiveSummary,
    shortSummary,
    confidenceTier: row.confidence_tier,
    actionRecommendation,
    googleAdsActionSnippet: row.search_term,
    googleAdsActionType: 'CONTINUE_OBSERVING',
    logicSteps,
    counterfactual: {
      question: counterQuestion,
      explanation: counterExplanation,
    },
    metrics: {
      observedCvr: row.observed_cvr,
      shrunkBaselineCvr: row.shrunk_baseline_cvr,
      wilsonCiLower: row.wilson_ci_lower,
      wilsonCiUpper: row.wilson_ci_upper,
      spend: row.cost,
      cpaGate: effectiveBlockCostGate,
      clicks: row.clicks,
      conversions: row.conversions,
      pValue: row.observed_cvr >= row.shrunk_baseline_cvr ? pValUp : pValLow,
      qValue: row.observed_cvr >= row.shrunk_baseline_cvr ? qValUp : qValLow,
    },
  };
}

/**
 * Format a clean, ready-to-paste Google Ads negative keyword list from triage results.
 */
export function generateNegativeKeywordsList(results: TriageRowResult[]): string {
  const blocks = results.filter(r => r.decision === 'BLOCK');
  return blocks.map(r => `-[${r.search_term}]`).join('\n');
}

/**
 * Format a clean, ready-to-paste Google Ads exact match expansion list.
 */
export function generatePromotedKeywordsList(results: TriageRowResult[]): string {
  const promotes = results.filter(r => r.decision === 'PROMOTE');
  return promotes.map(r => `[${r.search_term}]`).join('\n');
}
