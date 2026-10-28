#!/usr/bin/env node
/**
 * cx-docs.mjs —— 文档任务点（insertdoc）驱动。
 *
 * ★ 合规边界（写死在这里，别以后忘）：**不允许**直接 GET `/mooc-ans/job/document` 把任务点标完成 ——
 *   那正是「跳过内容却标记已完成」。本脚本走的是**驱动 UI**：切到该节 → 点开附件 →
 *   由平台自己的 `documentJob.js` 上报（与视频"真播"同一条路）。
 *   第一阶段的"抓参数"只用来**核对**平台是否真的上报了（对账用），不用来伪造调用。
 *
 * 机制来源（2026-09-29 从平台自己的 JS 里读出来的，不是猜的）：
 *   · 文档模块 iframe = `/ananas/modules/zt/<pdf|doc|ppt|xls>/index.html`（卡片里只有 70px 高的预览条）
 *   · 完成上报 = `documentJob.js` 的 `finishJob()` → `POST/GET /mooc-ans/job/document?jobid=…&jtoken=…`
 *   · **`isZtChapterAttach` 为真（章节附件就是这种）时不会自动上报** ⇒ 必须"点开附件"触发
 *
 * 用法：
 *   node cx-docs.mjs --course 267202626 --clazz 155007944 --tag xls          # ① 只盘点（纯 HTTP，不碰浏览器）
 *   node cx-docs.mjs --course ... --clazz ... --tag xls --apply              # ② 驱动 UI（需要浏览器空闲）
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const COURSE = opt('--course');
const CLAZZ = opt('--clazz');
const TAG = opt('--tag', COURSE);
const CPI = opt('--cpi', '');
const APPLY = argv.includes('--apply');
const OUT = opt('--out', `docs-${TAG}.json`);
if (!COURSE || !CLAZZ || !CPI) { console.error('用法：node cx-docs.mjs --course <id> --clazz <id> --cpi <id> --tag <t> [--apply]'); process.exit(2); }

const jar = new Map();
for (const p of fs.readFileSync('cookies.txt', 'utf8').trim().split(';')) {
  const i = p.indexOf('=');
  if (i >= 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
}
const COOKIE = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const get = async (url, referer = 'https://mooc1.chaoxing.com/') =>
  (await fetch(url, { headers: { Cookie: COOKIE, 'User-Agent': UA, Referer: referer } })).text();

/* ---------- ① 盘点：待完成节 + 每节的任务点类型与上报参数 ---------- */
const scUrl = `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${COURSE}&clazzid=${CLAZZ}&cpi=${CPI}&ut=s&t=${Date.now()}&stuenc=`;
const sc = await get(scUrl, 'https://mooc2-ans.chaoxing.com/');
const pend = [];
for (const chunk of sc.split('class="chapter_item"').slice(1)) {
  const b = chunk.slice(0, 2000);
  const idm = /id="cur(\d+)"/.exec(b);
  if (!idm) continue;
  const yi = /class="catalog_points_yi"[^>]*>(\d+)</.exec(b);
  if (!(yi && Number(yi[1]) > 0)) continue;
  const sb = /class="catalog_sbar">([^<]*)<\/span>\s*([^<]*)/.exec(b);
  pend.push({ kid: idm[1], code: sb ? sb[1].trim() : '', name: sb ? sb[2].replace(/\s+/g, ' ').trim() : '', pending: Number(yi[1]) });
}
console.log(`待完成节 ${pend.length} 个`);

const parseAtts = (html) => {
  const m = /mArg\s*=\s*(\{[\s\S]*?\})\s*;\s*uParse/.exec(html) || /mArg\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(html);
  if (!m) return [];
  try { return JSON.parse(m[1]).attachments || []; } catch { return []; }
};

const docs = [];
const others = [];
for (const s of pend) {
  let atts = [];
  for (const num of [0, 1, 2, 3]) {
    const t = await get(`https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=${CLAZZ}&courseid=${COURSE}&knowledgeid=${s.kid}&num=${num}&ut=s&cpi=${CPI}&v=2`);
    const a = parseAtts(t);
    if (a.some((x) => x.job === true)) { atts = a; break; }
    atts = a;
  }
  for (const a of atts) {
    if (a.job !== true) continue;
    const p = a.property || {};
    const mod = p.module || a.type || '?';
    if (mod === 'insertdoc') {
      docs.push({
        kid: s.kid, code: s.code, name: s.name, file: p.name, ext: p.type, size: p.size, page: p.pagenum,
        jobid: a.jobid, jtoken: a.jtoken, mid: a.mid, objectid: p.objectid, enc: a.enc, aid: a.aid,
        microTopicId: a.microTopicId || '',
      });
    } else {
      others.push({ kid: s.kid, code: s.code, name: s.name, module: mod, dur: a.attDuration != null ? a.attDuration : null });
    }
  }
  process.stdout.write(`\r  扫 ${docs.length + others.length}/${pend.length} …`);
  await new Promise((r) => setTimeout(r, 250));
}
console.log('');

console.log(`\n=== 文档任务点（insertdoc）${docs.length} 个 ===`);
docs.slice(0, 40).forEach((d) => console.log(`  ${String(d.code).padEnd(7)} ${String(d.name).slice(0, 20).padEnd(22)} ${String(d.file).slice(0, 22).padEnd(24)} ${d.ext || ''} jobid=${d.jobid}`));
if (others.length) {
  console.log(`\n=== 非文档任务点 ${others.length} 个 ===`);
  others.slice(0, 20).forEach((o) => console.log(`  ${String(o.code).padEnd(7)} ${String(o.name).slice(0, 22).padEnd(24)} module=${o.module} dur=${o.dur}`));
}

fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), course: COURSE, clazz: CLAZZ, cpi: CPI, docs, others }, null, 1), 'utf8');
console.log(`\n明细已写 ${OUT}`);

if (APPLY) {
  console.log('\n--apply：驱动 UI 的那一半还没实现（要先在浏览器空闲时把"点开附件"这一步实测出来）。');
  console.log('  ★ 明确不做的事：直接 GET /mooc-ans/job/document 把任务点标完成 —— 那是伪造学习记录。');
}
process.exit(0);
