// Admin / supervisor console. Uses the Supabase anon key + the signed-in user's JWT. Everything is protected by RLS and admin_* functions.
(function () {
  'use strict';
  const $app = document.getElementById('app'); let sb, user, role = null, tab = 'overview', date = null, rt = null, poll = null, live = 'connecting';
  const rm = (c) => 'RM ' + ((c || 0) / 100).toFixed(2);
  const myt = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const q = (c) => { const n = Math.round(parseFloat(c) * 100); return Number.isFinite(n) ? n : null; };
  function h(tag, a, ...k) { const e = document.createElement(tag); for (const [x, v] of Object.entries(a || {})) { if (x === 'class') e.className = v; else if (x.startsWith('on')) e.addEventListener(x.slice(2), v); else if (v === true) e.setAttribute(x, ''); else if (v !== false && v != null) e.setAttribute(x, v); } for (const c of k.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); return e; }
  const table = (head, rows) => { const t = h('table', {}, h('tr', {}, head.map((x) => h('th', {}, x)))); rows.forEach((r) => t.append(h('tr', {}, r.map((c) => h('td', {}, c))))); return h('div', { class: 'wrap' }, t); };
  const note = (m, k) => { const el = document.getElementById('flash'); if (el) { el.textContent = m; el.className = 'msg ' + (k || 'ok'); } };
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(error.message); return data; };
  const sel = async (t, f) => { const { data, error } = await f(sb.from(t)); if (error) throw new Error(error.message); return data; };
  const act = (fn, okMsg) => async (ev) => { const btn = ev.currentTarget; btn.disabled = true; try { await fn(); note(okMsg || 'Done.'); await show(); } catch (e) { note(e.message, 'err'); btn.disabled = false; } };

  async function boot() {
    let cfg; try { cfg = await (await fetch('/.netlify/functions/api?action=config')).json(); } catch (_) {}
    if (!cfg || !cfg.supabase_url || !cfg.supabase_anon_key) { $app.replaceChildren(h('p', { class: 'err' }, 'Server is missing SUPABASE_URL / SUPABASE_ANON_KEY. See README.')); return; }
    sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
    const { data } = await sb.auth.getSession(); user = data.session && data.session.user;
    sb.auth.onAuthStateChange((_e, s) => { const u = s && s.user; if ((u && u.id) !== (user && user.id)) { user = u; start(); } });
    start();
  }
  async function start() {
    stopLive();
    if (!user) return loginView();
    const { data } = await sb.from('admins').select('role').eq('user_id', user.id).maybeSingle();
    role = data && data.role;
    if (!role) { $app.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'err' }, 'This account is not an administrator.'), h('button', { class: 'sm', onclick: () => sb.auth.signOut() }, 'Sign out'))); return; }
    startLive(); show();
  }
  function loginView() {
    const e = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username' }), p = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' }), m = h('div', { class: 'msg err' });
    const go = async () => { const { error } = await sb.auth.signInWithPassword({ email: e.value.trim(), password: p.value }); if (error) m.textContent = 'Sign-in failed.'; };
    p.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    $app.replaceChildren(h('div', { class: 'card', style: 'max-width:380px;margin:40px auto' }, h('h1', {}, 'Admin sign-in'), e, h('div', { style: 'height:8px' }), p, h('button', { class: 'go', onclick: go }, 'Sign in'), m));
  }

  // ---- live updates: realtime first, polling as a fallback
  function startLive() {
    let timer; const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { if (['overview', 'sales', 'inventory', 'shifts'].includes(tab) && !document.querySelector('input:focus,select:focus')) show(true); }, 800); };
    rt = sb.channel('csr-live');
    ['sales', 'shifts', 'stock_allocations', 'stock_returns', 'cash_settlements'].forEach((t) => rt.on('postgres_changes', { event: '*', schema: 'public', table: t }, refresh));
    rt.subscribe((s) => { live = s === 'SUBSCRIBED' ? 'realtime' : 'polling'; setLive(); });
    poll = setInterval(() => { if (live !== 'realtime' && !document.hidden) refresh(); else if (!document.hidden) refresh(); }, 30000);
  }
  function stopLive() { if (rt) { sb.removeChannel(rt); rt = null; } if (poll) clearInterval(poll); poll = null; }
  function setLive() { const el = document.getElementById('live'); if (el) { el.textContent = live === 'realtime' ? 'Live' : 'Auto-refresh 30s'; el.className = 'pill ' + (live === 'realtime' ? 'online' : 'pending'); } }

  const TABS = [['overview', 'Overview'], ['sales', 'Sales'], ['inventory', 'Inventory'], ['shifts', 'Shifts & cash'], ['settings', 'Settings'], ['export', 'Export']];
  async function show(quiet) {
    const body = h('div', {}); let view;
    try { view = await ({ overview: vOverview, sales: vSales, inventory: vInventory, shifts: vShifts, settings: vSettings, export: vExport }[tab])(); } catch (e) { view = h('p', { class: 'err' }, e.message); }
    const y = window.scrollY;
    $app.replaceChildren(h('div', { class: 'bar' }, h('h1', {}, 'Christmas Sales — Admin'), h('span', {}, h('span', { id: 'live', class: 'pill pending' }, ''), ' ', h('span', { class: 'mu' }, role + ' · ' + (user.email || '')), ' ', h('button', { class: 'sm s', onclick: () => sb.auth.signOut() }, 'Sign out'))),
      h('div', { class: 'tabs' }, TABS.map(([k, l]) => h('button', { class: 'sm' + (k === tab ? ' on' : ''), onclick: () => { tab = k; show(); } }, l))), h('div', { id: 'flash', class: 'msg' }), view);
    setLive(); window.scrollTo(0, y);
  }
  const owner = () => role === 'admin';

  // ---- Overview
  async function vOverview() {
    const d = await rpc('admin_dashboard', { p_date: date });
    const dateIn = h('input', { type: 'date', value: d.date, style: 'width:auto', onchange: (e) => { date = e.target.value || null; show(); } });
    const t = d.totals, el = h('div', {});
    el.append(h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, 'Business date'), dateIn),
      h('div', { class: 'kpi', style: 'grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' }, kpi('Revenue', rm(t.revenue_cents)), kpi('Cash', rm(t.cash_cents)), kpi('DuitNow QR', rm(t.qr_cents)), kpi('Transactions', t.transactions), kpi('Units sold', t.units_sold), kpi('Active shifts', d.active_shifts), kpi('Need review', d.review_count, d.review_count > 0), kpi('Stock differences', d.open_stock_differences, d.open_stock_differences > 0)),
      h('div', { class: 'mu' }, 'Generated ' + myt(d.generated_at) + '. "QR" is what promoters confirmed; it is not verified with the bank.')));
    el.append(h('div', { class: 'card' }, h('h2', {}, 'By promoter'), table(['Promoter', 'Sales', 'Cash', 'QR', 'Total'], d.by_promoter.map((p) => [p.name, p.transactions, rm(p.cash_cents), rm(p.qr_cents), rm(p.revenue_cents)]))));
    el.append(h('div', { class: 'card' }, h('h2', {}, 'By product'), table(['Product', 'Category', 'Units', 'Revenue'], d.by_product.map((p) => [p.name, p.category, p.units, rm(p.revenue_cents)]))));
    el.append(h('div', { class: 'card' }, h('h2', {}, 'By category'), table(['Category', 'Units', 'Revenue'], d.by_category.map((p) => [p.category, p.units, rm(p.revenue_cents)]))));
    el.append(h('div', { class: 'card' }, h('h2', {}, 'Last 14 days'), table(['Date', 'Sales', 'Revenue'], d.trend.map((x) => [x.date, x.transactions, rm(x.revenue_cents)]))));
    el.append(h('div', { class: 'card' }, h('h2', {}, 'Stock position'), table(['Product', 'Category', 'Warehouse', 'With promoters'], d.stock.map((s) => [s.name, s.category, s.warehouse, s.allocated]))));
    return el;
  }
  const kpi = (l, v, bad) => h('div', {}, l, h('b', { class: bad ? 'bad' : '' }, v));

  // ---- Sales (+ review queue)
  async function vSales() {
    const rows = await sel('sales', (t) => t.select('id,sale_number,occurred_at,business_date,payment_method,status,total_cents,review_reason,staff(name),shifts(status)').order('occurred_at', { ascending: false }).limit(300));
    const el = h('div', {}); const rev = rows.filter((r) => r.status === 'requires_review');
    if (rev.length) el.append(h('div', { class: 'card' }, h('h2', {}, 'Sales that need review (' + rev.length + ')'), h('p', { class: 'mu' }, 'These were recorded offline but the promoter did not have enough stock when they synced. Approve = count the sale and take the stock from the promoter; Void = cancel the sale. Either way you must write a short note.'),
      rev.map((r) => { const nt = h('input', { type: 'text', placeholder: 'Note (min 3 characters)' }); const a = h('button', { class: 'sm', onclick: act(() => rpc('admin_resolve_sale', { p_sale_id: r.id, p_action: 'approve', p_note: nt.value }), 'Sale approved.') }, 'Approve'); const v = h('button', { class: 'sm', onclick: act(() => rpc('admin_resolve_sale', { p_sale_id: r.id, p_action: 'void', p_note: nt.value }), 'Sale voided.') }, 'Void');
        return h('div', { class: 'line', style: 'flex-wrap:wrap' }, h('span', {}, r.sale_number + ' · ' + r.staff.name + ' · ' + rm(r.total_cents) + ' · ' + r.review_reason), nt, a, v); })));
    el.append(h('div', { class: 'card' }, h('h2', {}, 'Latest 300 sales'), table(['No.', 'Time', 'Promoter', 'Pay', 'Status', 'Total', ''], rows.map((r) => [r.sale_number, myt(r.occurred_at), r.staff.name, r.payment_method === 'cash' ? 'Cash' : 'QR', r.status, rm(r.total_cents),
      owner() && r.status === 'confirmed' ? (() => { const b = h('button', { class: 'sm s' }, 'Void'); b.addEventListener('click', async () => { const why = prompt('Reason for voiding ' + r.sale_number + '?'); if (!why) return; try { await rpc('admin_void_sale', { p_sale_id: r.id, p_reason: why }); note('Voided.'); show(); } catch (e) { note(e.message, 'err'); } }); return b; })() : '']))));
    return el;
  }

  // ---- Inventory
  async function vInventory() {
    const [products, d, allocs] = await Promise.all([sel('products', (t) => t.select('id,name,categories(name)').eq('active', true).order('name')), rpc('admin_dashboard', { p_date: date }),
      sel('stock_allocations', (t) => t.select('id,shift_id,product_id,declared_quantity,declared_at,products(name),shifts(business_date,staff(name))').eq('status', 'pending').order('declared_at'))]);
    const el = h('div', {});
    const byShift = {}; allocs.forEach((a) => (byShift[a.shift_id] = byShift[a.shift_id] || []).push(a));
    el.append(h('div', { class: 'card' }, h('h2', {}, 'Allocations waiting for confirmation'), !allocs.length ? h('p', { class: 'mu' }, 'Nothing waiting.') : Object.entries(byShift).map(([sid, list]) => {
      const ins = list.map((a) => [a, h('input', { type: 'number', min: '0', value: a.declared_quantity, style: 'width:90px' })]);
      const b = h('button', { class: 'sm', onclick: act(() => rpc('admin_confirm_allocation', { p_shift_id: sid, p_items: ins.map(([a, i]) => ({ allocation_id: a.id, confirmed_quantity: parseInt(i.value, 10) })) }), 'Allocation confirmed — stock moved from warehouse.') }, 'Confirm all');
      return h('div', { class: 'box' }, h('b', {}, list[0].shifts.staff.name + ' · ' + list[0].shifts.business_date), h('p', { class: 'mu' }, 'Edit the quantity to what you actually handed over.'), ins.map(([a, i]) => h('div', { class: 'line' }, h('span', {}, a.products.name + ' (declared ' + a.declared_quantity + ')'), i)), b);
    })));
    if (owner()) {
      const ps = h('select', {}, products.map((p) => h('option', { value: p.id }, p.name + ' (' + p.categories.name + ')'))), qn = h('input', { type: 'number', min: '1', placeholder: 'Quantity' }), nt = h('input', { type: 'text', placeholder: 'Note (supplier, invoice…)' });
      const rb = h('button', { class: 'go', onclick: act(() => rpc('admin_record_receipt', { p_product_id: ps.value, p_quantity: parseInt(qn.value, 10), p_note: nt.value || null }), 'Receipt recorded.') }, 'Record stock received into warehouse');
      el.append(h('div', { class: 'card' }, h('h2', {}, 'Warehouse receipt'), ps, h('div', { style: 'height:6px' }), qn, h('div', { style: 'height:6px' }), nt, rb));
      const ps2 = h('select', {}, products.map((p) => h('option', { value: p.id }, p.name))), dl = h('input', { type: 'number', placeholder: 'Change, e.g. -3 or 5' }), n2 = h('input', { type: 'text', placeholder: 'Reason (required)' });
      const ab = h('button', { class: 'go red', onclick: act(() => rpc('admin_adjust_warehouse', { p_product_id: ps2.value, p_delta: parseInt(dl.value, 10), p_note: n2.value }), 'Adjustment recorded.') }, 'Adjust warehouse stock');
      el.append(h('div', { class: 'card' }, h('h2', {}, 'Warehouse adjustment (damage, loss, correction)'), ps2, h('div', { style: 'height:6px' }), dl, h('div', { style: 'height:6px' }), n2, ab));
    }
    const ps3 = h('select', {}, products.map((p) => h('option', { value: p.id }, p.name)));
    const shifts = await sel('shifts', (t) => t.select('id,business_date,status,staff(name)').neq('status', 'closed').order('started_at'));
    if (shifts.length) { const ss = h('select', {}, shifts.map((s) => h('option', { value: s.id }, s.staff.name + ' · ' + s.business_date))), qn = h('input', { type: 'number', min: '1', placeholder: 'Quantity' });
      const b = h('button', { class: 'go', onclick: act(() => rpc('admin_allocate_stock', { p_shift_id: ss.value, p_product_id: ps3.value, p_quantity: parseInt(qn.value, 10) }), 'Stock allocated.') }, 'Give stock to promoter');
      el.append(h('div', { class: 'card' }, h('h2', {}, 'Top-up / allocate directly to an open shift'), ss, h('div', { style: 'height:6px' }), ps3, h('div', { style: 'height:6px' }), qn, b)); }
    return el;
  }

  // ---- Shifts, returns, cash, closing
  async function vShifts() {
    const shifts = await sel('shifts', (t) => t.select('id,business_date,status,started_at,ended_at,staff(name)').order('started_at', { ascending: false }).limit(40));
    const el = h('div', {});
    for (const s of shifts) {
      const box = h('div', { class: 'card' }, h('div', { class: 'bar', style: 'margin:0' }, h('b', {}, s.staff.name + ' · ' + s.business_date), h('span', { class: 'pill ' + (s.status === 'closed' ? 'synced' : 'pending') }, s.status)));
      if (s.status !== 'closed') {
        const [cl, counts, cs, bal] = await Promise.all([rpc('admin_shift_closing_status', { p_shift_id: s.id }), sel('stock_counts', (t) => t.select('product_id,expected_quantity,actual_quantity,difference,products(name)').eq('shift_id', s.id)), sel('cash_settlements', (t) => t.select('*').eq('shift_id', s.id).maybeSingle()),
          sel('stock_movements', (t) => t.select('product_id,quantity_change,products(name)').eq('shift_id', s.id).eq('location', 'shift'))]);
        const held = {}; bal.forEach((m) => { held[m.product_id] = held[m.product_id] || { name: m.products.name, n: 0 }; held[m.product_id].n += m.quantity_change; });
        box.append(h('p', { class: 'mu' }, 'Sales sync: ' + cl.sales_sync + ' · Stock: ' + cl.stock_closing + ' · Cash: ' + cl.cash_closing), cl.blockers.length ? h('p', { class: 'warn' }, 'Cannot close yet: ' + cl.blockers.join('; ')) : h('p', { class: 'ok' }, 'Ready to close.'));
        if (s.status === 'pending_reconciliation') {
          if (counts.length) {
            const ins = counts.map((c) => [c, h('input', { type: 'number', min: '0', value: c.actual_quantity, style: 'width:90px' })]);
            const rb = h('button', { class: 'sm', onclick: act(() => rpc('admin_confirm_return', { p_shift_id: s.id, p_items: ins.map(([c, i]) => ({ product_id: c.product_id, confirmed_quantity: parseInt(i.value, 10) })) }), 'Returned stock confirmed.') }, 'Confirm returned stock');
            box.append(h('h2', {}, 'Returned stock — enter what you physically received'), table(['Product', 'System expects', 'Promoter counted', 'You received'], ins.map(([c, i]) => [c.products.name, c.expected_quantity, c.actual_quantity, i])), rb);
          }
          const reRows = await sel('stock_returns', (t) => t.select('product_id,expected_quantity,confirmed_quantity,difference,discrepancy_status,products(name)').eq('shift_id', s.id));
          for (const r of reRows.filter((x) => x.discrepancy_status === 'open')) { const nt = h('input', { type: 'text', placeholder: 'Explanation (required)' }); const wo = h('input', { type: 'checkbox' });
            const b = h('button', { class: 'sm', onclick: act(() => rpc('admin_acknowledge_stock_difference', { p_shift_id: s.id, p_product_id: r.product_id, p_note: nt.value, p_write_off: wo.checked }), 'Difference acknowledged.') }, 'Acknowledge');
            box.append(h('div', { class: 'line', style: 'flex-wrap:wrap' }, h('span', { class: 'bad' }, r.products.name + ': expected ' + r.expected_quantity + ', received ' + r.confirmed_quantity + ' (' + r.difference + ')'), nt, h('label', {}, wo, ' write off remaining'), b)); }
          if (cs && cs.status === 'pending_handover') {
            const rc = h('input', { type: 'number', step: '0.01', placeholder: 'Cash received (RM)' }), fl = h('input', { type: 'number', step: '0.01', placeholder: 'Float given at start (RM)', value: '0' }), nt = h('input', { type: 'text', placeholder: 'Notes' });
            const b = h('button', { class: 'sm', onclick: act(() => rpc('admin_confirm_cash', { p_shift_id: s.id, p_received_cents: q(rc.value), p_float_cents: q(fl.value) || 0, p_adjustment_cents: 0, p_notes: nt.value || null }), 'Cash recorded.') }, 'Confirm cash received');
            box.append(h('h2', {}, 'Cash handover'), h('p', { class: 'mu' }, 'Expected from cash sales: ' + rm(cs.expected_cash_cents) + ' · promoter declared ' + rm(cs.declared_cash_cents)), rc, fl, nt, b);
          } else if (cs) {
            box.append(h('p', {}, 'Cash: expected ' + rm(cs.expected_cash_cents) + ', declared ' + rm(cs.declared_cash_cents) + ', received ' + rm(cs.received_cash_cents) + ', difference ' + rm(cs.difference_cents) + ' (' + cs.status + ')'));
            if (cs.status === 'discrepancy') { const nt = h('input', { type: 'text', placeholder: 'Explanation (required)' }); const b = h('button', { class: 'sm', onclick: act(() => rpc('admin_acknowledge_cash', { p_shift_id: s.id, p_note: nt.value }), 'Cash difference acknowledged.') }, 'Acknowledge cash difference'); box.append(nt, b); }
          }
          const cb = h('button', { class: 'go', disabled: !cl.can_close, onclick: act(() => rpc('admin_close_shift', { p_shift_id: s.id, p_note: null }), 'Shift closed.') }, 'Close shift'); box.append(cb);
        } else box.append(h('p', { class: 'mu' }, 'Promoter has not ended the shift yet.'), Object.keys(held).length ? table(['Product', 'Held now'], Object.values(held).filter((x) => x.n).map((x) => [x.name, x.n])) : '');
      }
      el.append(box);
    }
    return el;
  }

  // ---- Settings (owner only; RLS enforces it too)
  async function vSettings() {
    if (!owner()) return h('div', { class: 'card' }, h('p', { class: 'mu' }, 'Only an admin (not a supervisor) can change products, prices and promoters.'));
    const [cats, prods, staff, promos] = await Promise.all([sel('categories', (t) => t.select('*').order('sort_order').order('name')), sel('products', (t) => t.select('*').order('name')), sel('staff', (t) => t.select('*').order('name')), sel('promotions', (t) => t.select('*'))]);
    const el = h('div', {});
    const write = (fn) => async () => { try { const { error } = await fn(); if (error) throw new Error(error.message); note('Saved.'); show(); } catch (e) { note(e.message, 'err'); } };
    // staff
    const nn = h('input', { type: 'text', placeholder: 'New promoter name', maxlength: '80' });
    el.append(h('div', { class: 'card' }, h('h2', {}, 'Promoters'), staff.map((s) => h('div', { class: 'line' }, s.name, h('button', { class: 'sm s', onclick: write(() => sb.from('staff').update({ active: !s.active }).eq('id', s.id)) }, s.active ? 'Active — deactivate' : 'Inactive — activate'))), h('div', { class: 'row' }, nn, h('button', { class: 'sm', onclick: write(() => sb.from('staff').insert({ name: nn.value.trim() })) }, 'Add'))));
    // categories
    const cn = h('input', { type: 'text', placeholder: 'New category name' });
    el.append(h('div', { class: 'card' }, h('h2', {}, 'Categories'), cats.map((c) => h('div', { class: 'line' }, c.name)), h('div', { class: 'row' }, cn, h('button', { class: 'sm', onclick: write(() => sb.from('categories').insert({ name: cn.value.trim() })) }, 'Add'))));
    // products
    const pn = h('input', { type: 'text', placeholder: 'Product name' }), pp = h('input', { type: 'number', step: '0.01', placeholder: 'Price RM' }), pc = h('select', {}, cats.map((c) => h('option', { value: c.id }, c.name)));
    el.append(h('div', { class: 'card' }, h('h2', {}, 'Products and prices'), h('p', { class: 'mu' }, 'A price change only affects new sales; old sales keep the price they were sold at.'),
      prods.map((p) => { const pr = h('input', { type: 'number', step: '0.01', value: (p.price_cents / 100).toFixed(2), style: 'width:100px' }); return h('div', { class: 'line' }, h('span', {}, p.name + (p.active ? '' : ' (inactive)')), h('span', {}, pr, ' ', h('button', { class: 'sm s', onclick: write(() => sb.from('products').update({ price_cents: q(pr.value) }).eq('id', p.id)) }, 'Save price'), ' ', h('button', { class: 'sm s', onclick: write(() => sb.from('products').update({ active: !p.active }).eq('id', p.id)) }, p.active ? 'Hide' : 'Show'))); }),
      h('h2', { style: 'margin-top:14px' }, 'Add product'), pn, h('div', { style: 'height:6px' }), pp, h('div', { style: 'height:6px' }), pc, h('button', { class: 'go', onclick: write(() => sb.from('products').insert({ name: pn.value.trim(), price_cents: q(pp.value), category_id: pc.value })) }, 'Add product')));
    // promotions
    el.append(h('div', { class: 'card' }, h('h2', {}, 'Promotions'), promos.map((p) => {
      const pr = h('input', { type: 'number', step: '0.01', value: (p.promotional_price_cents / 100).toFixed(2), style: 'width:100px' });
      const cfg = p.configuration || {}; const elig = h('div', { class: 'mu' }, 'Bundle size ' + cfg.bundle_size + ' · eligible categories: ' + (cfg.eligible_category_ids || []).map((id) => (cats.find((c) => c.id === id) || {}).name).join(', ') + (cfg.eligible_product_ids && cfg.eligible_product_ids.length ? ' · products: ' + cfg.eligible_product_ids.map((id) => (prods.find((x) => x.id === id) || {}).name).join(', ') : ''));
      return h('div', { class: 'box' }, h('b', {}, p.name + (p.active ? '' : ' (off)')), elig, h('div', { class: 'row' }, pr, h('button', { class: 'sm', onclick: write(() => sb.from('promotions').update({ promotional_price_cents: q(pr.value) }).eq('id', p.id)) }, 'Save price'), h('button', { class: 'sm', onclick: write(() => sb.from('promotions').update({ active: !p.active }).eq('id', p.id)) }, p.active ? 'Turn off' : 'Turn on')));
    }), h('p', { class: 'mu' }, 'To change which drinks are eligible, edit promotions.configuration in Supabase (see README).')));
    return el;
  }

  // ---- CSV export (RFC 4180 quoting + spreadsheet formula-injection guard)
  const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function download(name, rows) { const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }); const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); }
  async function vExport() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }); const f = h('input', { type: 'date', value: today }), t = h('input', { type: 'date', value: today });
    const mk = (label, fn, name, cols, map) => h('button', { class: 'go', onclick: async (ev) => { ev.target.disabled = true; try { const rows = await rpc(fn, { p_from: f.value, p_to: t.value }); download(name + '_' + f.value + '_' + t.value + '.csv', [cols, ...rows.map(map)]); note('Downloaded ' + rows.length + ' rows.'); } catch (e) { note(e.message, 'err'); } ev.target.disabled = false; } }, label);
    return h('div', { class: 'card' }, h('h2', {}, 'CSV export (business dates, Asia/Kuala_Lumpur)'), h('div', { class: 'row' }, h('label', {}, 'From'), f), h('div', { class: 'row' }, h('label', {}, 'To'), t),
      mk('Sales (every transaction)', 'admin_report_sales', 'sales', ['Date', 'Sale no', 'Time', 'Promoter', 'Payment', 'Status', 'Subtotal RM', 'Discount RM', 'Total RM', 'Items'], (r) => [r.business_date, r.sale_number, r.occurred_at, r.promoter, r.payment_method, r.status, (r.subtotal_cents / 100).toFixed(2), (r.discount_cents / 100).toFixed(2), (r.total_cents / 100).toFixed(2), r.items]),
      mk('Products sold', 'admin_report_products', 'products', ['Date', 'Category', 'Product', 'Units', 'Revenue RM'], (r) => [r.business_date, r.category, r.product, r.units, (r.revenue_cents / 100).toFixed(2)]),
      mk('Shifts & cash', 'admin_report_shifts', 'shifts', ['Date', 'Promoter', 'Shift status', 'Started', 'Ended', 'Revenue RM', 'Cash expected RM', 'Declared RM', 'Received RM', 'Difference RM', 'Cash status'], (r) => [r.business_date, r.promoter, r.shift_status, r.started_at, r.ended_at, (r.revenue_cents / 100).toFixed(2), r.cash_expected_cents == null ? '' : (r.cash_expected_cents / 100).toFixed(2), r.cash_declared_cents == null ? '' : (r.cash_declared_cents / 100).toFixed(2), r.cash_received_cents == null ? '' : (r.cash_received_cents / 100).toFixed(2), r.cash_difference_cents == null ? '' : (r.cash_difference_cents / 100).toFixed(2), r.cash_status]));
  }
  boot();
})();
