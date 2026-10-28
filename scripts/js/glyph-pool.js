(() => {
  // 在【顶层窗口】建一次 CJK 字形参照库并缓存，供各作业页复用。
  // 参照字体是系统字体，与具体页面无关；位图按 1 bit/像素打包，2 字体 × 2 万字 ≈ 5 MB。
  const KEY = '__glyphPool_v1';
  if (window[KEY]) return JSON.stringify({ cached: true, chars: window[KEY].chars.length, fonts: window[KEY].fonts });

  const FONTS = ['80px "SimSun", serif', '80px "Microsoft YaHei", sans-serif'];
  const cv = document.createElement('canvas'); cv.width = 96; cv.height = 96;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cs = document.createElement('canvas'); cs.width = 32; cs.height = 32;
  const cxs = cs.getContext('2d', { willReadFrequently: true });

  const chars = [];
  const bits = [];   // 与 fonts 对应：每字 128 字节
  const ars = [];
  const t0 = Date.now();

  for (let c = 0x4e00; c <= 0x9fa5; c++) chars.push(String.fromCharCode(c));
  for (let fi = 0; fi < FONTS.length; fi++) {
    const arr = [];
    for (const ch of chars) {
      ctx.clearRect(0, 0, 96, 96);
      ctx.font = FONTS[fi]; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#000';
      ctx.fillText(ch, 10, 78);
      const d = ctx.getImageData(0, 0, 96, 96).data;
      let minX = 96, minY = 96, maxX = -1, maxY = -1;
      for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
        if (d[(y * 96 + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      if (maxX < 0) { arr.push(null); ars.push(0); continue; }
      const w = maxX - minX + 1, h = maxY - minY + 1;
      cxs.clearRect(0, 0, 32, 32);
      cxs.drawImage(cv, minX, minY, w, h, 0, 0, 32, 32);
      const g = cxs.getImageData(0, 0, 32, 32).data;
      const packed = new Uint8Array(128);
      for (let i = 0; i < 1024; i++) if (g[i * 4 + 3] > 110) packed[i >> 3] |= 1 << (i & 7);
      arr.push(packed);
      ars.push(Math.round((w / h) * 100));
    }
    bits.push(arr);
  }
  window[KEY] = { fonts: FONTS, chars, bits, ars, builtMs: Date.now() - t0 };
  return JSON.stringify({ cached: false, chars: chars.length, fonts: FONTS.length, builtMs: window[KEY].builtMs });
})()
