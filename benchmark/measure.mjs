/**
 * Fixed-sample benchmark harness.
 *
 * Counts VERDICTS, not outputs. Every field gets one of eight outcome classes, and the
 * headline rates are computed over exactly one class, so a classification ("we know this is
 * a V3/V4 pool") can never be counted as a measurement ("we know the lock state").
 *
 * Usage: node benchmark/measure.mjs [--json out.json] [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { liveScan } = await import(`file://${ROOT.replace(/\\/g, '/')}/src/live-scan.mjs`);
const { resolveQuickCheck } = await import(`file://${ROOT.replace(/\\/g, '/')}/src/card-layout.mjs`);
const { researchToken } = await import(`file://${ROOT.replace(/\\/g, '/')}/src/research/research-service.mjs`);

/**
 * The eight outcome classes. DETERMINED and CLASSIFIED are deliberately separate: knowing a
 * pool type is real information but it does not answer "is the liquidity locked".
 */
export const OUTCOME = {
  MEASURED: 'measured',       // a real value from evidence
  PARTIAL: 'partial',         // verified but incomplete (e.g. a Top 10 that is not the top 10)
  NOT_APPLICABLE: 'na',       // proven the concept does not exist for this subject
  UNAVAILABLE: 'unavailable', // provider has no record / does not cover it
  RATE_LIMITED: 'rate-limited',
  UNSUPPORTED: 'unsupported', // this chain/feature combination is not implemented
  UNKNOWN: 'unknown',         // we could not determine it
  CONFIRMED_ZERO: 'zero',     // measured, and the answer really is zero
};

/** Which classes count as answering a "≥90% coverage" question. */
const COUNTS_AS_COVERED = new Set([OUTCOME.MEASURED, OUTCOME.PARTIAL, OUTCOME.NOT_APPLICABLE, OUTCOME.CONFIRMED_ZERO]);

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const LIMIT = arg('limit') ? Number(arg('limit')) : null;
const SKIP_NARRATIVE = args.includes('--skip-narrative');
const OUT = arg('json', path.join(HERE, 'results.json'));

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
const tokens = LIMIT ? manifest.tokens.slice(0, LIMIT) : manifest.tokens;

// ---------------------------------------------------------------------------
// Field extractors: each returns { outcome, value, evidence }
// ---------------------------------------------------------------------------

function classifyTop10(r) {
  const top10 = r.risk?.holders?.top10Percentage;
  const total = r.risk?.holders?.total;
  if (top10 == null) {
    if (r.riskStatus === 'unsupported') return { outcome: OUTCOME.UNSUPPORTED };
    if (r.riskStatus === 'no-data') return { outcome: OUTCOME.UNAVAILABLE };
    if (r.riskStatus === 'error') return { outcome: OUTCOME.UNAVAILABLE, evidence: r.riskDetail };
    return { outcome: OUTCOME.UNKNOWN };
  }
  // A concentration figure is only the TOP 10 if the provider actually sampled 10 holders.
  // With fewer holders than that, a "top10" sum is really "top N" and calling it complete
  // Top 10 coverage would be a false claim.
  if (total != null && total < 10) {
    return { outcome: OUTCOME.PARTIAL, value: top10, evidence: `only ${total} holders exist` };
  }
  if (top10 === 0) return { outcome: OUTCOME.CONFIRMED_ZERO, value: 0 };
  return { outcome: OUTCOME.MEASURED, value: top10 };
}

function classifyHolders(r) {
  const total = r.risk?.holders?.total;
  if (total == null) {
    if (r.riskStatus === 'unsupported') return { outcome: OUTCOME.UNSUPPORTED };
    if (r.riskStatus === 'no-data') return { outcome: OUTCOME.UNAVAILABLE };
    if (r.riskStatus === 'error') return { outcome: OUTCOME.UNAVAILABLE, evidence: r.riskDetail };
    return { outcome: OUTCOME.UNKNOWN };
  }
  if (total === 0) return { outcome: OUTCOME.CONFIRMED_ZERO, value: 0 };
  return { outcome: OUTCOME.MEASURED, value: total };
}

function classifyTax(r) {
  const tax = r.risk?.tax;
  if (!tax) return { outcome: OUTCOME.UNAVAILABLE };
  // Solana legacy SPL has no buy/sell tax concept at all - a verified non-applicability.
  if (tax.kind === 'not-applicable') return { outcome: OUTCOME.NOT_APPLICABLE };
  if (tax.kind === 'transfer-fee') {
    return tax.pct == null
      ? { outcome: OUTCOME.PARTIAL, evidence: 'transfer fee present, value unreported' }
      : { outcome: OUTCOME.MEASURED, value: tax.pct };
  }
  if (tax.buy != null || tax.sell != null) return { outcome: OUTCOME.MEASURED, value: `${tax.buy}/${tax.sell}` };
  return { outcome: OUTCOME.UNKNOWN };
}

function classifyLp(r) {
  const lp = r.risk?.lpLock;
  if (!lp) return { outcome: OUTCOME.UNAVAILABLE };
  // CLASSIFIED-ONLY outcomes: the pool type is known, the lock state is not measurable.
  // These must never be counted toward a "determined LP intelligence" rate.
  if (lp.kind === 'bonding-curve') return { outcome: OUTCOME.PARTIAL, evidence: 'bonding curve - no pool to lock' };
  if (lp.positionType === 'v3-v4') return { outcome: OUTCOME.UNKNOWN, evidence: 'pool type known, lock state not measurable' };
  if (lp.kind === 'burned') return { outcome: OUTCOME.MEASURED, value: `burned ${lp.burnedPercentage}%` };
  if (lp.kind === 'not-burned') return { outcome: OUTCOME.MEASURED, value: 'not burned, no locker' };
  if (lp.kind === 'locked' || lp.kind === 'partially-locked') {
    return { outcome: OUTCOME.MEASURED, value: `locked ${lp.lockedPercentage}%` };
  }
  if (lp.kind === 'unlocked') return { outcome: OUTCOME.MEASURED, value: 'unlocked' };
  if (lp.lockedPercentage != null || lp.burnedPercentage != null) {
    return { outcome: OUTCOME.MEASURED, value: `${lp.burnedPercentage ?? 0}/${lp.lockedPercentage ?? 0}` };
  }
  return { outcome: OUTCOME.UNKNOWN };
}

function classifyDev(r) {
  const dev = r.risk?.dev;
  if (!dev) return { outcome: OUTCOME.UNAVAILABLE };
  if (dev.address && dev.percentage == null) return { outcome: OUTCOME.PARTIAL, evidence: 'address known, holding unmeasured' };
  if (dev.percentage != null) {
    return dev.percentage === 0
      ? { outcome: OUTCOME.CONFIRMED_ZERO, value: 0 }
      : { outcome: OUTCOME.MEASURED, value: dev.percentage };
  }
  return { outcome: OUTCOME.UNKNOWN };
}

/**
 * Narrative is produced by researchToken(), NOT by liveScan - they are two different
 * pipelines. The first version of this harness measured only liveScan and reported narrative
 * 0%, which described the HARNESS rather than the product. That is the same error as reading a
 * provider's silence as a fact about the token, so it is measured properly here.
 */
function classifyNarrative(research) {
  if (!research) return { outcome: OUTCOME.UNKNOWN, evidence: 'research not run' };
  const n = research.narrative;
  if (!n) return { outcome: OUTCOME.UNKNOWN, evidence: 'no narrative block' };
  if (n.available && n.summary) {
    const len = String(n.summary).trim().length;
    if (!len) return { outcome: OUTCOME.UNKNOWN, evidence: 'empty summary' };
    // A summary that is merely the token's own name/symbol is not a description of it.
    const sym = String(research.symbol ?? '').toLowerCase();
    const txt = String(n.summary).trim().toLowerCase();
    if (sym && (txt === sym || txt === `${sym} token`)) {
      return { outcome: OUTCOME.PARTIAL, evidence: 'summary restates the ticker' };
    }
    return {
      outcome: OUTCOME.MEASURED,
      value: len,
      evidence: n.summarySource ?? null,
    };
  }
  // A provider outage is not "no description published".
  if (n.reason === 'provider-error') return { outcome: OUTCOME.UNAVAILABLE, evidence: n.reason };
  if (n.reason === 'unsupported-chain') return { outcome: OUTCOME.UNSUPPORTED };
  return { outcome: OUTCOME.UNAVAILABLE, evidence: n.reason ?? 'no published description' };
}

function classifyDexPaid(r) {
  const p = r.dexPaid;
  if (!p) return { outcome: OUTCOME.UNAVAILABLE };
  if (p.paid === true) return { outcome: OUTCOME.MEASURED, value: 'paid' };
  if (p.paid === false) return { outcome: OUTCOME.CONFIRMED_ZERO, value: 'not paid' };
  return { outcome: OUTCOME.UNKNOWN, evidence: p.status ?? null };
}

// ---------------------------------------------------------------------------

const rows = [];
for (const t of tokens) {
  const started = Date.now();
  let r;
  try {
    r = await liveScan({ chain: t.chain, address: t.address });
  } catch (err) {
    r = { status: 'error', detail: String(err?.message ?? err) };
  }

  // Narrative comes from its own pipeline, so it gets its own call.
  let research = null;
  if (!SKIP_NARRATIVE) {
    try {
      research = await researchToken({
        chain: t.chain,
        address: t.address,
        symbol: t.symbol,
        name: t.name ?? null,
        scanResult: r.status === 'ok' ? r : null,
        // No paid X requests: the benchmark must not spend money.
        includePosts: false,
        xCacheOnly: true,
      });
    } catch (err) {
      research = { narrative: { available: false, reason: 'provider-error', detail: String(err?.message ?? err) } };
    }
  }

  const fields = {
    narrative: classifyNarrative(research),
    holders: classifyHolders(r),
    top10: classifyTop10(r),
    tax: classifyTax(r),
    lp: classifyLp(r),
    dev: classifyDev(r),
    dexPaid: classifyDexPaid(r),
  };

  // Card/risk consistency: the quick-check values must match the risk block they came from.
  let consistent = true;
  let inconsistency = null;
  if (r.riskStatus === 'ok' && r.risk) {
    for (const key of ['top10', 'holders', 'lpLock', 'tax', 'dev']) {
      const q = resolveQuickCheck(key, r);
      if (q.cls?.state === 'verified' && q.value === '—') {
        consistent = false;
        inconsistency = `${key}: verified but rendered as dash`;
        break;
      }
    }
  }

  rows.push({
    symbol: t.symbol,
    chain: t.chain,
    address: t.address,
    role: t.role,
    scanStatus: r.status,
    riskStatus: r.riskStatus ?? null,
    ms: Date.now() - started,
    fields,
    consistent,
    inconsistency,
    evidence: {
      pairAddress: r.source?.pairAddress ?? null,
      labels: r.source?.labels ?? null,
      riskDetail: r.riskDetail ?? null,
      lpDetail: r.risk?.lpLock?.positionTypeDetail ?? r.risk?.lpLock?.detail ?? null,
      narrativeSource: research?.narrative?.summarySource ?? null,
      narrativeReason: research?.narrative?.reason ?? null,
      narrativeCoverage: research?.narrative?.coverage ?? null,
      // Whether the SCAN itself answered. Provider throttling varies run to run, and a field
      // that flips between runs is a throttle, not a regression - recording the scan status
      // lets that distinction be made from stored data instead of by re-running.
      scanStatus: r.status,
      riskStatus: r.riskStatus ?? null,
    },
  });

  const cell = (f) => ({ measured: 'M', zero: '0', partial: 'P', na: 'N/A', unavailable: 'u', 'rate-limited': 'RL', unsupported: 'U', unknown: '?' }[f.outcome] ?? '?');
  console.log(
    (t.symbol ?? '').slice(0, 10).padEnd(11),
    t.chain.padEnd(10),
    'nar=' + cell(fields.narrative),
    'hold=' + cell(fields.holders),
    'top10=' + cell(fields.top10),
    'tax=' + cell(fields.tax),
    'lp=' + cell(fields.lp),
    'dev=' + cell(fields.dev),
    'paid=' + cell(fields.dexPaid),
    consistent ? '' : ' ⚠INCONSISTENT',
  );

  await new Promise((res) => setTimeout(res, 1200));
}

// ---- aggregation ----------------------------------------------------------
const FIELD_NAMES = ['narrative', 'holders', 'top10', 'tax', 'lp', 'dev', 'dexPaid'];

function rate(filter, field) {
  const subset = rows.filter(filter);
  if (!subset.length) return { n: 0, covered: 0, pct: null };
  const covered = subset.filter((r) => COUNTS_AS_COVERED.has(r.fields[field].outcome)).length;
  return { n: subset.length, covered, pct: Math.round((covered / subset.length) * 100) };
}

const summary = { total: rows.length, byChain: {}, byField: {}, outcomes: {} };

for (const f of FIELD_NAMES) {
  summary.outcomes[f] = {};
  for (const r of rows) {
    const o = r.fields[f].outcome;
    summary.outcomes[f][o] = (summary.outcomes[f][o] ?? 0) + 1;
  }
  summary.byField[f] = rate(() => true, f);
}

const chains = [...new Set(rows.map((r) => r.chain))];
for (const c of chains) {
  summary.byChain[c] = { n: 0 };
  summary.byChain[c].n = rows.filter((r) => r.chain === c).length;
  for (const f of FIELD_NAMES) summary.byChain[c][f] = rate((r) => r.chain === c, f);
}

console.log('\n=== RAW COVERAGE (all tokens, all classes) ===');
for (const f of FIELD_NAMES) {
  const b = summary.byField[f];
  const o = summary.outcomes[f];
  console.log(
    f.padEnd(10),
    `${b.covered}/${b.n} = ${b.pct}%`.padEnd(16),
    Object.entries(o).map(([k, v]) => `${k}:${v}`).join(' '),
  );
}

console.log('\n=== BY CHAIN ===');
for (const c of chains) {
  const row = summary.byChain[c];
  console.log(
    c.padEnd(10), `n=${row.n}`.padEnd(5),
    FIELD_NAMES.map((f) => `${f}=${row[f].pct}%`).join(' '),
  );
}

const inconsistent = rows.filter((r) => !r.consistent);
console.log('\nconsistency:', rows.length - inconsistent.length, '/', rows.length,
  inconsistent.length ? `— ${inconsistent.length} INCONSISTENT` : '(100%)');

fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
console.log('\nwrote', OUT);
