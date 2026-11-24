/**
 * src/research/premium-preview.mjs
 * The free-tier X/KOL surface.
 *
 * PRODUCT DECISION (owner, Phase 4 strategy update): deep X/KOL research is a
 * premium WEBSITE feature. The Telegram bot is the free community tool and the
 * acquisition channel. So the bot must show a genuine, useful preview of research it
 * already has, and point at the website for the rest - without ever paying for an X
 * search on an ordinary scan.
 *
 * THE HARD RULE: a preview may only state something the cached evidence supports.
 *   - no cached research        -> invitation only, NO numbers
 *   - cached but zero posts     -> no counts (a zero would claim we searched and found none)
 *   - posts but unknown accounts-> omit that field rather than print 0
 * Every field below is derived from real cached data or omitted.
 *
 * This module does not fetch. It cannot fetch. It takes what the cache returned and
 * shapes it for display, so "no paid call from an ordinary scan" is a property of the
 * code path, not a promise in a comment.
 */

/** How many accounts a free preview may name. */
export const PREVIEW_MAX_ACCOUNTS = 2;

/**
 * Is the caller entitled to full research output?
 * During OWNER-only staging the owner sees everything. Everyone else gets the preview.
 * Fails closed: an unparsable policy returns not-entitled.
 */
export function isEntitledToFullResearch(policy, userId) {
  if (!(policy?.ownerIds instanceof Set)) return false;
  if (userId == null) return false;
  return policy.ownerIds.has(String(userId));
}

/**
 * Build the free preview from a research result.
 *
 * @param {object} research  the researchToken() result (already cached/available)
 * @param {object} [opts]
 * @param {string|null} [opts.premiumUrl]  verified premium destination, or null
 * @returns {object} preview fields; absent values are null, never 0 or a guess
 */
export function buildPreview(research, { premiumUrl = null } = {}) {
  const x = research?.x ?? null;
  const narrative = research?.narrative ?? null;

  const posts = Array.isArray(x?.posts) ? x.posts : [];
  const hasEvidence = Boolean(x?.status?.available) && posts.length > 0;

  // Counts are only stated when there is real evidence behind them.
  const postCount = hasEvidence ? posts.length : null;
  const accountCount = hasEvidence
    ? new Set(posts.map((p) => p.authorHandle).filter(Boolean)).size
    : null;

  // A "public caller" means the classifier found an actual position claim. Most
  // samples have none, and reporting 0 is correct only when we genuinely classified
  // posts. With no evidence at all the field is null.
  const kols = Array.isArray(x?.kols) ? x.kols : [];
  const callerCount = hasEvidence
    ? kols.filter((k) => k.role === 'public-call').length
    : null;

  // Up to two accounts, preferring real callers, then the project account, then the
  // most active. Labelled with what the account actually did, never "KOL".
  const ranked = [...kols].sort((a, b) => {
    const rank = (k) => (k.role === 'public-call' ? 0 : k.role === 'announcement' ? 1 : 2);
    return rank(a) - rank(b) || (b.posts ?? 0) - (a.posts ?? 0);
  });
  const accounts = ranked.slice(0, PREVIEW_MAX_ACCOUNTS).map((k) => ({
    handle: k.handle,
    role: k.role,
    roleLabel: k.role === 'public-call' ? 'Public call'
      : k.role === 'announcement' ? 'Project account'
        : k.role === 'repost' ? 'Repost' : 'Mention',
    posts: k.posts ?? 0,
    // How strongly this account's posts tie to the token.
    contractMatched: Boolean(k.hasContractMatch),
  }));

  const narrativePreview = narrative?.available && narrative.summary
    ? (narrative.summary.length <= 200
      ? narrative.summary
      : `${narrative.summary.slice(0, 200).replace(/\s\S*$/, '')}…`)
    : null;

  // Distinguish "we never looked" from "we looked and found nothing". They read
  // identically if both just say "no research", but they mean opposite things.
  const searched = Boolean(x?.status?.available);
  const state = hasEvidence ? 'evidence' : searched ? 'searched-empty' : 'not-cached';

  return {
    hasEvidence,
    state,
    postCount,
    accountCount,
    callerCount,
    accounts,
    narrativePreview,
    narrativeClass: narrative?.available ? (narrative.summaryClass ?? null) : null,
    narrativeSource: narrative?.available ? (narrative.summarySource ?? null) : null,
    // The CTA is only offered when a real destination exists.
    premiumUrl: typeof premiumUrl === 'string' && /^https?:\/\//.test(premiumUrl) ? premiumUrl : null,
    coverage: hasEvidence
      ? 'Preview of cached public X posts. Full research is on the website.'
      : null,
  };
}

/**
 * Render the preview for an HTML-mode Telegram card.
 * Returns [] when there is nothing honest to say and no CTA to offer, so the card
 * omits the section entirely rather than printing an empty shell.
 */
export function renderPreview(preview, { esc = (s) => String(s) } = {}) {
  if (!preview) return [];
  const out = [];

  if (preview.hasEvidence) {
    const bits = [];
    if (preview.postCount !== null) {
      bits.push(`<b>${preview.postCount}</b> public post${preview.postCount === 1 ? '' : 's'}`);
    }
    if (preview.accountCount !== null) {
      bits.push(`<b>${preview.accountCount}</b> account${preview.accountCount === 1 ? '' : 's'}`);
    }
    // Only mention callers when we actually classified posts; a genuine zero is
    // stated as zero because we did look.
    if (preview.callerCount !== null) {
      bits.push(preview.callerCount === 0
        ? 'no public calls identified'
        : `<b>${preview.callerCount}</b> public caller${preview.callerCount === 1 ? '' : 's'}`);
    }
    if (bits.length) out.push(bits.join(' · '));

    for (const a of preview.accounts) {
      const strength = a.contractMatched ? '' : ' <i>(ticker only)</i>';
      out.push(`${esc('@' + a.handle)} — ${esc(a.roleLabel)}${strength}`);
    }
  }

  if (preview.premiumUrl) {
    out.push(`<a href="${esc(preview.premiumUrl)}">Full X &amp; KOL research on the website</a>`);
  } else if (preview.hasEvidence) {
    out.push('<i>Full X &amp; KOL research is available on the website.</i>');
  } else if (preview.state === 'searched-empty') {
    // We DID search. Saying "not cached" here would understate our own work and
    // imply the token might have posts we simply have not fetched.
    out.push('<i>No public X posts matched this contract in the latest cached search. Full research is on the website.</i>');
  } else {
    // Never searched: invite, and promise no numbers.
    out.push('<i>No X research cached for this token yet. Full intelligence is available on the website.</i>');
  }

  return out;
}
