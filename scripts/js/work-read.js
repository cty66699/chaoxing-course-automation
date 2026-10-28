(async () => {
  const doc = document;
  const isCJK = (ch) => { const c = ch.charCodeAt(0); return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf); };
  const pool = (() => { try { return window.top.__glyphPool_v1 || null; } catch { return null; } })();
  if (!pool) return JSON.stringify({ err: 'glyph pool missing: run js/glyph-pool.js in top frame' });

  /* ---------- 反爬字体：cmap + 字形比对 ---------- */
  let b64 = null;
  outer: for (const sheet of Array.from(doc.styleSheets)) {
    let rules = []; try { rules = Array.from(sheet.cssRules || []); } catch { continue; }
    for (const r of rules) {
      const t = r.cssText || '';
      if (!/font-cxsecret/i.test(t)) continue;
      const m = /base64,([A-Za-z0-9+/=]+)/.exec(t);
      if (m) { b64 = m[1]; break outer; }
    }
  }
  const subMap = {}, subDetail = {};
  if (b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const dv = new DataView(buf.buffer);
    const numTables = dv.getUint16(4);
    let cmapOff = 0;
    for (let i = 0; i < numTables; i++) { const p = 12 + i * 16; if (String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]) === 'cmap') cmapOff = dv.getUint32(p + 8); }
    const covered = new Set();
    const nSub = dv.getUint16(cmapOff + 2);
    for (let i = 0; i < nSub; i++) {
      const p = cmapOff + 4 + i * 8, off = cmapOff + dv.getUint32(p + 4), fmt = dv.getUint16(off);
      if (fmt === 4) {
        const segX2 = dv.getUint16(off + 6), seg = segX2 / 2;
        const endO = off + 14, startO = endO + segX2 + 2;
        for (let s = 0; s < seg; s++) {
          const end = dv.getUint16(endO + s * 2), start = dv.getUint16(startO + s * 2);
          if (start === 0xffff) continue;
          for (let c = start; c <= end && c !== 0xffff; c++) covered.add(c);
        }
      } else if (fmt === 12) {
        const n = dv.getUint32(off + 12);
        for (let g = 0; g < n; g++) { const q = off + 16 + g * 12, sc = dv.getUint32(q), ec = dv.getUint32(q + 4); for (let c = sc; c <= ec && c - sc < 5000; c++) covered.add(c); }
      }
    }

    const cv = doc.createElement('canvas'); cv.width = 96; cv.height = 96;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const cs = doc.createElement('canvas'); cs.width = 32; cs.height = 32;
    const cxs = cs.getContext('2d', { willReadFrequently: true });
    const cf = doc.createElement('canvas'); cf.width = 56; cf.height = 56;
    const cxf = cf.getContext('2d', { willReadFrequently: true });
    const POP = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1]; return t; })();

    function box() {
      const d = ctx.getImageData(0, 0, 96, 96).data;
      let minX = 96, minY = 96, maxX = -1, maxY = -1;
      for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) if (d[(y * 96 + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      return maxX < 0 ? null : { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
    function render(ch, f) { ctx.clearRect(0, 0, 96, 96); ctx.font = f; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#000'; ctx.fillText(ch, 10, 78); return box(); }
    function coarsePack(ch, f) {
      const b = render(ch, f); if (!b) return null;
      cxs.clearRect(0, 0, 32, 32); cxs.drawImage(cv, b.minX, b.minY, b.w, b.h, 0, 0, 32, 32);
      const g = cxs.getImageData(0, 0, 32, 32).data;
      const p = new Uint8Array(128);
      for (let i = 0; i < 1024; i++) if (g[i * 4 + 3] > 110) p[i >> 3] |= 1 << (i & 7);
      return { p, ar: Math.round((b.w / b.h) * 100) };
    }
    function fine(ch, f) {
      const b = render(ch, f); if (!b) return null;
      cxf.clearRect(0, 0, 56, 56); cxf.drawImage(cv, b.minX, b.minY, b.w, b.h, 0, 0, 56, 56);
      const d = cxf.getImageData(0, 0, 56, 56).data;
      const a = new Float32Array(3136); let s = 0;
      for (let i = 0; i < 3136; i++) { a[i] = d[i * 4 + 3] / 255; s += a[i]; }
      const mean = s / 3136; let q = 0;
      for (let i = 0; i < 3136; i++) { a[i] -= mean; q += a[i] * a[i]; }
      const sd = Math.sqrt(q / 3136) || 1;
      for (let i = 0; i < 3136; i++) a[i] /= sd;
      return { a, ar: Math.round((b.w / b.h) * 100) };
    }
    const iouP = (x, y) => { let i = 0, u = 0; for (let k = 0; k < 128; k++) { const a = x[k], b = y[k]; i += POP[a & b]; u += POP[a | b]; } return u ? i / u : 0; };
    const corr = (x, y) => { let s = 0; for (let i = 0; i < 3136; i++) s += x.a[i] * y.a[i]; return s / 3136; };

    const FINE_FONTS = [
      '80px "SimSun", serif', '80px "SimHei", sans-serif', '80px "Microsoft YaHei", sans-serif',
      '80px "KaiTi", serif', '80px "FangSong", serif', '80px "DengXian", sans-serif',
      '80px "NSimSun", monospace', '80px "Microsoft JhengHei", sans-serif',
      '80px "YouYuan", sans-serif', '80px "STSong", serif', '80px "STKaiti", serif',
      '80px "Source Han Sans SC", sans-serif', '80px "Noto Sans CJK SC", sans-serif',
    ];

    const need = new Set();
    for (const el of doc.querySelectorAll('.font-cxsecret')) for (const ch of el.innerText || '') if (isCJK(ch) && covered.has(ch.charCodeAt(0))) need.add(ch);
    for (const ch of need) {
      const t = coarsePack(ch, '80px font-cxsecret');
      if (!t) { subMap[ch] = ch; continue; }
      const rank = [];
      for (let fi = 0; fi < pool.fonts.length; fi++) {
        const arr = pool.bits[fi], ars = pool.ars;
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i]; if (!p) continue;
          if (Math.abs(ars[i] - t.ar) > 45) continue;
          const s = iouP(t.p, p);
          if (s > 0.25) rank.push({ i, s });
        }
      }
      rank.sort((a, b) => b.s - a.s);
      const shortlist = [], seen = new Set();
      for (const x of rank) { const c = pool.chars[x.i]; if (seen.has(c)) continue; seen.add(c); shortlist.push(c); if (shortlist.length >= 60) break; }
      const tf = fine(ch, '80px font-cxsecret');
      const scored = [];
      for (const c of shortlist) for (const ff of FINE_FONTS) {
        const b = fine(c, ff);
        if (!b || Math.abs(b.ar - tf.ar) > 45) continue;
        scored.push({ c, s: corr(tf, b) });
      }
      scored.sort((a, b) => b.s - a.s);
      const byChar = new Map();
      for (const x of scored) if (!byChar.has(x.c)) byChar.set(x.c, x);
      const top = Array.from(byChar.values()).slice(0, 3);
      subMap[ch] = top.length ? top[0].c : ch;
      subDetail[ch] = { s: top.length ? +top[0].s.toFixed(3) : 0, margin: top.length > 1 ? +(top[0].s - top[1].s).toFixed(3) : 1, top: top.map((x) => `${x.c}:${x.s.toFixed(3)}`).join(' ') };
    }
  }
  const dec = (s) => Array.from(s || '').map((c) => subMap[c] || c).join('');

  /* ---------- 题目结构 ---------- */
  const questions = [];
  doc.querySelectorAll('.TiMu').forEach((el, qi) => {
    const labelEl = el.querySelector('.newZy_TItle');
    const stemEl = el.querySelector('.font-cxsecret');
    const q = {
      idx: qi + 1,
      typeLabel: dec(labelEl ? labelEl.innerText : '').replace(/\s+/g, ''),
      stemRaw: stemEl ? (stemEl.innerText || '').replace(/\s+/g, ' ').trim() : '',
      options: [],
      handler: null,
      qid: null,
      qtype: null,
    };
    q.stem = dec(q.stemRaw).replace(/\s+/g, ' ').replace(/^\s*【[^】]*】\s*/, '').trim();
    const lis = Array.from(el.querySelectorAll('.Zy_ulTop li, ul li'));
    for (const li of lis) {
      const a = li.querySelector('a');
      const span = li.querySelector('span[data]');
      if (!a) continue;
      q.options.push({
        label: span ? span.getAttribute('data') : '',
        // 选项也必须解码：实测有题干像明文、选项却是乱码的题（如「属于( )」的四个选项）
        text: dec(a.innerText || '').replace(/\s+/g, ' ').trim(),
        onclick: (li.getAttribute('onclick') || '').slice(0, 60),
        role: li.getAttribute('role') || '',
      });
      if (!q.handler) { q.handler = li.getAttribute('onclick') || ''; q.qid = li.getAttribute('qid'); q.qtype = li.getAttribute('qtype'); }
    }
    questions.push(q);
  });

  return JSON.stringify({
    url: location.href.slice(0, 120),
    title: dec((doc.querySelector('h1,h2,.workTitle,.tit') || {}).innerText || '').slice(0, 60),
    subMap: Object.entries(subMap).map(([k, v]) => k + '→' + v).join(' '),
    subDetail,
    questionCount: questions.length,
    questions,
    submitButtons: Array.from(doc.querySelectorAll('a,button,input')).filter((e) => /提交|保存/.test(e.innerText || e.value || '')).map((e) => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 40), text: (e.innerText || e.value || '').slice(0, 12), onclick: (e.getAttribute('onclick') || '').slice(0, 60) })).slice(0, 6),
    hidden: Array.from(doc.querySelectorAll('input[type=hidden]')).map((e) => `${e.id || e.name}=${(e.value || '').slice(0, 30)}`).slice(0, 20),
  }, null, 1);
})()
