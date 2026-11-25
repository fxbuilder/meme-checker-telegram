#!/usr/bin/env node
/**
 * Run-to-run stability of the fixed sample.
 *
 * WHY THIS EXISTS: the sample has now been measured several times on identical product code,
 * and the totals moved between runs (tax 63% vs 74%, dev 60% vs 74%, lp 37% vs 40%). Those
 * swings were provider throttling, not code changes - but that was established by re-running
 * individual tokens, which is slow and unrepeatable.
 *
 * A field whose value flips between runs is a THROTTLE. A field that never moves is a genuine
 * capability limit. Those two need different responses, and telling them apart by re-running
 * is guessing. This tool turns the distinction into a measurement.
 *
 * Usage: node benchmark/stability.mjs run1.json run2.json [run3.json ...]
 */
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2).filter((f) => !f.startsWith('--'));
if (files.length < 2) {
  console.error('need at least two result files to compare');
  process.exit(2);
}

const runs = files.map((f) => {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  const byKey = new Map();
  for (const r of data.rows) byKey.set(`${r.chain}:${r.address}`, r);
  return { file: path.basename(f), summary: data.summary, byKey };
});

const FIELDS = ['narrative', 'holders', 'top10', 'tax', 'lp', 'dev', 'dexPaid'];

// Every run must cover the same addresses, or a "difference" could just be sample drift.
const keysets = runs.map((r) => [...r.byKey.keys()].sort().join('|'));
const sameSample = new Set(keysets).size === 1;
if (!sameSample) {
  console.error('WARNING: the runs do not cover identical address sets - differences may be sample drift');
}

// The tool cannot detect a code change - only the operator knows. Comparing runs from
// DIFFERENT commits makes every improved field look like a throttle, which is the opposite of
// the truth. Say so up front so the output is not misread.
console.log('NOTE: only meaningful between runs of IDENTICAL code. Comparing different commits');
console.log('      shows the code change as flapping, not a throttle.');
// Caching is a third cause of run-to-run variation, separate from both code and throttling:
// descriptions are cached for 6 HOURS, so a back-to-back repeat can read a warm cache and
// report a field the first run had to fetch live. That makes a repeat run measure CACHE
// WARMTH, not provider stability. Clear the research cache for a true cold comparison.
console.log('NOTE: description responses are cached for 6h, so a back-to-back repeat measures');
console.log('      CACHE WARMTH rather than provider stability. Clear the cache to compare cold.\n');
// Totals are computed from the ROWS, not read from the file's summary.
//
// A results file may carry a partial summary, or one produced under a different schema. Trusting
// it crashed the tool on a field the summary omitted - and a stability report that throws is
// worse than one that recomputes: the rows are the primary evidence, so derive from them.
const COVERED = new Set(['measured', 'partial', 'na', 'zero']);
function totalsFromRows(run) {
  const out = {};
  const n = run.byKey.size;
  for (const f of FIELDS) {
    let covered = 0;
    for (const row of run.byKey.values()) {
      if (COVERED.has(row?.fields?.[f]?.outcome)) covered += 1;
    }
    out[f] = n ? Math.round((covered / n) * 100) : null;
  }
  return out;
}

console.log('=== TOTALS ACROSS RUNS (recomputed from rows) ===');
console.log('run'.padEnd(24), FIELDS.map((f) => f.slice(0, 7).padEnd(8)).join(''));
for (const r of runs) {
  const t = totalsFromRows(r);
  console.log(
    r.file.slice(0, 23).padEnd(24),
    FIELDS.map((f) => (t[f] == null ? '-'.padEnd(8) : `${t[f]}%`.padEnd(8))).join(''),
  );
}

// Per-field, per-token stability.
// Only addresses present in EVERY run can be compared. An address missing from one run would
// otherwise look like an outcome change, which is a fabricated instability finding.
const commonKeys = [...runs[0].byKey.keys()].filter((k) => runs.every((r) => r.byKey.has(k)));
if (commonKeys.length !== runs[0].byKey.size) {
  console.log(`\ncomparing ${commonKeys.length} addresses present in all runs `
    + `(of ${runs[0].byKey.size} in the first)`);
}

console.log('\n=== PER-FIELD STABILITY (same address, across runs) ===');
const verdicts = {};
for (const f of FIELDS) {
  let stable = 0;
  let flapping = 0;
  let alwaysCovered = 0;
  let neverCovered = 0;
  const flappers = [];

  for (const key of commonKeys) {
    const outcomes = runs.map((r) => r.byKey.get(key)?.fields?.[f]?.outcome ?? 'missing');
    const unique = new Set(outcomes);
    if (unique.size === 1) {
      stable += 1;
      if (COVERED.has(outcomes[0])) alwaysCovered += 1;
      else neverCovered += 1;
    } else {
      flapping += 1;
      if (flappers.length < 6) {
        const row = runs[0].byKey.get(key);
        flappers.push(`${row.chain}:${row.symbol} ${outcomes.join('|')}`);
      }
    }
  }

  // A field that is NEVER covered is a capability limit. One that FLAPS is a throttle.
  // One that is always covered is working. Anything else is partly both.
  let verdict = 'working';
  if (neverCovered === commonKeys.length) verdict = 'never-covered: capability limit OR instrument fault - verify the extractor reads the field the adapter actually sets';
  else if (flapping > 0 && alwaysCovered === 0) verdict = 'throttle (only ever intermittent)';
  else if (flapping > 0) verdict = 'mixed: stable core plus intermittent edges';
  verdicts[f] = { stable, flapping, alwaysCovered, neverCovered, verdict };

  console.log(
    f.padEnd(11),
    `stable=${String(stable).padEnd(3)} flapping=${String(flapping).padEnd(3)}`,
    '| ' + verdict,
  );
  for (const fl of flappers) console.log('      ', fl);
}

console.log('\n=== INTERPRETATION ===');
for (const [f, v] of Object.entries(verdicts)) {
  console.log(f.padEnd(11), v.verdict);
}

const out = { files: runs.map((r) => r.file), sameSample, verdicts };
fs.writeFileSync(path.join(path.dirname(files[0]), 'stability.json'), JSON.stringify(out, null, 2));
console.log('\nwrote stability.json');
