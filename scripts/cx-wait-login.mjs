#!/usr/bin/env node
/**
 * cx-wait-login.mjs —— 等用户自己把学习通登录好。
 *
 * ★ 为什么不代替用户登录：账号密码由**用户本人**在浏览器窗口里输。
 *   （代解密浏览器密码库 / 替用户输密码都不做。）
 *
 * 判据（两个都要满足才算登录成功，避免"页面没跳但其实没登"的假绿）：
 *   ① URL 不在 passport2.chaoxing.com/login
 *   ② ★ `document.cookie` 里有 `UID=` —— **这是登录态的核心**（登录后才会下发），
 *      比在正文里找「退出/个人空间」这类文字稳得多（页面改版就失效）。
 *      辅助信号：页面里有 `#exit` 元素。
 *
 * 用法：node cx-wait-login.mjs [--port 9223] [--timeout 300] [--url <登录页>]
 */
import { connect, nav, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const opt = { port: 9223, timeout: 300, url: 'https://i.chaoxing.com/' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--timeout') opt.timeout = Number(argv[++i]);
  else if (a === '--url') opt.url = argv[++i];
}

const s = await connect({ port: opt.port });

// 先把窗口顶到前面（用户要在这个窗口里输密码）
try { await s.send('Page.bringToFront'); } catch {}

// 如果还停在登录页，把登录页打开
let st = await s.eval('location.href').catch(() => '');
if (/passport2\.chaoxing\.com\/login/.test(String(st))) {
  await nav(s, opt.url).catch(() => {});
}

const deadline = Date.now() + opt.timeout * 1000;
let last = '';
while (Date.now() < deadline) {
  const info = await s.eval(`(()=>{
    const u = location.href;
    const t = (document.body ? document.body.innerText : '') || '';
    const ck = document.cookie || '';
    return JSON.stringify({
      url: u,
      onLogin: /passport2\\.chaoxing\\.com\\/login/.test(u),
      hasUid: /(^|;\\s*)UID=/.test(ck),
      hasExit: !!document.getElementById('exit'),
      title: document.title,
      name: (t.match(/[\\u4e00-\\u9fa5]{2,6}(?=\\s)/) || [''])[0] || '',
    });
  })()`).catch((e) => JSON.stringify({ err: String(e.message) }));
  let o = {};
  try { o = JSON.parse(info); } catch {}
  if (o.err) { await sleep(1500); continue; }
  const logged = !o.onLogin && /chaoxing\.com/.test(String(o.url)) && o.hasUid;
  if (logged) {
    console.log(JSON.stringify({ ok: true, url: o.url, title: o.title, uid: (o.hasUid ? '有' : '无') }, null, 2));
    s.close();
    process.exit(0);
  }
  if (o.url !== last) { last = o.url; process.stderr.write(`[等登录] ${o.url}\n`); }
  await sleep(1500);
}
console.error(`[x] ${opt.timeout} 秒内没等到登录完成（当前 ${last}）`);
s.close();
process.exit(1);
