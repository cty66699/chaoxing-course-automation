/**
 * lib/pages.mjs —— 加载"注入页面的脚本"，并提供几个共用的小工具。
 *
 * 为什么把页面脚本单独放一个目录：它们要**在平台的页面上下文里**跑
 * （有的还要在跨域 iframe 里跑），和 Node 侧的调度代码是两套运行环境，
 * 混在一起就会出现"这段到底在哪跑"的错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const JS_DIR = path.resolve(HERE, '..', 'js');

export function pageScript(name) {
  const p = path.join(JS_DIR, name.endsWith('.js') ? name : name + '.js');
  if (!fs.existsSync(p)) throw new Error(`页面脚本不存在：${p}`);
  return fs.readFileSync(p, 'utf8');
}

/** 从题干里取题号（平台自己在题干开头写了 "12. (单选题, 2.0 分)"） */
export function stemIndex(stem) {
  const m = /^\s*(\d+)\s*[.、]/.exec(String(stem || ''));
  return m ? Number(m[1]) : null;
}

/** 答案比较：大小写/多选顺序无关；判断题按 true/false 归一 */
export function normAnswer(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^(true|false|T|F|对|错|正确|错误)$/i.test(s)) {
    return /^(true|T|对|正确)$/i.test(s) ? 'T' : 'F';
  }
  return s.toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
}

/** 两份答案是否等价 */
export function sameAnswer(a, b) {
  const x = normAnswer(a), y = normAnswer(b);
  if (!x && !y) return true;
  return x === y;
}

/** 读 JSON 文件（不存在返回 null） */
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 写 JSON 文件（UTF-8 无 BOM） */
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}
