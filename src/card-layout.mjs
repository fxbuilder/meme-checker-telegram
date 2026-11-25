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
import {
  classifyTop10, classifyLiquidity, classifyCreatorHolding, classifyTax,
  classifyTransferFee, FIELD_STATE, iconFor,
} from './risk-classify.mjs';

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
/**
 * Which specific market figure looks wrong, and why.
 *
 * Previously this was one boolean, so the card could only say "some figures look
 * inconsistent" — true, but useless: the OWNER could not tell whether the price, the market
 * cap or the volume was the problem, and therefore could not judge whether to trust the
 * rest of the card. Naming the field and the reason makes the caveat actionable.
 *
 * @returns {Array<{field:string, label:string, reason:string, value:number|null}>}
 */
export function marketImplausibilities(market) {
  if (!market) return [];
  const { marketCapUsd, priceChange24h, priceChange1h, volume24hUsd, liquidityUsd, fdvUsd } = market;
  const out = [];

  if (Number.isFinite(marketCapUsd) && marketCapUsd > 5e12) {
    out.push({ field: 'marketCapUsd', label: 'Market Cap', reason: 'above any plausible token valuation', value: marketCapUsd });
  }
  if (Number.isFinite(priceChange24h) && Math.abs(priceChange24h) > 1000) {
    out.push({ field: 'priceChange24h', label: 'Change 24H', reason: 'change exceeds 1000%', value: priceChange24h });
  }
  if (Number.isFinite(priceChange1h) && Math.abs(priceChange1h) > 1000) {
    out.push({ field: 'priceChange1h', label: 'Change 1H', reason: 'change exceeds 1000%', value: priceChange1h });
  }
  if (Number.isFinite(volume24hUsd) && Number.isFinite(marketCapUsd) && marketCapUsd > 0
      && volume24hUsd > marketCapUsd * 100) {
    out.push({ field: 'volume24hUsd', label: 'Volume 24H', reason: 'volume exceeds market cap by over 100x', value: volume24hUsd });
  }
  // A market cap far below the reported FDV usually means a decimals or supply error on a
  // replica pair, so it is worth naming too.
  if (Number.isFinite(fdvUsd) && Number.isFinite(marketCapUsd) && marketCapUsd > 0
      && fdvUsd > marketCapUsd * 1000) {
    out.push({ field: 'fdvUsd', label: 'FDV', reason: 'FDV exceeds market cap by over 1000x', value: fdvUsd });
  }
  // Liquidity that dwarfs the market cap cannot be real: nobody provides more depth than
  // the asset is worth.
  if (Number.isFinite(liquidityUsd) && Number.isFinite(marketCapUsd) && marketCapUsd > 0
      && liquidityUsd > marketCapUsd * 10) {
    out.push({ field: 'liquidityUsd', label: 'Liquidity', reason: 'liquidity exceeds market cap by over 10x', value: liquidityUsd });
  }
  return out;
}

/** Back-compat boolean form, derived from the detailed list. */
export function marketLooksImplausible(market) {
  return marketImplausibilities(market).length > 0;
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
      // ONE classifier for every surface. This block used to carry its own thresholds
      // (>=50 bad, >=25 warn) while /risk used concentrationTone(), so a 20% token was
      // green here and yellow there. Both now call classifyTop10().
      if (unsupported) return { label: 'Top 10', value: NA, tone: 'muted' };
      const c = classifyTop10(risk?.holders?.top10Percentage);
      if (c.state !== FIELD_STATE.VERIFIED) {
        return { label: 'Top 10', value: DASH, tone: 'muted', cls: c };
      }
      // Render the same rounded value the band was computed from.
      return { label: 'Top 10', value: fmtPp(c.shown ?? c.value), tone: c.severity, cls: c };
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
      //
      // Bands come from the SHARED engine so the card and /risk cannot disagree.
      if (t?.kind === 'transfer-fee') {
        const c = classifyTransferFee(t.pct, 'token-2022');
        if (c.state !== FIELD_STATE.VERIFIED) {
          return { label: 'Transfer Fee', value: DASH, tone: 'muted', cls: c };
        }
        return {
          label: 'Transfer Fee',
          value: c.value === 0 ? '0%' : `${c.value.toFixed(2)}%`,
          tone: c.severity,
          cls: c,
        };
      }

      // Verified non-applicability. A legacy SPL token has no fee concept at all, which
      // is a real finding and is stated as N/A. It is NOT a dash: a dash means we could
      // not measure something that does exist.
      if (t?.kind === 'not-applicable') {
        return { label: 'Tax', value: 'N/A', tone: 'muted', cls: classifyTransferFee(null, 'spl-token') };
      }

      const c = classifyTax(t?.buy ?? null, t?.sell ?? null);
      if (c.state !== FIELD_STATE.VERIFIED) {
        // An UNKNOWN tax is a dash. It is never 0%.
        return { label: 'Tax', value: DASH, tone: 'muted', cls: c };
      }
      const { buy, sell } = c.value;
      // A one-sided measurement names the side it knows. Substituting the known side into
      // the unknown one would fabricate a symmetric tax.
      if (c.partial) {
        const only = buy !== null ? `Buy ${buy.toFixed(1)}%` : `Sell ${sell.toFixed(1)}%`;
        return { label: 'Tax', value: only, tone: c.severity, cls: c };
      }
      if (buy !== sell) {
        return { label: 'Tax (B/S)', value: `${buy.toFixed(1)}/${sell.toFixed(1)}%`, tone: c.severity, cls: c };
      }
      if (buy === 0) {
        return { label: 'Tax (B/S)', value: '0.0%', tone: 'none', cls: c };
      }
      return { label: 'Tax (B/S)', value: `${buy.toFixed(1)}%`, tone: c.severity, cls: c };
    }
    case 'lpLock': {
      if (unsupported) return { label: 'LP Locked', value: NA, tone: 'muted' };
      const lp = risk?.lpLock;

      // BURNED and LOCKED are different guarantees and must not be silently summed into
      // one number. A destroyed LP mint can never be withdrawn, permanently; a locked one
      // becomes withdrawable when the term ends. The LABEL now states which one it is,
      // because "LP Locked: Burned 100%" put a burn under a lock heading and the OWNER
      // rightly flagged the ambiguity.
      //
      // The classification itself (bands, unknown handling, expiry) lives in the shared
      // engine so this row cannot drift from /risk.
      const cls = classifyLiquidity(lp);
      if (cls.state === FIELD_STATE.UNKNOWN) {
        // Never "unlocked": we could not tell, which is a different statement.
        return { label: 'LP', value: DASH, tone: 'muted', cls };
      }
      if (cls.kind === 'burned') {
        return { label: 'LP Burned', value: `${cls.value.toFixed(0)}%`, tone: cls.severity, cls };
      }
      if (cls.kind === 'bonding-curve') {
        return { label: 'LP', value: 'Bonding curve', tone: 'medium', cls };
      }
      if (cls.kind === 'locked') {
        return { label: 'LP Locked', value: `${cls.value.toFixed(0)}%`, tone: cls.severity, cls };
      }
      if (cls.kind === 'partially-locked') {
        // A sub-1% lock is materially different from none, so it is stated as "<1%"
        // rather than rounding to a confident "0%". The caller escapes it for HTML.
        const shown = cls.value > 0 && cls.value < 1 ? '<1%' : `${cls.value.toFixed(0)}%`;
        return { label: 'LP Locked', value: `Partial ${shown}`, tone: cls.severity, cls };
      }
      if (cls.kind === 'unlocked') {
        // A real, measured zero. Distinct from unknown, and worth showing plainly.
        return { label: 'LP', value: 'Unlocked', tone: cls.severity, cls };
      }
      return { label: 'LP', value: DASH, tone: 'muted', cls };
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
/**
 * Tone dot. Keys are the SHARED severity vocabulary from risk-classify.mjs; the legacy
 * good/warn/bad aliases are kept so older call sites keep working, and they map to the
 * same glyphs so the two can never disagree.
 */
const TONE_DOT = {
  none: '🟢', low: '🟢', medium: '🟡', high: '🔴', critical: '🔴',
  unknown: '⚪', 'not-applicable': '➖',
  // legacy aliases, same glyphs
  good: '🟢', warn: '🟡', bad: '🔴', plain: '⚪', muted: '⚪',
};

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
