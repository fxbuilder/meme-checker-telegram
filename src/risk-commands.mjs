/**
 * src/risk-commands.mjs
 * Phase 5 — `/risk`, `/dev`, `/bundle`.
 *
 * DESIGN PRINCIPLE: a risk report is a statement about what was MEASURED, and every
 * line either carries evidence or says it does not have it. Three states are kept
 * strictly apart, because collapsing them is how a scanner ends up implying safety:
 *
 *   measured value    a number/flag the provider actually returned
 *   unknown  (-)      the chain is covered but this reading is absent
 *   not supported (n/a)  no source exists for this chain at all
 *
 * Unsupported is NEVER rendered as safe. A missing honeypot flag is not "not a
 * honeypot", and a token with no tax data is not "0% tax".
 *
 * Labels are heuristics unless the provider says otherwise. `sniper`, `bundle` and
 * `insider` are words with legal weight, so they are only used when there is direct
 * transaction evidence, and the report states the observation window.
 */

import { fetchRisk } from './risk-intel.mjs';
import { getChain } from './chains.mjs';
import { resolveResearchTarget, resolveChainForResearch, ambiguityMessage } from './research/research-commands.mjs';

const DASH = '—';
const NA = 'n/a';

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(v, n) {
  const s = String(v ?? '');
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Format a percentage, refusing impossible values.
 *
 * A concentration above 100% is invalid for a consistent denominator. `risk-intel`
 * already returns null for that case, but this function is the last line of defence:
 * if a bad value ever reaches it, printing it would present a fabrication as a reading.
 */
function fmtPp(v, { max = 100 } = {}) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  if (n < 0 || n > max) return null;
  // A tiny positive value must never print as 0.00% - "holds nothing" and "holds a
  // little" are different statements.
  if (n > 0 && n < 0.01) return '<0.01%';
  // Sub-1% is real but a single bucket hides ordering; keep two decimals so a
  // genuine sub-1% holding cannot round away to nothing.
  if (n > 0 && n < 1) return `${n.toFixed(2)}%`;
  return `${n.toFixed(n >= 10 ? 1 : 2)}%`;
}

function fmtInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : null;
}

/**
 * Traffic-light judgement for a concentration reading.
 * Returns null when there is nothing to judge - never 'good' by default.
 */
export function concentrationTone(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return null;
  const n = Number(pct);
  if (n >= 50) return 'high';
  if (n >= 25) return 'elevated';
  return 'low';
}

/** Tone for a 0-100 tax value. null when the value is absent. */
export function taxTone(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return null;
  const n = Number(pct);
  if (n >= 10) return 'high';
  if (n > 0) return 'low';
  return 'none';
}

function icon(tone) {
  return tone === 'high' ? '🔴' : tone === 'elevated' ? '🟠' : tone === 'low' ? '🟡' : tone === 'none' ? '🟢' : '•';
}

/**
 * Render the risk report.
 *
 * @param {object} args
 * @param {object} args.target   { chain, address }
 * @param {object} args.risk     fetchRisk() result: { status, data, detail }
 * @param {string} args.chainName
 */
export function renderRisk({ target, risk, chainName }) {
  const L = [];
  L.push('🛡 <b>RISK CHECK</b>');
  L.push('');
  L.push(`${esc(chainName)} · <code>${esc(clip(target.address, 44))}</code>`);
  L.push('');

  const chain = getChain(target.chain);
  const covered = Boolean(chain?.goplus);

  // ---- provider-level outcomes -------------------------------------------
  if (risk.status === 'unsupported') {
    L.push(`<i>No risk provider covers ${esc(chainName)} yet.</i>`);
    L.push('');
    L.push('<i>This is a coverage gap, not a clean result — nothing about this token has been verified.</i>');
    return L.join('\n');
  }
  if (risk.status === 'error') {
    L.push('<i>The risk provider could not be reached.</i>');
    L.push('');
    L.push(`<i>No conclusion can be drawn. ${esc(risk.detail ?? 'provider error')}</i>`);
    return L.join('\n');
  }
  if (risk.status === 'no-data') {
    L.push('<i>The provider has no record for this contract.</i>');
    L.push('');
    L.push('<i>That usually means very new or very small. It says nothing about safety.</i>');
    return L.join('\n');
  }

  const d = risk.data;
  const unsupported = (v) => (v === null || v === undefined ? (covered ? DASH : NA) : v);

  // ---- holders -----------------------------------------------------------
  L.push('<b>Holders</b>');
  const hold = d.holders ?? {};
  const total = fmtInt(hold.total);
  L.push(`• Holders: ${total ?? unsupported(null)}`);

  const top10 = fmtPp(hold.top10Percentage);
  if (top10) {
    const tone = concentrationTone(hold.top10Percentage);
    L.push(`• Top 10: ${icon(tone)} ${top10}`);
  } else if (hold.concentrationReason === 'inconsistent-denominator') {
    // Measured, but not reconcilable. Saying "unknown" is the honest reading; the
    // alternative is publishing an impossible percentage.
    L.push(`• Top 10: ${DASH} <i>(provider rows could not be reconciled)</i>`);
  } else {
    L.push(`• Top 10: ${unsupported(null)}`);
  }

  const largest = fmtPp(hold.largestHolderPercentage);
  if (largest) L.push(`• Largest holder: ${largest}`);

  // The denominator matters and is almost never stated by scanners.
  L.push('<i>Concentration excludes LP, burn and contract accounts; percentages are of reported supply.</i>');

  // ---- contract controls --------------------------------------------------
  L.push('');
  L.push('<b>Contract</b>');
  const sec = d.security ?? {};
  const flagLine = (label, v, { inverse = false } = {}) => {
    if (v === null || v === undefined) return `${label}: ${unsupported(null)}`;
    // For risk flags, "true" is the dangerous value; for capability flags, false is.
    const risky = inverse ? v === false : v === true;
    return `${label}: ${risky ? '🔴' : '🟢'} ${v ? 'Yes' : 'No'}`;
  };

  // HONEYPOT RISK: four states, and UNKNOWN is never green.
  //
  // A provider flag is only a yes/no. Presenting "No" as a green tick overstates what was
  // actually verified - a token can be sellable in a simulation and still trap holders
  // via a hidden blacklist. So the risk LEVEL is explicit:
  //   flag true       -> HIGH
  //   flag false      -> LOW (the provider did simulate and the token passed)
  //   flag unmeasured -> UNKNOWN, muted, never green
  // RugCheck's published score is a second, independent signal, shown separately.
  const honeypotLevel = (() => {
    if (sec.honeypot === true) return { label: 'HIGH', tone: 'bad' };
    if (sec.honeypot === false) return { label: 'LOW', tone: 'good' };
    return { label: 'UNKNOWN', tone: 'muted' };
  })();
  const hpIcon = honeypotLevel.tone === 'good' ? '🟢' : honeypotLevel.tone === 'bad' ? '🔴' : '⚪';
  L.push(`• Honeypot Risk: ${hpIcon} <b>${honeypotLevel.label}</b>`);

  L.push(`• ${flagLine('Mintable', sec.mintable)}`);
  L.push(`• ${flagLine('Freezable', sec.freezable)}`);

  // RugCheck's own score, clearly attributed. Shown only when RugCheck published it, and
  // never substituted with another provider's figure under this name.
  if (sec.rugcheckScore !== null && sec.rugcheckScore !== undefined) {
    const n = Number(sec.rugcheckScore);
    // 0 = clean, 100 = worst.
    const band = n >= 50 ? 'HIGH' : n >= 20 ? 'MEDIUM' : 'LOW';
    const icon = band === 'LOW' ? '🟢' : band === 'MEDIUM' ? '🟡' : '🔴';
    L.push(`• RugCheck Score: ${icon} <b>${n}</b>/100 (${band} risk)`);
  }
  if (Array.isArray(sec.rugcheckRisks) && sec.rugcheckRisks.length) {
    for (const risk of sec.rugcheckRisks.slice(0, 3)) {
      L.push(`   – ${esc(risk.name)}`);
    }
  }
  if (sec.hiddenOwner !== null && sec.hiddenOwner !== undefined) {
    L.push(`• ${flagLine('Hidden owner', sec.hiddenOwner)}`);
  }
  if (sec.canTakeBackOwnership !== null && sec.canTakeBackOwnership !== undefined) {
    L.push(`• ${flagLine('Ownership reclaimable', sec.canTakeBackOwnership)}`);
  }
  if (sec.openSource !== null && sec.openSource !== undefined) {
    L.push(`• ${flagLine('Open source', sec.openSource, { inverse: true })}`);
  }
  if (sec.cannotSellAll !== null && sec.cannotSellAll !== undefined) {
    L.push(`• ${flagLine('Cannot sell all', sec.cannotSellAll)}`);
  }

  // ---- tax ---------------------------------------------------------------
  L.push('');
  L.push('<b>Tax</b>');
  if (d.tax && (d.tax.buy !== null || d.tax.sell !== null)) {
    const b = fmtPp(d.tax.buy) ?? DASH;
    const s = fmtPp(d.tax.sell) ?? DASH;
    const tone = taxTone(Math.max(Number(d.tax.buy ?? 0), Number(d.tax.sell ?? 0)));
    L.push(`• Buy ${icon(tone)} ${b} · Sell ${icon(tone)} ${s}`);
  } else {
    // Absent tax data is NOT zero tax. Solana has no tax concept at all.
    L.push(`• ${unsupported(null)} <i>${target.chain === 'solana' ? '(no tax concept on Solana)' : '(provider did not report)'}</i>`);
  }

  // ---- LP -----------------------------------------------------------------
  L.push('');
  L.push('<b>Liquidity</b>');
  if (d.lpLock && d.lpLock.lockedPercentage !== null) {
    const lockedPct = Number(d.lpLock.lockedPercentage);
    const locked = fmtPp(lockedPct);
    const covered_ = fmtPp(d.lpLock.coveredPercentage);
    // Interpretation needs BOTH numbers. "0.4% locked" sounds alarming, but if the
    // provider only saw 0.4% of LP, it means nothing is known, not that LP is unlocked.
    const lowCoverage = Number.isFinite(Number(d.lpLock.coveredPercentage))
      && Number(d.lpLock.coveredPercentage) < 5;
    if (lowCoverage) {
      L.push(`• LP lock: ${DASH} <i>(provider reported only ${covered_} of LP — no conclusion possible)</i>`);
    } else {
      const tone = lockedPct >= 90 ? 'none' : lockedPct >= 50 ? 'low' : 'elevated';
      L.push(`• LP locked/burned: ${icon(tone)} ${locked}`);
      if (covered_) L.push(`  <i>measured across ${covered_} of LP</i>`);
    }
  } else {
    L.push(`• LP lock: ${unsupported(null)}`);
  }

  // ---- dev ----------------------------------------------------------------
  if (d.dev) {
    L.push('');
    L.push('<b>Creator</b>');
    if (d.dev.address) L.push(`• Address: <code>${esc(clip(d.dev.address, 20))}</code>`);
    const devPct = fmtPp(d.dev.balancePercentage);
    if (devPct) L.push(`• Holding: ${devPct}`);
    L.push('<i>Creator holdings are not the same as all insider holdings.</i>');
  }

  // ---- what this report does NOT do --------------------------------------
  L.push('');
  L.push('<i>Heuristic signals only. Bundles, snipers and insider wallets are not inferred here — they need transaction-level evidence.</i>');

  return L.join('\n');
}

// ---- /risk ---------------------------------------------------------------

export async function handleRisk(ctx, deps) {
  if (ctx.from?.is_bot) return;
  const target = resolveResearchTarget(ctx.message?.text, { defaultEvmChain: deps.defaultEvmChain });
  if (target.error === 'missing') {
    await ctx.reply('Usage: <code>/risk &lt;contract_address&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  if (target.error) {
    await ctx.reply('❌ That does not look like a contract address.');
    return;
  }
  const resolved = await resolveChainForResearch(target, deps);
  if (!resolved.ok) {
    await ctx.reply(ambiguityMessage(target.address, { candidates: resolved.candidates ?? null }), { parse_mode: 'HTML' });
    return;
  }
  target.chain = resolved.chain;

  let risk;
  try {
    risk = await fetchRisk(target.chain, target.address, { fetchImpl: deps.fetchImpl });
  } catch (err) {
    console.error('[risk] /risk failed:', err?.message ?? err);
    await ctx.reply('⚠️ The risk check could not be completed.');
    return;
  }

  const text = renderRisk({
    target, risk, chainName: getChain(target.chain)?.name ?? target.chain,
  });
  await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
}

// ---- /dev ----------------------------------------------------------------

/**
 * Creator/developer view.
 *
 * Deliberately small: the provider gives an address and a holding percentage, and
 * nothing else can be inferred from that. Claiming "dev sold" or "dev holds 12% of
 * insiders" without wallet-history evidence would be fabrication.
 */
export function renderDev({ target, risk, chainName }) {
  const L = [];
  L.push('👤 <b>CREATOR</b>');
  L.push('');
  L.push(`${esc(chainName)} · <code>${esc(clip(target.address, 44))}</code>`);
  L.push('');

  if (risk.status === 'unsupported') {
    L.push(`<i>No creator data source covers ${esc(chainName)} yet.</i>`);
    return L.join('\n');
  }
  if (risk.status !== 'ok' || !risk.data?.dev) {
    L.push('<i>No creator record is available for this contract.</i>');
    L.push('');
    L.push('<i>Absence of a record is not evidence that a creator holds nothing.</i>');
    return L.join('\n');
  }

  const dev = risk.data.dev;
  if (dev.address) L.push(`Address: <code>${esc(dev.address)}</code>`);
  else L.push('Address: — <i>(provider did not report one)</i>');

  const pct = fmtPp(dev.balancePercentage);
  // A measured exact zero is worth stating as zero; a rounded-to-zero value is not.
  if (pct === null) L.push('Holding: —');
  else if (Number(dev.balancePercentage) === 0) L.push('Holding: 0% (none at snapshot)');
  else L.push(`Holding: ${pct}`);
  if (dev.ownerAddress && dev.ownerAddress !== dev.address) {
    L.push(`Owner: <code>${esc(clip(dev.ownerAddress, 28))}</code>`);
  }

  L.push('');
  L.push('<i>Holding at the time of the provider snapshot. Historical dev sells, wallet count and insider share need transaction-level analysis, which is a Premium website feature.</i>');
  return L.join('\n');
}

export async function handleDev(ctx, deps) {
  if (ctx.from?.is_bot) return;
  const target = resolveResearchTarget(ctx.message?.text, { defaultEvmChain: deps.defaultEvmChain });
  if (target.error === 'missing') {
    await ctx.reply('Usage: <code>/dev &lt;contract_address&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  if (target.error) {
    await ctx.reply('❌ That does not look like a contract address.');
    return;
  }
  const resolved = await resolveChainForResearch(target, deps);
  if (!resolved.ok) {
    await ctx.reply(ambiguityMessage(target.address, { candidates: resolved.candidates ?? null }), { parse_mode: 'HTML' });
    return;
  }
  target.chain = resolved.chain;

  let risk;
  try {
    risk = await fetchRisk(target.chain, target.address, { fetchImpl: deps.fetchImpl });
  } catch (err) {
    console.error('[risk] /dev failed:', err?.message ?? err);
    await ctx.reply('⚠️ The creator check could not be completed.');
    return;
  }
  await ctx.reply(
    renderDev({ target, risk, chainName: getChain(target.chain)?.name ?? target.chain }),
    { parse_mode: 'HTML', disable_web_page_preview: true },
  );
}

// ---- /bundle -------------------------------------------------------------

/**
 * Bundle/sniper check.
 *
 * HONEST POSITION: none of the free sources expose same-block buyer sets in a form
 * that proves coordination. Same-block purchases alone do not demonstrate a bundle -
 * a launch can produce dozens of independent buyers in one slot. So this command
 * reports the evidence it actually has (holder concentration and creator holding) and
 * states plainly that a bundle analysis is not performed, rather than emitting a
 * fabricated "Bundle: No" which reads as an all-clear.
 */
export function renderBundle({ target, risk, chainName }) {
  const L = [];
  L.push('🧩 <b>BUNDLE / SNIPER CHECK</b>');
  L.push('');
  L.push(`${esc(chainName)} · <code>${esc(clip(target.address, 44))}</code>`);
  L.push('');

  if (risk.status === 'unsupported') {
    L.push(`<i>No data source covers ${esc(chainName)} yet.</i>`);
    return L.join('\n');
  }
  if (risk.status !== 'ok') {
    L.push('<i>No data available for this contract.</i>');
    return L.join('\n');
  }

  const d = risk.data;
  L.push('<b>What can be measured</b>');
  const top10 = fmtPp(d.holders?.top10Percentage);
  L.push(`• Top 10 concentration: ${top10 ?? '—'}`);
  const largest = fmtPp(d.holders?.largestHolderPercentage);
  if (largest) L.push(`• Largest single holder: ${largest}`);
  const devPct = fmtPp(d.dev?.balancePercentage);
  if (devPct) L.push(`• Creator holding: ${devPct}`);

  L.push('');
  L.push('<b>Not measured</b>');
  L.push('• <b>Bundled buys</b> — needs same-slot buyer grouping, which free sources do not expose.');
  L.push('• <b>Sniper wallets</b> — needs first-block transaction ordering.');
  L.push('• <b>Insider clusters</b> — needs funding-graph analysis.');
  L.push('');
  L.push('<i>Same-block purchases alone do not prove coordination: a launch can produce many independent buyers in one slot. These are Premium website analyses.</i>');

  return L.join('\n');
}

export async function handleBundle(ctx, deps) {
  if (ctx.from?.is_bot) return;
  const target = resolveResearchTarget(ctx.message?.text, { defaultEvmChain: deps.defaultEvmChain });
  if (target.error === 'missing') {
    await ctx.reply('Usage: <code>/bundle &lt;contract_address&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  if (target.error) {
    await ctx.reply('❌ That does not look like a contract address.');
    return;
  }
  const resolved = await resolveChainForResearch(target, deps);
  if (!resolved.ok) {
    await ctx.reply(ambiguityMessage(target.address, { candidates: resolved.candidates ?? null }), { parse_mode: 'HTML' });
    return;
  }
  target.chain = resolved.chain;

  let risk;
  try {
    risk = await fetchRisk(target.chain, target.address, { fetchImpl: deps.fetchImpl });
  } catch (err) {
    console.error('[risk] /bundle failed:', err?.message ?? err);
    await ctx.reply('⚠️ The bundle check could not be completed.');
    return;
  }
  await ctx.reply(
    renderBundle({ target, risk, chainName: getChain(target.chain)?.name ?? target.chain }),
    { parse_mode: 'HTML', disable_web_page_preview: true },
  );
}

/**
 * Provider capability matrix for the docs and for `/risk` on an unsupported chain.
 * Built from the chain registry so it cannot drift from what the bot actually does.
 */
export function riskCapabilityMatrix(chains) {
  const list = Array.isArray(chains) ? chains : Object.values(chains);
  return list.map((c) => ({
    chain: c.id,
    name: c.name,
    provider: c.goplus ?? null,
    holders: Boolean(c.goplus),
    tax: c.goplus === 'evm',
    lpLock: Boolean(c.goplus),
    contractControls: Boolean(c.goplus),
    creator: Boolean(c.goplus),
    bundle: false, // not implemented anywhere: needs transaction-level evidence
  }));
}
