#!/usr/bin/env node
/**
 * 学习通「任务点」驱动 v4 —— 一个进程 = 一个窗口 = 一门课（或一门课的一部分）
 *
 * 关键机制（全是实测踩出来的）：
 *   1. 章节列表 iframe（mooc2-ans/mycourse/studentcourse）带 sandbox → 顶层 contentDocument 读不到（SecurityError）。
 *      必须用该帧自己的执行上下文去读 / 去点。
 *   2. 进入小节后的 studentstudy 页里，cards / video 两个 iframe 同源可穿透，
 *      顶层一个上下文就能操控播放器，不必再解析帧。
 *   3. 切小节不用回目录：studentstudy 侧栏 #coursetree + 站内 getTeacherAjax() 原地切换。
 *   4. 完成判定读侧栏（服务端真值）：.jobUnfinishCount 还在 → 未完成；元素消失 → 已完成。
 *   5. 【顺序】先起播再等时长：播放器不 play 就不加载元数据，duration 恒为 null。
 *   6. 【倍速】播放器会在加载 / 切源后把 playbackRate 重置回 1，必须每轮重申。
 *
 * 用法：
 *   node cx-play.mjs --id <targetId> --course 266978105 --clazz 154456702 \
 *        [--rate 2] [--max 0] [--only k1,k2] [--tag x] [--log x.log] [--state state-x.json]
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const getOpt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = getOpt('--port');
const BASE = process.env.CDP_BASE || `http://127.0.0.1:${PORT || 9223}`;
const TAB_ID = getOpt('--id');
const COURSE = getOpt('--course');
// ★ clazzid / cpi 默认留空 —— 启动时从课程列表**自动解析**（抄错 clazzid 会跑到别的班去）
let CLAZZ = getOpt('--clazz', '');
let CPI = getOpt('--cpi', '');
const RATE = Number(getOpt('--rate', 2));
const MAX = Number(getOpt('--max', 0));
const ONLY = getOpt('--only', '') ? new Set(getOpt('--only', '').split(',').filter(Boolean)) : null;
const TAG = getOpt('--tag', COURSE);
const LOG = getOpt('--log', `cx-${TAG}.log`);
const STATE = getOpt('--state', `state-${TAG}.json`);
// 小节之间随机停顿：避免「一节接一节、毫不停歇」的机械节奏被判定异常
const GAP_MIN = Number(getOpt('--gap-min', 8));
const GAP_MAX = Number(getOpt('--gap-max', 25));
// 到点收工（epoch ms；0 = 不限）。深夜学习是平台风控触发项，做成机制而不是靠人记得停。
const UNTIL_TS = Number(getOpt('--until-ts', 0)) || 0;
const pastDeadline = () => UNTIL_TS > 0 && Date.now() >= UNTIL_TS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 倍速能力实测：有的课程播放器 playbackRates=false，强行设倍速会被重置并顺手暂停视频 */
let rateProbed = false, rateDisallowed = false;
const log = (...a) => {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {}
};

/* ---------------- CDP ---------------- */
class Tab {
  constructor(url) { this.url = url; this.n = 0; this.w = new Map(); this.ctxs = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws connect failed')); });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.w.has(m.id)) {
        const { res, rej } = this.w.get(m.id); this.w.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method === 'Runtime.executionContextCreated') {
        const c = m.params.context;
        if (c.auxData && c.auxData.frameId) this.ctxs.push({ id: c.id, frameId: c.auxData.frameId });
      }
    };
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    try { await this.send('Page.bringToFront'); } catch {}
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.n;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); rej(new Error(method + ' timeout')); } }, timeout);
      this.w.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalIn(expr, contextId = undefined, timeout = 30000) {
    const params = { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true };
    if (contextId) params.contextId = contextId;
    const r = await this.send('Runtime.evaluate', params, timeout);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'page exception');
    return r.result ? r.result.value : undefined;
  }
  js(expr, timeout = 30000) { return this.evalIn(expr, undefined, timeout); }
  async frames() {
    const tree = await this.send('Page.getFrameTree');
    const flat = [];
    (function walk(n) { flat.push(n.frame); (n.childFrames || []).forEach(walk); })(tree.frameTree);
    return flat;
  }
  /** 按 URL 片段找 iframe 自己的执行上下文（sandbox iframe 只能用这个） */
  async ctxFor(match, tries = 8) {
    for (let k = 0; k < tries; k++) {
      const flat = await this.frames();
      const hit = flat.find((f) => (f.url || '').includes(match));
      if (hit) {
        const c = this.ctxs.find((x) => x.frameId === hit.id);
        if (c) return c.id;
        await this.send('Runtime.enable').catch(() => {});
      }
      await sleep(600);
    }
    return null;
  }
  async jsInFrame(expr, match, timeout = 30000) {
    const ctx = await this.ctxFor(match);
    if (!ctx) throw new Error(`no frame context: ${match}`);
    return this.evalIn(expr, ctx, timeout);
  }
  async goto(url, waitMs = 6000) { await this.send('Page.navigate', { url }); await sleep(waitMs); }
  close() { try { this.ws.close(); } catch {} }
}

/* ---------------- 顶层页钩子（只在 studentstudy 上用） ---------------- */
const JS_HOOK = `
window.__cx = {
  cards: function(){ return document.querySelector('iframe[src*="knowledge/cards"]'); },
  // ★ 2026-09-29 修：一"节"可以挂**多个视频**，而其中只有一个是任务点。
  //   实测 xxsy 9.1 / 11.2：一张卡上两个视频 —— 非任务点那个 549s 且 isPassed=true，
  //   真任务点那个只有 72s、名字带"(案例)"。
  //   原来直接 querySelector 取**第一个** ⇒ 一直播那个非任务点、侧栏待办永远不掉
  //   ⇒ 每节干等 36 分钟然后 TIMEOUT，两节白烧 2h18m。
  //   判据用**平台自己标的 DOM**：任务点所在容器的 class 里有 ans-job-finished 才算完成
  //   （图标 aria-label 同步显示「任务点未完成 / 已完成」）⇒ 挑"容器还没 finished"的那个；
  //   全都 finished 了才退回第一个（此时本来也不该再播它）。
  videoFrame: function(){
    var c = this.cards(); if (!c || !c.contentDocument) return null;
    var fs = Array.prototype.slice.call(c.contentDocument.querySelectorAll('iframe[src*="modules/video"]'));
    if (!fs.length) return null;
    var open = fs.filter(function(f){
      var p = f.closest ? f.closest('.ans-attach-ct') : null;
      return p && !p.classList.contains('ans-job-finished');
    });
    return (open.length ? open : fs)[0];
  },
  // ★ 2026-09-29 加：文档任务点（insertdoc）。平台自己的完成条件是「把文档滚到底」——
  //   查看器 /ananas/modules/pdf/index.html 里的逻辑：
  //     if (scrollHeight == clientHeight) finishJob();                       // 不足一屏 ⇒ 直接算完成
  //     panView.contentWindow.onscroll = ... if (getScrollTop() > scrollHeight - clientHeight - 100) finishJob();
  //   ⇒ 本条走的是**驱动 UI**（把文档打开、滚到底），由平台自己的 documentJob.js 上报；
  //   ★ 绝不直接 GET /mooc-ans/job/document 标完成（那是"跳过内容却标记已完成"）。
  docFrames: function(){
    var c = this.cards(); if (!c || !c.contentDocument) return [];
    return Array.prototype.slice.call(c.contentDocument.querySelectorAll('iframe')).filter(function(f){
      var s = f.getAttribute('src') || '';
      return s.indexOf('modules/pdf') >= 0 || s.indexOf('modules/zt') >= 0
          || s.indexOf('modules/doc') >= 0 || s.indexOf('modules/ppt') >= 0 || s.indexOf('modules/xls') >= 0
          || (f.className || '').indexOf('insertdoc') >= 0;
    });
  },
  docDone: function(f){
    try {
      var cont = f.parentElement;
      if (cont && cont.className.indexOf('ans-job-finished') >= 0) return true;
      var w = f.contentWindow;
      if (w && typeof w.checkJobFinish === 'function' && w.checkJobFinish()) return true;
    } catch (e) {}
    return false;
  },
  docScroll: function(){
    var fs = this.docFrames(), self = this, n = 0, already = 0, err = '';
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i];
      if (self.docDone(f)) { already++; continue; }
      var pv = null;
      try { pv = f.contentDocument && f.contentDocument.getElementById('panView'); } catch (e) {}
      if (!pv) { err = err + 'nopanview;'; continue; }
      var iw = null;
      try { iw = pv.contentWindow; } catch (e) {}
      if (!iw || !iw.document) { err = err + 'noinner;'; continue; }
      var de = iw.document.documentElement;         // ★ 一定是内层那个 document
      de.scrollTop = de.scrollHeight;               // 滚到底
      try { iw.dispatchEvent(new Event('scroll')); } catch (e) {}
      try { iw.document.dispatchEvent(new Event('scroll')); } catch (e) {}
      n++;
    }
    return 'total=' + fs.length + ' scrolled=' + n + ' already=' + already + (err ? ' err=' + err : '');
  },
  docState: function(){
    var fs = this.docFrames(), self = this, done = 0;
    for (var i = 0; i < fs.length; i++) { if (self.docDone(fs[i])) done++; }
    return 'total=' + fs.length + ' done=' + done;
  },
  vwin: function(){ var f = this.videoFrame(); return f ? f.contentWindow : null; },
  video: function(){ var f = this.videoFrame(); return f && f.contentDocument ? f.contentDocument.querySelector('video') : null; },
  objectId: function(){ var w = this.vwin(); try { return w && w.videoObjectId ? String(w.videoObjectId) : null; } catch(e){ return null; } },
  modules: function(){
    var c = this.cards(); if (!c || !c.contentDocument) return [];
    var out = [];
    Array.prototype.forEach.call(c.contentDocument.querySelectorAll('iframe'), function(f){
      var m = f.getAttribute('module');
      if (m) { out.push(m); return; }
      var s = f.getAttribute('src') || '';
      var mm = /modules\\/([a-zA-Z]+)\\//.exec(s);
      if (mm) out.push(mm[1]);
    });
    return out;
  },
  sidebar: function(){
    var out = [];
    document.querySelectorAll('.posCatalog_select').forEach(function(el){
      var c = el.querySelector('.jobUnfinishCount'), s = el.querySelector('.posCatalog_sbar'), n = el.querySelector('.posCatalog_name');
      out.push({ kid: (el.id||'').replace(/^cur/,''), code: s?s.textContent.trim():'', pending: c?Number(c.value):0, name: n?(n.getAttribute('title')||''):'' });
    });
    return out;
  },
  pendingOf: function(kid){
    var el = document.getElementById('cur'+kid);
    if (!el) return null;
    var c = el.querySelector('.jobUnfinishCount');
    if (!c) return 0;
    return Number(c.value);
  },
  snap: function(){
    var v = this.video();
    var o = { url: location.href, chapterId: String(window.chapterId||''), hasCards: !!this.cards(), hasVideoFrame: !!this.videoFrame() };
    o.vis = document.visibilityState;   // hidden = 窗口被最小化/被遮挡，此时浏览器会暂停视频
    if (v) o.v = { dur: +v.duration||0, cur: +v.currentTime||0, paused: !!v.paused, rate: v.playbackRate, rs: v.readyState, obj: this.objectId() };
    o.modules = this.modules();
    return JSON.stringify(o);
  },
  rate: function(r){
    var w = this.vwin(), v = this.video();
    try { var ps = w && w.videojs && w.videojs.getPlayers ? w.videojs.getPlayers() : null; if (ps) { var k = Object.keys(ps)[0]; if (k) ps[k].playbackRate(r); } } catch(e){}
    if (v) { v.muted = true; try { v.playbackRate = r; } catch(e){} }
    return v ? v.playbackRate : null;
  },
  play: function(){
    var v = this.video(); if (!v) return 'novideo';
    v.muted = true;
    try { var p = v.play(); if (p && p.catch) p.catch(function(){}); return v.paused ? 'still-paused' : 'playing'; } catch(e){ return 'err:' + e.message; }
  },
  nudge: function(){ var v = this.video(); if(!v) return 0; try { if (v.paused) v.play(); else v.currentTime = v.currentTime + 0.5; return 1; } catch(e){ return 0; } },
  switchTo: function(courseId, clazzId, kid){ try { getTeacherAjax(courseId, clazzId, kid); return 'ok'; } catch(e){ return 'err:' + e.message; } },
  // ★ 2026-09-28 加：cards 是**分页**的（num 参数），一张卡只装一个任务点。
  //   实测 gdyy「2.1 巴赫的故事与作品」：num=0 附件 0 个，而 num=1 才是那段 899 秒的视频。
  //   此前只认 num=0 ⇒ 9 节真视频被判成「无任务点」，驱动又把它们标成 novideo 永久冻结。
  flipCard: function(n){
    var c = this.cards(); if (!c) return 'nocards';
    var s = c.getAttribute('src') || '';
    // ★ 双反斜杠是必须的：本钩子整体是一个**模板字符串**，单反斜杠 d 会被当成转义序列吃掉变成 d
    //   ⇒ 那个正则会静默变成永不匹配（2026-09-28 实测踩到，与既有教训「在 JS 字符串里写正则」同族）。
    //   ⚠️ 同理：本段注释里**不能出现反引号**（会提前截断这个模板字符串，直接 SyntaxError）。
    if (!/num=\\d+/.test(s)) return 'nonum';
    var ns = s.replace(/num=\\d+/, 'num=' + n);
    if (ns === s) return 'same';
    c.setAttribute('src', ns);
    return 'flipped:' + n;
  }
}; 'ok';
`;

/* ---------------- 连接 ---------------- */
const list = await (await fetch(BASE + '/json/list')).json();
const page = list.find((p) => p.type === 'page' && (!TAB_ID || p.id === TAB_ID || (p.id || '').startsWith(TAB_ID)));
if (!page) {
  console.error(`no such tab ${TAB_ID}. available:`, list.filter((p) => p.type === 'page').map((p) => p.id.slice(0, 8) + ' ' + p.url.slice(0, 60)));
  process.exit(1);
}
const tab = new Tab(page.webSocketDebuggerUrl);
await tab.connect();

/* ★ 班级 id 与 cpi 自动解析：只要给了 --course 就够，不必人肉抄 */
if (COURSE && (!CLAZZ || !CPI)) {
  try {
    await tab.goto('https://mooc2-ans.chaoxing.com/visit/interaction', 6000);
    const info = await tab.js(`(()=>{
      for (const c of document.querySelectorAll('div.course')) {
        const a=c.querySelector('a[href*=stucoursemiddle]'); if(!a) continue;
        const href=a.getAttribute('href')||'';
        const q=(k)=>{const m=new RegExp(k+'=(\\\\d+)').exec(href);return m?m[1]:'';};
        if(q('courseid')===${JSON.stringify(COURSE)}) return JSON.stringify({clazzid:q('clazzid'),cpi:q('cpi')});
      }
      return '{}';
    })()`);
    const o = JSON.parse(info || '{}');
    if (o.clazzid) { CLAZZ = CLAZZ || o.clazzid; CPI = CPI || o.cpi; log(`  auto-resolved clazz=${CLAZZ} cpi=${CPI}`); }
  } catch (e) { log(`  auto-resolve failed: ${e.message}`); }
}
if (!CLAZZ) { console.error('[x] 拿不到 clazzid：请显式给 --clazz <id>'); process.exit(1); }

log(`=== start tag=${TAG} course=${COURSE} clazz=${CLAZZ} tab=${page.id.slice(0, 8)} rate=${RATE}${ONLY ? ' only=' + ONLY.size : ''}`);

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {}, partial: {}, failed: {} };
const saveState = () => { try { fs.writeFileSync(STATE, JSON.stringify(state, null, 1), 'utf8'); } catch {} };

/** 注入钩子并校验（窗口里可能残留旧版钩子） */
async function injectHook() {
  for (let i = 0; i < 5; i++) {
    try {
      await tab.js(JS_HOOK);
      const keys = await tab.js('window.__cx ? Object.keys(window.__cx).join(",") : ""');
      if (typeof keys === 'string' && keys.includes('modules')) return true;
      log(`  hook check failed (#${i + 1}) keys=${keys}`);
    } catch (e) { log(`  hook inject error (#${i + 1}): ${e.message}`); }
    await sleep(1200);
  }
  return false;
}

/**
 * 判断当前是否已经在本课程的 studentstudy 上。
 * 只匹配 URL 是不够的：上一次跑别的课时页面会停在 studentstudy，
 * 直接复用就会把「别的课」的侧栏当成自己的（本次实测把信息素养的 71 个节点当成心理健康的待办）。
 * 所以必须同时核对页面里的 courseId。
 */
async function onStudy() {
  try {
    const raw = await tab.js(`JSON.stringify({
      url: location.href,
      course: String((document.getElementById('curCourseId')||{}).value || ''),
      cards: (function(){ var c = document.querySelector('iframe[src*="knowledge/cards"]'); return c ? (c.src||'') : ''; })(),
      tree: document.querySelectorAll('.posCatalog_select').length
    })`);
    const o = JSON.parse(raw);
    if (!/\/mycourse\/studentstudy/.test(o.url)) return false;
    const m = /courseid=(\d+)/i.exec(o.cards || '');
    const pageCourse = m ? m[1] : o.course;
    // ★★ fail-closed（2026-09-27 修）：判不出归属时必须判 **false**，不能放行。
    //   空壳页（页面没渲染完 / 渲染失败）里 `#curCourseId` 与 cards iframe 都不存在 ⇒
    //   pageCourse 为空 ⇒ 原来的 `if (pageCourse && ...)` 直接跳过检查、return true ⇒
    //   ensureStudy() 立刻"确认已在正确的课上"、只重注一次钩子就返回，**从来没等侧栏出现**。
    //   表现：`sidebar lost` / `!! sidebar still empty, exit`，整门课 done 0
    //   （2026-09-26 信息素养与心理健康两门课就是这么废掉的）。
    if (!pageCourse) return false;
    if (String(pageCourse) !== String(COURSE)) return false;
    // ★ 光 URL 对还不够：侧栏得真的渲染出来才算"在了"。
    //   enterCourse 点完小节如果立刻返回，后面读侧栏必然为空。
    if (!o.tree) return false;
    return true;
  } catch { return false; }
}
async function readSidebar() { try { return JSON.parse(await tab.js('JSON.stringify(window.__cx ? window.__cx.sidebar() : [])')); } catch { return []; } }

/** 章节列表在 sandbox iframe 里 → 必须用该帧自己的上下文 */
async function readChapterList() {
  try {
    const raw = await tab.jsInFrame(`(() => {
      const out = [];
      document.querySelectorAll('.chapter_item').forEach(el => {
        const yi = el.querySelector('.catalog_points_yi');
        const sb = el.querySelector('.catalog_sbar');
        out.push({ kid: (el.id||'').replace(/^cur/,''), code: sb?sb.textContent.trim():'', pending: yi?(Number((yi.innerText||'').trim())||0):0, name: el.getAttribute('title')||'' });
      });
      return JSON.stringify(out);
    })()`, 'studentcourse');
    return JSON.parse(raw);
  } catch (e) { return []; }
}

/** 从零进入课程：课程页 → 点「章节」→ 点第一个待完成节 → 落到 studentstudy */
async function enterCourse() {
  const url = await tab.js('location.href').catch(() => '');
  // 只有停在【课程首页】时才有「章节」Tab。若停在 studentstudy（别的课），
  // 直接找「章节」会一直找不到，空转到超时——必须先回课程首页。
  const onCourseHome = /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu/.test(url);
  if (!onCourseHome) {
    await tab.goto(`https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${COURSE}&clazzid=${CLAZZ}&cpi=${CPI}&ismooc2=1&v=2`, 8000);
  }
  let secs = [];
  const homeUrl = `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${COURSE}&clazzid=${CLAZZ}&cpi=${CPI}&ismooc2=1&v=2`;
  for (let i = 0; i < 40; i++) {
    // ★★ 每一轮都点「章节」（2026-09-27 修）。
    //   「章节」是**标签页**，`/mooc2-ans/mycourse/studentcourse` 这个 iframe 只有点开它才存在；
    //   课程首页默认标签常是「任务」（mobilelearn 的 stuActiveList）。
    //   原实现只在 `i % 12 === 0` 时点，而单轮 ctxFor 默认要烧 24×600ms≈14 秒
    //   ⇒ 两次点击间隔约 3 分钟，且中间一行日志都没有 ⇒ 表现是"静默空转十几分钟然后
    //   报 sidebar empty / chapter list 0"，2026-09-26 信息素养与心理健康两门课就是这么废掉的。
    const clicked = await tab.js(`(() => {
      const a = document.querySelector('a[data-url="/mooc2-ans/mycourse/studentcourse"]')
        || Array.from(document.querySelectorAll('a')).find(e => (e.title||'') === '章节');
      if (!a) return 'none';
      a.click(); return 'clicked';
    })()`).catch(() => 'err');
    await sleep(2500);
    secs = await readChapterList();
    if (secs.length) break;
    // 静默是这次最大的帮凶 —— 每轮都留痕
    log(`  waiting chapter list… (第 ${i + 1}/40 轮，click=${clicked})`);
    // 很久拿不到 ⇒ 多半是课程首页本身没渲染好，重进一次再试
    if (i === 12 || i === 26) {
      log('  长时间拿不到章节列表，重新进入课程首页');
      await tab.goto(homeUrl, 8000);
    }
  }
  log(`  chapter list: ${secs.length} sections, ${secs.filter((s) => s.pending > 0).length} pending`);
  if (!secs.length) return false;

  const first = secs.find((s) => s.pending > 0 && (!ONLY || ONLY.has(s.kid)));
  if (!first) return false;
  for (let i = 0; i < 8; i++) {
    await tab.jsInFrame(`(() => {
      const el = document.getElementById('cur${first.kid}'); if (!el) return 'none'; el.click(); return 'clicked';
    })()`, 'studentcourse').catch(() => {});
    await sleep(6000);
    if (await onStudy()) { await injectHook(); return true; }
  }
  return await onStudy();
}

async function ensureStudy() {
  if (await onStudy()) { await injectHook(); return true; }
  return await enterCourse();
}

/* ---------------- 初始化 ---------------- */
if (!(await injectHook()) && (await onStudy())) log('  WARN hook inject always failed');

let sidebar = await readSidebar();
for (let attempt = 1; attempt <= 4 && !sidebar.length; attempt++) {
  log(`not on chapter page (attempt ${attempt}) ...`);
  // ★ 一次导航失败不能杀掉整门课（2026-09-27 修）。
  //   实测古典音乐：`enterCourse` 里的 `tab.goto()` 没有 catch，`Page.navigate` 30 秒超时
  //   抛出来就是未处理异常 ⇒ 进程直接 exit 1，整门课 done 0。**30 秒 = 恰好是 send 的超时值。**
  let okNav = false;
  try {
    okNav = await ensureStudy();
  } catch (e) {
    log(`  ⚠ enterCourse 抛错（已吞掉，不让整门课死）：${e.message}`);
    await sleep(5000);
  }
  log(`  enter ${okNav ? 'OK' : 'FAIL'} : ${(await tab.js('location.href').catch(() => '?')).slice(0, 110)}`);
  sidebar = await readSidebar();
  if (!sidebar.length && okNav) { await sleep(5000); sidebar = await readSidebar(); }
}
if (!sidebar.length) { log('!! sidebar empty, exit'); tab.close(); process.exit(2); }
log(`sidebar ${sidebar.length} sections, ${sidebar.filter((s) => s.pending > 0).length} pending`);

/* ---------------- 做一节文档（insertdoc） ---------------- */
/**
 * 平台把「文档读完」定义为「滚到底」——
 *   scrollHeight == clientHeight        ⇒ 直接 finishJob()（不足一屏的短文档）
 *   scrollTop > scrollHeight - clientHeight - 100 ⇒ finishJob()
 * PDF 是**分页懒渲染**的：滚到底会让 scrollHeight 变大，所以要滚好几轮，每轮回读一次「平台标完成了吗」。
 * 回读判据用平台自己的 `checkJobFinish()` 与容器 class `ans-job-finished`，**不看我自己滚了多少**。
 */
async function handleDoc(sec) {
  let saw = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = await tab.js('window.__cx.docState()').catch(() => 'err');
    const m = typeof st === 'string' ? /^total=(\d+) done=(\d+)$/.exec(st) : null;
    if (!m) continue;
    const total = Number(m[1]), dn = Number(m[2]);
    if (total > 0 && total === dn) return 'done';
    if (total > 0) { saw = total; break; }
  }
  if (!saw) return 'no-doc-frame';
  for (let k = 0; k < 8; k++) {
    const r = await tab.js('window.__cx.docScroll()').catch(() => 'err');
    log(`  📄 滚到底 第${k + 1}轮（${r}）`);
    await sleep(2500);
    const st = await tab.js('window.__cx.docState()').catch(() => 'err');
    const m = typeof st === 'string' ? /^total=(\d+) done=(\d+)$/.exec(st) : null;
    if (m && Number(m[1]) > 0 && Number(m[1]) === Number(m[2])) return 'done';
  }
  return 'scrolled-but-not-credited';
}

/* ---------------- 播一节 ---------------- */
async function handleSection(sec) {
  const kid = sec.kid;
  const t0 = Date.now();
  const pendingAtStart = sec.pending;

  if (!(await onStudy())) { await ensureStudy(); sidebar = await readSidebar(); }
  await tab.js(`window.__cx.switchTo('${COURSE}','${CLAZZ}','${kid}')`);

  // 探测：出现 video 帧即为视频节。绝不能在这一步等 duration（不 play 就没有元数据）。
  let snap = null, gotVideoFrame = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try { snap = JSON.parse(await tab.js('window.__cx.snap()')); } catch { continue; }
    if (snap.chapterId === kid && snap.hasVideoFrame) { gotVideoFrame = true; break; }
    // 视频模块名各课不同（insertvideo / video），宽松匹配
    if (snap.chapterId === kid && snap.modules && snap.modules.length && !snap.modules.some((m) => /video/i.test(m))) break;
    if (snap.chapterId !== kid && (i === 8 || i === 20)) {
      await tab.js(`window.__cx.switchTo('${COURSE}','${CLAZZ}','${kid}')`).catch(() => {});
    }
  }

  // ★ 2026-09-28 加：第一张卡上什么都没有（modules 为空）时，翻到 num=1/2/3 再找视频。
  //   判据用「modules 为空」而不是「无视频帧」：文档节（xls 的 insertdoc）第一张卡就有模块，
  //   不该为它们多翻三张卡（30 节 × 3 张 = 白跑十几分钟页面加载）。
  if (!gotVideoFrame && snap && snap.chapterId === kid && (!snap.modules || snap.modules.length === 0)) {
    for (let n = 1; n <= 3 && !gotVideoFrame; n++) {
      const r = await tab.js(`window.__cx.flipCard(${n})`).catch(() => 'err');
      log(`  ↻ ${sec.code} ${sec.name}：第一张卡上没有模块，翻到第 ${n + 1} 张（${r}）`);
      if (r === 'nocards' || r === 'nonum') break;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        try { snap = JSON.parse(await tab.js('window.__cx.snap()')); } catch { continue; }
        if (snap.chapterId === kid && snap.hasVideoFrame) { gotVideoFrame = true; break; }
      }
    }
    if (gotVideoFrame) log(`  ✅ 翻卡找到视频（第 ${snap && snap.modules ? snap.modules.join('/') : '?'} 张卡）`);
  }

  // ★ 2026-09-29 加：**文档任务点（insertdoc）**。平台自己的完成条件是「把文档滚到底」——
  //   查看器 pdf/index.html：`getScrollTop() > scrollHeight - clientHeight - 100` ⇒ `finishJob()`。
  //   ★ 合规：走的是**驱动 UI**（把文档打开、滚到底），由平台自己的 documentJob.js 上报；
  //     **绝不直接 GET /mooc-ans/job/document 标完成**（那是"跳过内容却标记已完成"）。
  //   判据不靠 modules（它从 iframe src 抠出来的是 pdf/doc 而不是 insertdoc），直接问 DOM。
  if (!gotVideoFrame && snap && snap.chapterId === kid) {
    const dst = await tab.js('window.__cx.docState()').catch(() => 'err');
    const dm = typeof dst === 'string' ? /^total=(\d+) done=(\d+)$/.exec(dst) : null;
    if (dm && Number(dm[1]) > 0) {
      const dr = await handleDoc(sec);
      if (dr === 'done') { log(`  ✅ ${sec.code} ${sec.name}：文档任务点已完成（滚到底 → 平台自己上报）`); return 'done'; }
      log(`  ⚠ ${sec.code} ${sec.name}：文档没被标完成（${dr}）—— 交回重试`);
      return 'retry';
    }
  }

  if (!gotVideoFrame) {
    const mods = snap && snap.modules ? snap.modules.join('/') : '?';
    log(`  SKIP ${sec.code} ${sec.name} : no video (pending=${pendingAtStart} modules=[${mods}] chapterId=${snap ? snap.chapterId : '?'})`);
    return 'novideo';
  }

  // 先起播，再等时长
  if (!rateDisallowed) await tab.js(`window.__cx.rate(${RATE})`);
  await tab.js('window.__cx.play()');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try { snap = JSON.parse(await tab.js('window.__cx.snap()')); } catch { continue; }
    if (snap.v && snap.v.dur > 0) break;
    if (!rateDisallowed) await tab.js(`window.__cx.rate(${RATE})`).catch(() => {});
    await tab.js('window.__cx.play()').catch(() => {});
  }
  if (!snap || !snap.v || !snap.v.dur) { log(`  WARN ${sec.code} no duration after play`); return 'timeout'; }
  log(`  PLAY ${sec.code} ${sec.name}  ${Math.round(snap.v.dur)}s  pending=${pendingAtStart}`);

  // 播放器会在 loadedmetadata 时把 playbackRate 重置回 1。
  // 元数据就绪后必须再设一次，否则会误判成「本课禁用倍速」。
  if (!rateDisallowed) {
    for (let i = 0; i < 3; i++) { await tab.js(`window.__cx.rate(${RATE})`).catch(() => {}); await sleep(800); }
    await tab.js('window.__cx.play()').catch(() => {});
  }

  // 热身：等到画面**确实在推进**再测倍速。
  // 不能只判断「currentTime > 2」——从上次进度续播的视频本来就 > 2 秒，那样会在还没播起来时
  // 就开测，量到 0.00x 的假速率，从而误判「本课禁用倍速」并把视频压成 1x。必须比较两次采样。
  let prevCur = null;
  for (let i = 0; i < 24; i++) {
    let s0 = null;
    try { s0 = JSON.parse(await tab.js('window.__cx.snap()')); } catch {}
    const cur = s0 && s0.v ? s0.v.cur : null;
    if (cur != null && s0.v && !s0.v.paused) {
      if (prevCur != null && cur > prevCur + 0.5) break;   // 确认在推进，可以开测
      prevCur = cur;
    }
    if (!rateDisallowed) await tab.js(`window.__cx.rate(${RATE})`).catch(() => {});
    await tab.js('window.__cx.play()').catch(() => {});
    await sleep(1800);
  }

  // 实测有效倍速，决定本课到底能不能倍速
  if (!rateProbed) {
    let a = 0;
    try { const s = JSON.parse(await tab.js('window.__cx.snap()')); a = s.v ? s.v.cur : 0; } catch {}
    const ta = Date.now();
    await sleep(10000);
    let b = a, tb = Date.now();
    try { const s = JSON.parse(await tab.js('window.__cx.snap()')); if (s.v) { b = s.v.cur; tb = Date.now(); } } catch {}
    const eff = (b - a) / Math.max(1, (tb - ta) / 1000);
    rateProbed = true;
    if (eff < 0.3) {
      // ★ 关键区分：几乎没动 = 「还没播起来」，不是「播放器不支持倍速」。
      // 实测后段视频起播要几十秒，若据此永久禁用倍速，反而把原本能 2x 的视频压成 1x——自己给自己减速。
      // 所以这种情况不禁用倍速，标记为「待重测」。
      rateProbed = false;
      log(`  NOTE 视频尚未起播（${eff.toFixed(2)}x），保持 ${RATE}x 并稍后重测`);
    } else if (eff < RATE * 0.7) {
      rateDisallowed = true;
      log(`  NOTE 播放器确实不支持倍速（实测 ${eff.toFixed(2)}x）→ 退回 1x`);
    } else {
      log(`  NOTE 实测有效倍速 ${eff.toFixed(2)}x`);
    }
  }

  let curObj = snap.v.obj, lastCur = -1, lastMove = Date.now(), stalls = 0, played = 1, maxCur = 0;
  // 90 秒滑窗：用来识别「偶发推进但整体卡死」的媒体管线
  let winStartCur = null, winStartTime = Date.now();
  const deadline = Date.now() + Math.max(240000, (snap.v.dur / RATE) * 1000 * 3 + 300000);

  while (Date.now() < deadline) {
    await sleep(5000);
    if (pastDeadline()) { log(`  ⏰ 到点收工（避免深夜学习），本节停在这里，进度已由服务端记下`); return 'stopped'; }

    const left = await tab.js(`window.__cx.pendingOf('${kid}')`).catch(() => null);
    if (left === 0) { log(`  DONE ${sec.code} (${Math.round((Date.now() - t0) / 1000)}s, ${played} clip(s))`); return 'done'; }
    if (typeof left === 'number' && left > 0 && left < pendingAtStart) {
      let s3 = null;
      try { s3 = JSON.parse(await tab.js('window.__cx.snap()')); } catch {}
      const newVideo = s3 && s3.v && s3.v.obj && s3.v.obj !== curObj && s3.v.cur < 20;
      if (newVideo) {
        played++; curObj = s3.v.obj; lastCur = -1; maxCur = 0; lastMove = Date.now(); stalls = 0;
        if (!rateDisallowed) await tab.js(`window.__cx.rate(${RATE})`);
        await tab.js('window.__cx.play()');
        log(`  NEXT ${sec.code} clip #${played} (${left} left)`);
        continue;
      }
      if (s3 && s3.v && s3.v.cur < s3.v.dur - 15 && !s3.v.paused) { lastMove = Date.now(); continue; }
      log(`  PART ${sec.code} video done, ${left} non-video task point(s) left`);
      return 'partial';
    }

    let s2 = null;
    try { s2 = JSON.parse(await tab.js('window.__cx.snap()')); } catch { continue; }
    const v = s2.v;
    if (!v) { await sleep(2000); continue; }
    if (v.cur > maxCur) maxCur = v.cur;

    // ── ①型自愈：窗口被最小化 ────────────────────────────────────────
    // 2026-09-26 实测：窗口一最小化，浏览器就把视频暂停（实测 t 卡住、paused=true），
    // 驱动原本完全不处理这一档，只能干等 → 现在先恢复窗口，并重开停滞滑窗
    // （不把"最小化那段时间"算进停滞，否则一恢复就误报 STALL）。
    // 判据用页面自身的 visibilityState（便宜，随 snap 一起取回），
    // 只有真 hidden 时才走 CDP 恢复，避免每轮都发浏览器级命令。
    if (s2.vis === 'hidden') {
      let fixed = 'no';
      try { await tab.send('Page.bringToFront', {}, 8000); } catch (e) {}
      await sleep(1500);
      let now = await tab.js('document.visibilityState').catch(() => '?');
      if (now === 'hidden') {
        // 退一步：用 Browser 域直接改窗口状态（Page 域没恢复过来时才走这条）
        try {
          const r = await tab.send('Browser.getWindowForTarget', { targetId: page.id }, 8000);
          const st = r && r.bounds ? r.bounds.windowState : null;
          if (st && st !== 'normal') {
            await tab.send('Browser.setWindowBounds', { windowId: r.windowId, bounds: { windowState: 'normal' } }, 8000);
            await sleep(1500);
            now = await tab.js('document.visibilityState').catch(() => '?');
            fixed = 'setWindowBounds(' + st + ')';
          } else { fixed = 'browser-said:' + st; }
        } catch (e) { fixed = 'browserErr:' + e.message; }
      } else { fixed = 'bringToFront'; }
      log(`  ⚠ 窗口被最小化 → 恢复(${fixed}) 复核 visibilityState=${now}`);
      winStartCur = null; winStartTime = Date.now(); stalls = 0; lastMove = Date.now();
      continue;
    }
    // 停滞判定用【90 秒滑窗】而不是「单轮有没有动」：
    // 卡死的媒体管线会偶发推进一下（实测 0.03~0.18x，paused 时真时假），
    // 用「单轮 +2s 就清零」会被这种 burst 反复骗过去，永远触发不了恢复，白等到超时。
    // 滑窗判据：90 秒内推进不足 45 秒（即低于 0.5x）就算停滞。
    if (winStartCur === null) { winStartCur = v.cur; winStartTime = Date.now(); }
    // ★ cur 明显倒退 = 播放器换了片段 / 重播，**不是停滞**（2026-09-27 修）。
    //   实测信息素养 7.3：片段切换让"90 秒推进"算出 -366s ≈ -4.07x，被判成 STALL 1/3
    //   并触发一次毫无必要的 nudge。判据本身没错（<45 成立），错在把"换片段"也归进这一档。
    if (v.cur < winStartCur - 1) { winStartCur = v.cur; winStartTime = Date.now(); stalls = 0; }
    if (Date.now() - winStartTime > 90000) {
      const advanced = v.cur - winStartCur;
      if (advanced < 45) {
        stalls++;
        log(`  STALL ${stalls}/3 （90 秒只推进 ${Math.round(advanced)}s ≈ ${(advanced / 90).toFixed(2)}x，${Math.round(v.cur)}/${Math.round(v.dur)}s paused=${v.paused}）`);
        if (stalls < 3) {
          await tab.js('window.__cx.nudge()').catch(() => {});
          if (!rateDisallowed) await tab.js(`window.__cx.rate(${RATE})`).catch(() => {});
        } else {
          log(`  RELOAD ${sec.code}（媒体管线卡死，重载页面重建播放器）`);
          await ensureStudy();
          sidebar = await readSidebar();
          return 'retry';
        }
      } else {
        if (stalls) log(`  恢复：90 秒推进 ${Math.round(advanced)}s ≈ ${(advanced / 90).toFixed(2)}x`);
        stalls = 0;
      }
      winStartCur = v.cur; winStartTime = Date.now();
    }
    // 播放器会在加载 / 切源后把倍速重置回 1；但若本课禁用倍速，绝不能再设（会被判定异常并暂停）
    if (!rateDisallowed && v.rate !== RATE) await tab.js(`window.__cx.rate(${RATE})`).catch(() => {});
    if (v.paused) await tab.js('window.__cx.play()').catch(() => {});
    if (v.dur > 0 && maxCur >= v.dur - 2 && Date.now() - lastMove > 25000) {
      await sleep(8000);
      if ((await tab.js(`window.__cx.pendingOf('${kid}')`).catch(() => null)) === 0) { log(`  DONE ${sec.code} (tail confirmed)`); return 'done'; }
    }
  }
  log(`  TIMEOUT ${sec.code} (pending=${await tab.js(`window.__cx.pendingOf('${kid}')`).catch(() => '?')})`);
  return 'timeout';
}

/* ---------------- 主循环 ---------------- */
let done = 0, partial = 0, skipped = 0, fails = 0, retries = 0;
const retryCount = new Map();   // 每个节的重载重试次数（单节上限 3 次后跳过）
const failedKids = new Set();   // 失败节集合：停止阈值按**去重后**的坏节数算，不按失败次数
const failCount = new Map();    // 同一节失败了几次 —— 连续 2 次就强制跳过，防止反复挑中同一节
for (let round = 0; round < 400; round++) {
  // 每轮先确认页面确实在本课程上，否则侧栏会是别的课的
  if (!(await onStudy())) {
    log('not on this course page, re-entering');
    await ensureStudy();
    if (!(await onStudy())) log('  WARN still not on the right course');
  }
  sidebar = await readSidebar();
  if (!sidebar.length) {
    log('sidebar lost, re-entering');
    await ensureStudy();
    sidebar = await readSidebar();
    if (!sidebar.length) { log('!! sidebar still empty, exit'); break; }
  }
  const skipSet = new Set(Object.keys(state.partial || {}).filter((k) => state.partial[k] && state.partial[k].skip));
  const pending = sidebar.filter((s) => s.pending > 0 && (!ONLY || ONLY.has(s.kid)) && !skipSet.has(s.kid));
  log(`round ${round + 1}: todo ${pending.length} / course pending ${sidebar.filter((s) => s.pending > 0).length} (skipped ${skipSet.size})`);
  if (!pending.length) { log('all task points handled OK'); break; }
  if (MAX && done >= MAX) { log(`reached --max ${MAX}`); break; }
  if (pastDeadline()) { log(`⏰ 到点收工（避免深夜学习），停止本课`); break; }

  const target = pending[0];
  const r = await handleSection(target);
  if (r === 'done') { done++; delete state.partial[target.kid]; state.done[target.kid] = { code: target.code, name: target.name, at: Date.now() }; }
  else if (r === 'partial') { partial++; state.partial[target.kid] = { code: target.code, name: target.name, at: Date.now(), skip: true }; }
  else if (r === 'novideo') { skipped++; state.partial[target.kid] = { code: target.code, name: target.name, at: Date.now(), skip: true, reason: 'novideo' }; }
  else if (r === 'retry') {
    // 单节重载重试要有上限，但**不能因此终止整门课**——否则一个坏节就能拖垮几小时的无人值守。
    retries++;
    const n = (retryCount.get(target.kid) || 0) + 1;
    retryCount.set(target.kid, n);
    if (n >= 3) {
      log(`  ⚠ ${target.code} 重载重试 ${n} 次仍卡住，跳过该节继续跑（不拖垮整门课）`);
      state.failed[target.kid] = { code: target.code, name: target.name, at: Date.now(), reason: 'stall-after-reload' };
      retryCount.delete(target.kid);
      failedKids.add(target.kid);
      fails++;
    }
    if (retries > 60) { log('重试总数过多，停止'); break; }
    saveState();
    continue;
  }
  else if (r === 'stopped') { log(`⏰ 到点收工，停止本课（不是失败）`); break; }
  else {
    failedKids.add(target.kid);
    fails++;
    state.failed[target.kid] = { code: target.code, name: target.name, at: Date.now() };
    // ★ 通用保险：同一节连续失败 2 次就强制跳过。
    //   原来失败的节不标 skip ⇒ 下一轮 pending 表里它还在 ⇒ 被反复挑中、每轮重烧一遍。
    const nf = (failCount.get(target.kid) || 0) + 1;
    failCount.set(target.kid, nf);
    if (nf >= 2) {
      state.partial[target.kid] = { code: target.code, name: target.name, at: Date.now(), skip: true, reason: 'failed-twice' };
      log(`  ⛔ ${target.code} 连续失败 ${nf} 次，标为跳过（避免每轮反复重烧同一节）`);
    }
  }
  saveState();
  // 拟人化间隔
  if (r !== 'novideo' && r !== 'retry') {
    const gap = GAP_MIN + Math.floor(Math.random() * Math.max(1, GAP_MAX - GAP_MIN));
    if (gap > 0) { log(`  ... idle ${gap}s`); await sleep(gap * 1000); }
  }
  // ★ 停止阈值按**去重后的坏节数**算，不按失败次数（2026-09-27 修）。
  //   实测：信息素养一门 59 点的课，因为同一节反复失败凑够 7 次就整门停了（只 done 13）。
  //   坏节数才是"这门课是不是真有问题"的判据。
  if (failedKids.size > 15) { log(`坏节累计 ${failedKids.size} 个（上限 15），停止本课`); break; }
}
log(`=== end tag=${TAG}: done ${done}, partial ${partial}, novideo ${skipped}, failed ${fails}`);
tab.close();
