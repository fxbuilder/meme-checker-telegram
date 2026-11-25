/**
 * src/risk-classify.mjs
 *
 * THE single severity engine. Every surface — the main token card, /risk, /dev, the
 * security summary — must call these functions. Nothing else may define its own
 * thresholds.
 *
 * WHY THIS EXISTS
 * The OWNER reported a token whose Top 10 concentration was 20%: GREEN on the main card
 * and YELLOW on the detailed security card, for the same number. The cause was two
 * independent scales:
 *
 *   card-layout.mjs : v >= 50 ? 'bad' : v >= 25 ? 'warn' : 'good'   -> green at 20
 *   risk-commands.mjs concentrationTone(): >=50 high, >=25 elevated, else 'low'
 *                     icon('low') -> YELLOW                          -> yellow at 20
 *
 * Two thresholds and two colour vocabularies over one measurement. Any future edit to
 * either file would have re-broken it silently.
 *
 * FOUR EVIDENCE STATES, never collapsed:
 *   'verified'     measured, and the value is usable
 *   'unknown'      eligible for measurement but unavailable -> NEVER green
 *   'not-applicable' the concept cannot exist for this token/model -> N/A
 *   'conflicting'  measured twice with irreconcilable results -> reported as unknown,
 *                  with the conflict named rather than silently picking one
 */

/** Severity bands, ordered least to most severe. */
export const SEVERITY = ['none', 'low', 'medium', 'high', 'critical'];

/** Capability state for a single field. */
export const FIELD_STATE = {
  VERIFIED: 'verified',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not-applicable',
  UNSUPPORTED: 'unsupported',
  CONFLICTING: 'conflicting',
};

/**
 * One glyph vocabulary for every surface.
 *
 * `unknown` is deliberately NOT green and NOT red: it is grey. A missing value must never
 * look like a pass, and must not look like an accusation either.
 */
export const SEVERITY_ICON = {
  none: '\u{1F7E2}',      // green  - a real, measured absence of risk
  low: '\u{1F7E2}',       // green  - measured and acceptable
  medium: '\u{1F7E1}',    // yellow - worth a look
  high: '\u{1F534}',      // red    - material risk
  critical: '\u{1F534}',  // red
  unknown: '\u26AA',      // grey   - not measured; never a verdict
  'not-applicable': '\u2796', // minus - proven not applicable
};

/**
 * Top-10 holder concentration.
 *
 * Thresholds are stated once, here, with the reasoning:
 *   0-19.99%  low      widely distributed for a memecoin
 *   20-49.99% medium   a handful of wallets can move the price
 *   50%+      high     majority supply in ten wallets
 *
 * 20% is therefore MEDIUM, and it is medium on every surface.
 */
export const TOP10_BANDS = [
  { min: 50, severity: 'high' },
  { min: 20, severity: 'medium' },
  { min: 0, severity: 'low' },
];

/**
 * The precision a percentage is DISPLAYED at.
 *
 * Severity is banded on the rounded value on purpose. The OWNER saw "20.0%" rendered in
 * green: the provider returned 19.98, the card rounded it to 20.0% for display, but the
 * band was computed on the raw 19.98 and fell below the 20 line. The number on screen and
 * the number driving the colour disagreed, which is the worst possible kind of defect
 * because it looks like a bug in the threshold rather than in the rounding.
 *
 * Rounding first means the verdict always describes what the reader can see.
 */
export const DISPLAY_PCT_DIGITS = 1;

export function classifyTop10(pct) {
  if (pct === null || pct === undefined || pct === '') {
    return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', value: null };
  }
  const n = Number(pct);
  // An impossible percentage is not "very high" - it is an inconsistency, and calling it
  // critical would accuse the token of something we cannot actually see.
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { state: FIELD_STATE.CONFLICTING, severity: 'unknown', value: null, reason: 'impossible-percentage' };
  }
  // Band on the value the user will read, so the colour and the printed number agree.
  const shown = Number(n.toFixed(DISPLAY_PCT_DIGITS));
  const band = TOP10_BANDS.find((b) => shown >= b.min);
  return { state: FIELD_STATE.VERIFIED, severity: band.severity, value: n, shown };
}

/**
 * Buy/sell tax, as a percentage per side.
 *
 *   measured 0%     -> none    (a real, measured absence)
 *   >0 to <5%       -> low
 *   5 to <10%       -> medium
 *   >=10%           -> high
 *
 * A missing tax is UNKNOWN, never `none`. "We could not measure it" and "it is zero" are
 * different statements and only one of them is a green light.
 */
export function classifyTax(buy, sell) {
  const val = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const b = val(buy);
  const s = val(sell);

  // A one-sided value stays one-sided. Copying the known side into the unknown one
  // fabricated a symmetric 4%/4% tax from a provider that only reported sell: 4%.
  const known = [b, s].filter((v) => v !== null);
  if (!known.length) return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', value: null };
  if (known.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) {
    return { state: FIELD_STATE.CONFLICTING, severity: 'unknown', value: null, reason: 'impossible-percentage' };
  }

  const hi = Math.max(...known);
  const severity = hi >= 10 ? 'high' : hi >= 5 ? 'medium' : hi > 0 ? 'low' : 'none';
  return {
    state: FIELD_STATE.VERIFIED,
    severity,
    value: { buy: b, sell: s },
    // True when only one side was measured, so the renderer can say which.
    partial: b === null || s === null,
  };
}

/**
 * A Token-2022 transfer fee.
 *
 * This is NOT a tax. It applies to every transfer, not to a trade, so it gets its own
 * classifier and its own label. `not-applicable` is reserved for a VERIFIED legacy SPL
 * token, where the concept genuinely does not exist.
 */
export function classifyTransferFee(pct, standard) {
  if (standard === 'spl-token') {
    return { state: FIELD_STATE.NOT_APPLICABLE, severity: 'none', value: null };
  }
  if (pct === null || pct === undefined || pct === '') {
    return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', value: null };
  }
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { state: FIELD_STATE.CONFLICTING, severity: 'unknown', value: null, reason: 'impossible-percentage' };
  }
  const severity = n >= 5 ? 'high' : n > 0 ? 'medium' : 'none';
  return { state: FIELD_STATE.VERIFIED, severity, value: n };
}

/**
 * LP lock state.
 *
 * BURNED and LOCKED are different guarantees and are never summed into one number:
 *   burned  the LP mint was destroyed; withdrawal is impossible, permanently.
 *   locked  held by a locker contract; withdrawable when the term ends.
 *
 * An unknown state is UNKNOWN, never 'unlocked'. "We could not tell" must not read as
 * "the liquidity is free to be pulled".
 */
export function classifyLiquidity(lp) {
  if (!lp) return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', kind: null };

  const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const burned = num(lp.burnedPercentage);
  const locked = num(lp.lockedPercentage);

  // Pre-graduation bonding curve: liquidity is not "locked", the curve simply has not
  // opened a pool yet. A distinct state so it is never reported as unlocked.
  if (lp.kind === 'bonding-curve' || lp.state === 'bonding-curve') {
    return { state: FIELD_STATE.VERIFIED, severity: 'medium', kind: 'bonding-curve', value: null };
  }

  // A V3/V4 pool is a DETERMINED POOL TYPE, not an unknown value.
  //
  // We know exactly why the lock state is unavailable: liquidity sits in position NFTs that
  // have no fungible LP supply to measure, so balanceOf/totalSupply maths cannot apply. The
  // OWNER flagged ambiguous dashes, and this is precisely one - the field looked unchecked
  // when in fact the pool had been identified and could not be checked by design.
  //
  // Severity is deliberately 'unknown' rather than green: a pool we cannot assess is not a
  // safe pool, so it must not display a reassurance.
  if (lp.positionType === 'v3-v4') {
    return { state: FIELD_STATE.VERIFIED, severity: 'unknown', kind: 'position-pool', value: null };
  }

  if (burned !== null && burned >= 50) {
    return {
      state: FIELD_STATE.VERIFIED,
      severity: burned >= 95 ? 'none' : 'low',
      kind: 'burned',
      value: burned,
    };
  }
  if (locked !== null && locked > 0) {
    // A time lock may expire; the expiry is a separate fact we may not have.
    const expired = lp.expiresAt != null && Number(lp.expiresAt) * 1000 < Date.now();
    const severity = expired
      ? 'high'
      : locked >= 90 ? 'low' : locked >= 50 ? 'medium' : 'high';
    return {
      state: FIELD_STATE.VERIFIED,
      severity,
      // 95%+ of the LP supply held by a locker is "locked" in the sense a reader means:
      // the overwhelming majority cannot be pulled. Below that it is genuinely partial,
      // and saying "locked" would overstate the protection.
      kind: expired ? 'unlocked' : (locked >= 95 ? 'locked' : 'partially-locked'),
      value: locked,
      expiresAt: lp.expiresAt ?? null,
    };
  }
  // A MEASURED zero on either axis is "unlocked", not unknown. `{lockedPercentage: 0}`
  // with no burn field means the provider reported a real zero lock: the liquidity can be
  // pulled. Treating that as unknown would hide a genuine risk behind a dash.
  // An on-chain read that found NO burn and NO verified locker is a real finding: the
  // liquidity is withdrawable by whoever holds the LP. Reported as 'unlocked' rather than
  // hidden, because "we checked the pool and it is not secured" is a genuine risk signal.
  if (lp.kind === 'not-burned') {
    return { state: FIELD_STATE.VERIFIED, severity: 'high', kind: 'unlocked', value: 0 };
  }
  if (burned === 0 || locked === 0) {
    return { state: FIELD_STATE.VERIFIED, severity: 'high', kind: 'unlocked', value: 0 };
  }
  return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', kind: null };
}

/** A boolean risk flag: true is dangerous, false is a measured pass. */
export function classifyFlag(value, { notApplicable = false } = {}) {
  if (notApplicable) return { state: FIELD_STATE.NOT_APPLICABLE, severity: 'none', value: null };
  if (value === true) return { state: FIELD_STATE.VERIFIED, severity: 'high', value: true };
  if (value === false) return { state: FIELD_STATE.VERIFIED, severity: 'none', value: false };
  return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', value: null };
}

/**
 * Honeypot risk as an explicit LEVEL.
 *
 * A provider flag is a yes/no. Presenting "No" as a green tick overstates what was
 * verified — a token can pass one simulation and still trap holders — so the level is
 * stated, and UNKNOWN stays grey.
 */
export function classifyHoneypot(value) {
  if (value === true) return { state: FIELD_STATE.VERIFIED, severity: 'critical', level: 'HIGH' };
  if (value === false) return { state: FIELD_STATE.VERIFIED, severity: 'low', level: 'LOW' };
  return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', level: 'UNKNOWN' };
}

/** Create as a percentage of supply. */
export function classifyCreatorHolding(pct) {
  if (pct === null || pct === undefined || pct === '') {
    return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', value: null };
  }
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { state: FIELD_STATE.CONFLICTING, severity: 'unknown', value: null, reason: 'impossible-percentage' };
  }
  const severity = n >= 10 ? 'high' : n > 0 ? 'medium' : 'none';
  return { state: FIELD_STATE.VERIFIED, severity, value: n };
}

/**
 * RugCheck's own published score.
 *
 * Kept provider-specific on purpose: it is RugCheck's methodology, and presenting another
 * vendor's figure under this name would be a fabricated attribution. 0 = clean,
 * 100 = worst.
 */
export function classifyRugCheckScore(score) {
  if (score === null || score === undefined || score === '') {
    return { state: FIELD_STATE.UNKNOWN, severity: 'unknown', value: null };
  }
  const n = Number(score);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { state: FIELD_STATE.CONFLICTING, severity: 'unknown', value: null, reason: 'out-of-range' };
  }
  const severity = n >= 50 ? 'high' : n >= 20 ? 'medium' : 'low';
  return { state: FIELD_STATE.VERIFIED, severity, value: n };
}

/**
 * The display token for a state.
 *
 * `null` means "render the value"; otherwise it is the literal placeholder, so every
 * surface shows the same text for the same state. N/A and UNKNOWN are deliberately
 * different strings: `N/A` is a proven non-concept, `UNKNOWN` is an unmeasured one.
 */
export function statePlaceholder(state) {
  if (state === FIELD_STATE.NOT_APPLICABLE) return 'N/A';
  if (state === FIELD_STATE.UNSUPPORTED) return 'n/a';
  return 'UNKNOWN';
}

/** Icon for a field classification. */
export function iconFor(classification) {
  if (!classification) return SEVERITY_ICON.unknown;
  if (classification.state === FIELD_STATE.UNKNOWN) return SEVERITY_ICON.unknown;
  if (classification.state === FIELD_STATE.NOT_APPLICABLE) return SEVERITY_ICON['not-applicable'];
  if (classification.state === FIELD_STATE.CONFLICTING) return SEVERITY_ICON.unknown;
  return SEVERITY_ICON[classification.severity] ?? SEVERITY_ICON.unknown;
}

/**
 * Classify a whole risk block at once.
 *
 * Every consumer calls this, so card and /risk are the same computation by construction
 * rather than by two implementations happening to agree.
 */
export function classifyRiskBlock(risk) {
  const d = risk ?? {};
  const sec = d.security ?? {};
  return {
    top10: classifyTop10(d.holders?.top10Percentage),
    holders: d.holders?.total != null && Number(d.holders.total) > 0
      ? { state: FIELD_STATE.VERIFIED, severity: 'none', value: Number(d.holders.total) }
      : { state: FIELD_STATE.UNKNOWN, severity: 'unknown', value: null },
    largestHolder: classifyTop10(d.holders?.largestHolderPercentage),
    tax: d.tax?.kind === 'transfer-fee'
      ? classifyTransferFee(d.tax.pct, 'token-2022')
      : d.tax?.kind === 'not-applicable'
        ? classifyTransferFee(null, 'spl-token')
        : classifyTax(d.tax?.buy ?? null, d.tax?.sell ?? null),
    liquidity: classifyLiquidity(d.lpLock),
    creator: classifyCreatorHolding(d.dev?.balancePercentage),
    honeypot: classifyHoneypot(sec.honeypot),
    mintable: classifyFlag(sec.mintable),
    freezable: classifyFlag(sec.freezable),
    hiddenOwner: classifyFlag(sec.hiddenOwner),
    canTakeBackOwnership: classifyFlag(sec.canTakeBackOwnership),
    rugcheckScore: classifyRugCheckScore(sec.rugcheckScore),
  };
}
