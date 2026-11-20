// API tests: the Netlify handler is called with a db adapter that runs the real SQL functions as service_role.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool, Client } = require('pg');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { _handle } = require('../netlify/functions/api.js');
const CONN = { host: process.env.PGHOST || '127.0.0.1', user: process.env.PGUSER || 'tester', password: process.env.PGPASSWORD || 'tester' };
const DB = 'csr_api_run'; let pool; const OWNER = crypto.randomUUID();
const ORIGIN = 'https://sales.example.com';
process.env.ALLOWED_ORIGINS = ORIGIN;

const db = {
  async rpc(fn, args) {
    const names = Object.keys(args), c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role');
      const r = await c.query(`select ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(',')}) as r`, names.map((n) => (typeof args[n] === 'object' && args[n] !== null ? JSON.stringify(args[n]) : args[n])));
      await c.query('COMMIT'); return { data: r.rows[0].r, error: null };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); return { data: null, error: e }; } finally { c.release(); }
  },
  from(t) {
    const st = { t, where: [], order: [] };
    const q = { select(cols) { st.cols = cols; return q; }, eq(k, v) { st.where.push([k, v]); return q; }, order(k) { st.order.push(k); return q; },
      then(res, rej) { return (async () => {
        const c = await pool.connect();
        try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role');
          const r = await c.query(`select ${st.cols} from ${st.t}${st.where.length ? ' where ' + st.where.map(([k], i) => `${k}=$${i + 1}`).join(' and ') : ''}${st.order.length ? ' order by ' + st.order.join(',') : ''}`, st.where.map(([, v]) => v));
          await c.query('COMMIT'); return { data: r.rows, error: null };
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); return { data: null, error: e }; } finally { c.release(); } })().then(res, rej); } };
    return q;
  },
};
let n = 0;
const call = (action, body = {}, o = {}) => _handle({ httpMethod: o.method || 'POST', headers: { origin: o.origin === undefined ? ORIGIN : o.origin, 'x-nf-client-connection-ip': o.ip || `10.0.0.${++n % 250}`, ...(o.headers || {}) },
  body: JSON.stringify({ action, ...body }), queryStringParameters: o.qs || {} }, db).then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers }));
const su = async (s, p) => (await pool.query(s, p)).rows;
const adm = async (s, p) => { const c = await pool.connect(); try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [OWNER]); const r = await c.query(s, p); await c.query('COMMIT'); return r.rows; } finally { c.release(); } };

before(async () => {
  const root = new Client({ ...CONN, database: 'postgres' }); await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`); await root.query(`create database ${DB}`); await root.end();
  pool = new Pool({ ...CONN, database: DB, max: 10 });
  for (const f of ['tests/supabase_stub.sql', 'supabase/migrations/001_schema.sql', 'supabase/migrations/002_functions.sql', 'supabase/migrations/003_security.sql', 'supabase/seed.sql'])
    await pool.query(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  await su(`insert into admins(user_id,email) values ($1,'o@x.com')`, [OWNER]);
  await su(`insert into staff(name) values ('Aina'), ('Budi')`);
  for (const p of await su('select id from products')) await adm('select admin_record_receipt($1,500,$2)', [p.id, 'open']);
});
after(async () => { await pool.end(); const root = new Client({ ...CONN, database: 'postgres' }); await root.connect(); await root.query(`drop database if exists ${DB} with (force)`); await root.end(); });

test('public data: staff names and catalogue only - no stock levels, no other shifts', async () => {
  const s = await call('staff'); assert.equal(s.status, 200); assert.deepEqual(s.body.staff.map((x) => x.name), ['Aina', 'Budi']);
  const c = await call('catalog'); assert.equal(c.body.products.length, 14);
  assert.deepEqual(Object.keys(c.body.products[0]).sort(), ['category_id', 'id', 'name', 'price_cents', 'sort_order']);
  assert.equal(c.body.promotions[0].promotional_price_cents, 1000);
});

test('full promoter flow through the API incl. promotion and duplicate retry', async () => {
  const staff = (await call('staff')).body.staff[0], cat = (await call('catalog')).body;
  const pep = cat.products.find((p) => p.name === 'Pepsi'), dew = cat.products.find((p) => p.name === 'M.Dew');
  const st = await call('start_shift', { staff_id: staff.id }); assert.equal(st.status, 200);
  const A = { shift_id: st.body.shift.id, token: st.body.token };
  const batch = crypto.randomUUID();
  assert.equal((await call('declare_allocation', { ...A, batch_id: batch, items: [{ product_id: pep.id, quantity: 20 }, { product_id: dew.id, quantity: 10 }] })).status, 200);
  const rows = await su('select id, product_id, declared_quantity from stock_allocations where shift_id = $1', [A.shift_id]);
  await adm('select admin_confirm_allocation($1,$2::jsonb)', [A.shift_id, JSON.stringify(rows.map((r) => ({ allocation_id: r.id, confirmed_quantity: r.declared_quantity })))]);
  const key = crypto.randomUUID();
  const sale = { ...A, key, payment: 'cash', cash_received_cents: 2000, bundles: [{ promotion_id: cat.promotions[0].id, items: [{ product_id: pep.id, quantity: 4 }, { product_id: dew.id, quantity: 2 }] }], occurred_at: new Date().toISOString() };
  const r1 = await call('create_sale', sale), r2 = await call('create_sale', sale);
  assert.equal(r1.body.total_cents, 1000); assert.equal(r1.body.change_cents, 1000);
  assert.equal(r1.body.sale_id, r2.body.sale_id); assert.equal(r2.body.duplicate, true);
  const sum = (await call('shift_summary', A)).body;
  assert.equal(sum.totals.total_cents, 1000);
  assert.equal(sum.products.find((p) => p.name === 'Pepsi').balance, 16);
  const mine = (await call('my_sales', A)).body.sales; assert.equal(mine.length, 1);
  await call('end_shift', A);
  const bad = await call('submit_closing', { ...A, counts: [{ product_id: pep.id, actual_quantity: 16 }], declared_cash_cents: 1000 });
  assert.equal(bad.status, 400); assert.match(bad.body.message, /M\.Dew/);
  const ok = await call('submit_closing', { ...A, counts: [{ product_id: pep.id, actual_quantity: 16 }, { product_id: dew.id, actual_quantity: 8 }], declared_cash_cents: 1000 });
  assert.equal(ok.status, 200);
});

test('security: price/total in the request are ignored; bad token, ids and payloads are rejected', async () => {
  const staff = (await call('staff')).body.staff[1], cat = (await call('catalog')).body, pep = cat.products[0];
  const st = (await call('start_shift', { staff_id: staff.id })).body; const A = { shift_id: st.shift.id, token: st.token };
  const rows = (await call('declare_allocation', { ...A, batch_id: crypto.randomUUID(), items: [{ product_id: pep.id, quantity: 5 }] })).status; assert.equal(rows, 200);
  const r = await su('select id from stock_allocations where shift_id=$1', [A.shift_id]);
  await adm('select admin_confirm_allocation($1,$2::jsonb)', [A.shift_id, JSON.stringify([{ allocation_id: r[0].id, confirmed_quantity: 5 }])]);
  const sale = await call('create_sale', { ...A, key: crypto.randomUUID(), payment: 'cash', cash_received_cents: 1000, lines: [{ product_id: pep.id, quantity: 1 }], unit_price_cents: 1, total_cents: 1 });
  assert.equal(sale.body.total_cents, pep.price_cents);
  assert.equal((await call('create_sale', { ...A, token: 'x'.repeat(40), key: crypto.randomUUID(), payment: 'cash', cash_received_cents: 1000, lines: [{ product_id: pep.id, quantity: 1 }] })).status, 401);
  assert.equal((await call('create_sale', { shift_id: 'nope', token: 'x', key: 'k' })).status, 401);
  assert.equal((await call('create_sale', { ...A, key: crypto.randomUUID(), payment: 'cash', cash_received_cents: 1000, lines: [{ product_id: pep.id, quantity: -3 }] })).status, 400);
  assert.equal((await call('create_sale', { ...A, key: crypto.randomUUID(), payment: 'cash', cash_received_cents: 1000, lines: [{ product_id: "1'; drop table sales;--", quantity: 1 }] })).status, 400);
  assert.equal((await call('nope')).status, 404);
  assert.equal((await call('create_sale', {}, { method: 'GET', qs: { action: 'create_sale' } })).status, 405);
  assert.equal((await call('ping', {}, { origin: 'https://evil.example' })).status, 403);
  const big = await _handle({ httpMethod: 'POST', headers: { origin: ORIGIN, 'x-nf-client-connection-ip': '9.9.9.9' }, body: JSON.stringify({ action: 'ping', pad: 'a'.repeat(40000) }) }, db);
  assert.equal(big.statusCode, 413);
  const dbg = await call('start_shift', { staff_id: crypto.randomUUID() }); assert.equal(dbg.status, 404);
});

test('rate limiting kicks in per client address', async () => {
  let last; for (let i = 0; i < 260; i++) last = await call('ping', {}, { ip: '7.7.7.7' });
  assert.equal(last.status, 429);
});

test('optional event access code', async () => {
  process.env.EVENT_ACCESS_CODE = 'XMAS26';
  try {
    assert.equal((await call('staff')).status, 401);
    assert.equal((await call('staff', {}, { headers: { 'x-event-code': 'XMAS26' } })).status, 200);
    assert.equal((await call('ping')).status, 200);
  } finally { delete process.env.EVENT_ACCESS_CODE; }
});
