#!/usr/bin/env node
/**
 * cx-media-fix.mjs —— 学习通「视频不动」的三型诊断与自愈（移植自 实验室安全教育_5 的
 * probe-buffer.mjs / nudge-back.mjs / set-window-normal.mjs，2026-09-26）。
 *
 * 为什么要有它：学习通全场视频"爬行"（0.02~0.35x）与我 09-23 排查了几小时未果的现象，
 * 已在另一个项目上定性并解出——「媒体管线退化」（有缓冲、paused=false，但 currentTime 不走），
 * 解法是 **把 currentTime 往回拨一点（=重播，不跳过内容）**，实测 0.035x → 0.93x。
 *
 * 三型判据（判错就白等，必须先 probe 再动手）：
 *   ① 窗口被最小化   → bounds.windowState != 'normal' → 恢复窗口（**此型下回拨无效**）
 *   ② 媒体管线退化   → ahead ≥ 5s 且 paused=false 但 currentTime 不走 → 回拨 [默认 1.5s]
 *   ③ 平台送流碎片化 → readyState 低 + buffered 区间碎片、块间有洞 → 客户端无解，只能等
 *
 * 用法（端口用环境变量传，别写死在命令里）：
 *   CDP_BASE=http://127.0.0.1:$PORT node cx-media-fix.mjs probe            # 只读诊断（默认）
 *   CDP_BASE=http://127.0.0.1:$PORT node cx-media-fix.mjs nudge [秒数]     # 回拨，默认 1.5
 *   CDP_BASE=http://127.0.0.1:$PORT node cx-media-fix.mjs window-normal    # 把窗口恢复成 normal
 *   CDP_BASE=http://127.0.0.1:$PORT node cx-media-fix.mjs all              # 先恢复窗口，再按需回拨
 */
const BASE = process.env.CDP_BASE || ('http://127.0.0.1:' + (process.env.CDP_PORT || 9223));
const MODE = (process.argv[2] || 'probe').toLowerCase();
const BACK = Number(process.argv[3] || 1.5);

/** 顶层同源穿透到播放器：studentstudy 页里 cards 与 video 两个 iframe 都可穿透 */
const FIND_VIDEO = `
  (function(){
    function firstVideo(doc){ try { return doc ? doc.querySelector('video') : null; } catch(e){ return null; } }
    var v = firstVideo(document);
    if (v) return v;
    var chains = [
      ['iframe[src*="knowledge/cards"]', 'iframe[src*="modules/video"]'],
      ['iframe[src*="knowledge/cards"]', 'iframe[src*="ananas/modules/video"]'],
      ['iframe[src*="knowledge/cards"]', null]
    ];
    for (var i = 0; i < chains.length; i++) {
      var a = document.querySelector(chains[i][0]);
      if (!a || !a.contentDocument) continue;
      if (!chains[i][1]) { v = firstVideo(a.contentDocument); if (v) return v; continue; }
      var b = a.contentDocument.querySelector(chains[i][1]);
      if (b && b.contentDocument) { v = firstVideo(b.contentDocument); if (v) return v; }
    }
    return null;
  })()`;

const READ_EXPR = `(function(){
  var v = ${FIND_VIDEO};
  if (!v) return JSON.stringify({err:'no-video'});
  var b = v.buffered, rng = '';
  for (var i = 0; i < b.length; i++) rng += b.start(i).toFixed(1) + '-' + b.end(i).toFixed(1) + ' ';
  var ahead = (b.length ? b.end(b.length - 1) : 0) - v.currentTime;
  return JSON.stringify({
    t: Math.round(v.currentTime * 10) / 10,
    d: Math.round(v.duration || 0),
    ready: v.readyState, net: v.networkState, paused: v.paused, rate: v.playbackRate,
    ahead: Math.round(ahead), ranges: rng.trim()
  });
})()`;

const NUDGE_EXPR = `(function(){
  var v = ${FIND_VIDEO};
  if (!v) return JSON.stringify({err:'no-video'});
  var before = v.currentTime;
  var target = Math.max(0, before - ${BACK});
  try { v.currentTime = target; } catch (e) { return JSON.stringify({err:'seek:' + e.message}); }
  try { if (v.paused) v.play(); } catch (e) {}
  return JSON.stringify({before: Math.round(before * 10) / 10, seekTo: Math.round(target * 10) / 10, paused: v.paused});
})()`;

/** 只读：这门课的播放器官方提供了哪些倍速档位（判断"退回 1x"到底是平台不给，还是设速失败） */
const RATES_EXPR = `(function(){
  var cards = document.querySelector('iframe[src*="knowledge/cards"]');
  var vf = null;
  try { vf = cards && cards.contentDocument ? cards.contentDocument.querySelector('iframe[src*="modules/video"]') : null; } catch (e) {}
  var out = { cardsFound: !!cards, videoFrameFound: !!(vf && vf.contentWindow) };
  if (!vf || !vf.contentWindow) return JSON.stringify(out);
  var w = vf.contentWindow;
  try {
    out.hasVideojs = !!(w.videojs && w.videojs.getPlayers);
    if (out.hasVideojs) {
      var ps = w.videojs.getPlayers(), k = Object.keys(ps)[0];
      out.playerId = k;
      var p = ps[k];
      try { out.currentRate = p.playbackRate(); } catch (e) { out.currentRate = 'err'; }
      try { out.optionsRates = p.options().playbackRates || null; } catch (e) { out.optionsRates = 'err:' + e.message; }
      var btn = p.controlBar && p.controlBar.playbackRateMenuButton;
      out.hasRateButton = !!btn;
      if (btn) { try { out.menuRates = btn.playbackRates_ || null; } catch (e) { out.menuRates = 'err'; } }
      // ★ 以「平台 UI 真正渲染出来的档位」为准（记忆里的红线：只用平台给出的档位）
      try {
        var root = (btn && btn.el_) || w.document.querySelector('.vjs-playback-rate');
        if (root) {
          out.menuItems = Array.prototype.map.call(
            root.querySelectorAll('.vjs-menu-item, .vjs-menu li'),
            function (li) { return (li.textContent || '').trim().replace(/\s+/g, ' '); }
          );
          out.menuVisible = !!root.querySelector('.vjs-menu');
        }
      } catch (e) { out.menuItems = 'err:' + e.message; }
    }
  } catch (e) { out.err = e.message; }
  try {
    var v = w.document.querySelector('video');
    if (v) { out.videoRate = v.playbackRate; out.defaultRate = v.defaultPlaybackRate; }
  } catch (e) {}
  return JSON.stringify(out);
})()`;

/** 实测某档倍速能不能保住（视频js player 与原生 video 各设一次），用于甄别"平台不给" vs "设早了被重置" */
const setRateExpr = (target) => `(function(){
  var cards = document.querySelector('iframe[src*="knowledge/cards"]');
  var vf = null;
  try { vf = cards && cards.contentDocument ? cards.contentDocument.querySelector('iframe[src*="modules/video"]') : null; } catch (e) {}
  if (!vf || !vf.contentWindow) return JSON.stringify({ err: 'no-video-frame' });
  var w = vf.contentWindow, out = {};
  try {
    var ps = w.videojs && w.videojs.getPlayers();
    var k = ps && Object.keys(ps)[0];
    if (k) { ps[k].playbackRate(${target}); out.playerRate = ps[k].playbackRate(); }
  } catch (e) { out.playerErr = e.message; }
  try {
    var v = w.document.querySelector('video');
    if (v) {
      v.playbackRate = ${target};
      out.videoRate = v.playbackRate;
      out.paused = v.paused;
      if (v.paused) { try { v.play(); } catch (e) {} }
    }
  } catch (e) { out.videoErr = e.message; }
  return JSON.stringify(out);
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function conn(wsUrl, onMessage) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws fail'));
    if (onMessage) ws.onmessage = onMessage;
  });
}

/** 在某个 target 上跑一次 Runtime.evaluate，取回值 */
async function ev(wsUrl, expression, timeout = 12000) {
  let ws;
  try { ws = await conn(wsUrl); } catch (e) { return null; }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, timeout);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (m.error) return resolve('CDP-ERR:' + m.error.message);
        resolve(m.result && m.result.result ? m.result.result.value : null);
      }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}

/** 浏览器级调用（Browser 域只在 browser endpoint 上稳） */
async function browserCall(method, params, timeout = 8000) {
  const ver = await (await fetch(BASE + '/json/version')).json();
  let ws;
  try { ws = await conn(ver.webSocketDebuggerUrl); } catch (e) { return null; }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, timeout);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) { clearTimeout(timer); try { ws.close(); } catch {} resolve(m.error ? { err: m.error.message } : m.result); }
    };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
}

// ── 找学习通课程页 ────────────────────────────────────────────────
const all = (await (await fetch(BASE + '/json/list')).json()).filter((x) => x.type === 'page');
const page = all.find((p) => /studentstudy/.test(p.url || '')) ||
             all.find((p) => /knowledge\/cards/.test(p.url || '')) ||
             all.find((p) => /chaoxing/.test(p.url || ''));
if (!page) {
  console.log('❌ 没找到学习通页面。当前 page 标签页：');
  all.forEach((p) => console.log('   - ' + (p.url || '').slice(0, 120)));
  process.exit(1);
}
console.log('目标页：' + (page.url || '').slice(0, 110));

/** 分类：三型判据。advPerSec = 实测净推进速率（需要两次采样才能算，单次采样判不出「有缓冲」与「在推进」的区别） */
const OK_WINDOW_STATES = ['normal', 'maximized', 'fullscreen'];
function classify(s, wsState, advPerSec) {
  if (!s || s.err) return { type: '?', why: '读不到 video 元素' };
  // ⚠ 只有 minimized 才是①型。maximized 是正常状态——早先把任何非 normal 都判成①，
  //   结果把一个正在 2.00x 满速播放的窗口误报成"被最小化"。
  if (wsState && wsState !== '(查不到)' && !OK_WINDOW_STATES.includes(wsState)) {
    return { type: '①', why: `窗口状态 ${wsState}（不是 normal/maximized）→ 恢复窗口，此型下回拨无效` };
  }
  const expect = s.rate || 1;
  if (typeof advPerSec === 'number' && advPerSec >= expect * 0.7) {
    return { type: '✅ 正常', why: `实测推进 ${advPerSec.toFixed(2)}x（目标 ${expect}x）——不需要任何处置，别乱动` };
  }
  if (typeof advPerSec === 'number') {
    return { type: '②', why: `有缓冲(${s.ahead}s) 但实测只推进 ${advPerSec.toFixed(2)}x（目标 ${expect}x）→ 媒体管线退化，回拨 ${BACK}s` };
  }
  const fragmented = (s.ranges || '').split(/\s+/).filter(Boolean).length > 2;
  if (s.ready <= 2 && fragmented && s.ahead < 5) return { type: '③', why: 'readyState 低 + 缓冲碎片化 → 平台送流问题，客户端无解，只能等' };
  if (s.ahead >= 5 && s.paused === false) return { type: '②?', why: `有缓冲(${s.ahead}s)且 paused=false —— 但**没测推进速率**，无法区分「正常」与「退化」；用 probe 模式（会采两次）再判` };
  if (s.paused === true) return { type: '②?', why: 'paused=true 且缓冲充足 → 先 play() 再看，仍不走则按 ② 回拨' };
  return { type: '?', why: `读数落在三型之间（ready=${s.ready} ahead=${s.ahead} paused=${s.paused}）` };
}

async function probe(label) {
  const raw = await ev(page.webSocketDebuggerUrl, READ_EXPR);
  let s = null;
  try { s = JSON.parse(raw); } catch (e) { s = { err: String(raw) }; }
  const w = await browserCall('Browser.getWindowForTarget', { targetId: page.id });
  const wsState = w && w.bounds ? w.bounds.windowState : '(查不到)';
  if (s && s.err) { console.log(`  ${label} 读不到 video：${s.err}`); return { s, wsState }; }
  console.log(`  ${label} t=${s.t}/${s.d} ready=${s.ready} net=${s.net} paused=${s.paused} rate=${s.rate} ahead=${s.ahead}s ranges=[${s.ranges}] 窗口=${wsState}`);
  return { s, wsState };
}

if (MODE === 'probe') {
  // 采两次：单次采样分不出「有缓冲」与「真的在推进」——早先就因此误报过 ② 型
  const a = await probe('采样1');
  await sleep(6000);
  const b = await probe('采样2');
  let adv = null;
  if (a.s && !a.s.err && b.s && !b.s.err) adv = (b.s.t - a.s.t) / 6;
  if (a.s && !a.s.err) {
    const c = classify(a.s, a.wsState, adv);
    console.log(`  ➜ 判型【${c.type}】${c.why}`);
    if ((a.s.ranges || '').split(/\s+/).filter(Boolean).length > 2) {
      console.log(`  ⚠ 附带读数：buffered 有 ${(a.s.ranges || '').split(/\s+/).filter(Boolean).length} 段（有洞）——若同时 readyState 低，更像③型平台碎流；若在正常推进，那只是平台的分片下发，不用管。`);
    }
  }
} else if (MODE === 'rates') {
  const raw = await ev(page.webSocketDebuggerUrl, RATES_EXPR);
  let r = null;
  try { r = JSON.parse(raw); } catch (e) { r = { raw: String(raw) }; }
  console.log('  倍速档位读数：' + JSON.stringify(r));
  if (r && r.optionsRates === false) console.log('  ➜ playbackRates=false ⇒ **平台官方没开倍速，只能 1x**，走 1x 是对的。');
  else if (r && Array.isArray(r.optionsRates)) console.log('  ➜ 官方档位 ' + JSON.stringify(r.optionsRates) + ' ⇒ **可以用 2x**（跑不到 2x 是设速时机/被重置的问题，不是平台不给）。');
} else if (MODE === 'setrate') {
  const target = Number(process.argv[3] || 2);
  const t0 = await ev(page.webSocketDebuggerUrl, `(function(){var v=${FIND_VIDEO};return v?JSON.stringify({t:v.currentTime,paused:v.paused,rate:v.playbackRate}):'null'})()`);
  console.log('  设速前：' + t0);
  console.log('  设 ' + target + 'x：' + await ev(page.webSocketDebuggerUrl, setRateExpr(target)));
  await sleep(5000);
  const t1 = await ev(page.webSocketDebuggerUrl, `(function(){var v=${FIND_VIDEO};return v?JSON.stringify({t:Math.round(v.currentTime*10)/10,paused:v.paused,rate:v.playbackRate}):'null'})()`);
  console.log('  5 秒后：' + t1 + '   ← 速率没退回 1 才说明设住了');
  await sleep(30000);
  const t2 = await ev(page.webSocketDebuggerUrl, `(function(){var v=${FIND_VIDEO};return v?JSON.stringify({t:Math.round(v.currentTime*10)/10,paused:v.paused,rate:v.playbackRate}):'null'})()`);
  console.log('  再 30 秒后：' + t2);
  try {
    const a = JSON.parse(t1), b = JSON.parse(t2);
    console.log(`  ➜ 30 秒净推进 ${(b.t - a.t).toFixed(1)}s ⇒ 实测 ${((b.t - a.t) / 30).toFixed(2)}x（目标 ${target}）`);
  } catch (e) {}
} else if (MODE === 'window-normal' || MODE === 'win') {
  const before = await browserCall('Browser.getWindowForTarget', { targetId: page.id });
  const visBefore = await ev(page.webSocketDebuggerUrl, 'document.visibilityState');
  console.log('  改前：bounds=' + JSON.stringify(before && before.bounds) + '  visibilityState=' + visBefore);
  if (MODE !== 'win') {
    if (before && before.bounds && before.bounds.windowState !== 'normal') {
      console.log('  setWindowBounds(normal) → ' + JSON.stringify(await browserCall('Browser.setWindowBounds', { windowId: before.windowId, bounds: { windowState: 'normal' } })));
    }
    const after = await browserCall('Browser.getWindowForTarget', { targetId: page.id });
    const visAfter = await ev(page.webSocketDebuggerUrl, 'document.visibilityState');
    console.log('  改后：bounds=' + JSON.stringify(after && after.bounds) + '  visibilityState=' + visAfter);
    if (visAfter === 'hidden') console.log('  ⚠ 仍 hidden —— setWindowBounds 没解决；改由 cx-play 的 Page.bringToFront，或人工点一下那个窗口');
  }
} else if (MODE === 'nudge' || MODE === 'all') {
  const before = await probe('回拨前');
  if (MODE === 'all' && before.wsState && before.wsState !== 'normal') {
    const wid = (await browserCall('Browser.getWindowForTarget', { targetId: page.id })).windowId;
    console.log('  ① 先恢复窗口：' + JSON.stringify(await browserCall('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'normal' } })));
    await sleep(3000);
    await probe('恢复窗口后');
  }
  if (before.s && !before.s.err) {
    const c = classify(before.s, before.wsState);
    console.log(`  ➜ 判型【${c.type}】${c.why}`);
  }
  if (MODE === 'all' && before.s && !before.s.err && classify(before.s, before.wsState).type === '③') {
    console.log('  ⛔ 判为③型（平台送流），不做回拨 —— 回拨对这个型没用，白折腾。');
    process.exit(0);
  }
  console.log('  执行回拨：' + await ev(page.webSocketDebuggerUrl, NUDGE_EXPR));
  await sleep(20000);
  await probe('20 秒后');
}

process.exit(0);
