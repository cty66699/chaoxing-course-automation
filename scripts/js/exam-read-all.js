/**
 * exam-read-all.js —— 在**整卷预览页**一次性读出**全部**题目与已存答案。
 *
 * ★ 为什么要有它：预览页是**服务端渲染**的，它同时带着
 *   ① 全部题干与选项 ② 全部 `answer<qid>` 已存值。
 *   ⇒ **一次读取 = 一条独立于"我刚点的"之外的读数**，
 *     用它做交卷前复核，才能排除"我以为点上了"。
 *
 * 注意：预览页的选项里**没有** `span.addChoice`（结构与答题页不同），
 *      所以字母从选项文字的首字符取。
 */
(() => {
  const out = [];
  const blocks = [...document.querySelectorAll('.questionLi')];
  for (const el of blocks) {
    const qid = el.getAttribute('data') || '';
    const h3 = el.querySelector('h3.mark_name');
    const stored = qid ? ((document.getElementById('answer' + qid) || {}).value || '') : '';
    const opts = [...el.querySelectorAll('.stem_answer > .answerBg')].map((d) => {
      const p = d.querySelector('.answer_p');
      const txt = (d.innerText || '').replace(/\s+/g, ' ').trim();
      return { k: (txt[0] || ''), v: p ? p.innerText.trim() : txt.replace(/^[A-Z]\s*/, '') };
    });
    out.push({
      qid,
      stem: h3 ? h3.innerText.replace(/\s+/g, ' ').trim() : '',
      stored,
      opts,
    });
  }
  // 另按 hidden input 再收一遍答案（两个来源互相对账）
  const byInput = {};
  for (const i of document.querySelectorAll('input[name^=answer]')) {
    const m = i.name.match(/^answer(\d+)$/);
    if (m) byInput[m[1]] = i.value || '';
  }
  return JSON.stringify({ n: out.length, byInputCount: Object.keys(byInput).length, questions: out });
})()
