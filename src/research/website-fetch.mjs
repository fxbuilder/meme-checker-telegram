/**
 * src/research/website-fetch.mjs
 * Fetch a project's own website prose, safely and within a hard budget.
 *
 * REUSES the existing SSRF guard (`isSafeExternalUrl` from media.mjs) rather than
 * duplicating it: HTTPS only, no loopback/private/link-local/CGNAT/metadata hosts,
 * no non-default ports. A second copy of that logic would drift.
 *
 * BOUNDS. One redirect hop at most, hard timeout, hard byte cap, text-only content
 * types, and the result is cached by the caller. A website is untrusted input: it is
 * converted to text and treated as data, never as instructions.
 */

import { isSafeExternalUrl } from '../media.mjs';

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 1;

/** Content types we will read as prose. Anything else is refused. */
const TEXT_TYPES = /^text\/(html|plain)|application\/xhtml\+xml/i;

/**
 * Fetch and extract readable prose from a project website.
 * Never throws; every failure is a status.
 *
 * @returns {Promise<{status:'ok'|'unsafe-url'|'no-url'|'timeout'|'too-large'|'not-text'|'provider-error', text?:string, finalUrl?:string}>}
 */
export async function fetchWebsiteText(url, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof url !== 'string' || !url.trim()) return { status: 'no-url' };
  if (!isSafeExternalUrl(url)) return { status: 'unsafe-url' };
  if (typeof fetchImpl !== 'function') return { status: 'provider-error' };

  let current = url;
  let hops = 0;

  for (;;) {
    if (!isSafeExternalUrl(current)) return { status: 'unsafe-url' };
    let res;
    try {
      res = await fetchImpl(current, {
        // Manual redirects: every hop must be re-validated, otherwise a public URL
        // can bounce into a private network.
        redirect: 'manual',
        headers: { 'user-agent': 'MemeChecker/1.0 (+research)', accept: 'text/html,text/plain' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { status: timedOut ? 'timeout' : 'provider-error', detail: String(err?.message ?? err) };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.get?.('location');
      if (!loc || hops >= MAX_REDIRECTS) return { status: 'provider-error', detail: 'redirect limit' };
      // Resolve relative redirects against the current URL before validating.
      let next;
      try { next = new URL(loc, current).toString(); } catch { return { status: 'unsafe-url' }; }
      if (!isSafeExternalUrl(next)) return { status: 'unsafe-url', detail: 'redirect to a blocked host' };
      current = next;
      hops += 1;
      continue;
    }

    if (!res.ok) return { status: 'provider-error', detail: `http ${res.status}` };

    // A response with NO content-type must not be assumed to be prose. Public
    // websites usually declare one; a binary payload served without a header would
    // otherwise flow straight into text extraction.
    const ctype = res.headers?.get?.('content-type') ?? '';
    if (!ctype) return { status: 'not-text', detail: 'no content-type' };
    if (!TEXT_TYPES.test(ctype)) return { status: 'not-text', detail: ctype.split(';')[0] };

    let body;
    try {
      body = await res.text();
    } catch {
      return { status: 'provider-error', detail: 'body read failed' };
    }
    if (typeof body !== 'string') return { status: 'provider-error', detail: 'non-string body' };
    if (body.length > MAX_BYTES) return { status: 'too-large' };

    return { status: 'ok', text: body, finalUrl: current };
  }
}
