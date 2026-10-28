#!/usr/bin/env node
/**
 * cx-exam-list.mjs —— 列出某门课里的**考试**（名称 / 状态 / 剩余时间 / examId）。
 *
 * ★ 只要给 `--course <courseid>` 就能跑：班级 id 与 cpi 会**从课程列表自动取**，
 *   不用人肉抄（抄错 clazzid 会跑到别的班去）。
 *
 * 用法：node cx-exam-list.mjs --course 267202626 [--port 9223] [--json]
 */
import { connect, nav, sleep, frameCtx, evalFrame } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const opt = { port: 9223, course: '', json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--course') opt.course = argv[++i];
  else if (a === '--json') opt.json = true;
}
if (!opt.course) { console.error('用法：--course <courseid>'); process.exit(2); }

const s = await connect({ port: opt.port });

// ① 课程列表里取 clazzid / cpi
await nav(s, 'https://mooc2-ans.chaoxing.com/visit/interaction');
await sleep(1200);
const info = await s.eval(`(()=>{
  for (const c of document.querySelectorAll('div.course')) {
    const a=c.querySelector('a[href*=stucoursemiddle]');
    if(!a) continue;
    const href=a.getAttribute('href')||'';
    const q=(k)=>{const m=new RegExp(k+'=(\\\\d+)').exec(href);return m?m[1]:'';};
    if(q('courseid')===${JSON.stringify(opt.course)}) {
      const n=c.querySelector('.course-name');
      return JSON.stringify({name:n?n.innerText.trim():'',clazzid:q('clazzid'),cpi:q('cpi')});
    }
  }
  return JSON.stringify({err:'这个 courseid 不在课程列表里'});
})()`);
let ci = {}; try { ci = JSON.parse(info); } catch {}
if (ci.err) { console.error('[x] ' + ci.err); s.close(); process.exit(1); }

// ② 进课程页 → 点「考试」标签 → 读考试列表 iframe
await nav(s, `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${opt.course}&clazzid=${ci.clazzid}&cpi=${ci.cpi}&ismooc2=1&v=2`);
await sleep(2000);
const tab = await s.eval(`(()=>{
  const e=[...document.querySelectorAll('a,li,div,span')].find(x=>x.children.length===0&&(x.innerText||'').trim()==='考试');
  if(!e) return 'notab';
  e.click(); return 'ok';
})()`);
if (tab !== 'ok') { console.error('[x] 课程页里没找到「考试」标签'); s.close(); process.exit(1); }
await sleep(2500);

let raw = '';
try {
  const ctxId = await frameCtx(s, 'exam-list', 8000);
  raw = await s.eval(`(()=>{
    const items=[...document.querySelectorAll('.bottomList li')].map(li=>{
      const t=(li.innerText||'').replace(/\\s+/g,' ').trim();
      const a=li.querySelector('[onclick]');
      const oc=a?(a.getAttribute('onclick')||''):'';
      // 未做的考试是 goTest(courseId, examId, ...)；已做完的变成 viewExamAnswer(examId, examAnswerId)
      const m=/(goTest|viewExamAnswer)\\(([^)]*)\\)/.exec(oc);
      const args=m?m[2].split(',').map(x=>x.trim().replace(/^'|'$/g,'')):[];
      const examId = m && m[1]==='goTest' ? (args[1]||'') : (args[0]||'');
      return {text:t.slice(0,160), examId, endTime: args[3]||'', action: m?m[1]:'', raw:oc.slice(0,200)};
    });
    return JSON.stringify({url:location.href, n:items.length, items});
  })()`, { ctxId });
} catch (e) {
  console.error('[x] 读考试列表失败：' + e.message);
  s.close();
  process.exit(1);
}

let o = {}; try { o = JSON.parse(raw); } catch {}
const out = {
  ok: true, course: { courseid: opt.course, clazzid: ci.clazzid, cpi: ci.cpi, name: ci.name },
  count: o.n || 0, exams: o.items || [],
};
console.log(JSON.stringify(out, null, 2));
s.close();
process.exit(0);
