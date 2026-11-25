/**
 * Run-to-run stability analysis.
 *
 * The report claims certain fields are "throttle" and others are "capability limits". That
 * distinction decides whether a gap is worth engineering effort, so it needs to be computed
 * rather than asserted — and the computation has its own traps, which these tests pin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'benchmark', 'stability.mjs');

/** Build a synthetic results file with the given per-token outcomes. */
function makeRun(dir, name, tokens, extra = {}) {
  const rows = tokens.map(([chain, address, symbol, fields]) => ({
    chain, address, symbol, role: 'named',
    scanStatus: 'ok', riskStatus: 'ok', ms: 1,
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, outcome]) => [k, { outcome }]),
    ),
    consistent: true, inconsistency: null, evidence: {},
  }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({
    summary: { byField: extra.byField ?? {}, byChain: {}, outcomes: {} },
    rows,
  }, null, 2));
  return file;
}

/**
 * Run the tool and return BOTH streams.
 *
 * The sample-drift warning is written to stderr, so capturing stdout alone made the
 * behaviour look absent when it was working - a test asserting on the wrong stream reports a
 * false failure, which is its own kind of wrong finding.
 */
function runTool(files) {
  const r = spawnSync('node', [TOOL, ...files], { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stability-'));

test('a field always covered is "working"; one never covered is a capability limit', () => {
  const tokens = [
    ['bsc', '0xaaa', 'AAA', { holders: 'measured', lp: 'unknown' }],
    ['bsc', '0xbbb', 'BBB', { holders: 'measured', lp: 'unknown' }],
  ];
  const r1 = makeRun(TMP, 'r1.json', tokens);
  const r2 = makeRun(TMP, 'r2.json', tokens);
  const { all: out } = runTool([r1, r2]);

  // holders never varies -> working. lp never varies -> capability limit, NOT a throttle.
  const lpLine = out.split('\n').find((l) => l.startsWith('lp '));
  assert.match(lpLine, /capability-limit/, 'a field that is never covered is a limit, not a throttle');
  const holdLine = out.split('\n').find((l) => l.startsWith('holders'));
  assert.match(holdLine, /working/);
});

test('a field that flips between runs is classified as a throttle', () => {
  // This is the real case: tax moved 63% -> 74% across runs on identical code because the
  // provider throttled some tokens. That is a different problem from a missing source.
  const r1 = makeRun(TMP, 'f1.json', [
    ['base', '0xaaa', 'AAA', { tax: 'unavailable' }],
    ['base', '0xbbb', 'BBB', { tax: 'unavailable' }],
  ]);
  const r2 = makeRun(TMP, 'f2.json', [
    ['base', '0xaaa', 'AAA', { tax: 'measured' }],
    ['base', '0xbbb', 'BBB', { tax: 'measured' }],
  ]);
  const { all: out } = runTool([r1, r2]);
  const line = out.split('\n').find((l) => l.startsWith('tax'));
  assert.match(line, /throttle/, 'an intermittently-available field is throttled');
});

test('a stable core with intermittent edges is neither pure case', () => {
  const r1 = makeRun(TMP, 'm1.json', [
    ['bsc', '0xaaa', 'AAA', { top10: 'measured' }],
    ['bsc', '0xbbb', 'BBB', { top10: 'unknown' }],
  ]);
  const r2 = makeRun(TMP, 'm2.json', [
    ['bsc', '0xaaa', 'AAA', { top10: 'measured' }],
    ['bsc', '0xbbb', 'BBB', { top10: 'measured' }],
  ]);
  const { all: out } = runTool([r1, r2]);
  const line = out.split('\n').find((l) => l.startsWith('top10'));
  assert.match(line, /mixed/);
});

test('runs covering DIFFERENT address sets are flagged, because a difference could be drift', () => {
  // Comparing two different samples and calling the delta "instability" would be a fabricated
  // finding - the sample changed, not the provider.
  const r1 = makeRun(TMP, 'd1.json', [['bsc', '0xaaa', 'AAA', { holders: 'measured' }]]);
  const r2 = makeRun(TMP, 'd2.json', [
    ['bsc', '0xaaa', 'AAA', { holders: 'measured' }],
    ['bsc', '0xbbb', 'BBB', { holders: 'unknown' }],
  ]);
  const { all: out } = runTool([r1, r2]);
  // Two acceptable signals: the explicit set warning, or the intersection line showing fewer
  // addresses were compared than the first run contained.
  assert.ok(
    /do not cover identical address sets/.test(out) || /present in all runs/.test(out),
    'a differing sample must be flagged rather than silently compared',
  );
});

test('the tool refuses to run on a single file', () => {
  const one = makeRun(TMP, 'one.json', [['bsc', '0xaaa', 'AAA', { holders: 'measured' }]]);
  const r = runTool([one]);
  assert.notEqual(r.status, 0, 'a single file must not be accepted');
  assert.match(r.all, /at least two/);
});
