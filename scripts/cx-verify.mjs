#!/usr/bin/env node
/**
 * cx-verify.mjs —— **交卷前的独立复核**：把卷子里每一题当前真正落库的答案读出来，
 *                   逐题与"我们打算交的答案"比对，有任何一处对不上就**拒绝**。
 *
 * ★ 为什么"我刚点的"不算验收：执行者自己的日志只能当"它认为自己做了"。
 *   复核必须来自**另一条读数**。本脚本对考试走的是"逐题跳过去重新读"，
 *   对作业走的是"在作业页重新从 DOM 反读选中态"—— 两者都**不经过**作答路径。
 *
 * 用法：
 *   node cx-verify.mjs --type exam --paper paper.json --answers answers.json [--url <答题页URL>]
 *   node cx-verify.mjs --type work --paper paper.json --answers answers.json [--url <作业页URL>]
 */
import { connect, nav, sleep } from './lib/cdp.mjs';
import { jumpTo, frameWithSelector } from './lib/exam.mjs';
import { pageScript, readJson, sameAnswer, writeJson, stemIndex } from './lib/pages.mjs';

const argv = process.argv.slice(2);
const opt = { port: 9223, type: 'exam', url: '', paper: 'paper.json', answers: 'answers.json' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--type') opt.type = argv[++i];
  else if (a === '--url') opt.url = argv[++i];
  else if (a === '--paper') opt.paper = argv[++i];
  else if (a === '--answers') opt.answers = argv[++i];
}

const paper = readJson(opt.paper);
const ansFile = readJson(opt.answers);
if (!paper || !ansFile) { console.error('[x] 读不到 paper/answers'); process.exit(1); }
const ANS = ansFile.answers && typeof ansFile.answers === 'object' ? ansFile.answers : ansFile;

const s = await connect({ port: opt.port });
if (opt.url) { await nav(s, opt.url); await sleep(1200); }

const diffs = [];
let checked = 0;

if (opt.type === 'exam') {
  for (const q of paper.questions) {
    const want = ANS[q.qid] ?? ANS[String(q.i)] ?? ANS['#' + q.i];
    const cur = await jumpTo(s, q.i);
    const got = cur.stored || '';
    checked++;
    if (!sameAnswer(got, want)) diffs.push({ i: q.i, qid: q.qid, want: want || null, got: got || '(空)' });
    process.stderr.write(`[复核] ${q.i}/${paper.questions.length} ${sameAnswer(got, want) ? '✓' : '✗'}\r`);
  }
  process.stderr.write('\n');
} else {
  const f = await frameWithSelector(s, '.TiMu');
  const raw = await s.eval(pageScript('work-read-stored'), { ctxId: f.ctxId, timeout: 60000 });
  let o = {}; try { o = JSON.parse(raw); } catch { o = { err: '解析失败' }; }
  for (const q of o.questions || []) {
    const want = ANS[q.qid] ?? ANS[String(q.i)] ?? ANS['#' + q.i];
    const got = (q.sel || []).join('');
    checked++;
    if (!sameAnswer(got, want)) diffs.push({ i: q.i, qid: q.qid, want: want || null, got: got || '(空)' });
  }
}

const out = {
  ok: diffs.length === 0,
  type: opt.type, checked, diffCount: diffs.length,
  diffs,
  verdict: diffs.length === 0
    ? `全部 ${checked} 题与预期一致 ✔`
    : `有 ${diffs.length} 题不一致 ✘ —— 拒绝交卷`,
};
writeJson('verify-result.json', out);
console.log(JSON.stringify(out, null, 2));
s.close();
process.exit(diffs.length ? 1 : 0);
