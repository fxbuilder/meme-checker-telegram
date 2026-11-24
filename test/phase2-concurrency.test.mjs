import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CallStore } from '../src/store.mjs';
import { recordCall } from '../src/call-service.mjs';

const scanFor = (i = 1) => ({
  status: 'ok', mode: 'live',
  token: { chain: 'bsc', address: `0x${i.toString(16).padStart(40, '0')}`, name: 'Audit', symbol: 'AUDIT' },
  market: { marketCapUsd: 100_000, priceUsd: 1, liquidityUsd: 50_000 },
});

for (const instances of [1, 2]) {
  test(`five simultaneous identical calls across ${instances} store instance(s) have one winner`, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mc-concurrent-'));
    const file = path.join(dir, 'calls.json');
    try {
      const stores = Array.from({ length: instances }, () => new CallStore(file).load());
      const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => recordCall({
        store: stores[i % instances], scanResult: scanFor(), chatId: '-1001',
        caller: { id: i + 1, displayName: `Caller ${i + 1}` },
      })));
      const result = {
        instances,
        recorded: outcomes.filter((o) => o.value?.status === 'recorded').length,
        duplicate: outcomes.filter((o) => o.value?.status === 'duplicate').length,
        errors: outcomes.filter((o) => o.status === 'rejected').map((o) => o.reason.message),
        memoryCounts: stores.map((s) => s.doc.calls.length),
        diskCount: JSON.parse(fs.readFileSync(file, 'utf8')).calls.length,
      };
      console.log('CONCURRENCY', JSON.stringify(result));
      assert.deepEqual(result.errors, []);
      assert.equal(result.recorded, 1);
      assert.equal(result.duplicate, 4);
      assert.equal(result.diskCount, 1);
      // A new object shares state; an actual fresh process proves durability.
      const reader = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { CallStore } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)}; console.log(JSON.stringify(new CallStore(${JSON.stringify(file)}).load().doc.calls));`,
      ], { encoding: 'utf8' });
      assert.equal(reader.status, 0, reader.stderr);
      const restarted = JSON.parse(reader.stdout);
      assert.equal(restarted.length, 1);
      assert.equal(restarted[0].callerId, '1');
      for (const store of stores) assert.equal(store.firstCall('-1001', 'bsc', scanFor().token.address).callerId, '1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('two stores preserve distinct simultaneous calls and observations', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mc-concurrent-'));
  const file = path.join(dir, 'calls.json');
  try {
    const stores = [new CallStore(file).load(), new CallStore(file).load()];
    const outcomes = await Promise.all(Array.from({ length: 5 }, (_, i) => recordCall({
      store: stores[i % 2], scanResult: scanFor(i + 1), chatId: '-1001',
      caller: { id: i + 1, displayName: `Caller ${i + 1}` },
    })));
    await stores[1].updateCall(outcomes[0].call.id, { lastMarketCapUsd: 200_000 });
    assert.equal(stores[0].doc.calls[0].lastMarketCapUsd, 200_000);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.calls.length, 5);
    assert.equal(new Set(disk.calls.map((c) => c.id)).size, 5);
    assert.equal(disk.calls[0].lastMarketCapUsd, 200_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
