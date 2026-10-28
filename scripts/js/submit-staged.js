(async () => {
  const doc = document;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  const ANS = window.__ANS || {};
  // 单选(check_answer) 与 多选(check_answer_dx) 的类名不同 —— 统一用 aria-checked 判断，
  // 否则会认不出单选已选中而连点两次，把答案取消掉。
  const isSel = (li) => {
    if (li.getAttribute('aria-checked') === 'true') return true;
    const sp = li.querySelector('span[data]');
    return !!(sp && /check_answer/.test((sp.className || '').toString()));
  };
  const $ = window.jQuery || window.$;

  const snapshot = (tag) => {
    const enc = (doc.querySelector('#enc') || {}).value;
    const aq = (doc.querySelector('#answerwqbid') || {}).value;
    const url = location.href.slice(0, 100);
    out.steps.push(`${tag}: enc="${String(enc).slice(0, 20)}" answerwqbid="${String(aq).slice(0, 40)}" url=${url.includes('selectWorkQuestion') ? 'RESULT' : 'question'}`);
  };

  // 1) 作答
  const qs = Array.from(doc.querySelectorAll('.TiMu'));
  const state = [];
  for (let i = 0; i < qs.length; i++) {
    const el = qs[i];
    const li0 = el.querySelector('li[qid]');
    const qid = li0 ? li0.getAttribute('qid') : null;
    const key = (qid && ANS[qid]) || ANS[String(i + 1)];
    if (!key) { state.push(`Q${i + 1}:NOKEY`); continue; }
    const raw = String(key).trim();
    let wants;
    if (/^(true|false)$/i.test(raw)) wants = new Set([raw.toLowerCase()]);
    else wants = new Set(raw.toUpperCase().replace(/[^A-Z]/g, '').split(''));
    const lis = Array.from(el.querySelectorAll('.Zy_ulTop li, ul li')).filter((li) => li.querySelector('span[data]'));
    for (const li of lis) {
      const label = li.querySelector('span[data]').getAttribute('data');
      let g = 0;
      while (isSel(li) !== wants.has(label) && g++ < 2) { li.click(); await sleep(100); }
    }
    state.push(`Q${i + 1}:` + lis.filter(isSel).map((li) => li.querySelector('span[data]').getAttribute('data')).join(''));
  }
  out.applied = state;
  snapshot('作答后');

  // ★ 提交前闸门 ★ 章节测验提交后不可重做，有题没选中就绝不提交
  const blank = state.map((s, i) => (/:(空)?$/.test(s) ? i + 1 : null)).filter(Boolean);
  out.blankQuestions = blank;
  if (blank.length) {
    out.aborted = true;
    out.reason = `有 ${blank.length} 题没选中（第 ${blank.join(',')} 题），已拒绝提交`;
    return JSON.stringify(out, null, 1);
  }

  // 2) btnBlueSubmit（跑 /work/validate）
  if (typeof window.btnBlueSubmit === 'function') window.btnBlueSubmit();
  await sleep(4000);
  snapshot('btnBlueSubmit 后');

  // 3) submitCheckTimes（它内部才会 form1submit → confirmSubmitWork）
  if (typeof window.submitCheckTimes === 'function') { window.submitCheckTimes(); out.via = 'submitCheckTimes'; }
  await sleep(6000);
  snapshot('submitCheckTimes 后');

  // 4) 还没走就再直接 confirmSubmitWork
  if (!/selectWorkQuestion/.test(location.href)) {
    if (typeof window.confirmSubmitWork === 'function') { window.confirmSubmitWork(); out.fallback = 'confirmSubmitWork'; }
    await sleep(6000);
    snapshot('confirmSubmitWork 后');
  }

  out.finalUrl = location.href.slice(0, 130);
  out.bodyTail = (doc.body.innerText || '').replace(/\s+/g, ' ').slice(-300);
  return JSON.stringify(out, null, 1);
})()
