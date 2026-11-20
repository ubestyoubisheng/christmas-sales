// Database tests - run against a REAL PostgreSQL (needs PGHOST/PGUSER/PGPASSWORD of a superuser, defaults below).
// They apply the migrations to a throw-away database and exercise the atomic functions, RLS and concurrency.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool, Client } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONN = {
  host: process.env.PGHOST || '127.0.0.1',
  user: process.env.PGUSER || 'tester',
  password: process.env.PGPASSWORD || 'tester',
};
const DBNAME = 'csr_test_run';
let pool;

const OWNER = crypto.randomUUID();
const SUPERVISOR = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uuid = () => crypto.randomUUID();

// run one statement as a given database role (service_role / authenticated / anon) in its own transaction
async function call(role, uid, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r.rows;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const svc = (sql, p) => call('service_role', null, sql, p);
const admin = (sql, p, uid = OWNER) => call('authenticated', uid, sql, p);
const su = async (sql, p) => (await pool.query(sql, p)).rows;
const J = (x) => JSON.stringify(x);

const pid = {};
async function loadProducts() {
  for (const r of await su('select id, name from products')) pid[r.name] = r.id;
}

let staffN = 0;
async function newShift(name = `Promoter ${++staffN}`) {
  const [st] = await su('insert into staff(name) values ($1) returning id', [name]);
  const token = crypto.randomBytes(24).toString('hex');
  const hash = sha(token);
  const [r] = await svc('select api_start_shift($1, $2) as r', [st.id, hash]);
  return { staffId: st.id, shiftId: r.r.shift.id, hash, token };
}
async function declare(s, items) {
  const batch = uuid();
  await svc('select api_declare_allocation($1,$2,$3,$4::jsonb)', [s.shiftId, s.hash, batch,
    J(items.map(([n, q]) => ({ product_id: pid[n], quantity: q })))]);
  return su('select id, product_id, declared_quantity from stock_allocations where batch_id = $1', [batch]);
}
async function allocate(s, items) {
  const rows = await declare(s, items);
  const byProd = Object.fromEntries(items.map(([n, q]) => [pid[n], q]));
  await admin('select admin_confirm_allocation($1, $2::jsonb)', [s.shiftId,
    J(rows.map((r) => ({ allocation_id: r.id, confirmed_quantity: byProd[r.product_id] })))]);
}
async function sell(s, o = {}) {
  const lines = (o.lines || []).map(([n, q]) => ({ product_id: pid[n], quantity: q }));
  const bundles = (o.bundles || []).map((items) => ({ promotion_id: promoId, items: items.map(([n, q]) => ({ product_id: pid[n], quantity: q })) }));
  const [r] = await svc('select api_create_sale($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) as r', [
    s.shiftId, o.hash || s.hash, o.key || uuid(), o.payment || 'cash', J(lines), J(bundles),
    o.cash === undefined ? 100000 : o.cash, o.at || null]);
  return r.r;
}
const wh = async (name) => (await su('select warehouse_balance($1) as b', [pid[name]]))[0].b;
const bal = async (s, name) => (await su('select shift_balance($1,$2) as b', [s.shiftId, pid[name]]))[0].b;
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message), `expected error ${re}`);

let promoId;

before(async () => {
  const root = new Client({ ...CONN, database: 'postgres' });
  await root.connect();
  await root.query(`drop database if exists ${DBNAME} with (force)`);
  await root.query(`create database ${DBNAME}`);
  await root.end();
  pool = new Pool({ ...CONN, database: DBNAME, max: 20 });
  const base = path.join(__dirname, '..');
  for (const f of ['tests/supabase_stub.sql', 'supabase/migrations/001_schema.sql',
    'supabase/migrations/002_functions.sql', 'supabase/migrations/003_security.sql', 'supabase/seed.sql']) {
    await pool.query(fs.readFileSync(path.join(base, f), 'utf8'));
  }
  await su(`insert into admins(user_id, email, role) values ($1,'owner@example.com','admin'), ($2,'sup@example.com','supervisor')`,
    [OWNER, SUPERVISOR]);
  await loadProducts();
  promoId = (await su(`select id from promotions where name = 'Buy 5 Get 1'`))[0].id;
  // warehouse stock
  for (const [n, q] of [['Pepsi', 1000], ['Pepsi Black', 500], ['M.Dew', 500], ['7-Up', 500], ['Revive', 500],
    ['Twister 355ml Orange', 300], ['Wonda Ori', 300]]) {
    await admin('select admin_record_receipt($1,$2,$3)', [pid[n], q, 'opening stock']);
  }
});
after(async () => {
  await pool.end();
  const root = new Client({ ...CONN, database: 'postgres' });
  await root.connect();
  await root.query(`drop database if exists ${DBNAME} with (force)`);
  await root.end();
});

// ---------------------------------------------------------------- allocation
test('allocation: declared stock is NOT official until an administrator confirms it', async () => {
  const s = await newShift();
  const w0 = await wh('Pepsi');
  const rows = await declare(s, [['Pepsi', 100]]);
  assert.equal(await wh('Pepsi'), w0, 'declaring must not move warehouse stock');
  assert.equal(await bal(s, 'Pepsi'), 0);
  await admin('select admin_confirm_allocation($1,$2::jsonb)', [s.shiftId, J([{ allocation_id: rows[0].id, confirmed_quantity: 90 }])]);
  assert.equal(await wh('Pepsi'), w0 - 90);
  assert.equal(await bal(s, 'Pepsi'), 90, 'confirmed quantity (not declared) is what the promoter holds');
  const [sh] = await su('select status from shifts where id = $1', [s.shiftId]);
  assert.equal(sh.status, 'active');
});

test('allocation: cannot allocate more than the warehouse holds, nothing is half-applied', async () => {
  const s = await newShift();
  const w0 = await wh('Wonda Ori');
  const rows = await declare(s, [['Wonda Ori', w0 + 1], ['Pepsi', 5]]);
  const items = rows.map((r) => ({ allocation_id: r.id, confirmed_quantity: r.declared_quantity }));
  await rejects(admin('select admin_confirm_allocation($1,$2::jsonb)', [s.shiftId, J(items)]), /insufficient_warehouse_stock/);
  assert.equal(await wh('Wonda Ori'), w0);
  assert.equal(await bal(s, 'Pepsi'), 0, 'whole confirmation rolled back');
});

test('allocation: re-sending the same batch is idempotent', async () => {
  const s = await newShift();
  const batch = uuid();
  const items = J([{ product_id: pid['Pepsi'], quantity: 10 }]);
  await svc('select api_declare_allocation($1,$2,$3,$4::jsonb)', [s.shiftId, s.hash, batch, items]);
  const [r] = await svc('select api_declare_allocation($1,$2,$3,$4::jsonb) as r', [s.shiftId, s.hash, batch, items]);
  assert.equal(r.r.duplicate, true);
  const [c] = await su('select count(*)::int as n from stock_allocations where shift_id = $1', [s.shiftId]);
  assert.equal(c.n, 1);
});

test('allocation: a row cannot be confirmed twice (no double deduction)', async () => {
  const s = await newShift();
  const rows = await declare(s, [['M.Dew', 20]]);
  const items = J([{ allocation_id: rows[0].id, confirmed_quantity: 20 }]);
  await admin('select admin_confirm_allocation($1,$2::jsonb)', [s.shiftId, items]);
  const w = await wh('M.Dew');
  await rejects(admin('select admin_confirm_allocation($1,$2::jsonb)', [s.shiftId, items]), /allocation_not_pending/);
  assert.equal(await wh('M.Dew'), w);
});

test('allocation: two supervisors confirming the same row at the same time -> exactly one wins', async () => {
  const s = await newShift();
  const rows = await declare(s, [['Revive', 30]]);
  const items = J([{ allocation_id: rows[0].id, confirmed_quantity: 30 }]);
  const w0 = await wh('Revive');
  const res = await Promise.allSettled([
    admin('select admin_confirm_allocation($1,$2::jsonb)', [s.shiftId, items]),
    admin('select admin_confirm_allocation($1,$2::jsonb)', [s.shiftId, items], SUPERVISOR),
  ]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await wh('Revive'), w0 - 30);
});

test('allocation: concurrent over-allocation of scarce stock never makes the warehouse negative', async () => {
  const [p] = await su(`insert into products(name, category_id, price_cents) select 'Scarce Cola', id, 200 from categories limit 1 returning id`);
  pid['Scarce Cola'] = p.id;
  await admin('select admin_record_receipt($1,$2,$3)', [p.id, 100, 'test']);
  const shifts = await Promise.all([newShift(), newShift(), newShift()]);
  const all = [];
  for (const s of shifts) all.push([s, await declare(s, [['Scarce Cola', 60]])]);
  const res = await Promise.allSettled(all.map(([s, rows]) =>
    admin('select admin_confirm_allocation($1,$2::jsonb)', [s.shiftId, J([{ allocation_id: rows[0].id, confirmed_quantity: 60 }])])));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1, 'only one 60-unit allocation fits into 100');
  assert.equal(await wh('Scarce Cola'), 40);
});

// ---------------------------------------------------------------- sales + pricing
test('sale: prices come from the server; cash change is computed; stock leaves the promoter only', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 50], ['Twister 355ml Orange', 20]]);
  const w = await wh('Pepsi');
  const r = await sell(s, { lines: [['Pepsi', 3], ['Twister 355ml Orange', 1]], cash: 2000 });
  assert.equal(r.status, 'confirmed');
  assert.equal(r.total_cents, 3 * 200 + 350);
  assert.equal(r.change_cents, 2000 - 950);
  assert.equal(await bal(s, 'Pepsi'), 47);
  assert.equal(await wh('Pepsi'), w, 'selling an allocated bottle must not touch warehouse stock a second time');
  const [row] = await su('select business_date, payment_method from sales where id = $1', [r.sale_id]);
  assert.equal(row.payment_method, 'cash');
});

test('sale: DuitNow QR needs no cash amount; short cash is refused', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 10]]);
  const q = await sell(s, { lines: [['Pepsi', 1]], payment: 'duitnow_qr', cash: null });
  assert.equal(q.status, 'confirmed');
  assert.equal(q.change_cents, null);
  await rejects(sell(s, { lines: [['Pepsi', 2]], payment: 'cash', cash: 399 }), /insufficient_cash/);
  await rejects(sell(s, { lines: [['Pepsi', 1]], payment: 'bitcoin' }), /invalid_payment/);
  await rejects(sell(s, { lines: [['Pepsi', 0]] }), /invalid_quantity/);
  await rejects(sell(s, { lines: [] }), /empty_cart/);
});

test('sale: Buy 5 Get 1 - six mixed drinks cost the promotional price, discount recorded separately', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 20], ['M.Dew', 20], ['Twister 355ml Orange', 20]]);
  const r = await sell(s, { bundles: [[['Pepsi', 2], ['M.Dew', 3], ['Twister 355ml Orange', 1]]], cash: 1000 });
  assert.equal(r.status, 'confirmed');
  assert.equal(r.total_cents, 1000);
  assert.equal(r.discount_cents, 2 * 200 + 3 * 200 + 350 - 1000);
  const items = await su('select * from sale_items where sale_id = $1', [r.sale_id]);
  assert.equal(items.reduce((a, i) => a + i.quantity, 0), 6, 'all six drinks recorded');
  assert.equal(items.reduce((a, i) => a + i.discount_cents, 0), r.discount_cents);
  assert.equal(items.reduce((a, i) => a + i.line_total_cents, 0), 1000, 'line totals add up to the sale total');
  assert.ok(items.every((i) => i.promotion_id === promoId));
  assert.equal(await bal(s, 'Pepsi'), 18);
  assert.equal(await bal(s, 'M.Dew'), 17);
  assert.equal(await bal(s, 'Twister 355ml Orange'), 19, 'six drinks deducted in total');
});

test('sale: promotion rules are enforced (size, eligibility, unknown promotion)', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 20]]);
  await rejects(sell(s, { bundles: [[['Pepsi', 5]]] }), /invalid_bundle_size/);
  await rejects(sell(s, { bundles: [[['Pepsi', 7]]] }), /invalid_bundle_size/);
  const [other] = await su(`insert into categories(name) values ('Snacks') returning id`);
  const [chips] = await su(`insert into products(name, category_id, price_cents) values ('Chips', $1, 500) returning id`, [other.id]);
  pid['Chips'] = chips.id;
  await rejects(sell(s, { bundles: [[['Pepsi', 5], ['Chips', 1]]] }), /product_not_eligible/);
  await assert.rejects(svc(`select api_create_sale($1,$2,$3,'cash','[]'::jsonb,$4::jsonb,5000,null)`,
    [s.shiftId, s.hash, uuid(), J([{ promotion_id: uuid(), items: [{ product_id: pid['Pepsi'], quantity: 6 }] }])]), /unknown_promotion/);
});

test('sale: a bundle and ordinary lines can share one sale', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 30], ['7-Up', 30]]);
  const r = await sell(s, { lines: [['7-Up', 2]], bundles: [[['Pepsi', 6]]], cash: 5000 });
  assert.equal(r.total_cents, 1000 + 400);
  assert.equal(await bal(s, 'Pepsi'), 24);
  assert.equal(await bal(s, 'M.Dew'), 0);
});

test('sale: a retried request (lost acknowledgement) returns the same sale instead of a duplicate', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 10]]);
  const key = uuid();
  const a = await sell(s, { lines: [['Pepsi', 2]], key });
  const b = await sell(s, { lines: [['Pepsi', 2]], key });
  assert.equal(a.sale_id, b.sale_id);
  assert.equal(b.duplicate, true);
  assert.equal(await bal(s, 'Pepsi'), 8, 'stock deducted once');
  const [c] = await su('select count(*)::int as n from sales where idempotency_key = $1', [key]);
  assert.equal(c.n, 1);
});

test('sale: 10 simultaneous identical retries create exactly one sale', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 20]]);
  const key = uuid();
  const res = await Promise.all(Array.from({ length: 10 }, () => sell(s, { lines: [['Pepsi', 1]], key })));
  assert.equal(new Set(res.map((r) => r.sale_id)).size, 1);
  assert.equal(await bal(s, 'Pepsi'), 19);
});

test('sale: the same idempotency key cannot be reused on another shift', async () => {
  const a = await newShift(); const b = await newShift();
  await allocate(a, [['Pepsi', 5]]); await allocate(b, [['Pepsi', 5]]);
  const key = uuid();
  await sell(a, { lines: [['Pepsi', 1]], key });
  await rejects(sell(b, { lines: [['Pepsi', 1]], key }), /idempotency_conflict/);
});

test('sale: a wrong shift token is refused', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 5]]);
  await rejects(sell(s, { lines: [['Pepsi', 1]], hash: sha('not-the-token') }), /invalid_shift/);
});

test('sale: three promoters selling at the same time - totals and stock stay exact', async () => {
  const shifts = await Promise.all([newShift(), newShift(), newShift()]);
  for (const s of shifts) await allocate(s, [['Pepsi', 100]]);
  const w = await wh('Pepsi');
  await Promise.all(shifts.flatMap((s) => Array.from({ length: 30 }, () => sell(s, { lines: [['Pepsi', 2]] }))));
  for (const s of shifts) {
    assert.equal(await bal(s, 'Pepsi'), 100 - 60);
    const [t] = await su(`select count(*)::int n, sum(total_cents)::int t from sales where shift_id = $1 and status = 'confirmed'`, [s.shiftId]);
    assert.equal(t.n, 30); assert.equal(t.t, 30 * 400);
  }
  assert.equal(await wh('Pepsi'), w, 'warehouse untouched by sales');
});

// ---------------------------------------------------------------- stock conflicts
test('stock conflict: a sale beyond the promoter\'s stock is kept as "requires_review" - not lost, no negative stock', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 3]]);
  const r = await sell(s, { lines: [['Pepsi', 5]] });
  assert.equal(r.status, 'requires_review');
  assert.equal(r.review_reason, 'insufficient_stock');
  assert.equal(await bal(s, 'Pepsi'), 3, 'no stock moved');
  const [x] = await su('select total_cents from sales where id = $1', [r.sale_id]);
  assert.equal(x.total_cents, 1000, 'original transaction preserved');
  // administrator tops up stock -> the waiting sale is re-evaluated automatically
  await admin('select admin_allocate_stock($1,$2,$3,$4)', [s.shiftId, pid['Pepsi'], 10, 'top up']);
  const [after] = await su('select status from sales where id = $1', [r.sale_id]);
  assert.equal(after.status, 'confirmed');
  assert.equal(await bal(s, 'Pepsi'), 3 + 10 - 5);
});

test('stock conflict: sales recorded before the supervisor confirms the allocation wait, then confirm automatically', async () => {
  const s = await newShift();
  const rows = await declare(s, [['Pepsi', 20]]);
  const r1 = await sell(s, { lines: [['Pepsi', 4]] });
  assert.equal(r1.status, 'requires_review');
  await admin('select admin_confirm_allocation($1,$2::jsonb)', [s.shiftId, J([{ allocation_id: rows[0].id, confirmed_quantity: 20 }])]);
  const [x] = await su('select status from sales where id = $1', [r1.sale_id]);
  assert.equal(x.status, 'confirmed');
  assert.equal(await bal(s, 'Pepsi'), 16);
});

test('stock conflict: an administrator can approve or void a sale in review', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 1]]);
  const r = await sell(s, { lines: [['Pepsi', 3]] });
  await rejects(admin('select admin_resolve_sale($1,$2,$3)', [r.sale_id, 'approve', 'try']), /insufficient_stock/);
  await rejects(admin('select admin_resolve_sale($1,$2,$3)', [r.sale_id, 'void', '']), /note_required/);
  await admin('select admin_resolve_sale($1,$2,$3)', [r.sale_id, 'void', 'customer cancelled']);
  const [x] = await su('select status from sales where id = $1', [r.sale_id]);
  assert.equal(x.status, 'voided');
  assert.equal(await bal(s, 'Pepsi'), 1);
});

test('voiding a confirmed sale puts the bottles back into the shift', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 10]]);
  const r = await sell(s, { lines: [['Pepsi', 4]] });
  assert.equal(await bal(s, 'Pepsi'), 6);
  await rejects(admin('select admin_void_sale($1,$2)', [r.sale_id, 'x'], SUPERVISOR), /not_authorized|note_required/);
  await admin('select admin_void_sale($1,$2)', [r.sale_id, 'wrong item rung up']);
  assert.equal(await bal(s, 'Pepsi'), 10);
  await rejects(admin('select admin_void_sale($1,$2)', [r.sale_id, 'again please']), /already_voided/);
  assert.equal(await bal(s, 'Pepsi'), 10, 'no double reversal');
});

// ---------------------------------------------------------------- cross-day
test('cross-day: a sale made yesterday and synchronised today stays on yesterday\'s business date', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 10]]);
  await su(`update shifts set business_date = business_date - 1, started_at = now() - interval '26 hours' where id = $1`, [s.shiftId]);
  const at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const r = await sell(s, { lines: [['Pepsi', 1]], at });
  assert.equal(r.status, 'confirmed');
  const [x] = await su(`select business_date::text d, (select (business_date - 1)::text from shifts where id = $1) y from sales where id = $2`, [s.shiftId, r.sale_id]);
  const [sh] = await su(`select business_date::text d from shifts where id = $1`, [s.shiftId]);
  assert.equal(x.d, sh.d, 'business date follows the shift, not the upload time');
  const [o] = await su('select occurred_at from sales where id = $1', [r.sale_id]);
  assert.ok(Math.abs(new Date(o.occurred_at) - new Date(at)) < 1000, 'original timestamp preserved');
});

test('cross-day: a clock set in the future is clamped; a sale that predates the shift is flagged', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 10]]);
  const fut = await sell(s, { lines: [['Pepsi', 1]], at: new Date(Date.now() + 5 * 3600 * 1000).toISOString() });
  const [x] = await su('select occurred_at <= now() as ok from sales where id = $1', [fut.sale_id]);
  assert.equal(x.ok, true);
  const old = await sell(s, { lines: [['Pepsi', 1]], at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
  assert.equal(old.status, 'requires_review');
  assert.equal(old.review_reason, 'before_shift_start');
});

// ---------------------------------------------------------------- end of shift
async function endAndCount(s, counts, cash) {
  await svc('select api_end_shift($1,$2)', [s.shiftId, s.hash]);
  return svc('select api_submit_closing($1,$2,$3::jsonb,$4) as r', [s.shiftId, s.hash,
    J(counts.map(([n, q]) => ({ product_id: pid[n], actual_quantity: q }))), cash]);
}

test('closing: expected remaining = allocation - sold, differences computed per product', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 50], ['M.Dew', 20]]);
  await sell(s, { lines: [['Pepsi', 35]], cash: 100000 });
  const out = await endAndCount(s, [['Pepsi', 14], ['M.Dew', 20]], 7000);
  const pep = out[0].r.counts.find((c) => c.product_id === pid['Pepsi']);
  assert.deepEqual([pep.expected, pep.actual, pep.difference], [15, 14, -1]);
  const [sh] = await su('select status from shifts where id = $1', [s.shiftId]);
  assert.equal(sh.status, 'pending_reconciliation');
  const [cs] = await su('select * from cash_settlements where shift_id = $1', [s.shiftId]);
  assert.equal(cs.expected_cash_cents, 35 * 200);
  assert.equal(cs.declared_cash_cents, 7000);
  assert.equal(cs.status, 'pending_handover');
});

test('closing: a missing count for stock still in hand is refused', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 5], ['M.Dew', 5]]);
  await svc('select api_end_shift($1,$2)', [s.shiftId, s.hash]);
  await rejects(svc('select api_submit_closing($1,$2,$3::jsonb,$4)', [s.shiftId, s.hash, J([{ product_id: pid['Pepsi'], actual_quantity: 5 }]), 0]), /missing_count/);
});

test('closing: cash excludes QR sales and the declared cash alone never confirms anything', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 50]]);
  await sell(s, { lines: [['Pepsi', 10]], payment: 'cash', cash: 2000 });
  await sell(s, { lines: [['Pepsi', 5]], payment: 'duitnow_qr', cash: null });
  await endAndCount(s, [['Pepsi', 35]], 2000);
  const [cs] = await su('select * from cash_settlements where shift_id = $1', [s.shiftId]);
  assert.equal(cs.expected_cash_cents, 2000, 'QR not included');
  assert.equal(cs.received_cash_cents, null, 'promoter cannot mark money as received');
  assert.equal(cs.status, 'pending_handover');
});

test('full day: return, stock difference, cash shortage, closing rules and audit trail', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 50]]);
  await sell(s, { lines: [['Pepsi', 35]], cash: 100000 });
  await endAndCount(s, [['Pepsi', 14]], 6900);

  let st = (await admin('select admin_shift_closing_status($1) as r', [s.shiftId]))[0].r;
  assert.equal(st.can_close, false);
  await rejects(admin('select admin_close_shift($1)', [s.shiftId]), /closing_blocked/);

  const w0 = await wh('Pepsi');
  const ret = (await admin('select admin_confirm_return($1,$2::jsonb) as r', [s.shiftId, J([{ product_id: pid['Pepsi'], confirmed_quantity: 14 }])]))[0].r;
  assert.equal(ret.differences[0].difference, -1);
  assert.equal(await wh('Pepsi'), w0 + 14, 'only physically confirmed bottles go back to the warehouse');
  assert.equal(await bal(s, 'Pepsi'), 1, 'the missing bottle stays visible on the shift');
  await rejects(admin('select admin_confirm_return($1,$2::jsonb)', [s.shiftId, J([{ product_id: pid['Pepsi'], confirmed_quantity: 14 }])]), /already_confirmed/);
  assert.equal(await wh('Pepsi'), w0 + 14, 'no double return');

  await rejects(admin('select admin_acknowledge_stock_difference($1,$2,$3,false)', [s.shiftId, pid['Pepsi'], 'one bottle missing']), /balance_remaining/);
  await admin('select admin_acknowledge_stock_difference($1,$2,$3,true)', [s.shiftId, pid['Pepsi'], 'one bottle broken']);
  assert.equal(await bal(s, 'Pepsi'), 0);
  const [sold] = await su(`select count(*)::int n from sales where shift_id = $1 and status = 'confirmed'`, [s.shiftId]);
  assert.equal(sold.n, 1, 'sales untouched by the stock difference');

  const cash = (await admin('select admin_confirm_cash($1,$2,$3,$4,$5) as r', [s.shiftId, 6900, 5000, 0, 'counted twice']))[0].r;
  assert.deepEqual([cash.expected_cash_cents, cash.difference_cents, cash.status], [7000, -100, 'discrepancy']);
  await rejects(admin('select admin_confirm_cash($1,$2)', [s.shiftId, 7000]), /already_confirmed/);
  await rejects(admin('select admin_close_shift($1)', [s.shiftId]), /closing_blocked/);
  await admin('select admin_acknowledge_cash($1,$2)', [s.shiftId, 'RM1 short, covered by promoter']);
  const [cs] = await su('select * from cash_settlements where shift_id = $1', [s.shiftId]);
  assert.equal(cs.cash_float_cents, 5000, 'float tracked separately');
  assert.equal(cs.expected_cash_cents, 7000, 'float is not revenue');

  st = (await admin('select admin_shift_closing_status($1) as r', [s.shiftId]))[0].r;
  assert.equal(st.can_close, true, JSON.stringify(st));
  await admin('select admin_close_shift($1,$2)', [s.shiftId, 'ok']);

  const audit = await su(`select action from audit_logs where entity_id = $1`, [s.shiftId]);
  for (const a of ['shift_started', 'allocation_declared', 'allocation_confirmed', 'shift_ended', 'closing_submitted',
    'return_confirmed', 'stock_difference_acknowledged', 'cash_confirmed', 'cash_discrepancy_acknowledged', 'shift_closed']) {
    assert.ok(audit.some((x) => x.action === a), `audit entry ${a}`);
  }
});

test('closing: surplus stock at return is recorded explicitly, not hidden', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 10]]);
  await endAndCount(s, [['Pepsi', 11]], 0);
  const w0 = await wh('Pepsi');
  await admin('select admin_confirm_return($1,$2::jsonb)', [s.shiftId, J([{ product_id: pid['Pepsi'], confirmed_quantity: 11 }])]);
  assert.equal(await wh('Pepsi'), w0 + 11);
  const adj = await su(`select quantity_change from stock_movements where shift_id = $1 and movement_type = 'count_adjustment'`, [s.shiftId]);
  assert.equal(adj[0].quantity_change, 1);
  const [r] = await su(`select discrepancy_status, difference from stock_returns where shift_id = $1`, [s.shiftId]);
  assert.deepEqual([r.discrepancy_status, r.difference], ['open', 1]);
});

test('closing: a late-synchronised sale on a closed shift is flagged and reopens reconciliation when approved', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 10]]);
  await sell(s, { lines: [['Pepsi', 2]], cash: 1000 });
  await endAndCount(s, [['Pepsi', 8]], 400);
  await admin('select admin_confirm_return($1,$2::jsonb)', [s.shiftId, J([{ product_id: pid['Pepsi'], confirmed_quantity: 8 }])]);
  await admin('select admin_confirm_cash($1,$2)', [s.shiftId, 400]);
  await admin('select admin_close_shift($1)', [s.shiftId]);
  // an offline sale that was made before the end of shift arrives only now
  const late = await sell(s, { lines: [['Pepsi', 1]], at: new Date(Date.now() - 60 * 1000).toISOString() });
  assert.equal(late.status, 'requires_review');
  assert.equal(late.review_reason, 'shift_closed');
  const [still] = await su('select status from shifts where id = $1', [s.shiftId]);
  assert.equal(still.status, 'closed', 'closed shift is not silently changed');
  await admin('select admin_allocate_stock($1,$2,$3,$4)', [s.shiftId, pid['Pepsi'], 1, 'cover late sale']).catch((e) => assert.match(e.message, /shift_not_open/));
});

test('closing: a shift with a sale in review cannot be closed', async () => {
  const s = await newShift();
  await allocate(s, [['Pepsi', 2]]);
  await sell(s, { lines: [['Pepsi', 5]] });
  await endAndCount(s, [['Pepsi', 2]], 0);
  const st = (await admin('select admin_shift_closing_status($1) as r', [s.shiftId]))[0].r;
  assert.equal(st.sales_sync, 'review');
  assert.equal(st.can_close, false);
});

test('shift rules: one open shift per promoter, resuming re-issues access, sales after end are flagged', async () => {
  const s = await newShift();
  const again = await svc('select api_start_shift($1,$2) as r', [s.staffId, sha('another-device-token-123456')]);
  assert.equal(again[0].r.resumed, true);
  assert.equal(again[0].r.shift.id, s.shiftId);
  assert.equal(again[0].r.token_rotated, true);
  await allocate({ ...s, hash: sha('another-device-token-123456') }, [['Pepsi', 5]]);
  const hash2 = sha('another-device-token-123456');
  await svc('select api_end_shift($1,$2)', [s.shiftId, hash2]);
  const r = await sell({ ...s, hash: hash2 }, { lines: [['Pepsi', 1]], at: new Date(Date.now() + 120000).toISOString() });
  assert.equal(r.status, 'confirmed', 'clamped to now which is within the end-of-shift grace');
});

// ---------------------------------------------------------------- security
test('security: anonymous users can read and do nothing', async () => {
  for (const t of ['sales', 'products', 'staff', 'shifts', 'stock_movements', 'audit_logs', 'admins']) {
    await assert.rejects(call('anon', null, `select * from ${t}`), /permission denied/, t);
  }
  await assert.rejects(call('anon', null, `insert into products(name, category_id, price_cents) select 'x', id, 1 from categories limit 1`), /permission denied/);
  await assert.rejects(call('anon', null, `select admin_dashboard(null)`), /permission denied/);
  await assert.rejects(call('anon', null, `select api_create_sale(null,null,null,null,null,null,null,null)`), /permission denied/);
});

test('security: a signed-in user who is NOT an administrator sees nothing and can do nothing', async () => {
  const rows = await admin('select count(*)::int n from sales', [], OUTSIDER);
  assert.equal(rows[0].n, 0);
  assert.equal((await admin('select count(*)::int n from shifts', [], OUTSIDER))[0].n, 0);
  await rejects(admin('select admin_dashboard(null)', [], OUTSIDER), /not_authorized/);
  await rejects(admin('select admin_confirm_cash($1,$2)', [uuid(), 100], OUTSIDER), /not_authorized/);
  await assert.rejects(admin(`insert into products(name, category_id, price_cents) values ('hack', $1, 1)`, [(await su('select id from categories limit 1'))[0].id], OUTSIDER), /row-level security|permission denied/);
  await assert.rejects(call('authenticated', OUTSIDER, `select api_start_shift(null,null)`), /permission denied/);
});

test('security: administrators cannot rewrite sales, stock or audit records directly', async () => {
  await assert.rejects(admin(`update sales set total_cents = 1`), /permission denied/);
  await assert.rejects(admin(`delete from sales`), /permission denied/);
  await assert.rejects(admin(`insert into stock_movements(product_id, location, movement_type, quantity_change) select id, 'warehouse', 'adjustment', 999 from products limit 1`), /permission denied/);
  await assert.rejects(admin(`delete from audit_logs`), /permission denied/);
  await assert.rejects(admin(`update admins set role = 'admin'`), /permission denied/);
});

test('security: supervisors can confirm operations but cannot change prices, warehouse stock or void sales', async () => {
  assert.ok((await admin('select count(*)::int n from sales', [], SUPERVISOR))[0].n >= 0);
  await rejects(admin('select admin_record_receipt($1,$2,$3)', [pid['Pepsi'], 5, 'x'], SUPERVISOR), /not_authorized/);
  await rejects(admin('select admin_adjust_warehouse($1,$2,$3)', [pid['Pepsi'], -5, 'adjust'], SUPERVISOR), /not_authorized/);
  const n = await admin(`update products set price_cents = 1 where name = 'Pepsi' returning id`, [], SUPERVISOR);
  assert.equal(n.length, 0, 'RLS hides the row from a supervisor');
  const [p] = await su(`select price_cents from products where name = 'Pepsi'`);
  assert.equal(p.price_cents, 200);
});

test('security: owner price edits are audited and apply to the next sale only', async () => {
  const s = await newShift();
  await allocate(s, [['Wonda Ori', 5]]);
  await admin(`update products set price_cents = 320 where name = 'Wonda Ori'`);
  const r = await sell(s, { lines: [['Wonda Ori', 1]] });
  assert.equal(r.total_cents, 320);
  await admin(`update products set price_cents = 300 where name = 'Wonda Ori'`);
  const log = await su(`select action from audit_logs where action = 'update_products'`);
  assert.ok(log.length >= 2);
});

// ---------------------------------------------------------------- dashboard + reports
test('dashboard: only confirmed sales count; review sales are shown separately', async () => {
  const s = await newShift();
  await allocate(s, [['7-Up', 5]]);
  const before = (await admin('select admin_dashboard(null) as r'))[0].r;
  await sell(s, { lines: [['7-Up', 2]], payment: 'cash', cash: 1000 });
  await sell(s, { lines: [['7-Up', 1]], payment: 'duitnow_qr', cash: null });
  await sell(s, { lines: [['7-Up', 9]], payment: 'cash', cash: 100000 });
  const d = (await admin('select admin_dashboard(null) as r'))[0].r;
  assert.equal(d.totals.revenue_cents - before.totals.revenue_cents, 600);
  assert.equal(d.totals.cash_cents - before.totals.cash_cents, 400);
  assert.equal(d.totals.qr_cents - before.totals.qr_cents, 200);
  assert.equal(d.totals.transactions - before.totals.transactions, 2);
  assert.equal(d.review_count - before.review_count, 1);
  assert.ok(d.stock.length > 0 && d.by_promoter.length > 0);
});

test('reports: CSV source functions return rows and refuse crazy ranges', async () => {
  const today = (await su('select business_date_now()::text d'))[0].d;
  const rows = await admin('select * from admin_report_sales($1::date,$1::date)', [today]);
  assert.ok(rows.length > 0);
  assert.ok((await admin('select * from admin_report_products($1::date,$1::date)', [today])).length > 0);
  assert.ok((await admin('select * from admin_report_shifts($1::date,$1::date)', [today])).length > 0);
  await rejects(admin('select * from admin_report_sales($1::date,$2::date)', [today, '2020-01-01']), /invalid_range/);
});

test('ledger invariant: warehouse + all shift balances + sold = receipts (nothing created or lost)', async () => {
  const [r] = await su(`
    select (select coalesce(sum(quantity_change),0) from stock_movements where location = 'warehouse') as wh,
           (select coalesce(sum(quantity_change),0) from stock_movements where location = 'shift') as sh,
           (select coalesce(sum(quantity_change),0) from stock_movements where movement_type = 'receipt') as rec,
           (select coalesce(sum(quantity_change),0) from stock_movements where movement_type = 'adjustment' and location = 'warehouse') as adj,
           (select coalesce(sum(-quantity_change),0) from stock_movements where movement_type = 'sale') as sold,
           (select coalesce(sum(quantity_change),0) from stock_movements where movement_type = 'sale_void') as voided,
           (select coalesce(sum(-quantity_change),0) from stock_movements where movement_type = 'loss') as lost,
           (select coalesce(sum(quantity_change),0) from stock_movements where movement_type = 'count_adjustment') as surplus`);
  assert.equal(Number(r.wh) + Number(r.sh), Number(r.rec) + Number(r.adj) + Number(r.surplus) - Number(r.sold) + Number(r.voided) - Number(r.lost));
});
