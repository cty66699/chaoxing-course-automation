#!/usr/bin/env node
/**
 * cx-eval.mjs —— 在页面（顶层或指定 iframe）里求值一段 JS，打印结果。
 *
 * 为什么需要：现成脚本各自只答一类问题；当遇到"没人做过、但平台上查得到"的问题时，
 * **正确的动作是临时求值，而不是去改现成脚本**。
 *
 * 用法：
 *   node cx-eval.mjs --file probe.js              # 文件内容作为表达式（支持 await）
 *   node cx-eval.mjs --code "document.title"
 *   node cx-eval.mjs --frame exam-list --code "document.body.innerText"
 *   node cx-eval.mjs --list                       # 列出所有帧
 *
 * ★ 页面脚本请统一 return JSON.stringify(...) —— 这里会把它解回对象再打印。
 */
import fs from 'node:fs';
import { connect, evalTop, evalFrame, frameCtx } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const opt = { port: 9223, file: '', code: '', frame: '', list: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--file') opt.file = argv[++i];
  else if (a === '--code') opt.code = argv[++i];
  else if (a === '--frame') opt.frame = argv[++i];
  else if (a === '--list') opt.list = true;
}
if (!opt.list && !opt.file && !opt.code) {
  console.error('用法：node cx-eval.mjs --file <js> | --code "<js>" | --list  [--frame <url片段>] [--port N]');
  process.exit(2);
}
const expr = opt.file ? fs.readFileSync(opt.file, 'utf8') : opt.code;

const s = await connect({ port: opt.port });

if (opt.list) {
  const tree = await s.send('Page.getFrameTree');
  const flat = [];
  (function walk(n) { flat.push(n.frame); (n.childFrames || []).forEach(walk); })(tree.frameTree);
  console.log(JSON.stringify(flat.map((f) => ({ id: f.id, url: f.url })), null, 2));
  s.close();
  process.exit(0);
}

try {
  const v = opt.frame
    ? await evalFrame(s, opt.frame, expr)
    : await evalTop(s, expr);
  if (typeof v === 'string') {
    try { console.log(JSON.stringify(JSON.parse(v), null, 2)); } catch { console.log(v); }
  } else {
    console.log(JSON.stringify(v, null, 2));
  }
  s.close();
  process.exit(0);
} catch (e) {
  console.error('ERR:' + e.message);
  s.close();
  process.exit(1);
}
