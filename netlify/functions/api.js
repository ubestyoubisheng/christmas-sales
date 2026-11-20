// Promoter API (Netlify Function). The ONLY way the public site talks to the database.
// Uses the Supabase service-role key, which stays on the server (Netlify environment variables).
// Promoters never get a database key. After "Start Shift" they receive a random per-shift token; only its SHA-256
// hash is stored, and every call must present the shift id + token.
'use strict';
const crypto = require('crypto');

const MAX_BODY = 32 * 1024;
const RATE = { windowMs: 60_000, max: 240 };
const hits = new Map();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function allowedOrigin(origin) {
  const list = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin) return null;
  if (list.length === 0) return process.env.URL && origin === process.env.URL ? origin : null;
  return list.includes(origin) ? origin : null;
}

function rateLimited(key) {
  const now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < RATE.windowMs);
  h.push(now);
  hits.set(key, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > RATE.windowMs) hits.delete(k);
  return h.length > RATE.max;
}

const ERRORS = {
  invalid_shift: [401, 'Shift not recognised. Please start your shift again.'],
  invalid_token: [400, 'Invalid request.'],
  unknown_staff: [404, 'Staff not found.'],
  shift_not_open: [409, 'This shift is no longer open for this action.'],
  shift_not_ended: [409, 'End the shift first.'],
  already_confirmed: [409, 'Already confirmed by the supervisor.'],
  invalid_items: [400, 'Invalid items.'],
  invalid_quantity: [400, 'Invalid quantity.'],
  unknown_product: [400, 'Unknown product.'],
  unknown_promotion: [400, 'Unknown promotion.'],
  promotion_not_configured: [400, 'Promotion is not configured.'],
  product_not_eligible: [400, 'A selected drink is not part of the promotion.'],
  invalid_bundle_size: [400, 'Choose exactly the number of drinks the promotion needs.'],
  empty_cart: [400, 'The cart is empty.'],
  cart_too_large: [400, 'The cart is too large.'],
  invalid_payment: [400, 'Invalid payment method.'],
  insufficient_cash: [400, 'Cash received is less than the total.'],
  invalid_cash_amount: [400, 'Invalid cash amount.'],
  invalid_time: [400, 'Invalid transaction time.'],
  idempotency_conflict: [409, 'Duplicate transaction id.'],
};

function mapError(e) {
  const msg = String((e && e.message) || e || '');
  const key = Object.keys(ERRORS).find((k) => msg.includes(k));
  if (key) return { status: ERRORS[key][0], code: key, message: ERRORS[key][1] };
  if (msg.startsWith('missing_count')) return { status: 400, code: 'missing_count', message: 'Count every product you still hold: ' + msg.split(':').slice(1).join(':').trim() };
  return { status: 500, code: 'server_error', message: 'Server error. Your sale is safe on this device; it will retry.' };
}

function cors(event) {
  const o = allowedOrigin(event.headers.origin || event.headers.Origin);
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff' };
  if (o) { h['Access-Control-Allow-Origin'] = o; h['Access-Control-Allow-Headers'] = 'content-type'; h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'; }
  return h;
}

// ---- actions ------------------------------------------------------------
const actions = {
  async ping() { return { ok: true, time: new Date().toISOString() }; },

  // Public browser config for the admin page. The anon key is designed to be public; RLS protects the data.
  async config() { return { supabase_url: process.env.SUPABASE_URL || null, supabase_anon_key: process.env.SUPABASE_ANON_KEY || null }; },

  async staff(_b, db) {
    const { data, error } = await db.from('staff').select('id,name').eq('active', true).order('name');
    if (error) throw error;
    return { staff: data };
  },

  async catalog(_b, db) {
    const [cat, prod, promo] = await Promise.all([
      db.from('categories').select('id,name,sort_order').order('sort_order').order('name'),
      db.from('products').select('id,name,category_id,price_cents,sort_order').eq('active', true).order('sort_order').order('name'),
      db.from('promotions').select('id,name,promotional_price_cents,configuration').eq('active', true),
    ]);
    for (const r of [cat, prod, promo]) if (r.error) throw r.error;
    return { categories: cat.data, products: prod.data, promotions: promo.data };
  },

  async start_shift(b, db) {
    if (!isUuid(b.staff_id)) throw new Error('unknown_staff');
    const token = crypto.randomBytes(24).toString('hex');
    const { data, error } = await db.rpc('api_start_shift', { p_staff_id: b.staff_id, p_token_hash: sha(token) });
    if (error) throw error;
    return { ...data, token };
  },

  async declare_allocation(b, db) {
    need(b); if (!isUuid(b.batch_id)) throw new Error('invalid_items');
    const { data, error } = await db.rpc('api_declare_allocation', { p_shift_id: b.shift_id, p_hash: sha(b.token), p_batch_id: b.batch_id, p_items: cleanItems(b.items, 'quantity') });
    if (error) throw error;
    return data;
  },

  async create_sale(b, db) {
    need(b); if (!isUuid(b.key)) throw new Error('invalid_items');
    const lines = cleanItems(b.lines || [], 'quantity');
    const bundles = (Array.isArray(b.bundles) ? b.bundles : []).slice(0, 20).map((x) => {
      if (!x || !isUuid(x.promotion_id)) throw new Error('unknown_promotion');
      return {
      promotion_id: x.promotion_id, items: cleanItems(x.items || [], 'quantity') }; });
    const cash = b.payment === 'cash' ? toInt(b.cash_received_cents) : null;
    const when = b.occurred_at && !Number.isNaN(Date.parse(b.occurred_at)) ? new Date(b.occurred_at).toISOString() : null;
    const { data, error } = await db.rpc('api_create_sale', {
      p_shift_id: b.shift_id, p_hash: sha(b.token), p_key: b.key, p_payment: b.payment, p_lines: lines, p_bundles: bundles,
      p_cash_received_cents: cash, p_occurred_at: when, p_client: { ua: String(b.ua || '').slice(0, 200) } });
    if (error) throw error;
    return data;
  },

  async my_sales(b, db) {
    need(b);
    const { data, error } = await db.rpc('api_my_sales', { p_shift_id: b.shift_id, p_hash: sha(b.token) });
    if (error) throw error;
    return { sales: data };
  },
  async shift_summary(b, db) {
    need(b);
    const { data, error } = await db.rpc('api_shift_summary', { p_shift_id: b.shift_id, p_hash: sha(b.token) });
    if (error) throw error;
    return data;
  },
  async end_shift(b, db) {
    need(b);
    const { data, error } = await db.rpc('api_end_shift', { p_shift_id: b.shift_id, p_hash: sha(b.token) });
    if (error) throw error;
    return data;
  },
  async shift_report(b, db) {
    need(b);
    const { data, error } = await db.rpc('api_shift_report', { p_shift_id: b.shift_id, p_hash: sha(b.token) });
    if (error) throw error;
    return data;
  },
  async submit_closing(b, db) {
    need(b);
    const counts = (Array.isArray(b.counts) ? b.counts : []).slice(0, 200).map((c) => {
      if (!c || !isUuid(c.product_id)) throw new Error('unknown_product');
      return { product_id: c.product_id, actual_quantity: toInt(c.actual_quantity) };
    });
    const { data, error } = await db.rpc('api_submit_closing', { p_shift_id: b.shift_id, p_hash: sha(b.token), p_counts: counts, p_declared_cash_cents: toInt(b.declared_cash_cents) });
    if (error) throw error;
    return data;
  },
};

function need(b) {
  if (!isUuid(b.shift_id) || typeof b.token !== 'string' || b.token.length < 16 || b.token.length > 200) throw new Error('invalid_shift');
}
function toInt(v) { return Number.isInteger(v) ? v : null; }
function cleanItems(arr, qtyKey) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 200).map((x) => {
    if (!x || !isUuid(x.product_id)) throw new Error('unknown_product');
    return { product_id: x.product_id, [qtyKey]: toInt(x[qtyKey]) };
  });
}

let _db;
function client() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('missing server configuration');
  const { createClient } = require('@supabase/supabase-js');
  _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _db;
}

async function handle(event, dbOverride) {
  const headers = cors(event);
  const reply = (status, body) => ({ statusCode: status, headers, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') return reply(405, { error: 'method_not_allowed' });

  const origin = event.headers.origin || event.headers.Origin;
  if (origin && !allowedOrigin(origin)) return reply(403, { error: 'forbidden_origin', message: 'Origin not allowed.' });

  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) return { ...reply(429, { error: 'rate_limited', message: 'Too many requests. Please wait a moment.' }), headers: { ...headers, 'Retry-After': '30' } };

  let body = {};
  if (event.httpMethod === 'POST') {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    if (Buffer.byteLength(raw) > MAX_BODY) return reply(413, { error: 'payload_too_large' });
    try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { error: 'bad_json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'bad_json' });
  }
  const action = (event.queryStringParameters && event.queryStringParameters.action) || body.action;
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action)) return reply(404, { error: 'unknown_action' });
  if (event.httpMethod === 'GET' && !['ping', 'staff', 'catalog', 'config'].includes(action)) return reply(405, { error: 'method_not_allowed' });

  // optional event access code (set EVENT_ACCESS_CODE to require it for every call except ping)
  const code = process.env.EVENT_ACCESS_CODE;
  if (code && action !== 'ping' && action !== 'config') {
    const given = String(event.headers['x-event-code'] || '');
    const a = Buffer.from(sha(given)), b = Buffer.from(sha(code));
    if (!crypto.timingSafeEqual(a, b)) return reply(401, { error: 'access_code', message: 'Event access code required.' });
  }

  try {
    const db = dbOverride || ((action === 'ping' || action === 'config') ? null : client());
    return reply(200, await actions[action](body, db));
  } catch (e) {
    const m = mapError(e);
    if (m.status === 500) console.error('api error', action, e && e.message);
    return reply(m.status, { error: m.code, message: m.message });
  }
}

exports.handler = (event) => handle(event);
exports._handle = handle;
exports._sha = sha;
