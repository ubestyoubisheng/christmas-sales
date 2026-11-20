// Minimal PDF writer (A4, built-in Helvetica, ASCII text). No external libraries.
(function (root) {
  'use strict';
  const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  const clean = (s) => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '?');
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const width = (s, size, bold) => { const T = bold ? W_BOLD : W_REG; let w = 0; for (const ch of s) w += T[ch.charCodeAt(0) - 32] || 556; return (w * size) / 1000; };
  const f2 = (n) => (Math.round(n * 100) / 100).toString();

  function wrap(text, maxW, size, bold) {
    const out = []; for (const para of clean(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        let w = word;
        while (width(w, size, bold) > maxW && w.length > 1) { let k = w.length - 1; while (k > 1 && width(w.slice(0, k), size, bold) > maxW) k--; if (line) { out.push(line); line = ''; } out.push(w.slice(0, k)); w = w.slice(k); }
        const t = line ? line + ' ' + w : w;
        if (width(t, size, bold) <= maxW) line = t; else { if (line) out.push(line); line = w; }
      }
      out.push(line);
    } return out;
  }

  function create(opts) {
    const PW = 595.28, PH = 841.89, M = 40, CW = PW - 2 * M, FOOT = 34;
    const pages = []; let cur, y;
    const newPage = () => { cur = []; pages.push(cur); y = PH - M; };
    newPage();
    const ensure = (h) => { if (y - h < M + FOOT) newPage(); };
    const put = (x, yy, s, size, bold, gray) => cur.push(`BT /${bold ? 'F2' : 'F1'} ${f2(size)} Tf ${gray != null ? f2(gray) + ' g' : '0 g'} ${f2(x)} ${f2(yy)} Td (${esc(s)}) Tj ET`);
    const line = (x1, y1, x2, y2, gray, lw) => cur.push(`${f2(gray == null ? 0.75 : gray)} G ${f2(lw || 0.5)} w ${f2(x1)} ${f2(y1)} m ${f2(x2)} ${f2(y2)} l S`);
    const rect = (x, yy, w, h, gray) => cur.push(`${f2(gray)} g ${f2(x)} ${f2(yy)} ${f2(w)} ${f2(h)} re f`);
    const api = {
      title(t, sub) { put(M, y - 20, clean(t), 20, true); y -= 28; if (sub) { for (const l of wrap(sub, CW, 9.5, false)) { put(M, y - 10, l, 9.5, false, 0.35); y -= 13; } } y -= 4; line(M, y, M + CW, y, 0.3, 1); y -= 12; return api; },
      heading(t) { ensure(40); y -= 6; put(M, y - 11, clean(t), 12, true); y -= 17; return api; },
      text(t, o) { o = o || {}; const size = o.size || 9.5; for (const l of wrap(t, CW, size, !!o.bold)) { ensure(size + 4); put(M, y - size, l, size, !!o.bold, o.gray); y -= size + 3.5; } return api; },
      space(n) { y -= n == null ? 8 : n; return api; },
      // key/value pairs in two columns
      kv(pairs) {
        const half = CW / 2; for (let i = 0; i < pairs.length; i += 2) {
          ensure(16); for (let j = 0; j < 2; j++) { const p = pairs[i + j]; if (!p) continue; const x = M + j * half;
            put(x, y - 10, clean(p[0]), 9, false, 0.4); put(x + 108, y - 10, clean(p[1]), 9.5, true); }
          y -= 15;
        } return api;
      },
      // cols: [{h:'Product', w:0.4 (fraction), align:'l'|'r'}]
      table(cols, rows, o) {
        o = o || {}; const size = o.size || 8.5, pad = 3; const tw = cols.map((c) => c.w * CW);
        const header = () => { ensure(22); rect(M, y - 15, CW, 15, 0.92); let x = M; cols.forEach((c, i) => { const t = clean(c.h); const px = c.align === 'r' ? x + tw[i] - pad - width(t, size, true) : x + pad; put(px, y - 11, t, size, true); x += tw[i]; }); y -= 15; };
        header();
        rows.forEach((r, ri) => {
          const bold = !!(r.bold), cells = r.cells || r;
          const lines = cells.map((c, i) => wrap(c, tw[i] - 2 * pad, size, bold)); const n = Math.max(...lines.map((l) => l.length)), h = n * (size + 2.5) + 4;
          if (y - h < M + FOOT) { newPage(); header(); }
          if (r.bold) rect(M, y - h, CW, h, 0.95);
          let x = M; cells.forEach((c, i) => { lines[i].forEach((l, k) => { const px = cols[i].align === 'r' ? x + tw[i] - pad - width(l, size, bold) : x + pad; put(px, y - size - 2 - k * (size + 2.5), l, size, bold); }); x += tw[i]; });
          y -= h; line(M, y, M + CW, y, 0.85, 0.4);
        });
        y -= 6; return api;
      },
      signatures(labels) { ensure(60); y -= 30; const w = CW / labels.length; labels.forEach((l, i) => { const x = M + i * w; line(x, y, x + w - 24, y, 0.2, 0.7); put(x, y - 11, clean(l), 8.5, false, 0.35); }); y -= 20; return api; },
      finish() {
        const total = pages.length; const foot = clean(opts && opts.footer || '');
        pages.forEach((p, i) => { cur = p; line(M, M + 22, M + CW, M + 22, 0.8, 0.5); put(M, M + 10, foot, 7.5, false, 0.45); const t = 'Page ' + (i + 1) + ' of ' + total; put(M + CW - width(t, 7.5, false), M + 10, t, 7.5, false, 0.45); });
        const objs = []; const add = (s) => { objs.push(s); return objs.length; };
        const cat = add(null), pagesObj = add(null), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), f2o = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        const kids = []; pages.forEach((p) => { const body = p.join('\n'); const c = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
          kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${f2(PW)} ${f2(PH)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2o} 0 R >> >> /Contents ${c} 0 R >>`)); });
        objs[cat - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`; objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
        const info = add(`<< /Title (${esc(clean(opts && opts.title || 'Summary'))}) /Producer (Christmas Sales Recorder) >>`);
        let out = '%PDF-1.4\n'; const off = [];
        objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
        const xr = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
        out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${xr}\n%%EOF`;
        const bytes = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255; return bytes;
      },
    };
    return api;
  }

  // Save with the most compatible method; returns true if a download/preview was started.
  function save(bytes, filename) {
    try {
      const blob = new Blob([bytes], { type: 'application/pdf' }), url = URL.createObjectURL(blob), a = document.createElement('a');
      if ('download' in a) { a.href = url; a.download = filename; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); return true; }
      return !!window.open(url, '_blank');
    } catch (_) { return false; }
  }
  const out = { create, save, width, wrap };
  if (typeof module !== 'undefined' && module.exports) module.exports = out; else root.Pdf = out;
})(typeof window !== 'undefined' ? window : globalThis);
