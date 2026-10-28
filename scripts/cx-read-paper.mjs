#!/usr/bin/env node
/**
 * cx-read-paper.mjs —— 把一整份卷子读下来，落成 `paper.json`。
 *
 * ★ 为什么要"先读全卷、再一次性算答案"：
 *   边看边答 ⇒ 要来回跳、来回算，且容易在某一题上卡住；
 *   读全卷 ⇒ 一次拿到全部题干与选项 → 统一作答 → 统一回读。
 *
 * ★ 考试有**时限**（实测 60 分钟），所以"读完再答"必须在时限内完成；
 *   实测 50 题读全卷约 3～4 分钟（每跳一题约 3 秒）。
 *
 * 用法：
 *   node cx-read-paper.mjs --type exam --url <答题页URL> --out paper.json [--port 9223]
 *   node cx-read-paper.mjs --type work --url <作业页URL>  --out paper.json
 */
import { connect, nav, sleep } from './lib/cdp.mjs';
import { jumpTo, readCurrent, frameWithSelector } from './lib/exam.mjs';
import { pageScript, stemIndex, writeJson } from './lib/pages.mjs';

const argv = process.argv.slice(2);
const opt = { port: 9223, type: 'exam', url: '', out: 'paper.json' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--type') opt.type = argv[++i];
  else if (a === '--url') opt.url = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
}
if (!opt.url) { console.error('用法：--url <页面URL> [--type exam|work] [--out paper.json]'); process.exit(2); }

const s = await connect({ port: opt.port });
await nav(s, opt.url);
await sleep(1500);

let paper;

if (opt.type === 'exam') {
  // ① 先读第 1 题，拿到总题数
  const first = await jumpTo(s, 1);
  const total = first.total || 0;
  if (!total) { console.error('[x] 题号面板没读到题数 —— 是不是不在答题页？'); s.close(); process.exit(1); }
  // ② 一题一题跳着读
  const questions = [];
  for (let i = 1; i <= total; i++) {
    const q = i === 1 ? first : await jumpTo(s, i);
    questions.push({
      i: stemIndex(q.stem) || i,
      qid: q.qid,
      stem: q.stem,
      options: q.opts,
      stored: q.stored || '',
    });
    process.stderr.write(`[读卷] ${i}/${total}\r`);
  }
  process.stderr.write('\n');
  paper = { type: 'exam', readAt: new Date().toISOString(), url: opt.url, count: questions.length, questions };
} else {
  // 作业页：所有题在**一个 iframe** 里，且题干用**反爬字体**（必须先解码）
  const f = await frameWithSelector(s, '.TiMu');
  const pool = pageScript('glyph-pool');
  const read = pageScript('work-read');
  await s.eval(pool, { ctxId: f.ctxId, timeout: 60000 }).catch(() => {});
  const raw = await s.eval(read, { ctxId: f.ctxId, timeout: 60000 });
  let o = {};
  try { o = JSON.parse(raw); } catch { o = { err: '读题结果解析失败' }; }
  if (o.err) { console.error('[x] ' + o.err); s.close(); process.exit(1); }
  paper = {
    type: 'work', readAt: new Date().toISOString(), url: opt.url, frameUrl: f.url,
    count: o.questionCount || (o.questions || []).length,
    questions: (o.questions || []).map((q) => ({
      i: q.idx, qid: q.qid, type: q.typeLabel, stem: q.stem,
      options: (q.options || []).map((x) => ({ k: x.label, v: x.text })),
      stored: '',
    })),
  };
}

writeJson(opt.out, paper);
console.log(JSON.stringify({
  ok: true, type: paper.type, count: paper.count, out: opt.out,
  answered: paper.questions.filter((q) => q.stored).length,
}, null, 2));
s.close();
process.exit(0);
