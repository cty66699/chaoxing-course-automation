/**
 * exam-read-current.js —— 在**考试答题页**（顶层）读出"当前这一题"。
 *
 * 判据（全部来自平台自己的 DOM）：
 *   · 题干      `.questionLi h3.mark_name`
 *   · 选项      `.questionLi .stem_answer > .answerBg`，字母取内部 `span.addChoice[data]`
 *   · 已选答案  `#answer<qid>` 的 value —— ★ **这是唯一可靠的"答了没有"判据**
 *   · 剩余时间  `#remainTime`
 *
 * ⚠️ `#isAnswered` 不可靠：点完答案它仍然是 "false"（要等整页提交才变）。
 *
 * 返回 JSON 字符串（外层脚本统一用 JSON.stringify 的结果）。
 */
(() => {
  const q = document.querySelector('.questionLi');
  if (!q) return JSON.stringify({ err: 'no .questionLi（页面还没渲染出题目）' });
  const h3 = q.querySelector('h3.mark_name');
  const qid = (document.getElementById('questionId') || {}).value || '';
  const opts = [...q.querySelectorAll('.stem_answer > .answerBg')].map((d) => {
    const s = d.querySelector('span.addChoice');
    const p = d.querySelector('.answer_p');
    const txt = (d.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      k: s ? s.getAttribute('data') : (txt[0] || ''),
      v: p ? p.innerText.trim() : txt.replace(/^[A-Z]\s*/, ''),
    };
  });
  const stored = qid ? ((document.getElementById('answer' + qid) || {}).value || '') : '';
  const nums = [...document.querySelectorAll('.topicNumber *')]
    .filter((e) => e.children.length === 0 && /^\d+$/.test((e.innerText || '').trim()));
  return JSON.stringify({
    qid,
    stem: h3 ? h3.innerText.replace(/\s+/g, ' ').trim() : '',
    opts,
    stored,
    remain: (document.getElementById('remainTime') || {}).value || '',
    total: nums.length,
    url: location.href.slice(0, 160),
  });
})()
