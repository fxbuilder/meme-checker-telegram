/**
 * src/card-layout.mjs
 * Card presentation layer — compact (default) and detailed render modes.
 *
 * Design intent (Meme Checker's own identity, not a Phanes copy):
 *   - dense but breathable: no repeated horizontal rules between every section
 *   - the CA sits directly under the token identity, on its own copyable line
 *   - "Quick Checks" gives six at-a-glance risk signals in a fixed 3x2 grid so
 *     repeat users learn where to look
 *   - every unavailable value is stated in one short token, never omitted in a
 *     way that looks like "all clear"
 *
 * HONESTY CONTRACT (enforced by tests):
 *   null  → "—"  (checked, provider did not report it)
 *   absent/unsupported → "n/a" (this chain has no such data)
 *   never 0, never "No", never "Not Paid" for an unknown
 */

/**
 * Risk-status vocabulary. `pending` should never reach a card; it means the
 * caller forgot to enrich.
 */
export const QUICK_CHECK_KEYS = ['top10', 'holders', 'dexPaid', 'tax', 'lpLock', 'dev'];

const DASH = '—';
const NA = 'n/a';

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Compact money formatting: $1.2M, $845K, $0.00000123. */
export function fmtUsd(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v === 0) return '$0';
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(digits)}`;
}

/**
 * Percentage display with a sanity clamp.
 * A real token can move a lot, but "+1007903.00%" is not a useful figure and is
 * usually bad provider data (observed: a Solana WETH replica pair reported a
 * +1,007,903% 24h change and a $1.5T market cap). Clamping the DISPLAY keeps the
 * card readable without altering or hiding the underlying value.
 */
export function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v > 1000) return '>+1000%';
  if (v < -100) return '<-100%';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/**
 * True when a market figure looks implausible enough that the card should not
 * present it as a clean fact. Used for a disclosure note, never to suppress the
 * value — the reader decides, we just stop implying precision.
 */
export function marketLooksImplausible(market) {
  if (!market) return false;
  const { marketCapUsd, priceChange24h, priceChange1h, volume24hUsd } = market;
  if (Number.isFinite(marketCapUsd) && marketCapUsd > 5e12) return true;   // > $5T
  if (Number.isFinite(priceChange24h) && Math.abs(priceChange24h) > 1000) return true;
  if (Number.isFinite(priceChange1h) && Math.abs(priceChange1h) > 1000) return true;
  // Volume exceeding market cap by 100x is almost always a unit/decimals error.
  if (Number.isFinite(volume24hUsd) && Number.isFinite(marketCapUsd) &&
      marketCapUsd > 0 && volume24hUsd > marketCapUsd * 100) return true;
  return false;
}

function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v).toLocaleString('en-US');
}

/** Percentage points, already in 0-100 space. */
function fmtPp(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  return `${v.toFixed(digits)}%`;
}

/**
 * Resolve one quick check into { label, value, tone }.
 * tone: 'good' | 'warn' | 'bad' | 'muted' — presentation only, never a verdict
 * the data does not support.
 */
export function resolveQuickCheck(key, result) {
  const risk = result?.risk ?? null;
  const riskStatus = result?.riskStatus ?? 'pending';
  // Distinguish "this chain has no source" from "source said nothing".
  const unsupported = riskStatus === 'unsupported';
  const noData = riskStatus === 'no-data' || riskStatus === 'error';
  const unavailable = unsupported ? NA : DASH;

  switch (key) {
    case 'top10': {
      const v = risk?.holders?.top10Percentage;
      if (v == null) {
        return { label: 'Top 10', value: unavailable, tone: 'muted' };
      }
      // Concentration thresholds are conventional, not a safety guarantee.
      const tone = v >= 50 ? 'bad' : v >= 25 ? 'warn' : 'good';
      return { label: 'Top 10', value: fmtPp(v), tone };
    }
    case 'holders': {
      const v = risk?.holders?.total;
      if (v == null) return { label: 'Holders', value: unavailable, tone: 'muted' };
      return { label: 'Holders', value: fmtInt(v), tone: 'plain' };
    }
    case 'dexPaid': {
      const st = result?.dexPaid?.status ?? 'unknown';
      if (st === 'paid') return { label: 'Dex Paid', value: 'Paid', tone: 'good' };
      if (st === 'not-paid') return { label: 'Dex Paid', value: 'Not Paid', tone: 'muted' };
      // 'unknown' covers both "chain not indexed" and "provider failed".
      return {
        label: 'Dex Paid',
        value: 'Unknown',
        tone: 'muted',
        // Surfaced in detailed mode so the reader knows why it is unknown.
        reason: result?.dexPaid?.detail ?? null,
      };
    }
    case 'tax': {
      // Solana has no buy/sell tax concept at all.
      if (unsupported) return { label: 'Tax', value: NA, tone: 'muted' };
      const t = risk?.tax;
      if (!t || (t.buy == null && t.sell == null)) {
        return { label: 'Tax', value: DASH, tone: 'muted' };
      }
      if (t.buy == null || t.sell == null) {
        // Partial: show what we have, flagged.
        const only = t.buy != null ? `Buy ${t.buy.toFixed(1)}%` : `Sell ${t.sell.toFixed(1)}%`;
        return { label: 'Tax', value: only, tone: 'muted' };
      }
      const hi = Math.max(t.buy, t.sell);
      const tone = hi >= 10 ? 'bad' : hi > 0 ? 'warn' : 'good';
      // Symmetric taxes collapse to one number so the line stays compact.
      const value = t.buy === t.sell
        ? `${t.buy.toFixed(1)}%`
        : `${t.buy.toFixed(1)}/${t.sell.toFixed(1)}%`;
      return { label: 'Tax', value, tone };
    }
    case 'lpLock': {
      if (unsupported) return { label: 'LP Lock', value: NA, tone: 'muted' };
      const lp = risk?.lpLock;
      if (!lp || lp.lockedPercentage == null) {
        return { label: 'LP Lock', value: DASH, tone: 'muted' };
      }
      const locked = lp.lockedPercentage;
      const tone = locked >= 90 ? 'good' : locked >= 50 ? 'warn' : 'bad';
      // Sub-1% is real but not "0%" — a tiny locked sliver is different from none.
      if (locked > 0 && locked < 1) return { label: 'LP Lock', value: '<1%', tone: 'bad' };
      return { label: 'LP Lock', value: `${locked.toFixed(0)}%`, tone };
    }
    case 'dev': {
      if (unsupported) return { label: 'Dev', value: NA, tone: 'muted' };
      const d = risk?.dev;
      if (!d || (!d.address && d.balancePercentage == null)) {
        return { label: 'Dev', value: DASH, tone: 'muted' };
      }
      if (d.balancePercentage != null) {
        const tone = d.balancePercentage >= 10 ? 'bad' : d.balancePercentage > 0 ? 'warn' : 'good';
        // This is the dev's CURRENT holding, not a dev-history verdict.
        const shown = d.balancePercentage > 0 && d.balancePercentage < 0.1
          ? '<0.1%'
          : `${d.balancePercentage.toFixed(1)}%`;
        return { label: 'Dev', value: shown, tone };
      }
      // We know a dev exists but not the holding — say so rather than "0%".
      return { label: 'Dev', value: 'Known', tone: 'muted' };
    }
    default:
      return { label: key, value: DASH, tone: 'muted' };
  }
}

/** All six, in fixed order so the grid is learnable. */
export function quickChecks(result) {
  return QUICK_CHECK_KEYS.map((k) => ({ key: k, ...resolveQuickCheck(k, result) }));
}

/**
 * Render the quick checks as a compact 2-per-line grid.
 * Two per line is the safest width for Telegram mobile.
 *
 * Values are escaped: "<1%" is a legal value here but an illegal HTML tag
 * opener, and Telegram rejects the whole message with "Unclosed start tag".
 * Unit tests that only compare strings cannot catch that — this escape is what
 * makes the card sendable.
 */
export function renderQuickChecks(result, e) {
  const items = quickChecks(result);
  const escVal = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [];
  lines.push(`${e('🛡️')} <b>QUICK CHECKS</b>`);
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2).map((it) => `${it.label}: ${escVal(it.value)}`);
    lines.push(pair.join('  ·  '));
  }
  return lines;
}

/** True when every quick check is unavailable — used to avoid a hollow block. */
export function allQuickChecksEmpty(result) {
  return quickChecks(result).every((it) => it.value === DASH || it.value === NA);
}
