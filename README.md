# Christmas Sales Recorder — Ubest, Sibu (Dec 2026 market)

Netlify (static site + one serverless function) + Supabase (PostgreSQL, Auth, Realtime).

```
index.html            promoter app (phones/tablets)
admin.html            admin / supervisor console
css/app.css           shared styles (original colours)
js/app.js             promoter UI          js/offline.js  IndexedDB queue + sync
js/api.js             API client           js/admin.js    admin UI
netlify/functions/api.js   the ONLY thing promoters talk to (holds the service-role key)
supabase/migrations/  001_schema.sql, 002_functions.sql, 003_security.sql
supabase/seed.sql     categories, 14 products, Buy 5 Get 1
tests/  e2e/          automated tests (see "What is and is not tested")
netlify.toml  .env.example
```

## 1. Supabase setup
1. Create a project at supabase.com (choose a region near Malaysia, e.g. Singapore).
2. SQL Editor → run, in order, the contents of `supabase/migrations/001_schema.sql`, `002_functions.sql`, `003_security.sql`, then `supabase/seed.sql`.
3. Project Settings → API: note the **Project URL**, the **anon** key and the **service_role** key (secret).

## 2. Create the first admin
1. Authentication → Users → *Add user* (email + strong password, tick auto-confirm).
2. Copy that user's UUID, then in the SQL Editor:
   `insert into admins(user_id, email, role) values ('<UUID>', 'you@example.com', 'admin');`
3. Roles: **admin** can do everything (receipts, warehouse adjustments, void sales, edit products/prices/promoters). **supervisor** can confirm allocations/returns/cash, resolve review sales and close shifts, but cannot change the catalogue or warehouse stock. Add supervisors the same way with `'supervisor'`.

## 3. Environment variables (Netlify → Site configuration → Environment variables)
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (secret), optional `ALLOWED_ORIGINS`, optional `EVENT_ACCESS_CODE`. See `.env.example`. Nothing secret is stored in any file in this project.

## 4. Deploy to Netlify
Push the folder to GitHub and "Import from Git" (build command empty, publish directory `.`; `netlify.toml` already says so), **or** `npm i` then `npx netlify deploy --prod`. Drag-and-drop deploys do **not** include functions — use Git or the CLI. Open `https://<site>/admin.html` and sign in.

## 5. Add products and promoters
Admin → Settings: add promoters (names shown on the start screen), categories, products, prices. Promotions: price is editable in Settings; eligibility is in `promotions.configuration` (JSON, e.g. `{"bundle_size":6,"eligible_category_ids":["<category uuid>"]}`; optional `eligible_product_ids`). **The seed makes the whole Pepsi category eligible for Buy 5 Get 1 at RM10 for 6 drinks. That is an assumption — confirm it and edit if wrong.**

## 6. A first test sale
1. Admin → Inventory → record a warehouse receipt for a product (e.g. 50).
2. On a phone open the site, pick a promoter, *Start Shift*, enter the received stock, submit.
3. Admin → Inventory → *Confirm all* (stock moves warehouse → promoter).
4. Promoter records a sale; it appears in Admin → Overview within seconds.
5. Promoter: Summary → End Shift → count stock and cash → Submit. Admin → Shifts & cash: confirm returned stock, confirm cash, Close shift.
Use a test promoter and void test sales afterwards (admin only).

## 7. Verify offline sync
Open the promoter app, switch the phone to flight mode, record a sale: it shows "waiting to sync" and the badge says Offline. Turn the network back on: it syncs by itself (also when the app returns to the foreground), the sale number appears, status becomes Synced. The sale carries its own id, so a lost reply never creates a duplicate.

## 8. Troubleshooting
- *Admin says SUPABASE_… missing*: set the env vars and redeploy.
- *"Origin not allowed"*: add the site URL to `ALLOWED_ORIGINS`.
- *Promoter list empty*: add promoters in Settings (must be active).
- *"Shift not recognised"*: the shift token on that phone was replaced (shift restarted on another device). Choose the name and Start Shift again; the shift resumes and queued sales are retried.
- *Sale "Requires Review"*: stock was insufficient when it synced; admin approves or voids it (Sales tab).
- *Live badge says "Auto-refresh 30s"*: Realtime is unavailable; the page still refreshes by polling. Check Database → Replication that the `supabase_realtime` publication includes the tables (003_security.sql does this).
- Tell promoters never to clear browser data / use private mode: unsynced sales live in that browser.

## 9. Security — read this
- Browsers never receive a database key with write power. Promoters call `/.netlify/functions/api`; the function uses the service-role key on the server and only the fixed actions in `api.js`. Admin uses Supabase Auth + Row Level Security; tables are not writable by anyone anonymous.
- **Promoter login is "pick your name", with no password** (by design, as requested). Consequences: anyone who reaches the site can pick a name and start (or resume) that person's shift, and starting a shift on a second phone replaces the first phone's token. Mitigations built in: a random per-shift token (only its hash is stored), rate limiting, CORS allow-list, an optional `EVENT_ACCESS_CODE` you can share only with staff, and an audit log of every shift start/resume. Money is never moved by promoters: admin confirms every allocation, return and cash handover. For stronger protection, set `EVENT_ACCESS_CODE` and change it if it leaks.
- Promoters cannot read warehouse stock or other people's sales: the API only returns their own shift data and the product/price list.
- Prices, promotions and totals are recomputed on the server; browser prices are display only.
- DuitNow QR sales are recorded as "confirmed by promoter". The system does not check with any bank.
- The in-memory rate limiter is per function instance (best-effort).

## 10. Running the tests
Needs PostgreSQL 16 locally and a superuser role `tester`/`tester` (or set `PGHOST/PGUSER/PGPASSWORD`). `npm i && npm test` (database + API + offline queue). `npm run e2e` runs the browser smoke tests with Playwright.

### What is and is not tested
Tested automatically (52 tests, real PostgreSQL 16): atomic stock deduction and concurrency, idempotent retries, server-side pricing and Buy 5 Get 1, insufficient-stock → requires-review, cash/change rules, end-of-shift counts and differences, cash discrepancy flow, closing rules, cross-day business dates, RLS and role restrictions (anon / authenticated non-admin / supervisor / admin), API validation, CORS, rate limit, access code, offline queue (persistence across reload, back-off 2s…5min, same key on retry, requires-review, permanent failure kept, ordering).
Smoke-tested in headless Chromium with a **mocked** backend: promoter flow including offline→online sync, and every admin tab rendering.
**Not tested:** a real Supabase project (Auth login, Realtime, the anon-key REST calls the admin page makes), a real Netlify deploy, real iPhone Safari / Android Chrome, DuitNow, printing. Do a full dry run (section 6–7) on real devices before the market opens.

## 11. Open business questions
1. Which products qualify for Buy 5 Get 1 — whole Pepsi category (current assumption) or a list?
2. Do promoters get a cash float? (The admin cash form has a float field, but it is only recorded: expected cash = confirmed cash sales, so if you give floats, tell me and I will include them in the difference calculation.)
3. Do you need separate "admin" and "supervisor" people, or is one role enough?
