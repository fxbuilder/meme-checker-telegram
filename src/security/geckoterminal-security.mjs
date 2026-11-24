/**
 * src/security/geckoterminal-security.mjs
 * Security fields already present in the GeckoTerminal token-info response.
 *
 * WHY THIS MATTERS: we were ALREADY fetching this endpoint for narrative and discarding
 * the security fields inside it. On chains with no GoPlus coverage this is the only
 * keyless source of holder concentration, and it costs zero extra requests when the
 * narrative lookup has already run.
 *
 * WHAT IT ACTUALLY PROVIDES (verified per chain, not assumed):
 *   attributes.holders = { count, distribution_percentage: { top_10, 11_30, 31_50, rest } }
 *   attributes.mint_authority / freeze_authority  (null | address)
 *   attributes.is_honeypot                        ("true" | "false" | "unknown")
 *   attributes.developer_address / developer_holding_percentage
 *
 * COVERAGE IS UNEVEN AND MUST BE TREATED AS SUCH. In live testing:
 *   - unichain: top_10 71.59, mint/freeze authorities null, is_honeypot "unknown"
 *   - monad / robinhood: 404 for the specific tokens tested
 *   - developer_holding_percentage: null in EVERY sample seen
 * So every field is optional, and a missing field stays null rather than becoming a
 * reassuring default.
 *
 * A NOTE ON `is_honeypot: "unknown"`. That is a real provider answer meaning "not
 * determined" - it must not be read as false.
 */

/** GeckoTerminal reports honeypot as a string, including the literal "unknown". */
export function parseHoneypot(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  // "unknown", null, undefined and anything else: not determined.
  return null;
}

/** A number from a string like "71.5921", or null. Never coerces to 0. */
function pct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Number(n.toFixed(2));
}

/**
 * Extract the security-relevant subset from a GeckoTerminal token-info payload.
 *
 * @param {object} attributes  the `data.attributes` object
 * @returns {object|null} normalised security block, or null when nothing usable exists
 */
export function securityFromTokenInfo(attributes) {
  if (!attributes || typeof attributes !== 'object') return null;

  // TWO SHAPES ARRIVE HERE, and confusing them silently produced a null concentration:
  //   raw GeckoTerminal  : holders.distribution_percentage.top_10, is_honeypot,
  //                        mint_authority, developer_holding_percentage
  //   our normalised token: holders.top10Percentage, isHoneypot, mintAuthority, ...
  // Both are accepted so the caller does not have to care which it holds.
  const h = attributes.holders ?? null;
  const top10 = pct(h?.distribution_percentage?.top_10 ?? h?.top10Percentage);
  const holderCount = Number.isFinite(Number(h?.count ?? h?.total)) && Number(h.count ?? h.total) > 0
    ? Number(h.count ?? h.total)
    : null;

  // Distinguish THREE cases for each authority, and getting this wrong is a
  // data-safety bug, not a cosmetic one:
  //   key absent / undefined  -> UNKNOWN         -> null  (no claim)
  //   key present, value null -> RENOUNCED       -> false (a real, good fact)
  //   key present, non-null   -> ACTIVE          -> true  (a real risk)
  //
  // `hasOwnProperty` alone was not enough: the normalised token shape sets these keys
  // to `undefined` when the provider omitted them, so the presence test passed and an
  // UNKNOWN authority was reported as "renounced" - a false all-clear.
  const authorityValue = (...names) => {
    for (const n of names) {
      if (!Object.prototype.hasOwnProperty.call(attributes, n)) continue;
      const v = attributes[n];
      // A key that exists but holds `undefined` is ABSENT for our purposes: the
      // normalised shape sets exactly that when the provider omitted the field.
      if (v === undefined) continue;
      return { known: true, value: v }; // null is a real answer
    }
    return { known: false, value: null };
  };

  const mintAuth = authorityValue('mint_authority', 'mintAuthority');
  const freezeAuth = authorityValue('freeze_authority', 'freezeAuthority');

  const mintable = mintAuth.known ? (mintAuth.value !== null) : null;
  const freezable = freezeAuth.known ? (freezeAuth.value !== null) : null;
  const honeypot = parseHoneypot(attributes.is_honeypot ?? attributes.isHoneypot);

  const devPct = pct(attributes.developer_holding_percentage ?? attributes.developerHoldingPercentage);
  const devAddrRaw = attributes.developer_address ?? attributes.developerAddress ?? null;
  const devAddr = typeof devAddrRaw === 'string' && devAddrRaw ? devAddrRaw : null;

  const nothing = top10 === null && holderCount === null && honeypot === null
    && mintable === null && freezable === null && devPct === null && devAddr === null;
  if (nothing) return null;

  return {
    source: 'geckoterminal',
    holders: {
      total: holderCount,
      top10Percentage: top10,
      largestHolderPercentage: null, // not exposed by this endpoint
      concentrationSource: top10 !== null ? 'geckoterminal' : null,
    },
    security: {
      honeypot,
      mintable,
      freezable,
      // Not part of this payload; left null so a merge can fill them elsewhere.
      canTakeBackOwnership: null,
      hiddenOwner: null,
      openSource: null,
      cannotSellAll: null,
    },
    tax: null,
    lpLock: null,
    dev: devAddr || devPct !== null ? { address: devAddr, balancePercentage: devPct } : null,
  };
}

/** True when this block carries anything worth merging. */
export function hasUsableSecurity(block) {
  if (!block) return false;
  return block.holders?.top10Percentage !== null && block.holders?.top10Percentage !== undefined
    || block.holders?.total !== null && block.holders?.total !== undefined
    || block.security?.honeypot !== null
    || block.security?.mintable !== null
    || block.security?.freezable !== null
    || block.dev?.balancePercentage !== null && block.dev?.balancePercentage !== undefined
    || Boolean(block.dev?.address);
}
