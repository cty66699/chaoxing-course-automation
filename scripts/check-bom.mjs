#!/usr/bin/env node
/**
 * check-bom.mjs —— 断言所有 `.ps1` 都带 UTF-8 BOM（`.bat` 必须是 GBK）
 * ================================================================
 * 为什么是「断言」而不是又一条 lesson（工作区治理规则第 10 条「记忆毕业制」）：
 *   这个坑 **已经犯过第二次**——`edit` 工具会吃掉 `.ps1` 的 UTF-8 BOM，而本机 shell 是
 *   PowerShell 5.1（读无 BOM 的 UTF-8 会按 GBK 解）⇒ 中文全乱、**语法直接报错**、
 *   脚本起不来。2026-09-25 我又在 `lab-loop.ps1` 上踩了一次，代价是外壳静默退出、白等两分钟。
 *   ⇒ 同一个错第 2 次出现时，只允许二选一：**建断言** 或 **写"为什么建不了断言"的豁免**。
 *     这里选建断言：**改完 .ps1 立刻跑它**，绿了就说明 BOM 还在。
 *
 * 判据：
 *   · `*.ps1` 前 3 字节必须是 `EF BB BF`。
 *   · `*.bat` / `*.cmd` 不允许有 BOM（cmd.exe 在 chcp 936 下会把 BOM 当命令）；
 *     且非 ASCII 字节应按 GBK 可解（无法自动判定"应该是 GBK 还是 UTF-8"时只告警，不改文件）。
 *
 * 用法：node check-bom.mjs [目录...]     默认扫技能脚本目录
 * 退出码：0 = 全部通过；1 = 有违规
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRS = [fileURLToPath(new URL('.', import.meta.url))];
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_DIRS;

const files = [];
const walk = (d) => {
  let entries;
  try { entries = readdirSync(d); } catch { return; }
  for (const e of entries) {
    const p = join(d, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p);
    else if (/\.(ps1|bat|cmd)$/i.test(e)) files.push(p);
  }
};
dirs.forEach(walk);

const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
let bad = 0;
for (const f of files) {
  const buf = readFileSync(f);
  const ext = extname(f).toLowerCase();
  const nonAscii = buf.filter((b) => b > 0x7f).length;
  if (ext === '.ps1') {
    if (!hasBom(buf)) {
      console.log(`[FAIL] 缺 UTF-8 BOM：${f}（非 ASCII 字节 ${nonAscii}；PS 5.1 会按 GBK 解 ⇒ 中文乱码/语法错）`);
      bad++;
    } else {
      console.log(`[ ok ] ${f}（BOM 在，非 ASCII ${nonAscii}）`);
    }
  } else {
    if (hasBom(buf)) {
      console.log(`[FAIL] .bat/.cmd 不应带 BOM：${f}`);
      bad++;
    } else {
      console.log(`[ ok ] ${f}（无 BOM，非 ASCII ${nonAscii}）`);
    }
  }
}

console.log(`—— 扫描 ${files.length} 个文件（${dirs.join(' | ')}），违规 ${bad} 个`);
if (files.length === 0) { console.log('[WARN] 一个文件都没扫到，检查目录参数'); }
process.exit(bad === 0 ? 0 : 1);
