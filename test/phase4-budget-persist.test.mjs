/**
 * test/phase4-budget-persist.test.mjs
 *
 * The daily provider allowance must survive a restart, or an operator who restarts
 * twice quietly gets several times the intended budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RequestBudget, attachBudgetPersistence, budgetStatePath } from '../src/research/research-cache.mjs';

function withEnvFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-budget-'));
  const saved = { p: process.env.RESEARCH_BUDGET_PATH, l: process.env.RESEARCH_X_BUDGET };
  process.env.RESEARCH_BUDGET_PATH = path.join(dir, 'budget.json');
  try {
    return fn(dir);
  } finally {
    if (saved.p === undefined) delete process.env.RESEARCH_BUDGET_PATH; else process.env.RESEARCH_BUDGET_PATH = saved.p;
    if (saved.l === undefined) delete process.env.RESEARCH_X_BUDGET; else process.env.RESEARCH_X_BUDGET = saved.l;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mk = (limit) => attachBudgetPersistence(new RequestBudget({ limit, label: 'x-search' }), process.env);

test('a spent request survives a restart', () => withEnvFile(() => {
  const a = mk(3);
  a.spend(1); a.spend(1);
  assert.equal(a.used, 2);
  assert.ok(fs.existsSync(budgetStatePath()), 'state file written');

  const b = mk(3);
  assert.equal(b.used, 2, 'the new instance must not start from zero');
  assert.equal(b.remaining(), 1);
}));

test('an exhausted budget stays exhausted after a restart', () => withEnvFile(() => {
  const a = mk(2);
  assert.equal(a.spend(1), true);
  assert.equal(a.spend(1), true);
  assert.equal(a.spend(1), false);

  const b = mk(2);
  assert.equal(b.spend(1), false, 'a restart must not hand the allowance back');
}));

test('a different configured limit ignores the stored count', () => withEnvFile(() => {
  const a = mk(2);
  a.spend(1); a.spend(1);
  // A stored `used: 2` under limit 2 means nothing when the limit is now 10.
  const b = mk(10);
  assert.equal(b.used, 0, 'a stale count from another configuration is not transferable');
}));

test('a corrupt state file starts clean instead of throwing', () => withEnvFile(() => {
  fs.writeFileSync(budgetStatePath(), '{not json');
  const b = mk(5);
  assert.equal(b.used, 0);
  assert.equal(b.spend(1), true, 'the budget still works');
}));

test('an elapsed window rolls over on load', () => withEnvFile(() => {
  fs.writeFileSync(budgetStatePath(), JSON.stringify({
    'x-search': { used: 5, windowStart: Date.now() - 25 * 60 * 60 * 1000, limit: 5, windowMs: 86400000 },
  }));
  const b = mk(5);
  assert.equal(b.used, 0, 'yesterday\'s usage must not block today');
}));

test('restore refuses nonsense rather than trusting it', () => {
  const b = new RequestBudget({ limit: 5, label: 'x-search' });
  assert.equal(b.restore({ used: -1, windowStart: Date.now() }), false);
  assert.equal(b.restore({ used: 99, windowStart: Date.now() }), false, 'used cannot exceed the limit');
  assert.equal(b.restore({ used: 'x', windowStart: Date.now() }), false);
  assert.equal(b.restore(null), false);
  assert.equal(b.used, 0, 'a refused restore changes nothing');
});
