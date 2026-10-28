(async () => {
  const doc = document;
  const ANS = window.__ANS || null;
  if (!ANS) return JSON.stringify({ err: 'window.__ANS not set' });
  const DO_SUBMIT = window.__DO_SUBMIT !== false;
  // ★ 每题之间的停顿（毫秒）。设 0 就是"连续点完"。
  //   为什么要节奏：一份作业几十道题在几秒内全部点完，本身就是一种异常信号；
  //   均匀铺开也更接近真人。
  const PACE = Number(window.__PACE || 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { applied: [], missing: [], detail: [] };

  // 选中判据必须用 aria-checked：单选题选中时给 span 加的是 check_answer，
  // 多选题加的是 check_answer_dx —— 只认后者会认不出单选已选中，于是连点两次把答案取消掉。
  const isSel = (li) => {
    if (li.getAttribute('aria-checked') === 'true') return true;
    const sp = li.querySelector('span[data]');
    return !!(sp && /check_answer/.test((sp.className || '').toString()));
  };

  const qs = Array.from(doc.querySelectorAll('.TiMu'));
  for (let i = 0; i < qs.length; i++) {
    const el = qs[i];
    const firstLi = el.querySelector('li[qid]');
    const qid = firstLi ? firstLi.getAttribute('qid') : null;
    const key = (qid && ANS[qid]) || ANS[String(i + 1)] || ANS['#' + (i + 1)];
    if (!key) { out.missing.push(qid || '#' + (i + 1)); continue; }
    // 判断题的选项标签是 true / false，不是字母 —— 直接按字面匹配，别走拆字母那条路
    const rawKey = String(key).trim();
    let wants;
    if (/^(true|false)$/i.test(rawKey)) wants = new Set([rawKey.toLowerCase()]);
    else if (rawKey === '对' || rawKey === '正确' || rawKey === 'T') wants = new Set(['true']);
    else if (rawKey === '错' || rawKey === '错误' || rawKey === 'F') wants = new Set(['false']);
    else wants = new Set(rawKey.toUpperCase().replace(/[^A-Z]/g, '').split(''));
    const lis = Array.from(el.querySelectorAll('.Zy_ulTop li, ul li')).filter((li) => li.querySelector('span[data]'));
    const state = [];
    for (const li of lis) {
      const label = li.querySelector('span[data]').getAttribute('data');
      const need = wants.has(label);
      let guard = 0;
      while (isSel(li) !== need && guard++ < 2) { li.click(); await sleep(120); }
      state.push(`${label}${isSel(li) ? '+' : '-'}`);
    }
    out.applied.push(qid || '#' + (i + 1));
    out.detail.push(`Q${i + 1} want=${[...wants].join('')} now=${state.join(' ')}`);
    if (PACE > 0) await sleep(PACE);
  }

  // 核对：从 DOM 反读最终选择
  const finalState = [];
  qs.forEach((el, i) => {
    const sel = Array.from(el.querySelectorAll('.Zy_ulTop li, ul li'))
      .filter((li) => isSel(li))
      .map((li) => li.querySelector('span[data]').getAttribute('data'));
    finalState.push(`Q${i + 1}:${sel.join('') || '(空)'}`);
  });
  out.finalState = finalState;

  // ★ 提交前闸门 ★
  // 学习通章节测验提交后无法重做，答错不可逆。所以只要有任何一题没选中，一律拒绝提交。
  // （本次就是因为单选/判断没选中却照样提交，23 个作业平均只拿到 20~26 分）
  const blank = [];
  finalState.forEach((s, i) => { if (/\(空\)$/.test(s)) blank.push(i + 1); });
  out.blankQuestions = blank;
  if (blank.length) {
    out.aborted = true;
    out.reason = `有 ${blank.length} 题没选中（第 ${blank.join(',')} 题），已拒绝提交`;
    return JSON.stringify(out, null, 1);
  }

  if (DO_SUBMIT) {
    if (typeof window.btnBlueSubmit === 'function') { window.btnBlueSubmit(); out.submitCalled = true; }
    else return JSON.stringify({ ...out, err: 'btnBlueSubmit not found' }, null, 1);
    await sleep(2500);
    // 可能弹确认框
    const btns = Array.from(doc.querySelectorAll('a,button,div')).filter((e) => /^(确定|确认|继续|是)$/.test((e.innerText || '').trim()) && e.offsetHeight > 0);
    out.confirmCandidates = btns.map((e) => e.innerText.trim()).slice(0, 5);
    // 优先点弹窗里的确定
    for (const b of btns) {
      const inDialog = b.closest('.layui-layer, .popup, .dialog, [class*="mask"], [class*="pop"]');
      if (inDialog) { b.click(); out.confirmClicked = b.innerText.trim(); break; }
    }
    await sleep(4000);
  }
  out.url = location.href.slice(0, 130);
  out.bodySample = (doc.body ? doc.body.innerText : '').replace(/\s+/g, ' ').slice(0, 400);
  return JSON.stringify(out, null, 1);
})()
