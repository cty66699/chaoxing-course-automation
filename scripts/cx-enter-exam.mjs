#!/usr/bin/env node
/**
 * cx-enter-exam.mjs —— 自动走到「答题页」，把该人参与的一步留给用户。
 *
 * 完整链路：
 *   课程页 →「考试」标签 → 点考试卡片 → 考试说明页
 *   → 勾「我已阅读并同意」→ 点「进入考试」→ 弹窗点「确定」
 *   → **若弹滑块验证码 ⇒ 停下，交给用户**（不代过）
 *   → 打印答题页 URL（后续 read-paper / answer / verify / submit 都要它）
 *
 * 用法：
 *   node cx-enter-exam.mjs --port 9223 --course 267202626 [--examId 10975060] [--list-only]
 *
 * ★ 停止条件（安全设计）：
 *   · 出现滑块/图形验证码 ⇒ 打印 `needHuman` 并退出，**不尝试破解**；
 *   · 已交卷的考试 ⇒ 走"查看答卷"（只读），不会重新开考。
 */
import { connect, nav, sleep, frameCtx, switchToNewTab, listPages } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const opt = { port: 9223, course: '', examId: '', listOnly: false, allowCompleted: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--course') opt.course = argv[++i];
  else if (a === '--examId') opt.examId = argv[++i];
  else if (a === '--list-only') opt.listOnly = true;
  else if (a === '--allow-completed') opt.allowCompleted = true;
}
if (!opt.course) { console.error('用法：--course <courseid> [--examId <id>] [--list-only]'); process.exit(2); }

let s = await connect({ port: opt.port });
const out = { ok: false, step: '' };

// ① 课程列表取 clazzid / cpi
await nav(s, 'https://mooc2-ans.chaoxing.com/visit/interaction');
await sleep(1200);
const info = await s.eval(`(()=>{
  for (const c of document.querySelectorAll('div.course')) {
    const a=c.querySelector('a[href*=stucoursemiddle]'); if(!a) continue;
    const href=a.getAttribute('href')||'';
    const q=(k)=>{const m=new RegExp(k+'=(\\\\d+)').exec(href);return m?m[1]:'';};
    if(q('courseid')===${JSON.stringify(opt.course)}) return JSON.stringify({clazzid:q('clazzid'),cpi:q('cpi')});
  }
  return '{}';
})()`);
let ci = {}; try { ci = JSON.parse(info); } catch {}
if (!ci.clazzid) { console.error('[x] 这个 courseid 不在课程列表里'); s.close(); process.exit(1); }

// ② 进课程页 → 点「考试」
await nav(s, `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${opt.course}&clazzid=${ci.clazzid}&cpi=${ci.cpi}&ismooc2=1&v=2`);
await sleep(2200);
out.step = 'open-course';
const tab = await s.eval(`(()=>{
  const e=[...document.querySelectorAll('a,li,div,span')].find(x=>x.children.length===0&&(x.innerText||'').trim()==='考试');
  if(!e) return 'notab'; e.click(); return 'ok';
})()`);
if (tab !== 'ok') { out.err = '课程页里没找到「考试」标签'; console.log(JSON.stringify(out, null, 2)); s.close(); process.exit(1); }
await sleep(2500);

// ③ 读考试列表
let list = [];
try {
  const ctxId = await frameCtx(s, 'exam-list', 8000);
  const raw = await s.eval(`(()=>{
    const items=[...document.querySelectorAll('.bottomList li')].map(li=>{
      const t=(li.innerText||'').replace(/\\s+/g,' ').trim();
      const a=li.querySelector('[onclick]'); const oc=a?(a.getAttribute('onclick')||''):'';
      const m=/(goTest|viewExamAnswer)\\(([^)]*)\\)/.exec(oc);
      const args=m?m[2].split(',').map(x=>x.trim().replace(/^'|'$/g,'')):[];
      return {text:t.slice(0,120), examId: m&&m[1]==='goTest'?(args[1]||''):(args[0]||''), action:m?m[1]:'', oc};
    });
    return JSON.stringify({n:items.length, items});
  })()`, { ctxId });
  list = JSON.parse(raw).items || [];
} catch (e) { out.err = '读考试列表失败：' + e.message; console.log(JSON.stringify(out, null, 2)); s.close(); process.exit(1); }

out.exams = list.map((x) => ({ text: x.text, examId: x.examId, action: x.action }));
if (opt.listOnly) { out.ok = true; out.step = 'listed'; console.log(JSON.stringify(out, null, 2)); s.close(); process.exit(0); }

// ④ 选目标：指定 examId，或第一个"待做"
let target = opt.examId ? list.find((x) => x.examId === opt.examId) : list.find((x) => /待做/.test(x.text));
// 没有待做的 ⇒ 若允许，就打开"查看答卷"（已交卷的，只读，用于查分/对账）
if (!target && opt.allowCompleted) target = list.find((x) => /已完成/.test(x.text));
if (!target) {
  out.err = opt.examId ? `没找到 examId=${opt.examId}` : '没有"待做"的考试（要查已交卷的答卷加 --allow-completed）';
  out.exams = out.exams;
  console.log(JSON.stringify(out, null, 2)); s.close(); process.exit(1);
}
out.picked = { text: target.text, examId: target.examId, action: target.action };

// ★ 点击**前**先拍一张标签快照 —— 否则会把本来就开着的别的标签
//   （实测：学习通登录用的阿里云授权页）误认成"新开的"。
const beforeIds = new Set((await listPages(opt.port)).map((p) => p.id));

// ⑤ 点它 → 考试说明页
await s.eval(`(()=>{
  const li=[...document.querySelectorAll('.bottomList li')].find(l=>(l.innerText||'').includes(${JSON.stringify(target.text.slice(0, 12))}));
  if(!li) return 'nocard';
  const a=li.querySelector('[onclick]'); if(!a) return 'noonclick';
  const oc=a.getAttribute('onclick')||''; const fn=window[oc.split('(')[0]];
  if(typeof fn!=='function') return 'nofn';
  fn.apply(null, oc.replace(/^[^(]*\\(/,'').replace(/\\)$/,'').split(',').map(x=>x.trim().replace(/^'|'$/g,'')));
  return 'ok';
})()`).catch(() => {});
await sleep(2000);

// ★★ 点考试卡片是 window.open ⇒ **新标签**。不跟过去，后面所有操作都作用在错误的页面上。
const switched = await switchToNewTab(s, { port: opt.port, timeout: 12000, beforeIds });
if (switched) {
  s.close();
  s = switched.session;
  out.newTab = switched.page.url;
  await sleep(2000);
}
out.step = 'notes';
out.url = await s.eval('location.href').catch(() => '');

// ⑥ 若是"待做"，走 同意 → 进入考试 → 确定
if (target.action === 'goTest') {
  await s.eval(`(()=>{
    const ag=document.querySelector('.face_agreement');
    if(ag && !ag.querySelector('.agree_check').classList.contains('agree_checked')) ag.click();
    const b=document.querySelector('#startBtn')||document.querySelector('#tabIntoexam2');
    if(b) b.click(); return 'ok';
  })()`).catch(() => {});
  await sleep(2500);
  // 确认弹窗
  await s.eval(`(()=>{
    const c=[...document.querySelectorAll('a,button')].filter(e=>e.children.length===0&&/^(确定|确认)$/.test((e.innerText||'').trim()));
    const d=c.find(e=>e.closest('#confirmEnterWin,.maskDiv,[class*=mask]'))||c[0];
    if(d){d.click();return 'ok';} return 'noc';
  })()`).catch(() => {});
  await sleep(3000);
  out.step = 'entered';
  out.url = await s.eval('location.href').catch(() => '');
}

// ⑦ 有没有滑块？
const cap = await s.eval(`(()=>{
  const t=(document.body?document.body.innerText:'');
  return /安全验证|滑块|拼图|拖动/.test(t.slice(0,3000)) ? 'captcha' : 'none';
})()`).catch(() => 'unknown');

out.captcha = cap;
out.needHuman = cap === 'captcha' ? '滑块/拼图验证码：请用户自己拖（不代过）' : null;
out.ok = cap !== 'captcha';
out.finalUrl = await s.eval('location.href').catch(() => '');
console.log(JSON.stringify(out, null, 2));
s.close();
process.exit(out.ok ? 0 : 2);
