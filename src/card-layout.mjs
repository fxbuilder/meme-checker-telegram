/**
 * src/card-layout.mjs
 * Card presentation layer — STANDARD (bot default), SHORT and DETAILED.
 *
 * DESIGN INTENT
 * Readable first. The card should scan like a well-set data panel, not a
 * terminal log: clear identity header, then labelled metric rows with aligned
 * labels, grouped under short section headers, separated by whitespace rather
 * than stacked horizontal rules.
 *
 * The single dense line "MC $1.5B · Liq $24M · 24H +8%" is deliberately NOT
 * used for the standard card — it is hard to scan, and treating "compact" as
 * "fewer characters" was the previous revision's mistake. Metrics are emitted
 * as aligned label/value rows, full-width where the value needs the room.
 *
 * HONESTY CONTRACT (enforced by tests, never overridden for brevity)
 *   value  — measured
 *   "—"    — this source covers the chain but reported nothing for the token
 *   "n/a"  — this chain has no such data source at all
 *   Never 0, never "No", never "Not Paid" for an unknown. A material warning is
 *   never dropped to make the card shorter.
 */
import { getChain } from './chains.mjs';

export const QUICK_CHECK_KEYS = ['top10', 'holders', 'dexPaid', 'tax', 'lpLock', 'dev'];

const DASH = '—';
const NA = 'n/a';

/** Telegram HTML escape. Applied at the point every value is interpolated. */
export function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtUsd(v, digits = 8) {
  if (v == null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (v === 0) return '$0';
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(digits)}`;
}

/**
 * Percentage display with a sanity clamp.
 * The DISPLAY is clamped; the underlying value is untouched. Both clamp strings
 * contain "<"/">" and MUST be escaped by whatever interpolates them.
 */
export function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v > 1000) return '>+1000%';
  if (v < -100) return '<-100%';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v).toLocaleString('en-US');
}

export function fmtPp(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  return `${v.toFixed(digits)}%`;
}

/**
 * True when a market figure looks internally inconsistent enough that the card
 * should say so. Used for a disclosure, never to suppress the number.
 */
export function marketLooksImplausible(market) {
  if (!market) return false;
  const { marketCapUsd, priceChange24h, priceChange1h, volume24hUsd } = market;
  if (Number.isFinite(marketCapUsd) && marketCapUsd > 5e12) return true;
  if (Number.isFinite(priceChange24h) && Math.abs(priceChange24h) > 1000) return true;
  if (Number.isFinite(priceChange1h) && Math.abs(priceChange1h) > 1000) return true;
  if (Number.isFinite(volume24hUsd) && Number.isFinite(marketCapUsd) &&
      marketCapUsd > 0 && volume24hUsd > marketCapUsd * 100) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Security metric resolution
// ---------------------------------------------------------------------------

/**
 * Resolve one security metric into { label, value, tone }.
 * tone is presentation only — it never asserts a verdict the data cannot support.
 */
export function resolveQuickCheck(key, result) {
  const risk = result?.risk ?? null;
  const riskStatus = result?.riskStatus ?? 'pending';
  const unsupported = riskStatus === 'unsupported';
  const unavailable = unsupported ? NA : DASH;

  switch (key) {
    case 'top10': {
      const v = risk?.holders?.top10Percentage;
      if (v == null) return { label: 'Top 10', value: unavailable, tone: 'muted' };
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
      return {
        label: 'Dex Paid',
        value: 'Unknown',
        tone: 'muted',
        reason: result?.dexPaid?.detail ?? null,
      };
    }
    case 'tax': {
      if (unsupported) return { label: 'Tax', value: NA, tone: 'muted' };
      const t = risk?.tax;

      // SOLANA HAS NO BUY/SELL TAX. A Token-2022 token may carry a TRANSFER FEE, which
      // applies to every transfer rather than to a trade. Calling it "tax" would be
      // wrong, and treating a missing value as "0%" would be a fabricated all-clear,
      // so it is labelled for what it is.
      if (t?.kind === 'transfer-fee') {
        if (t.pct == null) return { label: 'Transfer Fee', value: DASH, tone: 'muted' };
        const pct = Number(t.pct);
        if (!Number.isFinite(pct) || pct < 0) return { label: 'Transfer Fee', value: DASH, tone: 'muted' };
        if (pct === 0) return { label: 'Transfer Fee', value: '0%', tone: 'good' };
        const tone = pct >= 5 ? 'bad' : 'warn';
        return { label: 'Transfer Fee', value: `${pct.toFixed(2)}%`, tone };
      }

      // Verified non-applicability. A legacy SPL token has no fee concept at all, which
      // is a real finding and is stated as N/A. It is NOT a dash: a dash means we could
      // not measure something that does exist.
      if (t?.kind === 'not-applicable') {
        return { label: 'Tax', value: 'N/A', tone: 'muted' };
      }

      if (!t || (t.buy == null && t.sell == null)) {
        return { label: 'Tax', value: DASH, tone: 'muted' };
      }
      if (t.buy == null || t.sell == null) {
        const only = t.buy != null ? `Buy ${t.buy.toFixed(1)}%` : `Sell ${t.sell.toFixed(1)}%`;
        return { label: 'Tax', value: only, tone: 'muted' };
      }
      const hi = Math.max(t.buy, t.sell);
      const tone = hi >= 10 ? 'bad' : hi > 0 ? 'warn' : 'good';
      const value = t.buy === t.sell
        ? `${t.buy.toFixed(1)}%`
        : `${t.buy.toFixed(1)}/${t.sell.toFixed(1)}%`;
      return { label: 'Tax (B/S)', value, tone };
    }
    case 'lpLock': {
      if (unsupported) return { label: 'LP Locked', value: NA, tone: 'muted' };
      const lp = risk?.lpLock;
      if (!lp) return { label: 'LP Locked', value: DASH, tone: 'muted' };

      // BURNED and LOCKED are different guarantees and must not be silently summed
      // into one number. A destroyed LP mint can never be withdrawn; a locked one can
      // be unlocked when the timer ends. Solana providers report burn explicitly.
      //
      // NULL GUARD: Number(null) is 0, so a naive isFinite(Number(x)) test turns an
      // UNKNOWN into a confident "0% (unlocked)". That is a fabricated risk verdict,
      // and it is exactly the class of bug this block exists to prevent.
      const toNum = (v) => (v === null || v === undefined || v === '' ? null
        : (Number.isFinite(Number(v)) ? Number(v) : null));
      const burned = toNum(lp.burnedPercentage);
      const locked = toNum(lp.lockedPercentage);

      if (burned !== null && burned >= 50) {
        return { label: 'LP Locked', value: `Burned ${burned.toFixed(0)}%`, tone: 'good' };
      }
      if (locked === null) return { label: 'LP Locked', value: DASH, tone: 'muted' };
      // A tiny locked sliver is materially different from none.
      if (locked > 0 && locked < 1) return { label: 'LP Locked', value: '<1%', tone: 'bad' };
      const tone = locked >= 90 ? 'good' : locked >= 50 ? 'warn' : 'bad';
      return { label: 'LP Locked', value: `${locked.toFixed(0)}%`, tone };
    }
    case 'dev': {
      // "Creator Holds" is the creator's CURRENT balance, not dev history, and not a
      // dev-trading verdict. Mislabeling it would be a data-safety bug.
      //
      // The LABEL follows the role the provider actually reported, because a creator
      // (who minted the token) and a contract owner (who controls it now) are different
      // parties. Calling an owner a creator - or vice versa - attributes a holding to
      // the wrong address.
      if (unsupported) return { label: 'Creator Holds', value: NA, tone: 'muted' };
      const d = risk?.dev;
      const roleLabel = d?.role === 'owner' ? 'Owner Holds' : 'Creator Holds';
      if (!d || (!d.address && d.balancePercentage == null)) {
        return { label: 'Creator Holds', value: DASH, tone: 'muted' };
      }
      if (d.balancePercentage != null) {
        const tone = d.balancePercentage >= 10 ? 'bad' : d.balancePercentage > 0 ? 'warn' : 'good';
        const shown = d.balancePercentage > 0 && d.balancePercentage < 0.1
          ? '<0.1%'
          : `${d.balancePercentage.toFixed(1)}%`;
        return { label: roleLabel, value: shown, tone };
      }
      // Address known, balance unknown. "Known" would read as "no holding", so it is
      // described as an address we could not measure.
      return { label: roleLabel, value: 'Known', tone: 'muted' };
    }
    default:
      return { label: key, value: DASH, tone: 'muted' };
  }
}

export function quickChecks(result) {
  return QUICK_CHECK_KEYS.map((k) => ({ key: k, ...resolveQuickCheck(k, result) }));
}

/** True when nothing at all could be established about risk. */
export function allQuickChecksEmpty(result) {
  return quickChecks(result).every((it) => it.value === DASH || it.value === NA);
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

// Every security row carries exactly one leading marker so the label column
// always starts at the same offset. A row with no marker would shift its label
// and break the alignment that makes the block scannable.
const TONE_DOT = { good: '🟢', warn: '🟡', bad: '🔴', plain: '⚪', muted: '⚪' };

/**
 * One metric row: "Label: value", single space after the colon.
 *
 * Space-padding to force a value column was tried and REMOVED: Telegram renders
 * captions in a PROPORTIONAL font, so N spaces are not a fixed width. Measured
 * in a 14.5px system font, the padded prefixes came out 58/81/96/78px for rows
 * that were supposed to line up — the "alignment" made the block look ragged,
 * not clean. Column alignment in Telegram is only achievable with <pre>, which
 * cannot mix bold/link entities, so uniform single spacing is the honest choice.
 * Values are escaped here.
 */
export function metricRow(label, value) {
  return `${esc(String(label))}: ${esc(value)}`;
}

export function sectionTitle(emoji, title) {
  return `${emoji} <b>${title}</b>`;
}

/**
 * Aligned rows from {label,value} pairs. Labels padded to the longest label in
 * the group so every value starts at the same column.
 */
export function alignedRows(pairs) {
  return pairs.map((p) => {
    const prefix = p.icon ? `${p.icon} ` : '';
    return prefix + metricRow(p.label, p.value);
  });
}

/** Security pairs in fixed order, with a tone dot that aids scanning. */
export function securityPairs(result) {
  return quickChecks(result).map((it) => ({
    label: it.label,
    value: it.value,
    icon: TONE_DOT[it.tone] ?? '•',
    tone: it.tone,
  }));
}
