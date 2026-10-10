/**
 * Deterministic statistical search term triage engine (TypeScript mirror of triage/*.py).
 * Implements:
 * - Inverse standard normal CDF (Acklam's rational approximation, accurate to <1.15e-9)
 * - Wilson score confidence interval
 * - Exact binomial lower and upper tail probabilities via regularized incomplete beta / log-gamma
 * - Benjamini-Hochberg step-up FDR adjustment
 * - Leave-one-out Empirical Bayes campaign-to-account baseline shrinkage
 * - Flexible CSV parser, column mapper, data quality inspector, and deterministic row-by-row triage
 */

export interface TriageConfig {
  alpha: number;
  shrinkageK: number;
  minTestClicks: number;
  minPromoteConversions: number;
  blockCostCpaMultiplier: number;
  fallbackBlockCostFloor: number;
  strictFdrGate: boolean;
}

export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  alpha: 0.05,
  shrinkageK: 100.0,
  minTestClicks: 10,
  minPromoteConversions: 2.0,
  blockCostCpaMultiplier: 1.0,
  fallbackBlockCostFloor: 25.0,
  strictFdrGate: false,
};

export interface ColumnMapping {
  search_term: string;
  clicks: string;
  cost: string;
  conversions: string;
  campaign?: string;
  ad_group?: string;
  match_type?: string;
  impressions?: string;
  conversion_value?: string;
}

export interface ColumnProfile {
  name: string;
  dtype: string;
  nullCount: number;
  nullPct: number;
  nonNullCount: number;
  sampleValues: string[];
}

export interface DataQualityReport {
  totalRows: number;
  totalColumns: number;
  columnProfiles: ColumnProfile[];
  uniqueSearchTerms: number;
  duplicateQueryRowCount: number;
  duplicateCampaignQueryRowCount: number;
  missingRequiredRowCount: number;
  zeroClickRowCount: number;
  negativeMetricRowCount: number;
  conversionsExceedClicksRowCount: number;
  fractionalConversionRowCount: number;
  costWithoutClicksRowCount: number;
  sampleRows: Record<string, string>[];
}

export type DecisionLabel = 'PROMOTE' | 'BLOCK' | 'IGNORE';

export interface TriageRowResult {
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
  decision: DecisionLabel;
  confidence_tier: string;
  review_flag: boolean;
  quality_flags: string;
  reason: string;
}

export interface TriageSummary {
  totalRows: number;
  promoteCount: number;
  blockCount: number;
  ignoreCount: number;
  reviewFlaggedCount: number;
  accountValidClicks: number;
  accountValidConversions: number;
  accountValidCost: number;
  accountBaselineCvr: number;
  accountCpa: number | null;
  effectiveBlockCostGate: number;
}

/**
 * Inverse standard normal CDF (Acklam's algorithm, relative error < 1.15e-9).
 */
export function normPpf(p: number): number {
  if (p <= 0 || p >= 1 || Number.isNaN(p)) {
    throw new Error(`Probability p must be in (0, 1), got ${p}`);
  }
  const a1 = -3.969683028665376e1;
  const a2 = 2.209460984245205e2;
  const a3 = -2.759285104469687e2;
  const a4 = 1.38357751867269e2;
  const a5 = -3.066479806614716e1;
  const a6 = 2.506628277459239;

  const b1 = -5.447609879822406e1;
  const b2 = 1.615858368580409e2;
  const b3 = -1.556989798598866e2;
  const b4 = 6.680131188771972e1;
  const b5 = -1.328068155288572e1;

  const c1 = -7.784894002430293e-3;
  const c2 = -3.223964580411365e-1;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;

  const d1 = 7.784695709041462e-3;
  const d2 = 3.224671290700398e-1;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
  );
}

/**
 * Lanczos approximation for ln(Gamma(z)).
 */
function logGamma(z: number): number {
  const g = 7;
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  let zMinus1 = z - 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) {
    x += p[i] / (zMinus1 + i);
  }
  const t = zMinus1 + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (zMinus1 + 0.5) * Math.log(t) -
    t +
    Math.log(x)
  );
}

/**
 * Continued fraction evaluation for regularized incomplete beta function I_x(a, b).
 */
function betacf(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const eps = 3e-14;
  const fpmin = 1e-30;

  const qab = a + b;
  const qap = a + 1.0;
  const qam = a - 1.0;
  let c = 1.0;
  let d = 1.0 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1.0 / d;
  let h = d;

  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1.0 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1.0 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1.0 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1.0 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1.0) < eps) break;
  }
  return h;
}

/**
 * Regularized incomplete beta function I_x(a, b), equivalent to scipy.special.betainc.
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0.0) return 0.0;
  if (x >= 1.0) return 1.0;
  const bt = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1.0 - x)
  );
  if (x < (a + 1.0) / (a + b + 2.0)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1.0 - (bt * betacf(b, a, 1.0 - x)) / b;
}

/**
 * Exact Wilson score (1 - alpha) confidence interval for a binomial proportion.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  alpha = 0.05
): [number, number] {
  if (
    trials === null ||
    successes === null ||
    Number.isNaN(trials) ||
    Number.isNaN(successes) ||
    trials <= 0 ||
    successes < 0
  ) {
    return [0.0, 0.0];
  }
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error(`alpha must be in (0, 1), got ${alpha}`);
  }
  const n = trials;
  const k = successes;
  const pHat = Math.min(1.0, Math.max(0.0, k / n));

  const z = normPpf(1.0 - alpha / 2.0);
  const z2 = z * z;
  const denom = 1.0 + z2 / n;
  const center = (pHat + z2 / (2.0 * n)) / denom;
  const radicand = Math.max(0.0, (pHat * (1.0 - pHat)) / n + z2 / (4.0 * n * n));
  const halfWidth = (z * Math.sqrt(radicand)) / denom;

  let lower = pHat <= 0.0 ? 0.0 : Math.max(0.0, Math.min(1.0, center - halfWidth));
  let upper = pHat >= 1.0 ? 1.0 : Math.max(0.0, Math.min(1.0, center + halfWidth));
  if (lower < 1e-14) lower = 0.0;
  if (upper > 1.0 - 1e-14) upper = 1.0;
  return [lower, upper];
}

/**
 * Exact one-sided binomial tail probabilities matching scipy.stats.binom.cdf and .sf:
 * For X ~ Binomial(n, p):
 * - P(X <= k) = I_{1 - p}(n - k, k + 1)
 * - P(X >= k) = I_{p}(k, n - k + 1)
 */
export function exactBinomialTails(
  successes: number,
  trials: number,
  p0: number
): [number, number] {
  if (
    trials === null ||
    successes === null ||
    p0 === null ||
    Number.isNaN(trials) ||
    Number.isNaN(successes) ||
    Number.isNaN(p0) ||
    trials <= 0 ||
    successes < 0
  ) {
    return [1.0, 1.0];
  }
  const nInt = Math.floor(trials);
  if (nInt <= 0) return [1.0, 1.0];

  const pNull = Math.min(1.0, Math.max(0.0, p0));
  const kClamped = Math.min(nInt, Math.max(0.0, successes));

  const kLower = Math.min(nInt, Math.ceil(kClamped - 1e-12));
  const kUpper = Math.max(0, Math.floor(kClamped + 1e-12));

  if (pNull <= 0.0) {
    const pLower = 1.0;
    const pUpper = kUpper === 0 ? 1.0 : 0.0;
    return [pLower, pUpper];
  }
  if (pNull >= 1.0) {
    const pLower = kLower < nInt ? 0.0 : 1.0;
    const pUpper = 1.0;
    return [pLower, pUpper];
  }

  // Lower tail P(X <= kLower)
  const pLower =
    kLower >= nInt
      ? 1.0
      : regularizedIncompleteBeta(1.0 - pNull, nInt - kLower, kLower + 1);

  // Upper tail P(X >= kUpper)
  const pUpper =
    kUpper <= 0
      ? 1.0
      : regularizedIncompleteBeta(pNull, kUpper, nInt - kUpper + 1);

  return [
    Math.min(1.0, Math.max(0.0, pLower)),
    Math.min(1.0, Math.max(0.0, pUpper)),
  ];
}

/**
 * Benjamini-Hochberg step-up False Discovery Rate adjustment.
 * Supports NaN entries (preserves NaN positions and adjusts finite entries as a family).
 */
export function benjaminiHochberg(pValues: number[]): number[] {
  if (pValues.length === 0) return [];
  const validIndices: number[] = [];
  for (let i = 0; i < pValues.length; i++) {
    if (Number.isFinite(pValues[i])) {
      validIndices.push(i);
    }
  }
  const m = validIndices.length;
  if (m === 0) {
    return pValues.map(() => Number.NaN);
  }

  const indexed = validIndices.map((origIdx, pos) => ({
    origIdx,
    pos,
    p: Math.min(1.0, Math.max(0.0, pValues[origIdx])),
  }));

  indexed.sort((a, b) => (a.p !== b.p ? a.p - b.p : a.pos - b.pos));

  const rawQ = indexed.map((item, idx) => (item.p * m) / (idx + 1));
  const monotonicQ = new Array<number>(m);
  let runningMin = 1.0;
  for (let i = m - 1; i >= 0; i--) {
    runningMin = Math.min(runningMin, rawQ[i]);
    monotonicQ[i] = Math.min(1.0, Math.max(0.0, runningMin));
  }

  const result = new Array<number>(pValues.length).fill(Number.NaN);
  for (let i = 0; i < m; i++) {
    result[indexed[i].origIdx] = monotonicQ[i];
  }
  return result;
}

/**
 * Leave-one-out campaign CVR shrunk toward leave-one-out account CVR.
 */
export function computeLeaveOneOutShrunkBaseline(
  termClicks: number,
  termConversions: number,
  campaignClicks: number,
  campaignConversions: number,
  accountClicks: number,
  accountConversions: number,
  shrinkageK = 100.0
): [number, number, number] {
  const tClicks = Math.max(0.0, termClicks);
  const tConv = Math.max(0.0, termConversions);

  const acctClicksLoo = Math.max(0.0, accountClicks - tClicks);
  const acctConvLoo = Math.max(0.0, accountConversions - tConv);
  const acctCvrLoo =
    acctClicksLoo > 0.0
      ? Math.min(1.0, Math.max(0.0, acctConvLoo / acctClicksLoo))
      : 0.0;

  const campClicksLoo = Math.max(0.0, campaignClicks - tClicks);
  const campConvLoo = Math.max(0.0, campaignConversions - tConv);
  const campCvrLoo =
    campClicksLoo > 0.0
      ? Math.min(1.0, Math.max(0.0, campConvLoo / campClicksLoo))
      : acctCvrLoo;

  const k = Math.max(0.0, shrinkageK);
  const denom = campClicksLoo + k;
  const shrunkCvr =
    denom > 0.0
      ? (campClicksLoo * campCvrLoo + k * acctCvrLoo) / denom
      : acctCvrLoo;

  return [
    Math.min(1.0, Math.max(0.0, shrunkCvr)),
    Math.min(1.0, Math.max(0.0, campCvrLoo)),
    Math.min(1.0, Math.max(0.0, acctCvrLoo)),
  ];
}

/**
 * RFC-4180 compliant CSV parser supporting quoted fields and commas.
 */
export function parseCsvFlexible(csvText: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  const text = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (ch === '\n') {
        currentRow.push(currentField);
        lines.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    lines.push(currentRow);
  }

  // Filter trailing blank line
  const nonEmptyLines = lines.filter(
    (r, idx) => !(idx === lines.length - 1 && r.length === 1 && r[0].trim() === '')
  );

  if (nonEmptyLines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = nonEmptyLines[0].map((h, idx) =>
    h.trim() || `column_${idx + 1}`
  );
  const rows: Record<string, string>[] = [];

  for (let rIdx = 1; rIdx < nonEmptyLines.length; rIdx++) {
    const rawCells = nonEmptyLines[rIdx];
    const obj: Record<string, string> = {};
    for (let cIdx = 0; cIdx < headers.length; cIdx++) {
      obj[headers[cIdx]] = rawCells[cIdx] !== undefined ? rawCells[cIdx].trim() : '';
    }
    rows.push(obj);
  }

  return { headers, rows };
}

const CANDIDATE_ALIASES: Record<keyof ColumnMapping, string[]> = {
  search_term: [
    'search_term',
    'search term',
    'query',
    'search_query',
    'search query',
    'customer_search_term',
    'customer search term',
    'term',
    'keyword_text',
  ],
  campaign: ['campaign', 'campaign_name', 'campaign name', 'campaign_id', 'campaign id'],
  ad_group: ['ad_group', 'ad group', 'ad_group_name', 'ad group name', 'adgroup'],
  match_type: ['match_type', 'match type', 'query_match_type'],
  impressions: ['impressions', 'impr.', 'impr', 'imps'],
  clicks: ['clicks', 'click', 'interactions'],
  cost: ['cost', 'spend', 'cost_usd', 'cost (usd)', 'cost_inr', 'amount_spent', 'total_cost'],
  conversions: ['conversions', 'conv.', 'conv', 'orders', 'purchases', 'leads'],
  conversion_value: [
    'conversion_value',
    'conv. value',
    'conv value',
    'revenue',
    'sales',
    'total_conversion_value',
    'value',
  ],
};

export function suggestColumnMapping(headers: string[]): ColumnMapping {
  const normToActual = new Map<string, string>();
  for (const h of headers) {
    const norm = h.trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, ' ');
    normToActual.set(norm, h);
    normToActual.set(norm.replace(/_/g, ' '), h);
  }

  const used = new Set<string>();
  const result: Partial<ColumnMapping> = {};

  (Object.keys(CANDIDATE_ALIASES) as Array<keyof ColumnMapping>).forEach((canonical) => {
    for (const alias of CANDIDATE_ALIASES[canonical]) {
      const match = normToActual.get(alias.toLowerCase());
      if (match && !used.has(match)) {
        result[canonical] = match;
        used.add(match);
        break;
      }
    }
  });

  // Fallback substring matching
  const fallbacks: Array<keyof ColumnMapping> = [
    'search_term',
    'clicks',
    'cost',
    'conversions',
    'campaign',
  ];
  for (const canonical of fallbacks) {
    if (result[canonical]) continue;
    for (const col of headers) {
      if (used.has(col)) continue;
      const low = col.toLowerCase();
      if (
        canonical === 'search_term' &&
        (low.includes('term') || low.includes('query') || low.includes('keyword'))
      ) {
        result[canonical] = col;
        used.add(col);
        break;
      } else if (canonical === 'clicks' && low.includes('click')) {
        result[canonical] = col;
        used.add(col);
        break;
      } else if (canonical === 'cost' && (low.includes('cost') || low.includes('spend'))) {
        result[canonical] = col;
        used.add(col);
        break;
      } else if (
        canonical === 'conversions' &&
        low.includes('conv') &&
        !low.includes('val') &&
        !low.includes('rate')
      ) {
        result[canonical] = col;
        used.add(col);
        break;
      } else if (canonical === 'campaign' && low.includes('camp')) {
        result[canonical] = col;
        used.add(col);
        break;
      }
    }
  }

  return {
    search_term: result.search_term || headers[0] || 'search_term',
    clicks: result.clicks || headers[1] || 'clicks',
    cost: result.cost || headers[2] || 'cost',
    conversions: result.conversions || headers[3] || 'conversions',
    campaign: result.campaign,
    ad_group: result.ad_group,
    match_type: result.match_type,
    impressions: result.impressions,
    conversion_value: result.conversion_value,
  };
}

function parseNumericCell(raw: string | undefined): { value: number; isMissing: boolean } {
  if (raw === undefined || raw === null) {
    return { value: Number.NaN, isMissing: true };
  }
  const trimmed = String(raw).trim();
  if (
    trimmed === '' ||
    ['nan', 'none', 'null', 'n/a', '--', '-'].includes(trimmed.toLowerCase())
  ) {
    return { value: Number.NaN, isMissing: true };
  }
  const cleaned = trimmed.replace(/[$₹€£,]/g, '').trim();
  const num = Number(cleaned);
  if (Number.isNaN(num)) {
    return { value: Number.NaN, isMissing: true };
  }
  return { value: num, isMissing: false };
}

export function runTriageEngine(
  headers: string[],
  rawRows: Record<string, string>[],
  mapping: ColumnMapping,
  config: TriageConfig = DEFAULT_TRIAGE_CONFIG
): {
  results: TriageRowResult[];
  summary: TriageSummary;
  qualityReport: DataQualityReport;
} {
  const nRows = rawRows.length;

  // 1. Build column profiles
  const columnProfiles: ColumnProfile[] = headers.map((col) => {
    let nullCount = 0;
    let allNumeric = true;
    let allInteger = true;
    const sampleValues: string[] = [];

    for (const r of rawRows) {
      const val = (r[col] ?? '').trim();
      if (val === '' || ['nan', 'none', 'null'].includes(val.toLowerCase())) {
        nullCount++;
      } else {
        if (sampleValues.length < 3) sampleValues.push(val);
        const parsed = parseNumericCell(val);
        if (parsed.isMissing) {
          allNumeric = false;
        } else if (Math.abs(parsed.value % 1) > 1e-6) {
          allInteger = false;
        }
      }
    }

    const nonNullCount = nRows - nullCount;
    const dtype =
      nonNullCount === 0
        ? 'empty'
        : allNumeric
          ? allInteger
            ? 'integer'
            : 'float'
          : 'string';

    return {
      name: col,
      dtype,
      nullCount,
      nullPct: nRows > 0 ? (nullCount / nRows) * 100 : 0,
      nonNullCount,
      sampleValues,
    };
  });

  // 2. First-pass parsing & duplicate detection
  const termFreq = new Map<string, number>();
  const campTermFreq = new Map<string, number>();

  const parsedRows = rawRows.map((r, idx) => {
    const rawTerm = (r[mapping.search_term] ?? '').trim();
    const termMissing =
      rawTerm === '' || ['nan', 'none', 'null'].includes(rawTerm.toLowerCase());
    const normTerm = rawTerm.toLowerCase().replace(/\s+/g, ' ');

    const hasCampaignCol = Boolean(mapping.campaign && headers.includes(mapping.campaign));
    const rawCamp = hasCampaignCol ? (r[mapping.campaign!] ?? '').trim() : 'Default Campaign';
    const campMissing =
      hasCampaignCol &&
      (rawCamp === '' || ['nan', 'none', 'null'].includes(rawCamp.toLowerCase()));
    const cleanCamp = campMissing ? 'Unassigned Campaign' : rawCamp || 'Default Campaign';

    if (!termMissing && normTerm !== '') {
      termFreq.set(normTerm, (termFreq.get(normTerm) ?? 0) + 1);
      const ck = `${cleanCamp.toLowerCase()}||${normTerm}`;
      campTermFreq.set(ck, (campTermFreq.get(ck) ?? 0) + 1);
    }

    const clicksP = parseNumericCell(r[mapping.clicks]);
    const costP = parseNumericCell(r[mapping.cost]);
    const convP = parseNumericCell(r[mapping.conversions]);
    const imprP =
      mapping.impressions && headers.includes(mapping.impressions)
        ? parseNumericCell(r[mapping.impressions])
        : { value: Number.NaN, isMissing: true };
    const valP =
      mapping.conversion_value && headers.includes(mapping.conversion_value)
        ? parseNumericCell(r[mapping.conversion_value])
        : { value: Number.NaN, isMissing: true };

    return {
      rowId: idx + 1,
      searchTerm: termMissing ? '[MISSING_SEARCH_TERM]' : rawTerm,
      normTerm,
      termMissing,
      campaign: cleanCamp,
      campMissing,
      adGroup:
        mapping.ad_group && headers.includes(mapping.ad_group)
          ? (r[mapping.ad_group] ?? '').trim()
          : '',
      matchType:
        mapping.match_type && headers.includes(mapping.match_type)
          ? (r[mapping.match_type] ?? '').trim()
          : '',
      impressions: imprP.isMissing ? null : imprP.value,
      clicks: clicksP.isMissing ? 0.0 : clicksP.value,
      clicksMissing: clicksP.isMissing,
      cost: costP.isMissing ? 0.0 : costP.value,
      costMissing: costP.isMissing,
      conversions: convP.isMissing ? 0.0 : convP.value,
      convMissing: convP.isMissing,
      conversionValue: valP.isMissing ? null : valP.value,
    };
  });

  // 3. Annotate quality flags & tally report counts
  let duplicateQueryRowCount = 0;
  let duplicateCampaignQueryRowCount = 0;
  let missingRequiredRowCount = 0;
  let zeroClickRowCount = 0;
  let negativeMetricRowCount = 0;
  let conversionsExceedClicksRowCount = 0;
  let fractionalConversionRowCount = 0;
  let costWithoutClicksRowCount = 0;

  const annotatedRows = parsedRows.map((pr) => {
    const flags: string[] = [];
    const missingReq =
      pr.termMissing || pr.clicksMissing || pr.costMissing || pr.convMissing;
    const negMetric =
      pr.clicks < 0 ||
      pr.cost < 0 ||
      pr.conversions < 0 ||
      (pr.impressions !== null && pr.impressions < 0);
    const zeroClick = !pr.clicksMissing && pr.clicks === 0;
    const costNoClicks = zeroClick && !pr.costMissing && pr.cost > 0;
    const convExceedClicks =
      !pr.clicksMissing &&
      !pr.convMissing &&
      pr.clicks >= 0 &&
      pr.conversions > pr.clicks + 1e-9;
    const fracConv =
      !pr.convMissing &&
      pr.conversions > 0 &&
      Math.abs(pr.conversions % 1) > 1e-6 &&
      Math.abs((pr.conversions % 1) - 1) > 1e-6;

    const isDupTerm =
      !pr.termMissing && pr.normTerm !== '' && (termFreq.get(pr.normTerm) ?? 0) > 1;
    const ck = `${pr.campaign.toLowerCase()}||${pr.normTerm}`;
    const isDupCampTerm =
      !pr.termMissing && pr.normTerm !== '' && (campTermFreq.get(ck) ?? 0) > 1;

    if (missingReq) {
      flags.push('MISSING_VALUES');
      missingRequiredRowCount++;
    }
    if (pr.campMissing) {
      flags.push('MISSING_CAMPAIGN');
    }
    if (negMetric) {
      flags.push('NEGATIVE_METRICS');
      negativeMetricRowCount++;
    }
    if (zeroClick) {
      flags.push('ZERO_CLICKS');
      zeroClickRowCount++;
    }
    if (costNoClicks) {
      flags.push('COST_WITHOUT_CLICKS');
      costWithoutClicksRowCount++;
    }
    if (convExceedClicks) {
      flags.push('CONVERSIONS_EXCEED_CLICKS');
      conversionsExceedClicksRowCount++;
    }
    if (fracConv) {
      flags.push('FRACTIONAL_CONVERSIONS');
      fractionalConversionRowCount++;
    }
    if (isDupTerm) {
      duplicateQueryRowCount++;
    }
    if (isDupCampTerm) {
      flags.push('DUPLICATE_QUERY_IN_CAMPAIGN');
      duplicateCampaignQueryRowCount++;
    } else if (isDupTerm) {
      flags.push('DUPLICATE_QUERY_ACROSS_CAMPAIGNS');
    }

    const hasFatalAnomaly = missingReq || negMetric || convExceedClicks;
    return {
      ...pr,
      flags,
      hasFatalAnomaly,
    };
  });

  // 4. Baseline pool totals (excluding fatal anomalies)
  let accountValidClicks = 0;
  let accountValidConversions = 0;
  let accountValidCost = 0;
  const campClicksMap = new Map<string, number>();
  const campConvMap = new Map<string, number>();

  for (const r of annotatedRows) {
    if (!r.hasFatalAnomaly && r.clicks >= 0) {
      accountValidClicks += r.clicks;
      accountValidConversions += r.conversions;
      accountValidCost += r.cost;
      campClicksMap.set(r.campaign, (campClicksMap.get(r.campaign) ?? 0) + r.clicks);
      campConvMap.set(r.campaign, (campConvMap.get(r.campaign) ?? 0) + r.conversions);
    }
  }

  const accountBaselineCvr =
    accountValidClicks > 0 ? accountValidConversions / accountValidClicks : 0.0;
  const accountCpa =
    accountValidConversions > 0 ? accountValidCost / accountValidConversions : null;
  const effectiveBlockCostGate =
    accountCpa !== null
      ? config.blockCostCpaMultiplier * accountCpa
      : config.fallbackBlockCostFloor;

  const minPromoteConvGate = Math.max(2.0, config.minPromoteConversions);

  // 5. Compute per-row LOO shrunk baseline, Wilson CI, and exact binomial tails
  const promoteTestPvals: number[] = [];
  const blockTestPvals: number[] = [];

  const intermediate = annotatedRows.map((r) => {
    const obsCvr = r.clicks > 0 && !r.hasFatalAnomaly ? r.conversions / r.clicks : 0.0;
    const obsCpa =
      r.conversions > 0 && !r.hasFatalAnomaly ? r.cost / r.conversions : null;

    const termCForLoo = !r.hasFatalAnomaly ? r.clicks : 0.0;
    const termXForLoo = !r.hasFatalAnomaly ? r.conversions : 0.0;

    const cClicks = campClicksMap.get(r.campaign) ?? 0.0;
    const cConv = campConvMap.get(r.campaign) ?? 0.0;

    const [shrunkP0, campLoo, acctLoo] = computeLeaveOneOutShrunkBaseline(
      termCForLoo,
      termXForLoo,
      cClicks,
      cConv,
      accountValidClicks,
      accountValidConversions,
      config.shrinkageK
    );

    const flags = [...r.flags];
    if (shrunkP0 <= 0.0 && !flags.includes('ZERO_BASELINE')) {
      flags.push('ZERO_BASELINE');
    }

    let wLow = 0.0;
    let wHigh = 0.0;
    let pLow = 1.0;
    let pUp = 1.0;

    if (!r.hasFatalAnomaly && r.clicks > 0) {
      [wLow, wHigh] = wilsonInterval(r.conversions, r.clicks, config.alpha);
      [pLow, pUp] = exactBinomialTails(r.conversions, r.clicks, shrunkP0);
    }

    if (
      !r.hasFatalAnomaly &&
      r.clicks >= config.minTestClicks &&
      r.conversions >= minPromoteConvGate &&
      obsCvr > shrunkP0
    ) {
      promoteTestPvals.push(pUp);
    } else {
      promoteTestPvals.push(Number.NaN);
    }

    if (
      !r.hasFatalAnomaly &&
      r.clicks >= config.minTestClicks &&
      r.cost >= effectiveBlockCostGate &&
      shrunkP0 > 0.0 &&
      obsCvr < shrunkP0
    ) {
      blockTestPvals.push(pLow);
    } else {
      blockTestPvals.push(Number.NaN);
    }

    return {
      ...r,
      flags,
      obsCvr,
      obsCpa,
      campLoo,
      acctLoo,
      shrunkP0,
      wLow,
      wHigh,
      pLow,
      pUp,
    };
  });

  const qUpperRaw = benjaminiHochberg(promoteTestPvals);
  const qLowerRaw = benjaminiHochberg(blockTestPvals);

  let promoteCount = 0;
  let blockCount = 0;
  let ignoreCount = 0;
  let reviewFlaggedCount = 0;

  const results: TriageRowResult[] = intermediate.map((r, i) => {
    const qUp = Number.isNaN(qUpperRaw[i]) ? 1.0 : qUpperRaw[i];
    const qLow = Number.isNaN(qLowerRaw[i]) ? 1.0 : qLowerRaw[i];

    const hasNonfatalWarning = r.flags.some((f) =>
      [
        'FRACTIONAL_CONVERSIONS',
        'DUPLICATE_QUERY_IN_CAMPAIGN',
        'DUPLICATE_QUERY_ACROSS_CAMPAIGNS',
        'MISSING_CAMPAIGN',
        'ZERO_BASELINE',
        'COST_WITHOUT_CLICKS',
      ].includes(f)
    );

    let decision: DecisionLabel = 'IGNORE';
    let confidenceTier = 'Baseline / Inconclusive';
    let reviewFlag = false;
    let reason = '';

    if (r.hasFatalAnomaly) {
      decision = 'IGNORE';
      confidenceTier = 'Data Anomaly (Hold)';
      reviewFlag = true;
      reason = `IGNORE: Data quality anomaly [${r.flags.join(', ')}] (clicks=${r.clicks}, conv=${r.conversions}, cost=$${r.cost.toFixed(2)}); manual review required.`;
    } else if (r.clicks <= 0) {
      decision = 'IGNORE';
      confidenceTier = 'Insufficient Data';
      reviewFlag = r.cost > 0 || r.conversions > 0 || hasNonfatalWarning;
      reason = `IGNORE: Zero clicks (0 clicks, ${r.conversions} conv, cost=$${r.cost.toFixed(2)}); minimum ${config.minTestClicks} clicks required for statistical triage.`;
    } else if (r.clicks < config.minTestClicks) {
      decision = 'IGNORE';
      confidenceTier = 'Insufficient Data';
      reviewFlag =
        r.cost >= effectiveBlockCostGate ||
        r.conversions >= minPromoteConvGate ||
        hasNonfatalWarning;
      if (r.conversions === 1) {
        reason = `IGNORE: Single-conversion low-click trap (${r.conversions} conv / ${r.clicks} clicks, CVR ${(r.obsCvr * 100).toFixed(1)}% vs ${(r.shrunkP0 * 100).toFixed(2)}% baseline, 95% Wilson CI [${(r.wLow * 100).toFixed(1)}%, ${(r.wHigh * 100).toFixed(1)}%]); requires >=${minPromoteConvGate} conv and >=${config.minTestClicks} clicks.`;
      } else {
        reason = `IGNORE: Insufficient click volume (${r.clicks} clicks < min ${config.minTestClicks}, ${r.conversions} conv, cost=$${r.cost.toFixed(2)}, 95% Wilson CI [${(r.wLow * 100).toFixed(1)}%, ${(r.wHigh * 100).toFixed(1)}%]).`;
      }
    } else {
      // Check PROMOTE
      const canPromote =
        r.conversions >= minPromoteConvGate &&
        r.obsCvr > r.shrunkP0 &&
        (config.strictFdrGate ? qUp <= config.alpha : r.pUp <= config.alpha);

      // Check BLOCK
      const canBlock =
        !canPromote &&
        r.shrunkP0 > 0 &&
        r.obsCvr < r.shrunkP0 &&
        r.cost >= effectiveBlockCostGate &&
        (config.strictFdrGate ? qLow <= config.alpha : r.pLow <= config.alpha);

      if (canPromote) {
        decision = 'PROMOTE';
        if (qUp <= config.alpha && r.wLow > r.shrunkP0 && !hasNonfatalWarning) {
          confidenceTier = 'Tier 1: High (FDR & CI Confirmed)';
          reviewFlag = false;
        } else if (qUp <= config.alpha) {
          confidenceTier = 'Tier 2: Medium (FDR Adjusted, Review Flags)';
          reviewFlag = true;
        } else {
          confidenceTier = 'Tier 3: Low (Unadjusted Signal, Review Required)';
          reviewFlag = true;
        }
        reason = `PROMOTE: ${r.conversions} conv / ${r.clicks} clicks (CVR ${(r.obsCvr * 100).toFixed(2)}% vs ${(r.shrunkP0 * 100).toFixed(2)}% shrunk baseline, 95% CI [${(r.wLow * 100).toFixed(2)}%, ${(r.wHigh * 100).toFixed(2)}%], p_up=${r.pUp.toFixed(4)}, q_up=${qUp.toFixed(4)} <= alpha=${config.alpha}).`;
      } else if (canBlock) {
        decision = 'BLOCK';
        const hasPosConv = r.conversions > 0;
        if (
          qLow <= config.alpha &&
          r.wHigh < r.shrunkP0 &&
          !hasPosConv &&
          !hasNonfatalWarning
        ) {
          confidenceTier = 'Tier 1: High (FDR & CI Confirmed)';
          reviewFlag = false;
        } else if (qLow <= config.alpha) {
          confidenceTier = 'Tier 2: Medium (FDR Adjusted, Review Flags)';
          reviewFlag = true;
        } else {
          confidenceTier = 'Tier 3: Low (Unadjusted Signal, Review Required)';
          reviewFlag = true;
        }
        reason = `BLOCK: ${r.conversions} conv / ${r.clicks} clicks, cost $${r.cost.toFixed(2)} >= gate $${effectiveBlockCostGate.toFixed(2)} (CVR ${(r.obsCvr * 100).toFixed(2)}% vs ${(r.shrunkP0 * 100).toFixed(2)}% shrunk baseline, 95% CI [${(r.wLow * 100).toFixed(2)}%, ${(r.wHigh * 100).toFixed(2)}%], p_low=${r.pLow.toFixed(4)}, q_low=${qLow.toFixed(4)} <= alpha=${config.alpha}).`;
      } else {
        decision = 'IGNORE';
        confidenceTier = 'Baseline / Inconclusive';
        const nearSigUp = r.conversions >= minPromoteConvGate && r.pUp <= config.alpha;
        const nearSigLow =
          r.cost >= effectiveBlockCostGate && r.shrunkP0 > 0 && r.pLow <= config.alpha;
        reviewFlag = nearSigUp || nearSigLow || hasNonfatalWarning;

        if (r.conversions === 1 && r.obsCvr > r.shrunkP0) {
          reason = `IGNORE: Single conversion never promoted (${r.conversions} conv < min ${minPromoteConvGate} across ${r.clicks} clicks; CVR ${(r.obsCvr * 100).toFixed(2)}% vs ${(r.shrunkP0 * 100).toFixed(2)}% baseline, 95% CI [${(r.wLow * 100).toFixed(2)}%, ${(r.wHigh * 100).toFixed(2)}%]).`;
        } else if (
          r.obsCvr < r.shrunkP0 &&
          r.pLow <= config.alpha &&
          r.cost < effectiveBlockCostGate
        ) {
          reason = `IGNORE: Underperforming CVR (${(r.obsCvr * 100).toFixed(2)}% vs ${(r.shrunkP0 * 100).toFixed(2)}% baseline, p_low=${r.pLow.toFixed(4)}) but cost $${r.cost.toFixed(2)} is below block cost gate $${effectiveBlockCostGate.toFixed(2)}.`;
        } else if (nearSigUp && config.strictFdrGate) {
          reason = `IGNORE: Unadjusted p_up=${r.pUp.toFixed(4)} <= ${config.alpha}, but BH-adjusted q_up=${qUp.toFixed(4)} > ${config.alpha} (${r.conversions} conv / ${r.clicks} clicks, CVR ${(r.obsCvr * 100).toFixed(2)}% vs ${(r.shrunkP0 * 100).toFixed(2)}% baseline).`;
        } else if (nearSigLow && config.strictFdrGate) {
          reason = `IGNORE: Unadjusted p_low=${r.pLow.toFixed(4)} <= ${config.alpha}, but BH-adjusted q_low=${qLow.toFixed(4)} > ${config.alpha} (${r.conversions} conv / ${r.clicks} clicks, cost=$${r.cost.toFixed(2)}).`;
        } else {
          reason = `IGNORE: Within expected baseline variation (${r.conversions} conv / ${r.clicks} clicks, cost=$${r.cost.toFixed(2)}, CVR ${(r.obsCvr * 100).toFixed(2)}% vs ${(r.shrunkP0 * 100).toFixed(2)}% shrunk baseline, 95% CI [${(r.wLow * 100).toFixed(2)}%, ${(r.wHigh * 100).toFixed(2)}%], p_low=${r.pLow.toFixed(4)}, p_up=${r.pUp.toFixed(4)}).`;
        }
      }
    }

    if (decision === 'PROMOTE') promoteCount++;
    else if (decision === 'BLOCK') blockCount++;
    else ignoreCount++;
    if (reviewFlag) reviewFlaggedCount++;

    return {
      row_id: r.rowId,
      search_term: r.searchTerm,
      campaign: r.campaign,
      ad_group: r.adGroup,
      match_type: r.matchType,
      impressions: r.impressions,
      clicks: r.clicks,
      cost: Number(r.cost.toFixed(2)),
      conversions: r.conversions,
      conversion_value_info: r.conversionValue,
      observed_cvr: Number(r.obsCvr.toFixed(6)),
      observed_cpa: r.obsCpa !== null ? Number(r.obsCpa.toFixed(2)) : null,
      campaign_loo_cvr: Number(r.campLoo.toFixed(6)),
      account_loo_cvr: Number(r.acctLoo.toFixed(6)),
      shrunk_baseline_cvr: Number(r.shrunkP0.toFixed(6)),
      wilson_ci_lower: Number(r.wLow.toFixed(6)),
      wilson_ci_upper: Number(r.wHigh.toFixed(6)),
      p_value_lower: Number(r.pLow.toFixed(6)),
      p_value_upper: Number(r.pUp.toFixed(6)),
      q_value_lower: Number(qLow.toFixed(6)),
      q_value_upper: Number(qUp.toFixed(6)),
      decision,
      confidence_tier: confidenceTier,
      review_flag: reviewFlag,
      quality_flags: r.flags.length > 0 ? r.flags.join('; ') : 'OK',
      reason,
    };
  });

  const summary: TriageSummary = {
    totalRows: nRows,
    promoteCount,
    blockCount,
    ignoreCount,
    reviewFlaggedCount,
    accountValidClicks,
    accountValidConversions,
    accountValidCost,
    accountBaselineCvr,
    accountCpa,
    effectiveBlockCostGate,
  };

  const qualityReport: DataQualityReport = {
    totalRows: nRows,
    totalColumns: headers.length,
    columnProfiles,
    uniqueSearchTerms: termFreq.size,
    duplicateQueryRowCount,
    duplicateCampaignQueryRowCount,
    missingRequiredRowCount,
    zeroClickRowCount,
    negativeMetricRowCount,
    conversionsExceedClicksRowCount,
    fractionalConversionRowCount,
    costWithoutClicksRowCount,
    sampleRows: rawRows.slice(0, 5),
  };

  return { results, summary, qualityReport };
}

export const EXPORT_COLUMNS: Array<keyof TriageRowResult> = [
  'row_id',
  'search_term',
  'campaign',
  'ad_group',
  'match_type',
  'impressions',
  'clicks',
  'cost',
  'conversions',
  'conversion_value_info',
  'observed_cvr',
  'observed_cpa',
  'campaign_loo_cvr',
  'account_loo_cvr',
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

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined || Number.isNaN(val)) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function resultsToCsvString(rows: TriageRowResult[]): string {
  const headerLine = EXPORT_COLUMNS.join(',');
  const dataLines = rows.map((row) =>
    EXPORT_COLUMNS.map((col) => escapeCsvCell(row[col])).join(',')
  );
  return [headerLine, ...dataLines].join('\n') + '\n';
}
