#!/usr/bin/env node
/**
 * cx-courses.mjs —— 列出这个账号上的**全部课程**。
 *
 * ★ 为什么要两条独立读数：接单第一件事是"这个账号到底有几门课"，
 *   而"记忆里的课程表"会过期（实测：2026-09-28 是 8 门，2026-10-20 变成 9 门，
 *   多了一门「2026全国大学生AI答题实践竞赛」）。
 *   ⇒ 本脚本用两条通道各读一遍并**互相对账**：
 *     ① DOM：课程列表页的 `div.course` 卡片
 *     ② API：同源 POST `/mooc2-ans/visit/courselistdata`（返回的是 HTML 片段）
 *   **两条不一致就报错**（而不是挑一个信）。
 *
 * 用法：node cx-courses.mjs [--port 9223] [--out courses.json]
 */
import { connect, nav, sleep } from './lib/cdp.mjs';
import { writeJson } from './lib/pages.mjs';

const argv = process.argv.slice(2);
const opt = { port: 9223, out: '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--out') opt.out = argv[++i];
}

const s = await connect({ port: opt.port });

// 课程列表页（不需要 s= 参数，实测 2026-10-20 有效）
await nav(s, 'https://mooc2-ans.chaoxing.com/visit/interaction');
await sleep(1200);

const probe = await s.eval(`(async () => {
  const body = 'courseType=1&courseFolderId=0&baseEducation=0&superstarClass=0&courseFolderSize=0';
  let api = { ok: false };
  try {
    const r = await fetch('/mooc2-ans/visit/courselistdata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const t = await r.text();
    api = { ok: r.ok, status: r.status, len: t.length, html: t };
  } catch (e) { api = { ok: false, err: String(e) }; }

  const cards = [...document.querySelectorAll('div.course')].map((c) => {
    const a = c.querySelector('a[href*=stucoursemiddle]');
    const n = c.querySelector('.course-name');
    const href = a ? (a.getAttribute('href') || '') : '';
    const q = (k) => { const m = new RegExp(k + '=(\\\\d+)').exec(href); return m ? m[1] : ''; };
    return { name: n ? n.innerText.trim() : '', courseid: q('courseid'), clazzid: q('clazzid'), cpi: q('cpi') };
  });
  return JSON.stringify({ api, cards });
})()`);

let o = {};
try { o = JSON.parse(probe); } catch { o = { err: '解析失败: ' + String(probe).slice(0, 200) }; }
if (o.err) { console.error('[x] ' + o.err); s.close(); process.exit(1); }

// ② API 里的课程 id
const apiIds = new Set();
if (o.api && o.api.html) {
  const re = /courseid=(\d+)[&;]clazzid=(\d+)/g;
  let m;
  while ((m = re.exec(o.api.html))) apiIds.add(m[1] + ':' + m[2]);
}

const domIds = new Set((o.cards || []).map((c) => `${c.courseid}:${c.clazzid}`));

// 对账：只报差异，不猜
const onlyDom = [...domIds].filter((x) => !apiIds.has(x));
const onlyApi = [...apiIds].filter((x) => !domIds.has(x));
const mismatch = onlyDom.length || onlyApi.length;

const result = {
  ok: !mismatch,
  readAt: new Date().toISOString(),
  count: (o.cards || []).length,
  courses: o.cards || [],
  cross: { domCount: domIds.size, apiCount: apiIds.size, onlyDom, onlyApi, mismatch },
};
if (opt.out) { writeJson(opt.out, result); result.saved = opt.out; }
console.log(JSON.stringify(result, null, 2));
s.close();
process.exit(mismatch ? 1 : 0);
