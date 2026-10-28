/**
 * exam-pick.js —— 在**考试答题页**点中当前题的某一个选项，并回读落库值。
 *
 * 用法：先在页面里设 `window.__K = 'A'`，再求值本脚本。
 *
 * ★ 选中判据用 **`#answer<qid>` 的 value**（平台自己写的答案域），
 *   不用 class 名 —— 不同题型的 class 不统一（判断题给的是 true/false）。
 * ★ 点完**必须回读**：点了不等于落上了。
 */
(() => {
  const K = (window.__K || '').trim();
  if (!K) return JSON.stringify({ err: 'window.__K not set' });
  const q = document.querySelector('.questionLi');
  if (!q) return JSON.stringify({ err: 'no .questionLi' });
  const qid = (document.getElementById('questionId') || {}).value || '';

  const targets = String(K).toUpperCase().replace(/[^A-Z]/g, '').split('').filter(Boolean);
  const lis = [...q.querySelectorAll('.stem_answer > .answerBg')];
  const hit = [];
  for (const t of targets) {
    const d = lis.find((x) => {
      const s = x.querySelector('span.addChoice');
      return s && s.getAttribute('data') === t;
    });
    if (!d) return JSON.stringify({ err: 'option not found: ' + t, have: lis.map((x) => (x.querySelector('span.addChoice') || {}).getAttribute?.('data')) });
    d.click();
    hit.push(t);
  }
  const stored = (document.getElementById('answer' + qid) || {}).value || '';
  const got = String(stored).toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
  const want = targets.slice().sort().join('');
  return JSON.stringify({ qid, picked: hit.join(''), stored, ok: got === want, want });
})()
