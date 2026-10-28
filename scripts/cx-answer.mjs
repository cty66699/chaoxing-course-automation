#!/usr/bin/env node
/**
 * cx-answer.mjs —— **按正常节奏**把答案写进卷子，每题写完立刻回读确认。
 *
 * ★ 三条硬规矩（都来自踩过的坑）：
 *   1. **慢**：每题之间随机停顿（默认 14～26 秒）。理由有二：
 *      ① "整卷几十秒点完"本身就是一种异常信号；② 一次观测 ≠ 结论，匀速铺开也给你留出观察时间。
 *      节奏可调（--pace-min / --pace-max），但**别调成 0**。
 *   2. **每题回读**：点完不等于落上了 —— 一律回读平台自己的答案域再往下走。
 *   3. **不提交**：本脚本**只作答不交卷**。交卷是独立一步（cx-submit.mjs），
 *      且交卷前会再做一次独立复核。
 *
 * 用法：
 *   node cx-answer.mjs --paper paper.json --answers answers.json [--type exam|work]
 *                       [--url <页面URL>] [--pace-min 14] [--pace-max 26] [--dry-run]
 *
 * answers.json 两种写法都认：
 *   { "1": "A", "2": "D", ... }        （按题号）
 *   { "885610744": "A", ... }          （按 qid，更稳）
 */
import { connect, nav, sleep } from './lib/cdp.mjs';
import { jumpTo, pick, readCurrent, frameWithSelector } from './lib/exam.mjs';
import { pageScript, readJson, sameAnswer, writeJson, stemIndex } from './lib/pages.mjs';

const argv = process.argv.slice(2);
const opt = {
  port: 9223, type: 'exam', url: '', paper: 'paper.json', answers: 'answers.json',
  paceMin: 14, paceMax: 26, dry: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--type') opt.type = argv[++i];
  else if (a === '--url') opt.url = argv[++i];
  else if (a === '--paper') opt.paper = argv[++i];
  else if (a === '--answers') opt.answers = argv[++i];
  else if (a === '--pace-min') opt.paceMin = Number(argv[++i]);
  else if (a === '--pace-max') opt.paceMax = Number(argv[++i]);
  else if (a === '--dry-run') opt.dry = true;
}

const paper = readJson(opt.paper);
if (!paper) { console.error(`[x] 读不到 ${opt.paper}`); process.exit(1); }
const ansFile = readJson(opt.answers);
if (!ansFile) { console.error(`[x] 读不到 ${opt.answers}`); process.exit(1); }
const ANS = ansFile.answers && typeof ansFile.answers === 'object' ? ansFile.answers : ansFile;

const rand = (a, b) => a + Math.floor(Math.random() * Math.max(1, b - a));
const s = await connect({ port: opt.port });
if (opt.url) { await nav(s, opt.url); await sleep(1200); }

const results = [];
let failed = 0;

if (opt.type === 'exam') {
  for (const q of paper.questions) {
    const key = ANS[q.qid] ?? ANS[String(q.i)] ?? ANS['#' + q.i];
    if (!key) { results.push({ i: q.i, ok: false, why: '没有对应答案' }); failed++; continue; }
    const cur = await jumpTo(s, q.i);
    if (q.qid && cur.qid && cur.qid !== q.qid) {
      results.push({ i: q.i, ok: false, why: `跳到的题 qid=${cur.qid} 与纸面 ${q.qid} 不符` });
      failed++; continue;
    }
    if (opt.dry) { results.push({ i: q.i, ok: true, picked: key, dry: true }); continue; }
    const r = await pick(s, key);
    const ok = r && !r.err && sameAnswer(r.stored, key);
    results.push({ i: q.i, qid: q.qid, picked: key, stored: r && r.stored, ok });
    if (!ok) failed++;
    process.stderr.write(`[作答] ${q.i}/${paper.questions.length} ${ok ? '✓' : '✗'}\r`);
    if (q.i !== paper.questions.length) await sleep(rand(opt.paceMin, opt.paceMax) * 1000);
  }
  process.stderr.write('\n');
} else {
  // 作业：所有题在一个 iframe 里
  const f = await frameWithSelector(s, '.TiMu');
  const pool = pageScript('glyph-pool');
  const apply = pageScript('work-apply');
  const map = {};
  for (const q of paper.questions) {
    const key = ANS[q.qid] ?? ANS[String(q.i)] ?? ANS['#' + q.i];
    if (key) map[q.qid || String(q.i)] = key;
  }
  await s.eval(pool, { ctxId: f.ctxId, timeout: 60000 }).catch(() => {});
  if (opt.dry) {
    console.log(JSON.stringify({ ok: true, dry: true, willApply: Object.keys(map).length }, null, 2));
    s.close(); process.exit(0);
  }
  await s.eval(`window.__ANS = ${JSON.stringify(map)}; window.__DO_SUBMIT = false; window.__PACE = ${Math.round((opt.paceMin + opt.paceMax) / 2 * 1000)};`, { ctxId: f.ctxId });
  const raw = await s.eval(apply, { ctxId: f.ctxId, timeout: 300000 });
  let o = {}; try { o = JSON.parse(raw); } catch { o = { err: '解析失败' }; }
  const blanks = o.blankQuestions || [];
  results.push({ applied: (o.applied || []).length, blanks });
  if (o.err || blanks.length) failed++;
}

const summary = {
  ok: failed === 0,
  type: opt.type,
  total: opt.type === 'exam' ? paper.questions.length : (results[0]?.applied ?? 0),
  failed,
  pace: opt.dry ? null : `${opt.paceMin}~${opt.paceMax}s/题`,
  detail: results.filter((r) => r.ok === false),
};
console.log(JSON.stringify(summary, null, 2));
writeJson(opt.out || 'answer-result.json', summary);
s.close();
process.exit(failed ? 1 : 0);
