// Offline queue for sales (IndexedDB) + synchronisation. Works in browsers and in Node (tests, with fake-indexeddb).
// Rules: a sale is written to IndexedDB BEFORE any network call; it is never deleted by the app;
// "synced" is only set after the server acknowledged it (the server's reply carries the sale number).
(function (root) {
  'use strict';
  const DB_NAME = 'csr-offline', STORE = 'sales';
  const uuid = () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

  function openDb(idb) {
    return new Promise((res, rej) => {
      const r = idb.open(DB_NAME, 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'key' }); s.createIndex('status', 'status'); s.createIndex('shift', 'shift_id'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted')); });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  // transient = worth retrying later; anything else needs a human
  const isTransient = (e) => !e.status || e.status >= 500 || e.status === 429 || e.status === 408;

  function createQueue(opts) {
    const api = opts.api, now = opts.now || (() => Date.now());
    const base = opts.baseDelayMs || 2000, maxDelay = opts.maxDelayMs || 5 * 60 * 1000;
    let dbp = null, running = null; const listeners = new Set();
    const db = () => (dbp = dbp || openDb(opts.indexedDB || root.indexedDB));
    const emit = () => listeners.forEach((f) => { try { f(); } catch (_) {} });

    async function put(rec) { const d = await db(); const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(rec); await done(tx); }
    async function all() { const d = await db(); return req(d.transaction(STORE).objectStore(STORE).getAll()); }
    async function get(key) { const d = await db(); return req(d.transaction(STORE).objectStore(STORE).get(key)); }

    // Save a finished sale. Resolves only once IndexedDB confirms the write.
    async function add(sale) {
      const seq = (await all()).reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
      const rec = { ...sale, seq, key: sale.key || uuid(), occurred_at: sale.occurred_at || new Date(now()).toISOString(), status: 'local', attempts: 0, next_at: 0, created_local: now() };
      await put(rec); emit(); return rec;
    }
    async function pendingCount(shiftId) { return (await all()).filter((r) => (r.status === 'local' || r.status === 'pending' || r.status === 'syncing' || r.status === 'failed') && (!shiftId || r.shift_id === shiftId)).length; }

    async function syncOne(rec) {
      rec = { ...rec, status: 'syncing' }; await put(rec); emit();
      try {
        const r = await api.createSale({ key: rec.key, shift_id: rec.shift_id, token: rec.token, payment: rec.payment, cash_received_cents: rec.cash_received_cents,
          lines: rec.lines, bundles: rec.bundles, occurred_at: rec.occurred_at });
        rec = { ...rec, status: r.status === 'requires_review' ? 'review' : 'synced', sale_number: r.sale_number, server_total_cents: r.total_cents, review_reason: r.review_reason || null, error: null, synced_at: now() };
      } catch (e) {
        if (isTransient(e)) { const attempts = rec.attempts + 1; rec = { ...rec, status: 'pending', attempts, next_at: now() + Math.min(maxDelay, base * 2 ** (attempts - 1)), error: e.message || 'network' }; }
        else rec = { ...rec, status: 'failed', attempts: rec.attempts + 1, next_at: Infinity, error: e.message || String(e.code || 'rejected'), error_code: e.code };
      }
      await put(rec); emit(); return rec;
    }

    // Sync everything that is due. `force` ignores the back-off timer (e.g. when the app returns to the foreground).
    function sync(force) {
      if (running) return running;
      running = (async () => {
        let ok = 0, left = 0;
        const due = (await all()).filter((r) => ['local', 'pending', 'syncing'].includes(r.status) && (force || r.next_at <= now()))
          .sort((a, b) => (a.seq || 0) - (b.seq || 0));
        for (const r of due) {
          const out = await syncOne(r);
          if (out.status === 'synced' || out.status === 'review') ok++;
          else if (out.status === 'pending') { left++; if (!out.error_code && /network|fetch|timeout|abort/i.test(out.error || '')) break; }
        }
        return { synced: ok, pending: left };
      })().finally(() => { running = null; });
      return running;
    }
    // A sale that the server rejected permanently can be retried after the cause is fixed (e.g. promoter restarted the shift).
    async function retryFailed(key, patch) { const r = await get(key); if (r && r.status === 'failed') { await put({ ...r, ...(patch || {}), status: 'pending', next_at: 0, error: null }); emit(); } }
    return { add, sync, all, get, pendingCount, retryFailed, onChange: (f) => { listeners.add(f); return () => listeners.delete(f); }, _put: put };
  }

  // Real connectivity check (navigator.onLine alone is not trusted)
  async function checkBackend(apiClient, timeoutMs) {
    try { await apiClient.ping(timeoutMs || 6000); return true; } catch (_) { return false; }
  }
  const out = { createQueue, checkBackend, uuid };
  if (typeof module !== 'undefined' && module.exports) module.exports = out; else root.Offline = out;
})(typeof window !== 'undefined' ? window : globalThis);
