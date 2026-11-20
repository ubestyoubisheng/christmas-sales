'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { createQueue } = require('../js/offline.js');

const mk = (apiImpl, idb = new IDBFactory(), t0 = 1_000_000) => {
  const clock = { t: t0 }; const calls = [];
  const api = { createSale: async (b) => { calls.push(b); return apiImpl(b, calls.length); } };
  return { q: createQueue({ api, indexedDB: idb, now: () => clock.t }), clock, calls, idb };
};
const sale = (extra = {}) => ({ shift_id: 's1', token: 't'.repeat(30), payment: 'cash', cash_received_cents: 1000, lines: [{ product_id: 'p', quantity: 1 }], bundles: [], ...extra });
const net = () => Object.assign(new Error('No connection'), { status: 0, code: 'network' });

test('a sale is saved locally first, survives a reload, and syncs after the network returns', async () => {
  let online = false;
  const { q, idb, clock } = mk(async () => { if (!online) throw net(); return { status: 'confirmed', sale_number: 'S1', total_cents: 200 }; });
  const rec = await q.add(sale());
  assert.equal((await q.get(rec.key)).status, 'local');
  let r = await q.sync(true);
  assert.equal(r.pending, 1); assert.equal((await q.get(rec.key)).status, 'pending');
  // simulate closing and reopening the browser tab (same IndexedDB)
  const again = createQueue({ api: { createSale: async () => ({ status: 'confirmed', sale_number: 'S1', total_cents: 200 }) }, indexedDB: idb, now: () => clock.t });
  assert.equal(await again.pendingCount(), 1);
  online = true; clock.t += 10 * 60 * 1000;
  r = await again.sync();
  assert.equal(r.synced, 1); const done = await again.get(rec.key);
  assert.equal(done.status, 'synced'); assert.equal(done.sale_number, 'S1');
});

test('exponential back-off: waits 2s, 4s, 8s ... and never beyond the cap; sale is never deleted', async () => {
  const { q, clock } = mk(async () => { throw net(); });
  const rec = await q.add(sale());
  const waits = [];
  for (let i = 0; i < 12; i++) { clock.t = Math.max(clock.t, (await q.get(rec.key)).next_at); const before = clock.t; await q.sync(); waits.push((await q.get(rec.key)).next_at - before); }
  assert.deepEqual(waits.slice(0, 4), [2000, 4000, 8000, 16000]);
  assert.ok(waits.every((w) => w <= 300000)); assert.equal(waits[11], 300000);
  assert.equal((await q.all()).length, 1);
});

test('back-off timer is respected unless the app is brought back to the foreground (force)', async () => {
  let n = 0; const { q, clock, calls } = mk(async () => { if (++n === 1) throw net(); return { status: 'confirmed', sale_number: 'S2', total_cents: 1 }; });
  await q.add(sale()); await q.sync(true);
  await q.sync(); assert.equal(calls.length, 1, 'not yet due');
  clock.t += 1000; await q.sync(); assert.equal(calls.length, 1);
  await q.sync(true); assert.equal(calls.length, 2);
});

test('lost acknowledgement: the retry uses the same idempotency key', async () => {
  let n = 0; const { q, calls } = mk(async (b) => { if (++n === 1) throw net(); return { status: 'confirmed', sale_number: 'S3', duplicate: true, total_cents: 1 }; });
  const rec = await q.add(sale()); await q.sync(true); await q.sync(true);
  assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key); assert.equal(calls[0].key, rec.key);
  assert.equal((await q.get(rec.key)).status, 'synced');
});

test('server marks a sale "requires review": shown as Requires Review, not as synced, and kept', async () => {
  const { q } = mk(async () => ({ status: 'requires_review', review_reason: 'insufficient_stock', sale_number: 'S4', total_cents: 500 }));
  const rec = await q.add(sale()); await q.sync(true);
  const x = await q.get(rec.key); assert.equal(x.status, 'review'); assert.equal(x.review_reason, 'insufficient_stock');
});

test('a permanent rejection is kept as "failed" with its reason and is not retried automatically', async () => {
  const { q, calls } = mk(async () => { throw Object.assign(new Error('Shift not recognised'), { status: 401, code: 'invalid_shift' }); });
  const rec = await q.add(sale()); await q.sync(true); await q.sync(true);
  assert.equal(calls.length, 1); const x = await q.get(rec.key);
  assert.equal(x.status, 'failed'); assert.match(x.error, /Shift/); assert.equal((await q.all()).length, 1);
  await q.retryFailed(rec.key, { token: 'n'.repeat(30) }); assert.equal((await q.get(rec.key)).status, 'pending');
});

test('server errors (500) and rate limits (429) are retried, not failed', async () => {
  for (const status of [500, 502, 429]) {
    const { q } = mk(async () => { throw Object.assign(new Error('x'), { status }); });
    const rec = await q.add(sale()); await q.sync(true);
    assert.equal((await q.get(rec.key)).status, 'pending', String(status));
  }
});

test('double sync calls and many queued sales: each sale is sent once, in order', async () => {
  const { q, calls } = mk(async () => ({ status: 'confirmed', sale_number: 'S', total_cents: 1 }));
  const keys = []; for (let i = 0; i < 5; i++) keys.push((await q.add(sale({ lines: [{ product_id: 'p', quantity: i + 1 }] }))).key);
  await Promise.all([q.sync(true), q.sync(true), q.sync(true)]);
  assert.equal(calls.length, 5); assert.deepEqual(calls.map((c) => c.key), keys);
});

test('late synchronisation next day keeps the original time of sale', async () => {
  const { q, calls, clock } = mk(async () => ({ status: 'confirmed', sale_number: 'S', total_cents: 1 }));
  const at = new Date(clock.t).toISOString(); const rec = await q.add(sale({ occurred_at: at }));
  clock.t += 26 * 3600 * 1000; await q.sync(true);
  assert.equal(calls[0].occurred_at, at); assert.equal((await q.get(rec.key)).status, 'synced');
});
