/**
 * src/research/research-commands.mjs
 * /narrative, /x and /kol.
 *
 * ROUTING
 * These are registered with bot.command(), which runs AFTER the generic message
 * listener. That listener passes commands through via next(), so a command is never
 * treated as a pasted contract — the Phase 2 lesson. Each handler also refuses to
 * run in a DM in a way that a user can see, rather than doing nothing.
 *
 * HONESTY RULES ENFORCED HERE
 *  - A project's own description is labelled a project claim on every render.
 *  - "No posts found" and "discovery is not configured" are different sentences.
 *  - /kol reports only the calls this bot actually recorded, and says so, with the
 *    sample size. It never implies a full trading record.
 *  - Performance is omitted when the entry market cap was never verifiable, rather
 *    than filled with the current market cap.
 */

import { Markup } from 'telegraf';
import { getChain } from '../chains.mjs';
import { parseCallArgs } from '../call-commands.mjs';
import { detectAll } from '../detect-ca.mjs';
import { buildPreview, renderPreview, isEntitledToFullResearch } from './premium-preview.mjs';
import { researchToken } from './research-service.mjs';
import { fmtUsd } from '../card-layout.mjs';
import { timeAgo, callMetrics, fmtMultiple } from '../calls.mjs';

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function clip(s, n) {
  const c = [...String(s ?? '')];
  return c.length <= n ? c.join('') : `${c.slice(0, n - 1).join('')}…`;
}

/**
 * Resolve the address a research command was given.
 * Research is not a scan, so this never falls back to the scanner and never creates
 * a record. It does need a chain, so an EVM address is resolved against recorded
 * calls first and then the group's default chain.
 */
export function resolveResearchTarget(text, { defaultEvmChain = 'bsc' } = {}) {
  const raw = String(text ?? '').replace(/^\/\w+(@\w+)?\s*/i, '').trim();
  if (!raw) return { error: 'missing' };
  const parsed = parseCallArgs(raw, defaultEvmChain);
  if (!parsed.address) return { error: 'not-an-address' };

  // An EVM address is valid on ~14 chains. Silently taking the group default would
  // research the wrong network — the same class of error as attributing a
  // same-ticker impostor. Mark it ambiguous and let the caller find evidence.
  const det = detectAll(raw, { defaultEvmChain });
  const ambiguous = det.kind === 'evm' && det.ambiguous;
  return {
    chain: parsed.candidates[0].chain,
    address: parsed.address,
    candidates: parsed.candidates,
    ambiguous,
    evmLikely: ambiguous ? ['ethereum', 'bsc', 'base'] : null,
  };
}

/**
 * When an EVM address could be several chains, find which one actually has a
 * project profile. That is evidence, not a guess: CoinGecko answers for a specific
 * platform, so a 200 is proof the contract exists there.
 *
 * Returns null when no chain is confirmed, so the caller shows a disambiguation
 * prompt instead of researching a default.
 */
export async function resolveAmbiguousChain({ address, candidates = ['ethereum', 'bsc', 'base'], fetchImpl = globalThis.fetch } = {}) {
  const { fetchContractProfile } = await import('./narrative-source.mjs');
  for (const chain of candidates) {
    const r = await fetchContractProfile(chain, address, { fetchImpl, skipThrottle: false });
    if (r?.status === 'ok') return { chain, evidence: 'project profile exists on this chain' };
  }
  return null;
}

/**
 * Resolve the chain for a research target.
 * Solana-like addresses are unambiguous. For an EVM address we look for real
 * evidence on the likely chains; if none is found we return a prompt rather than
 * researching a default network.
 */
async function resolveChainForResearch(target, deps) {
  if (!target.ambiguous) return { ok: true, chain: target.chain };
  const found = await resolveAmbiguousChain({
    address: target.address,
    candidates: target.evmLikely,
    fetchImpl: deps.fetchImpl,
  });
  if (found) {
    console.log(`[research] resolved ${target.address.slice(0, 10)}… to ${found.chain} (${found.evidence})`);
    return { ok: true, chain: found.chain };
  }
  return { ok: false };
}

function ambiguityMessage(address) {
  return [
    '🔎 <b>Which chain is this contract on?</b>',
    '',
    `<code>${esc(address)}</code>`,
    '',
    '<i>A 0x address can exist on several networks, and no project profile was found '
    + 'on Ethereum, BNB Chain or Base. Research will not guess.</i>',
    '',
    'Use the chain-prefixed form, for example:',
    `<code>/narrative bsc ${esc(address)}</code>`,
  ].join('\n');
}

// ---- /narrative -----------------------------------------------------------

export function renderNarrative({ target, research, chainName }) {
  const L = [];
  L.push('📖 <b>NARRATIVE</b>');
  L.push('');
  L.push(`${esc(chainName)} · <code>${esc(clip(target.address, 44))}</code>`);
  L.push('');

  const n = research.narrative;
  if (!n.available) {
    // A token with no published prose is not necessarily a token with nothing to
    // say. Verified on-chain facts and project links are still evidence, and showing
    // them beats a bare "unavailable" - especially for a fresh launch, where the
    // contract facts are often all that exists.
    const hasFacts = (n.claims?.length ?? 0) > 0;
    const why = n.reason === 'not-found' || n.reason === 'empty-description' || n.reason === 'no-published-description'
      ? 'No published project description exists for this contract.'
      : n.reason === 'unsupported-chain'
        ? `No verified narrative source covers ${esc(chainName)} yet.`
        : n.reason === 'rate-limited'
          ? 'The description provider is rate-limiting right now. Try again shortly.'
          : 'The description provider could not be reached right now.';

    if (!hasFacts) {
      L.push(`<i>${why} Nothing evidence-based can be summarised.</i>`);
      return L.join('\n');
    }

    // State the absence plainly, then give the verified substitute.
    L.push(`<i>${why} Showing verified contract facts instead.</i>`);
    L.push('');
    L.push('<b>Verified facts</b>');
    for (const c of n.claims.slice(0, 5)) L.push(`• ${esc(c.text)} <i>(${esc(c.source)})</i>`);

    const l = n.links ?? {};
    const rows = [];
    if (l.website) rows.push(`<a href="${esc(l.website)}">Website</a>`);
    if (l.twitter) rows.push(`<a href="${esc(l.twitter)}">X</a>`);
    if (l.telegram) rows.push(`<a href="${esc(l.telegram)}">Telegram</a>`);
    if (rows.length) {
      L.push('');
      L.push(rows.join(' · '));
    }
    return L.join('\n');
  }

  L.push('<b>Summary</b>');
  L.push(esc(n.summary));
  L.push('');
  // THE LABEL MUST MATCH THE ACTUAL SOURCE. This used to hardcode "Project's own
  // description", but the pipeline can select a market provider's blurb instead - so
  // third-party text was presented as the project describing itself. Each evidence
  // class now gets its own wording.
  const PROVENANCE = {
    'project-claim': "Project's own description — unverified claim",
    reported: 'Third-party market description — reported, not verified',
    verified: 'Verified from on-chain data',
    inference: 'Inferred — not directly stated by any source',
    unknown: 'Source unclear — treat as unverified',
  };
  const provenance = PROVENANCE[n.summaryClass] ?? 'Unverified description';
  L.push(`<i>${esc(provenance)}. Source: ${esc(n.summarySource)}</i>`);

  if (n.claims?.length) {
    L.push('');
    L.push('<b>Also stated</b>');
    for (const c of n.claims.slice(0, 4)) L.push(`• ${esc(c.text)} <i>(${esc(c.source)})</i>`);
  }

  const links = [];
  if (n.links?.homepage) links.push(`<a href="${esc(n.links.homepage)}">Website</a>`);
  if (n.links?.twitter) links.push(`<a href="https://x.com/${esc(n.links.twitter)}">@${esc(n.links.twitter)}</a>`);
  if (links.length) {
    L.push('');
    L.push(`<b>Declared links</b>`);
    L.push(links.join(' · '));
  }

  if (n.truncated) {
    L.push('');
    L.push('<i>Description excerpted; the full text is longer.</i>');
  }

  // Cross-reference what X discovery can add, and be clear when it cannot.
  L.push('');
  if (!research.x.status?.available) {
    L.push(`<i>X intelligence: ${esc(research.x.status?.detail ?? 'unavailable')}</i>`);
  } else {
    L.push(`<i>X intelligence: ${esc(research.x.coverage)}</i>`);
  }
  return L.join('\n');
}

export async function handleNarrative(ctx, deps) {
  if (ctx.from?.is_bot) return;
  const target = resolveResearchTarget(ctx.message?.text, { defaultEvmChain: deps.defaultEvmChain });
  if (target.error === 'missing') {
    await ctx.reply('Usage: <code>/narrative &lt;contract_address&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  if (target.error) {
    await ctx.reply('❌ That does not look like a contract address.');
    return;
  }
  const resolved = await resolveChainForResearch(target, deps);
  if (!resolved.ok) {
    await ctx.reply(ambiguityMessage(target.address), { parse_mode: 'HTML' });
    return;
  }
  target.chain = resolved.chain;

  let research;
  try {
    research = await researchToken({
      chain: target.chain, address: target.address, includePosts: false,
      cache: deps.cache, fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    console.error('[research] /narrative failed:', err?.message ?? err);
    await ctx.reply('⚠️ Research could not be completed. Market scanning and calls are unaffected.');
    return;
  }
  const text = renderNarrative({
    target, research, chainName: getChain(target.chain)?.name ?? target.chain,
  });
  // /narrative is a FREE feature (basic narrative). The footer only appears when a
  // verified premium destination is configured.
  await ctx.reply(text + premiumFooter(deps, ctx), { parse_mode: 'HTML', disable_web_page_preview: true });
}

// ---- /x -------------------------------------------------------------------

export function renderXPosts({ target, research, chainName, limit = 8 }) {
  const L = [];
  L.push('𝕏 <b>X INTELLIGENCE</b>');
  L.push('');
  L.push(`${esc(chainName)} · <code>${esc(clip(target.address, 44))}</code>`);
  L.push('');

  const x = research.x;
  if (!x.status?.available) {
    const detail = x.status?.detail
      ?? (x.status?.reason === 'budget-exhausted'
        ? 'The X search allowance for this window is used up.'
        : 'Public post discovery is unavailable.');
    L.push(`<i>${esc(detail)}</i>`);
    L.push('');
    L.push('<i>No posts are shown because none were retrieved. This is not a claim that nobody discussed the token.</i>');
    return L.join('\n');
  }

  const posts = (x.posts ?? []).slice(0, limit);
  if (!posts.length) {
    L.push('<i>No public posts matching this contract were found.</i>');
    return L.join('\n');
  }

  L.push(`<b>${posts.length}</b> post${posts.length === 1 ? '' : 's'} · <b>${x.uniqueAccounts}</b> account${x.uniqueAccounts === 1 ? '' : 's'} · <b>${x.contractMatches}</b> with the exact contract`);
  L.push('');

  for (const p of posts) {
    const strength = p.containsContract ? 'contract match' : p.containsTicker ? 'ticker only' : 'weak';
    const when = p.createdAt ? timeAgo(Date.parse(p.createdAt)) : 'time unknown';
    const head = p.authorHandle ? `@${esc(p.authorHandle)}` : 'unknown author';
    L.push(`• <b>${head}</b> · ${esc(when)} · <i>${esc(strength)}</i>`);
    L.push(`  ${esc(clip(p.text.replace(/\s+/g, ' '), 160))}`);
    if (p.url) L.push(`  <a href="${esc(p.url)}">open post</a>`);
    const m = p.metrics ?? {};
    const bits = [];
    if (m.likes != null) bits.push(`${m.likes} likes`);
    if (m.reposts != null) bits.push(`${m.reposts} reposts`);
    if (m.views != null) bits.push(`${m.views} views`);
    if (bits.length) L.push(`  <i>${esc(bits.join(' · '))}</i>`);
  }

  L.push('');
  L.push(`<i>${esc(coverageNoteFor(research))}</i>`);
  L.push('<i>Ticker-only matches are not attributed to this token.</i>');
  return L.join('\n');
}

function coverageNoteFor(research) {
  return research.x.coverage
    ?? 'Sample of public posts; not a complete record.';
}

export async function handleX(ctx, deps) {
  if (ctx.from?.is_bot) return;
  const target = resolveResearchTarget(ctx.message?.text, { defaultEvmChain: deps.defaultEvmChain });
  if (target.error === 'missing') {
    await ctx.reply('Usage: <code>/x &lt;contract_address&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  if (target.error) {
    await ctx.reply('❌ That does not look like a contract address.');
    return;
  }
  const resolved = await resolveChainForResearch(target, deps);
  if (!resolved.ok) {
    await ctx.reply(ambiguityMessage(target.address), { parse_mode: 'HTML' });
    return;
  }
  target.chain = resolved.chain;

  // ENTITLEMENT. Deep X/KOL research is a premium website feature. The OWNER (and
  // any explicitly authorized staging user) may spend a real request; an ordinary
  // user gets only what is already cached, so /x can never become a way to burn the
  // provider allowance from a public group.
  const entitled = isEntitledToFullResearch(deps.policy, ctx.from?.id);

  let research;
  try {
    research = await researchToken({
      chain: target.chain, address: target.address,
      cache: deps.cache, budget: deps.budget, fetchImpl: deps.fetchImpl,
      // Non-entitled callers cannot cause a paid search.
      xCacheOnly: !entitled,
    });
  } catch (err) {
    console.error('[research] /x failed:', err?.message ?? err);
    await ctx.reply('⚠️ X research could not be completed.');
    return;
  }

  // A non-entitled caller with nothing cached gets the preview invitation, not an
  // empty result set that reads like "this token has no posts".
  if (!entitled && !(research?.x?.available && (research.x.posts?.length ?? 0) > 0)) {
    const preview = buildPreview(research, { premiumUrl: deps.premiumUrl });
    await ctx.reply(renderPreview(preview, { esc }).join('\n'), {
      parse_mode: 'HTML', disable_web_page_preview: true,
    });
    return;
  }
  const text = renderXPosts({
    target, research, chainName: getChain(target.chain)?.name ?? target.chain,
  });
  await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
}

/**
 * Premium CTA footer for free-tier output.
 * Returns '' when no verified destination exists, so the bot never prints a dead
 * or invented link.
 */
function premiumFooter(deps, ctx) {
  if (isEntitledToFullResearch(deps.policy, ctx.from?.id)) return '';
  const url = deps.premiumUrl;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return '';
  return `\n\n<a href="${esc(url)}">Full X &amp; KOL research on the website</a>`;
}

// ---- /kol ----------------------------------------------------------------

/**
 * Public X call history recorded for one account.
 *
 * This reads Telegram-recorded public-call evidence only (research posts flagged as
 * public calls against a token). It is a RECORDED SAMPLE, and the render says so.
 * It never mixes in Telegram group calls: those belong to caller profiles.
 */
export function renderKolProfile({ handle, entries, coverage, limit = 6 }) {
  const L = [];
  L.push(`🎙 <b>@${esc(handle)}</b>`);
  L.push('');

  if (!entries.length) {
    L.push('<i>No public calls by this account have been recorded.</i>');
    L.push('');
    L.push('<i>A missing record means this bot has not recorded a call — it is not evidence that the account never called anything.</i>');
    return L.join('\n');
  }

  const withEntry = entries.filter((e) => Number.isFinite(e.entryMarketCapUsd));
  const unmeasured = entries.length - withEntry.length;

  L.push(`Recorded public calls: <b>${entries.length}</b>`);
  if (withEntry.length) {
    L.push(`With a verified entry market cap: <b>${withEntry.length}</b>`);
  }
  L.push('');

  for (const e of entries.slice(0, limit)) {
    const sym = e.symbol ? `$${e.symbol}` : (e.name ?? 'token');
    // timeAgo() takes epoch MILLISECONDS. Passing an ISO string returned '' for
    // every row, which rendered as a dangling "· " - the same class of defect as
    // the old "just now ago". Parse the timestamp, and fall back to the text the
    // caller actually has rather than dropping the date entirely.
    const stamp = e.createdAt ?? e.observedAt ?? null;
    const ms = stamp ? Date.parse(stamp) : NaN;
    const when = Number.isFinite(ms) ? timeAgo(ms) : 'date unknown';
    // Entry market cap is only shown when it was verifiable.
    const entry = Number.isFinite(e.entryMarketCapUsd) ? fmtUsd(e.entryMarketCapUsd) : null;
    L.push(`• <b>${esc(clip(sym, 18))}</b> · ${esc(when)}`);
    if (entry) L.push(`  Entry MC at post: ${esc(entry)}`);
    else L.push('  <i>Entry market cap not verifiable — performance unavailable</i>');
    if (e.url) L.push(`  <a href="${esc(e.url)}">source post</a>`);
  }

  L.push('');
  L.push(`<i>Sample of ${entries.length} recorded call${entries.length === 1 ? '' : 's'}.`
    + `${unmeasured ? ` ${unmeasured} without a verifiable entry, excluded from performance.` : ''}</i>`);
  L.push(`<i>${esc(coverage ?? 'Recorded history only; not the account\'s full trading record.')}</i>`);
  return L.join('\n');
}

export async function handleKol(ctx, deps) {
  if (ctx.from?.is_bot) return;
  const raw = String(ctx.message?.text ?? '').replace(/^\/\w+(@\w+)?\s*/i, '').trim();
  if (!raw) {
    await ctx.reply('Usage: <code>/kol &lt;@username&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const handle = raw.replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    await ctx.reply('❌ That does not look like an X username.');
    return;
  }

  // Read the recorded public-call evidence from the research store, if present.
  const entries = typeof deps.recordedCallsForHandle === 'function'
    ? await deps.recordedCallsForHandle(handle)
    : [];
  await ctx.reply(
    renderKolProfile({ handle, entries, coverage: deps.kolCoverage }) + premiumFooter(deps, ctx),
    { parse_mode: 'HTML', disable_web_page_preview: true },
  );
}
