// Promoter app. All text is plain; every dynamic value is inserted with textContent / escaped (no innerHTML with data).
(function () {
  'use strict';
  const $app = document.getElementById('app');
  const LS = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }, del(k) { try { localStorage.removeItem(k); } catch (_) {} } };
  const api = CsrApi.createApi({ getAccessCode: () => LS.get('csr.code') || '' });
  const queue = Offline.createQueue({ api });
  const rm = (c) => 'RM ' + (c / 100).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const myt = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  // The shift session is kept in memory only: a refresh/reopen always asks "who is selling?" again.
  const S = { online: navigator.onLine, view: 'boot', session: null, catalog: LS.get('csr.catalog'), staff: [], cart: {}, bundles: [], pay: 'cash', cash: '', msg: '', busy: false, picker: null, open: new Set(), summary: null, history: [], codeNeeded: false };

  // ---- connectivity: navigator.onLine is only a hint; a real request decides
  async function probe() { const ok = await Offline.checkBackend(api, 6000); if (ok !== S.online) { S.online = ok; render(); } return ok; }
  async function syncNow(force) { if (!(await probe())) return; await queue.sync(force); render(); if (S.view === 'history') loadHistory(); }
  setInterval(() => { if (!document.hidden) syncNow(false); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(true); });
  window.addEventListener('online', () => syncNow(true)); window.addEventListener('offline', () => { S.online = false; render(); });
  queue.onChange(() => { if (S.view === 'sell' || S.view === 'history') render(); });

  // ---- tiny DOM helper
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  function render() {
    const y = window.scrollY; $app.replaceChildren();
    const v = { boot: vBoot, staff: vStaff, alloc: vAlloc, sell: vSell, history: vHistory, summary: vSummary, closing: vClosing, done: vDone, code: vCode }[S.view] || vBoot;
    $app.append(header(), v()); window.scrollTo(0, y);
  }
  function header() {
    const st = S.online ? 'online' : 'offline';
    return h('div', { class: 'bar' }, h('h1', {}, 'Christmas Sales Recorder'), h('span', { class: 'pill ' + st }, S.online ? 'Online' : 'Offline'));
  }
  const msg = () => h('div', { class: 'msg ' + (S.msgKind || '') }, S.msg);
  function say(m, kind) { S.msg = m; S.msgKind = kind || ''; render(); }

  // ---- boot
  async function boot() {
    await probe();
    LS.del('csr.session');   // older versions stored the shift token here; it is no longer kept on the device
    if (S.online) syncNow(false);   // unsent sales from before the refresh keep syncing in the background
    await goStaff();
  }
  async function loadCatalog() { try { S.catalog = await api.catalog(); LS.set('csr.catalog', S.catalog); } catch (e) { handleErr(e); } }
  function handleErr(e) { if (e.code === 'access_code') { S.view = 'code'; render(); } }
  async function goStaff() {
    S.view = 'staff'; render();
    try { const r = await api.staff(); S.staff = r.staff; await loadCatalog(); S.msg = ''; } catch (e) { handleErr(e); S.msg = S.online ? e.message : 'You are offline. Connect to the internet to start your shift.'; S.msgKind = 'err'; }
    render();
  }
  function vCode() {
    const i = h('input', { type: 'password', placeholder: 'Event access code', autocomplete: 'off' });
    return h('div', { class: 'card' }, h('h2', {}, 'Event access code'), i,
      h('button', { class: 'go', onclick: () => { LS.set('csr.code', i.value.trim()); boot(); } }, 'Continue'));
  }
  function vBoot() { return h('p', { class: 'mu' }, 'Loading…'); }

  // ---- staff selection + Start Shift
  function vStaff() {
    const sel = h('select', {}, h('option', { value: '' }, 'Select your name'), S.staff.map((s) => h('option', { value: s.id }, s.name)));
    const btn = h('button', { class: 'go', onclick: async () => {
      if (!sel.value || S.busy) return; S.busy = true; btn.disabled = true;
      try {
        const r = await api.startShift(sel.value);
        S.session = { shift_id: r.shift.id, token: r.token, staff_name: r.staff_name, staff_id: r.shift.staff_id, business_date: r.shift.business_date, status: r.shift.status, allocated: r.shift.status !== 'pending_allocation', ended: ['closing', 'pending_reconciliation', 'closed'].includes(r.shift.status) };
        await queue.retoken(r.shift.id, r.token);   // unsent sales of this shift continue with the new token
        // A resumed shift whose stock is already declared (waiting for the supervisor) goes straight to selling.
        if (!S.session.allocated) { try { const sm = await api.summary({ shift_id: S.session.shift_id, token: S.session.token }); if (sm && sm.pending_allocation_rows > 0) S.session.allocated = true; } catch (_) {} }
        S.cart = {}; S.bundles = []; S.history = []; S.summary = null;
        S.view = S.session.ended ? 'closing' : (S.session.allocated ? 'sell' : 'alloc'); S.msg = r.resumed ? 'Welcome back, ' + r.staff_name + ' — your shift was resumed.' : ''; S.msgKind = 'ok';
        syncNow(true);
      } catch (e) { S.msg = e.message; S.msgKind = 'err'; }
      S.busy = false; render();
    } }, 'Start Shift');
    return h('div', { class: 'card' }, h('h2', {}, 'Who is selling today?'), sel, btn, msg(),
      h('p', { class: 'mu' }, 'Pick your own name only. If you already have an open shift it will continue where you left off.'));
  }

  // ---- declare the stock received for this shift
  function vAlloc() {
    const cat = S.catalog; if (!cat) return h('p', { class: 'err' }, 'Product list not loaded. Connect to the internet.');
    const inputs = {};
    const groups = groupByCategory();
    const card = h('div', { class: 'card' }, h('h2', {}, 'Stock you received for this shift'),
      h('p', { class: 'mu' }, 'Enter how many you physically took. It is recorded as your stock straight away; everything is checked again when you end the shift. Leave 0 for items you did not take.'),
      groups.map((g) => h('div', {}, h('h2', { style: 'margin-top:12px' }, g.name), g.items.map((p) => {
        const i = h('input', { type: 'number', min: '0', inputmode: 'numeric', value: '0' }); inputs[p.id] = i;
        return h('div', { class: 'row' }, h('label', { style: 'flex:1 1 55%;color:inherit' }, p.name), i);
      }))),
      h('button', { class: 'go', onclick: async (ev) => {
        const items = Object.entries(inputs).map(([id, i]) => ({ product_id: id, quantity: parseInt(i.value, 10) || 0 })).filter((x) => x.quantity > 0);
        if (!items.length) return say('Enter at least one product.', 'err');
        ev.target.disabled = true;
        try { const d = await api.declareAllocation({ shift_id: S.session.shift_id, token: S.session.token, batch_id: Offline.uuid(), items }); S.session.allocated = true; S.view = 'sell'; S.msg = d && d.pending_rows ? 'Stock recorded, but some items are waiting for the supervisor because the warehouse does not have enough.' : 'Stock recorded.'; S.msgKind = d && d.pending_rows ? 'err' : 'ok'; }
        catch (e) { S.msg = e.message; S.msgKind = 'err'; if (e.code === 'invalid_shift') return resetSession(); }
        render();
      } }, 'Submit stock'),
      h('button', { class: 'sm', style: 'margin-top:10px;width:100%', onclick: () => { S.session.allocated = true; S.view = 'sell'; render(); } }, 'Skip — I took no stock yet'),
      msg());
    return card;
  }
  function groupByCategory() {
    const cats = S.catalog.categories; return cats.map((c) => ({ id: c.id, name: c.name, items: S.catalog.products.filter((p) => p.category_id === c.id) })).filter((g) => g.items.length);
  }
  function resetSession() { LS.del('csr.session'); S.session = null; S.cart = {}; S.bundles = []; goStaff(); }

  // ---- selling
  const cartLines = () => Object.entries(S.cart).filter(([, q]) => q > 0).map(([product_id, quantity]) => ({ product_id, quantity }));
  const prodById = (id) => S.catalog.products.find((p) => p.id === id);
  const bundleTotal = () => S.bundles.reduce((a, b) => a + b.promo.promotional_price_cents, 0);
  const lineTotal = () => cartLines().reduce((a, l) => a + l.quantity * prodById(l.product_id).price_cents, 0);
  const total = () => lineTotal() + bundleTotal();   // display only; the server recomputes the price
  const empty = () => !cartLines().length && !S.bundles.length;

  function vSell() {
    const cat = S.catalog; if (!cat) return h('p', { class: 'err' }, 'Product list not loaded. Connect to the internet once.');
    if (S.picker) return vPicker();
    const el = h('div', {});
    el.append(h('div', { class: 'card' }, h('div', { class: 'bar', style: 'margin:0' }, h('div', {}, h('b', {}, S.session.staff_name), h('div', { class: 'mu' }, 'Shift ' + S.session.business_date)),
      h('div', {}, h('button', { class: 'sm s', onclick: () => { S.view = 'history'; loadHistory(); render(); } }, 'My sales '), ' ', h('button', { class: 'sm s', onclick: () => { S.view = 'summary'; loadSummary(); render(); } }, 'Summary'))), syncBanner(), msg()));
    for (const g of groupByCategory()) {
      const open = S.open.has(g.id), inCart = g.items.reduce((a, p) => a + (S.cart[p.id] || 0), 0) + S.bundles.filter((b) => (b.promo.configuration.eligible_category_ids || []).includes(g.id)).length * 0;
      const card = h('div', { class: 'card' });
      card.append(h('button', { class: 'opt', style: 'width:100%;display:flex;justify-content:space-between;align-items:center;font-size:17px;font-weight:700', 'aria-expanded': open ? 'true' : 'false',
        onclick: () => { if (open) S.open.delete(g.id); else S.open.add(g.id); render(); } },
        h('span', {}, g.name + (inCart ? '  (' + inCart + ' in sale)' : '')), h('span', {}, open ? '▲' : '▼')));
      if (open) {
        const grid = h('div', { class: 'grid', style: 'margin-top:10px' });
        for (const p of g.items) { const q = S.cart[p.id] || 0;
          grid.append(h('button', { class: 'opt' + (q ? ' on' : ''), onclick: () => { S.cart[p.id] = q + 1; S.msg = ''; render(); } }, p.name, h('small', {}, rm(p.price_cents) + (q ? '  ×' + q : '')))); }
        card.append(grid);
        for (const promo of cat.promotions.filter((x) => (x.configuration.eligible_category_ids || []).includes(g.id)))
          card.append(h('button', { class: 'sm', style: 'width:100%;margin-top:8px', onclick: () => { S.picker = { promo, items: {} }; render(); } }, promo.name + ' — ' + rm(promo.promotional_price_cents)));
      }
      el.append(card);
    }
    el.append(vCart());
    return el;
  }
  function syncBanner() {
    const e = h('div', { class: 'mu' }); queue.all().then((all) => {
      const p = all.filter((r) => ['local', 'pending', 'syncing'].includes(r.status)).length, f = all.filter((r) => r.status === 'failed').length, rv = all.filter((r) => r.status === 'review').length;
      const parts = []; if (p) parts.push(p + ' sale(s) waiting to sync'); if (f) parts.push(f + ' rejected — tell your supervisor'); if (rv) parts.push(rv + ' under review');
      e.textContent = parts.join(' · ') || 'All sales synced.'; e.className = (f || rv) ? 'warn' : 'mu';
    }); return e;
  }
  function vCart() {
    const card = h('div', { class: 'card' }, h('h2', {}, 'Current sale'));
    if (empty()) card.append(h('p', { class: 'mu' }, 'Tap drinks above to add them.'));
    for (const l of cartLines()) { const p = prodById(l.product_id);
      card.append(h('div', { class: 'line' }, h('span', {}, p.name), h('span', {}, h('button', { class: 'sm s', onclick: () => { S.cart[l.product_id]--; render(); } }, '−'), ' ' + l.quantity + ' ', h('button', { class: 'sm s', onclick: () => { S.cart[l.product_id]++; render(); } }, '+'), '  ' + rm(l.quantity * p.price_cents)))); }
    S.bundles.forEach((b, i) => card.append(h('div', { class: 'line' }, h('span', {}, b.promo.name + ': ' + Object.entries(b.items).filter(([, q]) => q).map(([id, q]) => q + '× ' + prodById(id).name).join(', ')),
      h('span', {}, rm(b.promo.promotional_price_cents) + ' ', h('button', { class: 'sm s', onclick: () => { S.bundles.splice(i, 1); render(); } }, '✕')))));
    card.append(h('div', { class: 'line' }, h('b', {}, 'Total'), h('b', {}, rm(total()))));
    card.append(h('div', { class: 'pay', style: 'margin-top:10px' },
      h('button', { class: 'opt' + (S.pay === 'cash' ? ' on cash' : ''), onclick: () => { S.pay = 'cash'; render(); } }, 'Cash'),
      h('button', { class: 'opt' + (S.pay === 'duitnow_qr' ? ' on qr' : ''), onclick: () => { S.pay = 'duitnow_qr'; render(); } }, 'DuitNow QR')));
    let chg = null;
    if (S.pay === 'cash') {
      const i = h('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'Exact ' + rm(total()) + ' (type only if more)', value: S.cash });
      i.addEventListener('input', () => { S.cash = i.value; const c = cashVal(); chg.textContent = c == null ? '' : c >= total() ? 'Change: ' + rm(c - total()) : 'Short by ' + rm(total() - c); chg.className = 'msg ' + (c != null && c < total() ? 'err' : 'ok'); btn.disabled = !canPay(); });
      const c0 = cashVal(); chg = h('div', { class: 'msg ' + (c0 != null && c0 < total() ? 'err' : 'ok') }, c0 == null ? '' : c0 >= total() ? 'Change: ' + rm(c0 - total()) : 'Short by ' + rm(total() - c0));
      card.append(h('div', { class: 'row' }, h('label', {}, 'Cash given'), i), chg,
        h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [200, 500, 1000, 2000, 5000].map((n) => h('button', { class: 'sm s', onclick: () => { S.cash = (n / 100).toFixed(2); render(); } }, rm(n)))));
    } else card.append(h('p', { class: 'mu' }, 'Tap "Confirm QR payment" only after you have seen the payment on the customer\'s screen. The system does not verify it with the bank.'));
    const btn = h('button', { class: 'go alt', disabled: !canPay(), onclick: pay }, S.pay === 'cash' ? 'Record cash sale' : 'Confirm QR payment');
    card.append(btn);
    return card;
  }
  // blank = customer paid the exact amount (no change)
  const cashVal = () => (S.cash === '' ? total() : cents(S.cash));
  function cents(v) { if (v === '' || v == null) return null; const n = Math.round(parseFloat(v) * 100); return Number.isFinite(n) && n >= 0 ? n : null; }
  function canPay() { if (empty() || S.busy) return false; if (S.pay === 'cash') { const c = cashVal(); return c != null && c >= total(); } return true; }
  async function pay() {
    if (!canPay()) return; S.busy = true;
    const rec = { shift_id: S.session.shift_id, token: S.session.token, payment: S.pay, cash_received_cents: S.pay === 'cash' ? cashVal() : null,
      lines: cartLines(), bundles: S.bundles.map((b) => ({ promotion_id: b.promo.id, items: Object.entries(b.items).filter(([, q]) => q).map(([product_id, quantity]) => ({ product_id, quantity })) })),
      display_total_cents: total() };
    const change = S.pay === 'cash' ? cashVal() - total() : 0;
    try { await queue.add(rec); } catch (e) { S.busy = false; return say('Could not save the sale on this device (' + e.message + '). Do NOT hand over the drinks without writing it down.', 'err'); }
    S.cart = {}; S.bundles = []; S.cash = ''; S.busy = false; S.msg = 'Saved' + (S.pay === 'cash' ? ' — give change ' + rm(change) : '') + '.'; S.msgKind = 'ok'; render();
    syncNow(true);
  }

  // ---- Buy 5 Get 1 picker
  function vPicker() {
    const { promo } = S.picker, size = promo.configuration.bundle_size, cfg = promo.configuration;
    const elig = S.catalog.products.filter((p) => (cfg.eligible_product_ids || []).includes(p.id) || (cfg.eligible_category_ids || []).includes(p.category_id));
    const count = () => Object.values(S.picker.items).reduce((a, b) => a + b, 0);
    const card = h('div', { class: 'card' }, h('h2', {}, promo.name + ' — choose ' + size + ' drinks'), h('div', { class: 'mu' }, count() + ' of ' + size + ' chosen · ' + rm(promo.promotional_price_cents)));
    const grid = h('div', { class: 'grid', style: 'margin-top:10px' });
    for (const p of elig) { const q = S.picker.items[p.id] || 0;
      grid.append(h('div', { class: 'opt' + (q ? ' on' : '') }, p.name, h('div', { style: 'margin-top:6px' },
        h('button', { class: 'sm s', onclick: () => { if (q) { S.picker.items[p.id] = q - 1; render(); } } }, '−'), ' ' + q + ' ', h('button', { class: 'sm s', onclick: () => { if (count() < size) { S.picker.items[p.id] = q + 1; render(); } } }, '+')))); }
    card.append(grid,
      h('button', { class: 'go alt', disabled: count() !== size, onclick: () => { S.bundles.push({ promo, items: { ...S.picker.items } }); S.picker = null; render(); } }, 'Add to sale'),
      h('button', { class: 'sm', style: 'width:100%;margin-top:8px', onclick: () => { S.picker = null; render(); } }, 'Cancel'));
    return card;
  }

  // ---- my sales (local queue merged with what the server knows)
  async function loadHistory() {
    const local = await queue.all(); let server = [];
    if (S.online) { try { server = (await api.mySales({ shift_id: S.session.shift_id, token: S.session.token })).sales; } catch (e) { if (e.code === 'invalid_shift') return resetSession(); } }
    const keys = new Set(local.map((r) => r.key)); const rows = local.filter((r) => r.shift_id === S.session.shift_id).map((r) => ({ key: r.key, number: r.sale_number, at: r.occurred_at, pay: r.payment, total: r.server_total_cents != null ? r.server_total_cents : r.display_total_cents, status: r.status, note: r.error || r.review_reason }));
    for (const s of server) if (!keys.has(s.key)) rows.push({ key: s.key, number: s.sale_number, at: s.occurred_at, pay: s.payment_method, total: s.total_cents, status: s.status === 'confirmed' ? 'synced' : s.status === 'requires_review' ? 'review' : s.status, note: s.review_reason });
    S.history = rows.sort((a, b) => (a.at < b.at ? 1 : -1)); render();
  }
  const STATUS = { local: 'Saved on device', pending: 'Waiting to sync', syncing: 'Syncing', synced: 'Synced', review: 'Requires Review', failed: 'Failed', voided: 'Voided' };
  function vHistory() {
    const card = h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, 'My sales'), h('button', { class: 'sm s', onclick: () => { S.view = 'sell'; render(); } }, 'Back')));
    if (!S.history.length) card.append(h('p', { class: 'mu' }, 'No sales yet.'));
    for (const r of S.history) card.append(h('div', { class: 'line' }, h('span', {}, myt(r.at) + ' · ' + (r.pay === 'cash' ? 'Cash' : 'QR') + (r.number ? ' · ' + r.number : ''), r.note && r.status !== 'synced' ? h('div', { class: 'mu' }, r.note) : null), h('span', {}, rm(r.total || 0) + ' ', h('span', { class: 'pill ' + r.status }, STATUS[r.status] || r.status))));
    card.append(h('p', { class: 'mu' }, 'Sales not yet synced are stored on this device. Do not clear browser data or uninstall the app until everything shows "Synced".'),
      h('button', { class: 'sm', style: 'width:100%', onclick: () => syncNow(true) }, 'Sync now'));
    return card;
  }

  // ---- summary + end shift
  async function loadSummary() { if (!S.online) { S.summary = null; return render(); } try { S.summary = await api.summary({ shift_id: S.session.shift_id, token: S.session.token }); } catch (e) { if (e.code === 'invalid_shift') return resetSession(); } render(); }
  function summaryTable(sm) {
    const t = h('table', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Received'), h('th', {}, 'Sold'), h('th', {}, 'Left')));
    for (const p of sm.products) t.append(h('tr', {}, h('td', {}, p.name), h('td', {}, p.allocated), h('td', {}, p.sold), h('td', {}, p.balance)));
    return h('div', { class: 'wrap' }, t);
  }
  function vSummary() {
    const sm = S.summary; const card = h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, 'My shift summary'), h('button', { class: 'sm s', onclick: () => { S.view = 'sell'; render(); } }, 'Back')));
    if (!sm) { card.append(h('p', { class: 'mu' }, S.online ? 'Loading…' : 'Offline — summary needs a connection.')); return card; }
    const t = sm.totals;
    card.append(h('div', { class: 'kpi' }, h('div', {}, 'Sales', h('b', {}, t.sales_count)), h('div', {}, 'Total', h('b', {}, rm(t.total_cents))), h('div', {}, 'Cash', h('b', {}, rm(t.cash_cents))), h('div', {}, 'QR', h('b', {}, rm(t.qr_cents)))),
      t.review_count ? h('p', { class: 'warn' }, t.review_count + ' sale(s) need supervisor review and are not counted above.') : '',
      sm.pending_allocation_rows ? h('p', { class: 'warn' }, 'Some of your received stock is still waiting for supervisor confirmation.') : '',
      h('div', { style: 'height:10px' }), summaryTable(sm),
      h('button', { class: 'go red', onclick: startEnd }, 'End Shift'));
    return card;
  }
  async function startEnd() {
    const n = await queue.pendingCount(S.session.shift_id);
    if (n) return say('You still have ' + n + ' unsynced sale(s). Connect to the internet and wait until they show "Synced", then end the shift.', 'err');
    if (!S.online) return say('You must be online to end the shift.', 'err');
    try { S.summary = await api.endShift({ shift_id: S.session.shift_id, token: S.session.token }); S.session.ended = true; S.view = 'closing'; S.msg = ''; }
    catch (e) { S.msg = e.message; S.msgKind = 'err'; }
    render();
  }
  function vClosing() {
    const sm = S.summary; if (!sm) { loadSummary().then(() => render()); return h('p', { class: 'mu' }, 'Loading…'); }
    const done = sm.cash && sm.cash.declared_cash_cents != null; const inputs = {};
    const card = h('div', { class: 'card' }, h('h2', {}, 'End of shift — count and hand in'));
    if (done) { card.append(h('p', { class: 'ok' }, 'Your count has been submitted. Hand the stock and cash to the supervisor.'), summaryTable(sm),
      h('p', { class: 'mu' }, 'Download your daily summary PDF (money, stock in/out, every sale). After the download the app returns to the start screen, ready for tomorrow.'),
      h('button', { class: 'go alt', id: 'dl', onclick: downloadAndFinish }, 'Download daily summary PDF & finish'), msg(),
      h('button', { class: 'sm', style: 'width:100%;margin-top:10px', onclick: finish }, 'Finish without PDF')); return card; }
    card.append(h('p', { class: 'mu' }, 'Count every drink you still hold and enter the real number, then count your cash. Enter 0 where nothing is left.'));
    for (const p of sm.products) { const i = h('input', { type: 'number', min: '0', inputmode: 'numeric', placeholder: '0' }); inputs[p.product_id] = i; card.append(h('div', { class: 'row' }, h('label', { style: 'flex:1 1 55%;color:inherit' }, p.name), i)); }
    const cash = h('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'Cash in hand (RM)' });
    card.append(h('div', { class: 'row' }, h('label', {}, 'Cash in hand'), cash), h('p', { class: 'mu' }, 'Count all notes and coins from your sales that you are handing in.'),
      h('button', { class: 'go', onclick: async (ev) => {
        const counts = []; for (const [id, i] of Object.entries(inputs)) { if (i.value === '') return say('Enter a count for every item (0 if none).', 'err'); counts.push({ product_id: id, actual_quantity: parseInt(i.value, 10) }); }
        const dc = cents(cash.value); if (dc == null) return say('Enter the cash you are holding.', 'err');
        ev.target.disabled = true;
        try { S.summary = await api.submitClosing({ shift_id: S.session.shift_id, token: S.session.token, counts, declared_cash_cents: dc }); S.msg = ''; }
        catch (e) { S.msg = e.message; S.msgKind = 'err'; }
        render();
      } }, 'Submit count'), msg());
    return card;
  }
  async function finish() { const n = await queue.pendingCount(S.session.shift_id); if (n) return say('Unsynced sales remain on this device. Connect to the internet first.', 'err'); LS.del('csr.session'); S.session = null; S.summary = null; S.cart = {}; S.bundles = []; S.history = []; S.open = new Set(); S.msg = ''; goStaff(); }
  async function downloadAndFinish(ev) {
    const btn = ev.currentTarget; const n = await queue.pendingCount(S.session.shift_id);
    if (n) return say(n + ' sale(s) are not synced yet, so the PDF would be incomplete. Connect to the internet and wait until they are synced.', 'err');
    btn.disabled = true; btn.textContent = 'Preparing PDF…';
    try {
      const rep = await api.shiftReport({ shift_id: S.session.shift_id, token: S.session.token });
      const bytes = Reports.shiftReport(rep); const name = 'Daily-Summary_' + rep.shift.business_date + '_' + rep.staff_name.replace(/[^A-Za-z0-9]+/g, '-') + '.pdf';
      if (!Pdf.save(bytes, name)) throw new Error('This browser could not save the PDF.');
    } catch (e) { btn.disabled = false; btn.textContent = 'Download daily summary PDF & finish'; return say('Could not create the PDF: ' + e.message + ' You can try again.', 'err'); }
    setTimeout(finish, 1200);
  }
  function vDone() { return h('div', { class: 'card' }, h('h2', {}, 'Shift submitted'), h('p', {}, 'Thank you. Your supervisor will confirm your stock and cash.'), h('button', { class: 'go', onclick: goStaff }, 'Back to start')); }

  boot();
})();
