#!/usr/bin/env node
/**
 * cx-start.mjs —— 起一个**专用** Chrome 供学习通刷课用，并打开登录页。
 *
 * 设计要点（每条都是踩出来的）：
 *  ① **独立 profile + 独立端口**：一人一 profile，互不干扰（cookie 会被互相覆盖）。
 *  ② **profile 不放在 skill 目录里** —— 它含登录态，skill 要能分发给别人。
 *  ③ **--no-proxy-server**：本机系统代理常开（Clash 等），而它开着时学习通子资源
 *     会加载失败（iframe 变 chrome-error://）。**给 Chrome 单独绕开代理**，
 *     而不是去改用户的系统代理设置。
 *  ④ **窗口恢复 normal**：窗口最小化时浏览器会**暂停视频**（无人值守就静默卡死）。
 *
 * 用法：
 *   node cx-start.mjs [--port 9223] [--profile <目录>] [--url <登录页>] [--browser auto|chrome|edge]
 *   node cx-start.mjs --status          # 只看状态不起
 *   node cx-start.mjs --stop            # 停掉这个 profile 的实例
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = {
  port: 9223,
  profile: process.env.CX_PROFILE || path.join(process.cwd(), 'cx-profile'),
  url: 'https://i.chaoxing.com/',
  browser: 'auto',
  status: false,
  stop: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--profile') opt.profile = path.resolve(argv[++i]);
  else if (a === '--url') opt.url = argv[++i];
  else if (a === '--browser') opt.browser = argv[++i];
  else if (a === '--status') opt.status = true;
  else if (a === '--stop') opt.stop = true;
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url)).pathname && ''); }
}

const CHROME_CANDIDATES = [
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findExe(kind) {
  const list = kind === 'edge' ? EDGE_CANDIDATES : CHROME_CANDIDATES;
  const hit = list.find((p) => fs.existsSync(p));
  return hit || null;
}

const BASE = `http://127.0.0.1:${opt.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtoolsAlive() {
  try {
    const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/** 列出命令行里带指定 profile 的进程（用于 --stop 与"是不是我的实例"自检） */
function procsForProfile(profile) {
  const out = [];
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`,
    ], { encoding: 'utf8' });
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\|(.+)$/);
      if (m) out.push({ pid: Number(m[1]), name: m[2] });
    }
  } catch { /* 没有这个权限就算了，--stop 会另外提示 */ }
  return out;
}

if (opt.stop) {
  const ps = procsForProfile(opt.profile);
  if (!ps.length) { console.log(JSON.stringify({ ok: true, stopped: 0, why: '没有该 profile 的进程' })); process.exit(0); }
  for (const p of ps) {
    try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
  console.log(JSON.stringify({ ok: true, stopped: ps.length, pids: ps.map((p) => p.pid) }));
  process.exit(0);
}

if (opt.status) {
  const alive = await devtoolsAlive();
  console.log(JSON.stringify({
    ok: alive, port: opt.port, profile: opt.profile,
    profileExists: fs.existsSync(opt.profile),
    procs: procsForProfile(opt.profile).map((p) => p.pid),
  }, null, 2));
  process.exit(alive ? 0 : 1);
}

// 已经在跑 ⇒ 只当作"已就绪"
if (await devtoolsAlive()) {
  console.log(JSON.stringify({ ok: true, already: true, port: opt.port, profile: opt.profile }, null, 2));
  process.exit(0);
}

const exe = findExe(opt.browser === 'auto' ? 'chrome' : opt.browser) || findExe('chrome') || findExe('edge');
if (!exe) {
  console.error('[x] 找不到 Chrome / Edge 可执行文件。用 --browser 指定，或自行安装 Chrome。');
  process.exit(1);
}

fs.mkdirSync(opt.profile, { recursive: true });
const args = [
  `--remote-debugging-port=${opt.port}`,
  `--user-data-dir=${opt.profile}`,
  '--no-proxy-server',           // ★ 绕开系统代理，但不动用户设置
  '--no-first-run', '--no-default-browser-check',
  '--mute-audio',               // 视频静音
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,900',
  '--new-window',
  opt.url,
];
const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
child.unref();

let alive = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (await devtoolsAlive()) { alive = true; break; }
}
if (!alive) {
  console.error(`[x] 起了浏览器但 ${opt.port} 没起来（10 秒内）。看窗口里有没有报错弹窗。`);
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true, port: opt.port, profile: opt.profile, exe, pid: child.pid, url: opt.url,
  next: '在弹出的窗口里登录学习通，然后跑 cx-wait-login.mjs',
}, null, 2));
