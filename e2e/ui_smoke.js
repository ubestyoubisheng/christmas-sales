// Browser smoke test with a mocked API (Playwright). Run: node tests/ui_smoke.js
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const srv = http.createServer((q, r) => { const f = path.join(root, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!f.startsWith(root) || !fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html'); r.end(fs.readFileSync(f)); });
const U = (n) => '00000000-0000-4000-8000-00000000000' + n;
const cat = { categories: [{ id: U(1), name: 'Pepsi' }], products: [{ id: U(2), name: 'Pepsi', category_id: U(1), price_cents: 200 }, { id: U(3), name: 'M.Dew', category_id: U(1), price_cents: 200 }], promotions: [{ id: U(4), name: 'Buy 5 Get 1', promotional_price_cents: 1000, configuration: { bundle_size: 6, eligible_category_ids: [U(1)] } }] };
(async () => {
  await new Promise((r) => srv.listen(0, r)); const port = srv.address().port; const sales = []; let down = false; const errs = [];
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 800 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/.netlify/functions/api', async (route) => {
    const body = JSON.parse(route.request().postData()); const j = (o, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
    if (down) return route.abort('failed');
    switch (body.action) {
      case 'ping': return j({ ok: true }); case 'staff': return j({ staff: [{ id: U(5), name: 'Ali' }] }); case 'catalog': return j(cat);
      case 'start_shift': return j({ shift: { id: U(6), staff_id: U(5), business_date: '2026-12-01', status: 'pending_allocation' }, resumed: false, staff_name: 'Ali', token: 'x'.repeat(48) });
      case 'declare_allocation': return j({ ok: 1 });
      case 'create_sale': sales.push(body); return j({ status: 'confirmed', sale_number: 'S' + sales.length, total_cents: 200 });
      case 'my_sales': return j({ sales: [] }); default: return j({}, 404);
    }
  });
  await p.goto('http://localhost:' + port + '/');
  await p.selectOption('select', { label: 'Ali' }); await p.click('text=Start Shift');
  await p.click('text=Skip'); await p.click('button.opt:has-text("Pepsi")');
  await p.fill('input[placeholder^="Cash received"]', '5'); await p.waitForSelector('text=Change: RM 3.00');
  down = true; await p.click('text=Record cash sale'); await p.waitForTimeout(500);
  const waiting = await p.locator('text=waiting to sync').count();
  down = false; await p.evaluate(() => window.dispatchEvent(new Event('online'))); await p.waitForTimeout(1500);
  const ok = await p.locator('text=All sales synced').count();
  await p.screenshot({ path: process.argv[2] || '/tmp/ui.png' });
  console.log(JSON.stringify({ waitingBanner: waiting > 0, syncedAfterReconnect: ok > 0, salesReceived: sales.length, key: !!sales[0] && !!sales[0].key, pageErrors: errs }));
  await b.close(); srv.close();
})();
