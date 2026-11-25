/**
 * src/emoji-preview.mjs
 * OWNER-only visual preview of the icon registry.
 *
 * WHY IT EXISTS: an ID that resolves is not an icon that looks right. The only way to confirm a
 * mapping is to see it rendered in the client, on the surfaces that use it. This renders every
 * role in labelled groups so a wrong picture is visible immediately — the Ethereum-as-envelope
 * defect survived several rounds precisely because nobody looked at the rendered result.
 *
 * Not registered as a public command: it is exposed only to the owner, and it reports coverage
 * numbers that are meant for the person maintaining the assets.
 */

import { GLYPHS, CUSTOM_IDS, ICON_LABELS, PRIORITY_CHAINS, CHAIN_LABELS, coverageSummary } from './icons.mjs';
import { icon, chainIcon } from './icons.mjs';

/** Roles shown in the preview, grouped the way a reader thinks about them. */
export const PREVIEW_GROUPS = [
  {
    title: 'Primary networks',
    roles: PRIORITY_CHAINS.map((c) => ({ role: `chain.${c}`, label: CHAIN_LABELS[c] })),
  },
  {
    title: 'Other networks',
    roles: ['chain.arbitrum', 'chain.optimism', 'chain.polygon', 'chain.avalanche', 'chain.story']
      .map((r) => ({ role: r, label: ICON_LABELS[r] ?? r })),
  },
  {
    title: 'Sections',
    roles: ['section.market', 'section.security', 'section.narrative', 'section.holders',
      'section.dev', 'section.bundle', 'section.alerts', 'section.pnl', 'section.leaderboard',
      'section.premium', 'section.research', 'section.settings', 'section.links']
      .map((r) => ({ role: r, label: r.replace('section.', '') })),
  },
  {
    title: 'Metrics',
    roles: ['metric.top10', 'metric.tax', 'metric.lp', 'metric.holders', 'metric.dexPaid',
      'metric.peak', 'metric.roi', 'metric.hitRate', 'metric.calls', 'metric.avg', 'metric.median',
      'metric.x', 'metric.social', 'metric.website', 'metric.ca']
      .map((r) => ({ role: r, label: r.replace('metric.', '') })),
  },
  {
    title: 'States',
    roles: ['state.good', 'state.warn', 'state.bad', 'state.neutral', 'state.unknown', 'state.pending']
      .map((r) => ({ role: r, label: r.replace('state.', '') })),
  },
  {
    title: 'Navigation & CTA',
    roles: ['cta.open', 'cta.website', 'cta.premium', 'brand.rocket', 'brand.token',
      'misc.fire', 'misc.down', 'misc.warning', 'misc.bolt', 'misc.lock', 'misc.gem']
      .map((r) => ({ role: r, label: r.split('.').slice(1).join('.') })),
  },
];

/**
 * Render the preview.
 *
 * Each line shows: the icon, its role, its glyph, and — crucially — the media type and pack it
 * came from. A reader can then tell a verified animated asset from a plain Unicode fallback
 * without consulting any other document.
 */
export function renderEmojiPreview({ theme = null, custom = undefined, page = 0, pageSize = 3 } = {}) {
  const lines = [];
  lines.push('🎛 <b>EMOJI REGISTRY — OWNER PREVIEW</b>');
  lines.push('<i>Each row: icon · role · glyph · source</i>');
  lines.push('');

  // Telegram caps a message at 4096 characters and the full registry exceeds that, so the groups
  // are paginated. The coverage summary is appended to the LAST page only, so it is read once.
  const totalPages = Math.max(1, Math.ceil(PREVIEW_GROUPS.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = PREVIEW_GROUPS.slice(safePage * pageSize, safePage * pageSize + pageSize);
  lines.push(`<i>page ${safePage + 1}/${totalPages}</i>`);
  lines.push('');

  for (const group of slice) {
    lines.push(`<b>${group.title}</b>`);
    for (const { role, label } of group.roles) {
      const entry = CUSTOM_IDS[role];
      const glyph = icon(role, { theme, custom });
      if (entry?.id) {
        const media = entry.media === 'video' ? 'video' : entry.media === 'animated' ? 'anim' : 'static';
        lines.push(`${glyph} <code>${role}</code> ${label} — <i>${media}</i> · ${entry.pack}`);
      } else {
        lines.push(`${glyph} <code>${role}</code> ${label} — <i>fallback only</i>`);
      }
    }
    lines.push('');
  }

  const cov = coverageSummary();
  if (safePage !== totalPages - 1) {
    return { text: lines.join('\n'), coverage: cov, page: safePage, pages: totalPages };
  }
  lines.push('<b>Coverage</b>');
  lines.push(`Roles <b>${cov.totalRoles}</b> · verified assets <b>${cov.verifiedAssets}</b>`);
  lines.push(`Animated <b>${cov.animatedRoles}</b> · static <b>${cov.staticRoles}</b> · Unicode-only <b>${cov.unicodeOnly}</b>`);

  const missing = Object.entries(cov.missingChainAssets);
  if (missing.length) {
    lines.push('');
    lines.push('<b>Missing brand assets</b>');
    for (const [chain, why] of missing) {
      lines.push(`${chainIcon(chain, { theme, custom })} <b>${CHAIN_LABELS[chain] ?? chain}</b> — ${why}`);
    }
  }

  return { text: lines.join('\n'), coverage: cov };
}

/**
 * A machine-readable coverage report for the acceptance document.
 * Counted from the registry, so the document cannot claim more than the code contains.
 */
export function coverageReport() {
  const cov = coverageSummary();
  const rows = Object.entries(GLYPHS).map(([role, glyph]) => {
    const entry = CUSTOM_IDS[role];
    return {
      role,
      glyph,
      id: entry?.id ?? null,
      pack: entry?.pack ?? null,
      media: entry?.media ?? null,
      depicts: entry?.depicts ?? null,
      source: entry?.source ?? null,
      fallbackOnly: !entry?.id,
    };
  });
  return {
    summary: cov,
    roles: rows,
    animated: rows.filter((r) => r.media === 'video' || r.media === 'animated').length,
    static: rows.filter((r) => r.media === 'static').length,
    fallbackOnly: rows.filter((r) => r.fallbackOnly).length,
  };
}
