#!/usr/bin/env node
/**
 * 可移植性断言：任何脚本里的调试端口都必须走环境变量兜底
 * ================================================================
 * 为什么要有它：
 *   2026-09-25 实测本目录有 6 个 .mjs 把 `http://127.0.0.1:9222` 写死
 *   （exam-answer2 / exam-fillcache / drill / drill-unanswered / findidle / newtab）。
 *   平时跑 9222 看不出问题，**多单并行（9224）到考试环节就会连错浏览器**——
 *   而且是在「视频都刷完了」之后才炸，代价最大。
 *   ⇒ 教训不写成教训，写成断言。
 *
 * 通过条件：出现 `127.0.0.1:<port>` 的那一行，必须同时出现
 *   `process.env.CDP_BASE` 或 `process.env.CDP_PORT`（或该行带 `port-hardcode-ok` 豁免注释）。
 *
 * 用法：node check-portability.mjs        # 0=通过，1=有违规
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((f) => /\.(mjs|js)$/.test(f) && f !== 'check-portability.mjs');
const bad = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(here, f), 'utf8').split(/\r?\n/);
  lines.forEach((ln, i) => {
    if (!/127\.0\.0\.1:\d{4}/.test(ln)) return;
    if (/port-hardcode-ok/.test(ln)) return;
    if (/process\.env\.CDP_BASE|process\.env\.CDP_PORT/.test(ln)) return;
    bad.push(`${f}:${i + 1}: ${ln.trim()}`);
  });
}
if (bad.length) {
  console.log(`❌ 端口硬编码 ${bad.length} 处（多单并行时会连错浏览器）：`);
  for (const b of bad) console.log('   ' + b);
  console.log('   修法：改成 process.env.CDP_BASE || \'http://127.0.0.1:9222\'；确需硬编码则加注释 port-hardcode-ok');
  process.exit(1);
}
console.log(`✔ 可移植性检查通过（扫描 ${files.length} 个脚本，无端口硬编码）`);
