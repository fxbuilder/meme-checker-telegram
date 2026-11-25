/**
 * test/phase9-round3.test.mjs
 *
 * Round 3: argument routing, launchpad metadata, RugCheck score, honeypot levels.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveResearchTarget } from '../src/research/research-commands.mjs';
import {
  decodeLaunchpadTuple, fetchLaunchpadMetadata, LAUNCHPAD_GETTERS,
} from '../src/research/launchpad-metadata.mjs';
import { normalizeRugCheck } from '../src/security/rugcheck.mjs';

const ANT = '0xb4f9d1b2cad3646d15797de462e5d773194d7777';
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

// ---- argument parsing (the OWNER's actual failure) ------------------------

test('/narrative <chain> <CA> respects the explicit chain and never asks again', () => {
  // THE BUG: this parsed chain=bsc correctly, then detectAll() was called WITHOUT the
  // hint, so it still reported ambiguity and the bot asked for a chain the user had just
  // supplied. Verified live through the middleware afterwards.
  const r = resolveResearchTarget(`/narrative bsc ${ANT}`, { defaultEvmChain: 'bsc' });
  assert.equal(r.chain, 'bsc');
  assert.equal(r.chainHint, 'bsc');
  assert.equal(r.ambiguous, false, 'an explicit chain is not ambiguous');
});

test('/narrative <CA> alone is ambiguous, so resolution can run', () => {
  const r = resolveResearchTarget(`/narrative ${ANT}`, { defaultEvmChain: 'bsc' });
  assert.equal(r.chainHint, null);
  assert.equal(r.ambiguous, true, 'no chain stated means the resolver decides');
});

test('/narrative with a chain on a DIFFERENT chain than the group default honours the chain', () => {
  const r = resolveResearchTarget(`/narrative ethereum ${ANT}`, { defaultEvmChain: 'bsc' });
  assert.equal(r.chain, 'ethereum', 'the stated chain beats the group default');
  assert.equal(r.ambiguous, false);
});

test('a bot-qualified command parses identically', () => {
  // /narrative@MyBot is a normal Telegram form and used to leave "@MyBot" in the args.
  const r = resolveResearchTarget(`/narrative@MemeCheckerStagingBot bsc ${ANT}`, { defaultEvmChain: 'base' });
  assert.equal(r.chain, 'bsc');
  assert.equal(r.chainHint, 'bsc');
  assert.equal(r.ambiguous, false);
});

test('a Solana address is never ambiguous and needs no chain', () => {
  const r = resolveResearchTarget(`/narrative ${SOL}`, { defaultEvmChain: 'bsc' });
  assert.equal(r.chain, 'solana');
  assert.equal(r.ambiguous, false);
});

test('a missing or invalid argument is reported, not guessed', () => {
  assert.equal(resolveResearchTarget('/narrative', {}).error, 'missing');
  assert.equal(resolveResearchTarget('/narrative not-an-address', {}).error, 'not-an-address');
});

// ---- launchpad metadata decoding -----------------------------------------

/**
 * Build an ABI tuple like getTokenInfo() returns.
 *
 * Every offset is ABSOLUTE from the start of the return payload, which is what the ABI
 * actually specifies - a first attempt used offsets relative to each block and produced
 * a payload the decoder correctly refused.
 */
function abiTuple({ deployer = '0x' + '11'.repeat(20), logo = '', description = '', socials = ['', '', '', '', ''] }) {
  const pad32 = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  const word = (n) => n.toString(16).padStart(64, '0');
  const strBlock = (v) => {
    const hex = Buffer.from(v, 'utf8').toString('hex');
    return word(hex.length / 2) + pad32(hex);
  };

  const logoBlock = strBlock(logo);
  const descBlock = strBlock(description);

  // Socials is its own tuple: five offset words (relative to the socials block start),
  // followed by the five string blocks.
  const socStrBlocks = socials.map(strBlock);
  const socHeadBytes = socials.length * 32;
  let socHead = '';
  let socCursor = socHeadBytes;
  for (const b of socStrBlocks) {
    socHead += word(socCursor);
    socCursor += b.length / 2;
  }
  const socBlock = socHead + socStrBlocks.join('');

  // Lay the outer tuple out, then compute absolute offsets.
  const outerWords = 4;
  const logoOff = outerWords * 32;
  const descOff = logoOff + logoBlock.length / 2;
  const socOff = descOff + descBlock.length / 2;

  return '0x'
    + deployer.replace(/^0x/, '').padStart(64, '0')
    + word(logoOff)
    + word(descOff)
    + word(socOff)
    + logoBlock
    + descBlock
    + socBlock;
}

const ponsGetter = LAUNCHPAD_GETTERS.find((g) => g.id === 'pons-v2');

test('a launchpad tuple decodes its description as TEXT, not hex', () => {
  // The first implementation read the length word one word early and returned the hex of
  // the payload as the "description" - which looked like success and was garbage.
  const payload = abiTuple({ description: '100% of fees go back to Pons', logo: 'ipfs://bafyabc' });
  const d = decodeLaunchpadTuple(ponsGetter, payload);
  assert.equal(d.description, '100% of fees go back to Pons');
  assert.equal(d.logo, 'ipfs://bafyabc');
});

test('launchpad socials decode against the nested tuple base', () => {
  // Socials offsets are relative to the Socials tuple, not the outer return data. Indexing
  // from the wrong base silently produced an empty socials object.
  const payload = abiTuple({
    description: 'A launchpad token',
    socials: ['https://x.com/a', '', '', 'https://site.test', ''],
  });
  const d = decodeLaunchpadTuple(ponsGetter, payload);
  assert.equal(d.socials.twitter, 'https://x.com/a');
  assert.equal(d.socials.website, 'https://site.test');
});

test('an empty description never becomes a summary', () => {
  // With no description and no socials there is nothing to report, so the decoder returns
  // null rather than an object whose empty string could be rendered as prose.
  const d = decodeLaunchpadTuple(ponsGetter, abiTuple({ description: '' }));
  assert.ok(d === null || d.description === '', 'no invented text');
  assert.notEqual(d?.description, 'No description available');
});

test('a malformed tuple is refused, never half-decoded', () => {
  assert.equal(decodeLaunchpadTuple(ponsGetter, '0x'), null);
  assert.equal(decodeLaunchpadTuple(ponsGetter, null), null);
  // A length word claiming far more bytes than exist.
  const lying = '0x' + '00'.repeat(31) + '20' + '00'.repeat(31) + 'ff' + '41'.repeat(4);
  assert.equal(decodeLaunchpadTuple(ponsGetter, lying), null);
});

test('a chain with no RPC yields unsupported-chain, not a false negative', async () => {
  const r = await fetchLaunchpadMetadata('monad', PONS, { fetchImpl: async () => { throw new Error('nope'); } });
  assert.equal(r.status, 'unsupported-chain');
});

test('only documented getters are called - an unknown token is not probed', async () => {
  // The rule under test is WHICH selectors are called, not how many times. Each
  // documented getter now gets one retry (this read is often the only prose source for a
  // launchpad token, and the Robinhood RPC throttles bursts), so the assertion is on the
  // distinct selectors probed rather than the raw call count.
  const probed = new Set();
  const r = await fetchLaunchpadMetadata('robinhood', PONS, {
    fetchImpl: async (_url, opts) => {
      probed.add(JSON.parse(opts.body).params[0].data.slice(0, 10));
      return { ok: false, status: 500 };
    },
  });
  assert.equal(r.status, 'no-getter');

  const expected = LAUNCHPAD_GETTERS
    .filter((g) => !g.chains || g.chains.includes('robinhood'))
    .map((g) => g.selector);
  assert.deepEqual([...probed].sort(), expected.sort(),
    'exactly the documented selectors, nothing guessed');
});

// ---- RugCheck score ------------------------------------------------------

test('the RugCheck score is read from score_normalised and kept under its own key', () => {
  const n = normalizeRugCheck({ tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', score: 101, score_normalised: 7, risks: [{ name: 'Mutable metadata', level: 'warn' }] });
  assert.equal(n.security.rugcheckScore, 7, 'the normalised 0-100 score, not the raw 101');
  assert.equal(n.security.rugcheckRisks[0].name, 'Mutable metadata');
});

test('an absent RugCheck score is null, never zero', () => {
  const n = normalizeRugCheck({ tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
  assert.equal(n.security.rugcheckScore, null, 'zero would render as a clean bill of health');
});
