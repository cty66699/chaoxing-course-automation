/**
 * lib/cdp.mjs —— 学习通刷课 skill 的 CDP 底座（零依赖，Node ≥ 18）
 *
 * 为什么要有它：学习通是「顶层页 + 多个跨域 iframe」的结构，
 * 而**每次导航都会销毁当前执行上下文** ⇒ 一次连接干不完整条链，
 * 必须「每步重新解析上下文」。这层把这件事收在一处。
 *
 * 导出：
 *   sleep(ms)
 *   pickPage({port,tab,id})      选标签页
 *   connect(opts)                建会话（自动 Runtime.enable / Page.enable）
 *   s.eval(expr, {ctxId,timeout})  求值（不传 ctxId = 顶层）
 *   evalTop(s, expr, opts)        顶层求值
 *   evalFrame(s, match, expr)     在 URL 含 match 的 iframe 里求值（跨域也行）
 *   frameCtx(s, match)            解析某 iframe 的 executionContextId
 *   nav(s, url)                   导航并等 readyState=complete
 *   normalizeWindow(s)            窗口恢复为 normal（最小化会暂停视频）
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CDP_BASE = (port) => `http://127.0.0.1:${port}`;

export async function pickPage({ port = 9222, tab = null, id = null } = {}) {
  let list;
  try {
    list = await (await fetch(`${CDP_BASE(port)}/json/list`)).json();
  } catch (e) {
    throw new Error(`连不上 Chrome（127.0.0.1:${port}）：${e.message} —— 先跑 cx-start.mjs 起浏览器`);
  }
  const pages = list.filter((t) => t.type === 'page' && !/^devtools:/.test(t.url || ''));
  if (!pages.length) throw new Error('没有可用标签页');
  if (id) {
    const hit = pages.find((p) => p.id === id || p.id.startsWith(id));
    if (!hit) throw new Error(`--id ${id} 没匹配到`);
    return hit;
  }
  if (tab !== null && tab !== undefined && tab !== '') {
    const n = Number(tab);
    if (!Number.isNaN(n) && pages[n]) return pages[n];
    const hit = pages.find((p) => (p.url || '').includes(tab) || (p.title || '').includes(tab));
    if (!hit) throw new Error(`--tab ${tab} 没匹配到`);
    return hit;
  }
  return pages[0];
}

export class Session {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.waiting = new Map();
    this.contexts = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error('WS 失败：' + (e.message || '')));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { res, rej } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
        return;
      }
      if (m.method === 'Runtime.executionContextCreated') {
        const c = m.params.context;
        this.contexts.push({ id: c.id, frameId: c.auxData && c.auxData.frameId, origin: c.origin });
      }
    };
  }

  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      // ★ 这里的计时器**不能 unref** —— 否则页面一导航、WebSocket 一断，
      //   事件循环就只剩这个 unref 计时器，Node 会直接报
      //   "unsettled top-level await" 并退出（2026-10-20 实测踩到）。
      const t = setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); rej(new Error(method + ' 超时')); }
      }, timeout);
      this.waiting.set(id, {
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, { ctxId = null, timeout = 30000, awaitPromise = true } = {}) {
    const params = { expression, returnByValue: true, awaitPromise, userGesture: true };
    if (ctxId != null) params.contextId = ctxId;
    const r = await this.send('Runtime.evaluate', params, timeout);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || '求值异常');
    }
    return r.result?.value;
  }

  /** 求值并把 JSON 字符串解回对象（页面脚本统一返回 JSON.stringify 的结果） */
  async evalJson(expression, opts) {
    const raw = await this.eval(expression, opts);
    if (raw == null) return null;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  close() { try { this.ws.close(); } catch {} }
}

export async function connect(opts = {}) {
  const page = await pickPage(opts);
  const s = new Session(page.webSocketDebuggerUrl);
  await s.connect();
  s.pageId = page.id;
  s.pageUrl = page.url;
  await s.send('Runtime.enable').catch(() => {});
  await s.send('Page.enable').catch(() => {});
  return s;
}

/** 列出所有 page 目标（用来发现 window.open 出来的新标签） */
export async function listPages(port = 9222) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && !/^devtools:/.test(t.url || ''));
}

/**
 * 跟到 window.open 打开的新标签。
 * ★ 为什么必须有它：学习通的 `toExamNotesAction()` / `viewExamAnswer()` 都是
 *   `window.open(url)` ⇒ **新标签**，而当前会话还连在旧标签上。
 *   不跟过去 ⇒ 后面所有操作都作用在错误的页面上（而且不报错）。
 */
export async function switchToNewTab(s, { port = 9222, timeout = 15000, match = '', beforeIds = null } = {}) {
  // ★ 必须用"点击前的标签快照"当基线 —— 否则会把**本来就开着**的别的标签
  //   （例如学习通登录用的阿里云授权页）误认成新开的。
  const before = beforeIds || new Set([s.pageId]);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pages = await listPages(port);
    const fresh = pages.find((p) => !before.has(p.id) && (!match || (p.url || '').includes(match)));
    if (fresh) {
      const ns = new Session(fresh.webSocketDebuggerUrl);
      await ns.connect();
      ns.pageId = fresh.id;
      ns.pageUrl = fresh.url;
      await ns.send('Runtime.enable').catch(() => {});
      await ns.send('Page.enable').catch(() => {});
      return { session: ns, page: fresh };
    }
    await sleep(500);
  }
  return null;
}

/** 解析 URL 含 match 的 iframe 的 executionContextId（跨域 iframe 的正解） */
export async function frameCtx(s, match, waitMs = 5000) {
  const tree = await s.send('Page.getFrameTree');
  const flat = [];
  (function walk(n) { flat.push(n.frame); (n.childFrames || []).forEach(walk); })(tree.frameTree);
  const hit = flat.find((f) => (f.url || '').includes(match));
  if (!hit) {
    throw new Error(
      `没有匹配 "${match}" 的 iframe。现有帧：\n` +
      flat.map((f) => '  ' + (f.url || '(无 url)').slice(0, 120)).join('\n'),
    );
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const c = s.contexts.find((c) => c.frameId === hit.id);
    if (c) return c.id;
    await sleep(150);
  }
  throw new Error(`iframe 没有执行上下文（可能还没加载完）：${(hit.url || '').slice(0, 90)}`);
}

export async function evalTop(s, expression, opts = {}) {
  return s.eval(expression, opts);
}

export async function evalFrame(s, match, expression, opts = {}) {
  const ctxId = await frameCtx(s, match, opts.waitMs ?? 5000);
  return s.eval(expression, { ...opts, ctxId });
}

/** 导航到 url 并等页面 readyState=complete（导航会销毁上下文，所以这里不假设旧 ctx 还有效） */
export async function nav(s, url, { timeout = 30000 } = {}) {
  await s.send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const st = await s.eval('document.readyState', { timeout: 5000 });
      if (st === 'complete') { await sleep(300); return; }
    } catch { /* 导航中上下文被销毁是正常的 */ }
    await sleep(400);
  }
  throw new Error(`导航超时：${url}`);
}

/**
 * 窗口恢复为 normal。
 * ★ 为什么必须做：学习通播放器在窗口**最小化**时会被浏览器暂停
 *   （实测：paused=true、currentTime 不走，而 readyState=4、缓冲充足）
 *   ⇒ 无人值守时就会静默卡死。
 */
export async function normalizeWindow(s, { width = 1280, height = 900 } = {}) {
  const res = await s.send('Browser.getWindowForTarget', { targetId: s.targetId }).catch(() => null);
  if (!res) return { ok: false, why: '拿不到窗口句柄' };
  const { windowId, bounds } = res;
  const st = bounds.windowState;
  if (st === 'normal' && bounds.width > 400) return { ok: true, why: '已是 normal' };
  await s.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal', left: 40, top: 20, width, height },
  });
  await s.send('Page.bringToFront').catch(() => {});
  return { ok: true, why: '已恢复 normal', was: st };
}

/** 读页面里的 JSON（页面脚本统一 return JSON.stringify(...)） */
export async function evalJsonTop(s, expression, opts = {}) {
  return s.evalJson(expression, opts);
}
