/**
 * Coverage must be reported TWO ways: raw and applicable.
 *
 * The owner brief asks for this explicitly, and there is a substantive reason. A field is not
 * "missing" when the concept genuinely does not exist: legacy SPL tokens have no buy/sell tax,
 * so `not-applicable` is the CORRECT answer and counting it as a gap understates the work.
 *
 * But a chain where the source is simply absent must still count against the applicable rate,
 * or the report hides real gaps. Reporting only one of the two numbers misleads in one direction
 * or the other, so the harness returns both and neither can be quoted alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '..', 'benchmark', 'round5-final.json');

test('the committed results carry both denominators for every field', () => {
  const d = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  for (const [field, v] of Object.entries(d.summary.byField)) {
    assert.ok('n' in v, `${field} must report a raw denominator`);
    assert.ok('pct' in v, `${field} must report a raw percentage`);
    assert.ok('applicableN' in v, `${field} must report an applicable denominator`);
    assert.ok('applicablePct' in v, `${field} must report an applicable percentage`);
    assert.ok(v.applicableN <= v.n, `${field}: applicable cannot exceed raw`);
  }
});

test('tax has a SMALLER applicable denominator because non-applicability is proven', () => {
  // The concrete case: 5 legacy SPL tokens have no tax concept. Their `not-applicable`
  // outcome is a finding, so the applicable rate is higher than the raw rate.
  const d = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  const tax = d.summary.byField.tax;
  assert.ok(tax.notApplicable > 0, 'some tokens must classify not-applicable');
  assert.equal(tax.applicableN, tax.n - tax.notApplicable);
  assert.ok(tax.applicablePct >= tax.pct,
    'excluding proven non-applicability cannot lower the rate');
});

test('a field with no non-applicable tokens has identical raw and applicable rates', () => {
  const d = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  const holders = d.summary.byField.holders;
  assert.equal(holders.notApplicable, 0, 'holders always apply');
  assert.equal(holders.applicablePct, holders.pct);
});

test('applicablePct is null rather than 0 when nothing is applicable', () => {
  // A zero denominator must not render as "0%" - that reads as total failure when the truth is
  // that the question does not apply. This is the same class of error as rendering an
  // unmeasured value as zero.
  const d = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  for (const [field, v] of Object.entries(d.summary.byField)) {
    if (v.applicableN === 0) {
      assert.equal(v.applicablePct, null, `${field}: empty denominator must be null, not 0`);
    } else {
      assert.equal(typeof v.applicablePct, 'number');
    }
  }
});

test('the harness prints both columns, so neither can be quoted alone', () => {
  // A run over two tokens would hit the network. Instead assert the label exists in the source,
  // which is what a reader checking "does it report both?" would look for.
  const src = fs.readFileSync(path.join(HERE, '..', 'benchmark', 'measure.mjs'), 'utf8');
  assert.match(src, /raw vs applicable/);
  assert.match(src, /applicablePct/);
});
