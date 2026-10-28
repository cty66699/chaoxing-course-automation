/**
 * lib/exam.mjs —— 学习通「考试」相关的页面操作（共用层）。
 *
 * ★ 关键事实（都是实测）：
 *   1. 答题页**一页只渲染一题**（`.questionLi`），整卷数据不在页面里；
 *      要读全卷只能**用题号面板一题一题跳**（每次跳 = 一次整页重载）。
 *   2. 跳题后**执行上下文被销毁** ⇒ 每跳一次都要重新求值（不能复用旧 ctx）。
 *   3. 题干开头自带题号（"12. (单选题, 2.0 分)"）⇒ **用它判断"跳到位了没有"**，
 *      比等固定时间可靠。
 *   4. 已选答案的权威字段是 **`#answer<qid>`**；`#isAnswered` 不可靠。
 *   5. **整卷预览页是服务端渲染的**，同时带全部题干与全部已存答案
 *      ⇒ 可作一条**独立于"我刚点的"**的读数，用于交卷前复核。
 */
import { sleep } from './cdp.mjs';
import { pageScript, stemIndex } from './pages.mjs';

const READ_ONE = pageScript('exam-read-current');
const PICK = pageScript('exam-pick');
const READ_ALL = pageScript('exam-read-all');

export async function readCurrent(s) {
  return s.evalJson(READ_ONE);
}

/** 列出所有帧 */
export async function frames(s) {
  const tree = await s.send('Page.getFrameTree');
  const flat = [];
  (function walk(n) { flat.push(n.frame); (n.childFrames || []).forEach(walk); })(tree.frameTree);
  return flat;
}

/** 找出"页面里含某个选择器"的帧的执行上下文（作业页/考试页都是 iframe） */
export async function frameWithSelector(s, selector, timeout = 8000) {
  const deadline = Date.now() + timeout;
  const tried = [];
  while (Date.now() < deadline) {
    const flat = await frames(s);
    for (const f of flat) {
      const ctx = s.contexts.find((c) => c.frameId === f.id);
      if (!ctx) continue;
      try {
        const hit = await s.eval(`!!document.querySelector(${JSON.stringify(selector)})`, { ctxId: ctx.id, timeout: 4000 });
        if (hit) return { ctxId: ctx.id, frameId: f.id, url: f.url };
      } catch { /* 跨域或正在导航 */ }
    }
    await sleep(600);
  }
  throw new Error(`没找到含 "${selector}" 的帧。现有帧：\n` + (await frames(s)).map((f) => '  ' + (f.url || '(无)').slice(0, 110)).join('\n'));
}

/** 跳到第 i 题（用题号面板）。已到位则不跳。 */
export async function jumpTo(s, i, { timeout = 20000 } = {}) {
  const cur = await readCurrent(s).catch(() => null);
  if (cur && !cur.err && stemIndex(cur.stem) === i) return cur;

  const clicked = await s.eval(`(()=>{
    const p = document.querySelector('.topicNumber');
    if (!p) return 'nopanel';
    const n = [...p.querySelectorAll('*')].filter(e=>e.children.length===0 && e.innerText.trim()==='${i}');
    if (!n.length) return 'nofind';
    n[0].click();
    return 'ok';
  })()`).catch((e) => 'ERR:' + e.message);
  if (clicked !== 'ok') throw new Error(`跳到第 ${i} 题失败：${clicked}`);

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(700);
    const r = await readCurrent(s).catch(() => null);
    if (r && !r.err && stemIndex(r.stem) === i) return r;
  }
  throw new Error(`跳到第 ${i} 题超时（题干里的题号没变成 ${i}）`);
}

/** 在当前题点中某个选项，并回读落库值 */
export async function pick(s, key) {
  await s.eval(`window.__K = ${JSON.stringify(String(key))}`);
  const r = await s.evalJson(PICK);
  if (r && r.err) throw new Error('选项点击失败：' + r.err);
  return r;
}

/** 在整卷预览页一次性读出全部题目与已存答案 */
export async function readAllPreview(s) {
  const r = await s.evalJson(READ_ALL);
  if (!r) throw new Error('预览页读取为空（是不是没在预览页？）');
  return r;
}
