// Thin client for the Netlify function. Errors carry .status (0 = network) and .code.
(function (root) {
  'use strict';
  function createApi(opts) {
    const url = (opts && opts.url) || '/.netlify/functions/api';
    const getCode = (opts && opts.getAccessCode) || (() => '');
    const f = (opts && opts.fetch) || ((...a) => root.fetch(...a));
    async function call(action, body, timeoutMs) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 15000) : null;
      let res;
      try {
        const h = { 'Content-Type': 'application/json' }; const c = getCode(); if (c) h['x-event-code'] = c;
        res = await f(url, { method: 'POST', headers: h, body: JSON.stringify({ action, ...(body || {}) }), signal: ctl && ctl.signal, cache: 'no-store' });
      } catch (e) { const err = new Error('No connection'); err.status = 0; err.code = 'network'; throw err; }
      finally { if (t) clearTimeout(t); }
      let data = null; try { data = await res.json(); } catch (_) {}
      if (!res.ok) { const err = new Error((data && data.message) || ('Error ' + res.status)); err.status = res.status; err.code = data && data.error; throw err; }
      return data;
    }
    return {
      ping: (ms) => call('ping', {}, ms), staff: () => call('staff'), catalog: () => call('catalog'),
      startShift: (staff_id) => call('start_shift', { staff_id }),
      declareAllocation: (b) => call('declare_allocation', b), createSale: (b) => call('create_sale', b, 20000),
      mySales: (b) => call('my_sales', b), summary: (b) => call('shift_summary', b),
      endShift: (b) => call('end_shift', b), submitClosing: (b) => call('submit_closing', b),
    };
  }
  const out = { createApi };
  if (typeof module !== 'undefined' && module.exports) module.exports = out; else root.CsrApi = out;
})(typeof window !== 'undefined' ? window : globalThis);
