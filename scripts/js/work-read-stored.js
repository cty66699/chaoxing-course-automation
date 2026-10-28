/**
 * work-read-stored.js —— 在**作业/章节测验页**读出**全部题目与当前已选状态**（只读）。
 *
 * ★ 选中判据：`span[data]` 的 class 里有 `check_answer`（单选）/ `check_answer_dx`（多选），
 *   或父 `li` 的 `aria-checked="true"`。
 *   ⚠️ 只认 `check_answer_dx` 会**认不出单选已选中** ⇒ 于是连点两次把答案又取消掉
 *      （这正是"在字符串里嵌半角引号"之外的另一个同族坑）。
 *
 * 与 `work-read.js` 的区别：那个负责**解码题干**（反爬字体），这个只负责**读状态**。
 */
(() => {
  const isSel = (li) => {
    if (li.getAttribute('aria-checked') === 'true') return true;
    const sp = li.querySelector('span[data]');
    return !!(sp && /check_answer/.test((sp.className || '').toString()));
  };
  const out = [];
  [...document.querySelectorAll('.TiMu')].forEach((el, i) => {
    const lis = [...el.querySelectorAll('.Zy_ulTop li, ul li')].filter((li) => li.querySelector('span[data]'));
    const first = el.querySelector('li[qid]');
    const sel = lis.filter(isSel).map((li) => li.querySelector('span[data]').getAttribute('data'));
    const h = el.querySelector('.newZy_TItle');
    out.push({
      i: i + 1,
      qid: first ? first.getAttribute('qid') : null,
      typeLabel: h ? h.innerText.replace(/\s+/g, '') : '',
      sel,
      optionCount: lis.length,
    });
  });
  return JSON.stringify({ n: out.length, questions: out });
})()
