#!/usr/bin/env node
/**
 * cx-submit.mjs —— **交卷**（不可逆动作，带闸门）。
 *
 * ★ 闸门（两条，任一不过就 abort，绝不交）：
 *   ① **独立复核**：从**服务端渲染的整卷预览页**再读一遍全部已存答案，
 *      与"我们打算交的答案"逐题比对 —— 这条读数**不经过**作答路径。
 *   ② **没有空题**：任何一题没有落上答案 ⇒ 拒绝提交。
 *      （依据：学习通章节测验提交后**不可重做**；实测曾因漏认单选/判断的选中态，
 *        提交了 23 份作业、平均只拿 20~26 分，唯一的补救是求老师重置。）
 *
 * 用法：
 *   node cx-submit.mjs --type exam --answers answers.json [--url <答题页URL>] [--yes]
 *   node cx-submit.mjs --type work --answers answers.json [--url <作业页URL>] [--yes]
 *
 * ★ `--yes` 是**显式确认**：不带它就只做复核、把结果打出来，**不交**。
 *   （"不可逆动作"本来就该多一道人工确认；但流程内已跑过 cx-verify 时可以带。）
 */
import { connect, nav, sleep } from './lib/cdp.mjs';
import { readAllPreview, frameWithSelector } from './lib/exam.mjs';
import { pageScript, readJson, sameAnswer, writeJson } from './lib/pages.mjs';

const argv = process.argv.slice(2);
const opt = { port: 9223, type: 'exam', url: '', answers: 'answers.json', yes: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--type') opt.type = argv[++i];
  else if (a === '--url') opt.url = argv[++i];
  else if (a === '--answers') opt.answers = argv[++i];
  else if (a === '--yes') opt.yes = true;
}
const ansFile = readJson(opt.answers);
if (!ansFile) { console.error('[x] 读不到 answers'); process.exit(1); }
const ANS = ansFile.answers && typeof ansFile.answers === 'object' ? ansFile.answers : ansFile;

const s = await connect({ port: opt.port });
if (opt.url) { await nav(s, opt.url); await sleep(1500); }

const out = { ok: false, type: opt.type, submitted: false };

if (opt.type === 'exam') {
  // ① 去整卷预览页（服务端渲染 ⇒ 一条独立读数）
  const jumped = await s.eval(`(()=>{ if (typeof topreview === 'function') { topreview(); return 'ok'; } const b=[...document.querySelectorAll('a')].find(e=>/整卷预览/.test(e.innerText||'')); if(b){b.click(); return 'click';} return 'nobtn'; })()`).catch((e) => 'ERR:' + e.message);
  out.previewJump = jumped;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const u = await s.eval('location.href').catch(() => '');
    if (/\/exam\/preview/.test(String(u))) break;
    await sleep(700);
  }
  const all = await readAllPreview(s);
  const diffs = [];
  const byQid = {};
  for (const q of all.questions) byQid[q.qid] = q.stored || '';
  for (const q of all.questions) {
    const want = ANS[q.qid] ?? ANS[String(q.i)] ?? ANS['#' + (q.i)];
    const got = q.stored || '';
    if (!sameAnswer(got, want)) diffs.push({ qid: q.qid, want: want || null, got: got || '(空)' });
  }
  out.checked = all.questions.length;
  out.diffs = diffs;
  if (diffs.length) { out.verdict = `复核不通过（${diffs.length} 处不一致）—— 已拒绝交卷`; console.log(JSON.stringify(out, null, 2)); s.close(); process.exit(1); }

  if (!opt.yes) {
    out.verdict = `复核通过（${all.questions.length} 题一致）。加 --yes 才真的交卷。`;
    console.log(JSON.stringify(out, null, 2)); s.close(); process.exit(0);
  }

  // ② 点「交卷」→ 弹窗点「确定」
  const clicked = await s.eval(`(()=>{
    const b=[...document.querySelectorAll('a,button,div')].find(e=>e.children.length===0&&(e.innerText||'').trim()==='交卷');
    if(!b) return 'nobtn';
    b.click(); return 'ok';
  })()`).catch((e) => 'ERR:' + e.message);
  out.submitClicked = clicked;
  await sleep(2500);

  // 确认弹窗
  const confirmed = await s.eval(`(()=>{
    const cands=[...document.querySelectorAll('a,button,div')].filter(e=>e.children.length===0&&/^(确定|确认提交|继续提交|是)$/.test((e.innerText||'').trim())&&e.offsetHeight>0);
    if(!cands.length) return 'nocandidates';
    const inDlg=cands.find(e=>e.closest('#submitConfirmPop,.maskDiv,[class*=mask],[class*=pop]'))||cands[0];
    inDlg.click(); return (inDlg.innerText||'').trim();
  })()`).catch((e) => 'ERR:' + e.message);
  out.confirm = confirmed;
  await sleep(5000);

  const u = await s.eval('location.href').catch(() => '');
  const body = await s.eval(`(document.body?document.body.innerText:'').replace(/\s+/g,' ').slice(0,300)`).catch(() => '');
  out.finalUrl = u;
  out.finalText = body;
  out.submitted = /\/exam\/test\/look/.test(String(u)) || /交卷成功/.test(String(body));
  out.verdict = out.submitted ? '交卷成功' : `交卷未确认（URL=${u}）—— 请人工检查`;
  console.log(JSON.stringify(out, null, 2));
  writeJson('submit-result.json', out);
  s.close();
  process.exit(out.submitted ? 0 : 1);
} else {
  // 作业：work-apply.js 自带"有题没选中就拒绝提交"的闸门
  const f = await frameWithSelector(s, '.TiMu');
  const map = {};
  const raw = await s.eval(pageScript('work-read-stored'), { ctxId: f.ctxId, timeout: 60000 });
  let o = {}; try { o = JSON.parse(raw); } catch {}
  for (const q of o.questions || []) {
    const want = ANS[q.qid] ?? ANS[String(q.i)] ?? ANS['#' + q.i];
    if (want) map[q.qid || String(q.i)] = want;
  }
  await s.eval(pageScript('glyph-pool'), { ctxId: f.ctxId, timeout: 60000 }).catch(() => {});
  await s.eval(`window.__ANS=${JSON.stringify(map)}; window.__DO_SUBMIT=${opt.yes ? 'true' : 'false'};`, { ctxId: f.ctxId });
  const res = await s.eval(pageScript('work-apply'), { ctxId: f.ctxId, timeout: 300000 });
  let r = {}; try { r = JSON.parse(res); } catch { r = { err: '解析失败' }; }
  out.blank = r.blankQuestions || [];
  out.applied = (r.applied || []).length;
  out.submitCalled = !!r.submitCalled;
  out.aborted = !!r.aborted;
  out.verdict = r.aborted ? `有 ${(r.blankQuestions || []).length} 题没选中 —— 已拒绝提交` : (opt.yes ? '已提交' : '已填好（未提交，加 --yes 才交）');
  console.log(JSON.stringify(out, null, 2));
  writeJson('submit-result.json', out);
  s.close();
  process.exit(r.aborted ? 1 : 0);
}
