---
name: chaoxing-course-automation
description: "用「专用 Chrome + 零依赖 CDP 驱动」自动完成学习通（超星 i.chaoxing.com）的刷课与在线考试：起浏览器→人工登录→自动列课→读整卷→按正常节奏逐题作答→三重回读复核→交卷；真播视频刷学时、文档任务点滚到底。含学习通平台机制实测（跨域 iframe、反爬字体解码、题号跳题、答案域判据、监考识别、滑块验证码）、全部踩坑与自愈设计。"
whenToUse: "学习通、超星、chaoxing、i.chaoxing.com、刷课、挂课、刷学时、任务点、在线考试、单元测验、章节测验、期末考试、做题、答题、交卷、网课、通识课、继续教育、mooc、iframe、CDP、浏览器自动化、单终端、风控"
---

# 学习通（超星）刷课 / 在线考试自动化

## 概览

用**专用 Chrome + 零依赖 Node 脚本**，替人完成这条链：
**起浏览器 → 人工登录 → 自动列课 → 读整卷 → 按正常节奏作答 → 独立复核 → 交卷**（视频/文档任务点另行处理）。

> **动手前先扫一眼 `references/runbook.md`（完整跑法）**，
> 遇到报错看 `references/pitfalls.md`，
> 需要改脚本/加功能看 `references/platform-internals.md`（平台机制实测）。

## ★ 五条铁律（违反了就是白做、甚至有代价）

1. **账号密码由本人输** —— 脚本只把登录页打开，**不代解密浏览器密码库、不代输密码**。
2. **单终端** —— 任何时刻**只允许一个终端登录**。用户的电脑浏览器、手机 App 都算一个终端。
   后果不是"报错"，而是**警告 → 不良记录（学校可见、不可消除）→ 黑名单（6 个月学时不予累计）**。
   ⇒ **开跑前必须确认用户没在别处开着学习通**；用户要看之前先让他退。
3. **不伪造学习记录** —— 视频**真播**（含平台自己提供的倍速档位）、文档**滚到底**（走 UI），
   **绝不直接调平台的完成上报接口**。那是"跳过内容却标记已完成"。
4. **慢** —— 每题之间随机停顿 14～26 秒。**"整卷几十秒点完"本身就是异常信号**，
   而且快了也读不细、正确率反而掉。**别把节奏调成 0。**
5. **交卷前必须独立复核** —— 执行者自己说"填好了"**不算验收**。
   必须有一条**不经过作答路径**的读数（跳题重读 / 预览页读取），且**逐题对得上**才交。

> **验证码与监考的处置**：滑块/图形验证码是**反自动化**检测 ⇒ **不代过**，让用户自己拖（他人在电脑前）。
> 若某场考试**开了人脸识别/摄像头/屏幕监控** ⇒ **不绕过**，当场停下告诉用户。
> 判据见 `references/platform-internals.md` §监考。

## 主流程

### 0）准备：一人一 profile 一端口

```powershell
cd <skill>\scripts
node cx-start.mjs --port 9223 --profile D:\somewhere\cx-profile
```
★ **profile 别放在 skill 目录里**（它含登录态，而 skill 要能分发给别人）。
★ 脚本给 Chrome 加了 `--no-proxy-server`：**绕开本机系统代理但不动用户设置**
（系统代理开着时学习通子资源会加载失败，iframe 变 `chrome-error://`）。

### 1）等用户登录

```powershell
node cx-wait-login.mjs --port 9223 --timeout 300
```
判据：URL 不在 `passport2.chaoxing.com/login` **且** `document.cookie` 里有 `UID=`。
★ **"等着用户登录"这件事不会自己过期提醒** —— 中间状态要主动报："现在只差你登录"。

### 2）列课程（接单第一件事）

```powershell
node cx-courses.mjs --port 9223 --out courses.json
```
★ **两条独立读数对账**（DOM 卡片 + `courselistdata` API），不一致就报错。
★ **别用记忆里的课程表** —— 实测 2026-09-28 是 8 门，2026-10-20 变成 9 门。

### 3）盘点这门课要做什么

```powershell
node cx-exam-list.mjs --port 9223 --course 267202626      # 有几场考试、状态、剩余时间
node cx-docs.mjs  --port 9223 --course 267202626 --clazz 155007944   # 文档任务点
```
★ **一个「节」可以挂多个任务点** ⇒ 侧栏"待办节数"与平台"待办任务点数"**不是同一个单位**。

### 4）视频 / 文档任务点

```powershell
node cx-play.mjs --port 9223 --course 267202626 --rate 2 --gap-min 8 --gap-max 25
```
* 视频**真播**；倍速**只用平台 UI 给出的档位**（有的课播放器 `playbackRates=false`，强设会被重置并顺手暂停视频）。
* 文档任务点的完成条件是**把文档滚到底**（平台自己判定）。
* `--until-ts <epoch毫秒>` 到点收工（**深夜学习是风控触发项**）。

### 5）考试 / 章节测验：先读全卷

```powershell
node cx-read-paper.mjs --port 9223 --type exam --url <答题页URL> --out paper.json
```
★ **考试有时限**（实测 60 分钟）：读全卷约 3～4 分钟/50 题，**要留足答题时间**。
★ 读全卷后**一次性算好所有答案**，不要边看边答。

### 6）按节奏作答（每题回读）

```powershell
node cx-answer.mjs --port 9223 --type exam --paper paper.json --answers answers.json --pace-min 14 --pace-max 26
```
* `answers.json`：`{"1":"A","2":"D"}`（按题号）或 `{"<qid>":"A"}`（按题目 id，更稳）。
* **每题点完立刻回读平台自己的答案域**，对不上就记为失败。
* **本步不交卷**。

### 7）独立复核（交卷前的闸门）

```powershell
node cx-verify.mjs --port 9223 --type exam --paper paper.json --answers answers.json
```
★ 走的是**另一条读数**（逐题跳过去重读 / 作业页从 DOM 反读选中态），**不经过作答路径**。
★ 任何一题对不上 ⇒ **拒绝交卷**，先修答案。

### 8）交卷（不可逆）

```powershell
node cx-submit.mjs --port 9223 --type exam --answers answers.json --yes
```
★ 交卷前**再从服务端渲染的整卷预览页读一遍**全部已存答案并对账（第三条独立读数）。
★ **不带 `--yes` 只做复核不交**（不可逆动作要多一道人工确认）。
★ 作业路径由 `work-apply.js` 自带闸门：**任何一题没选中 ⇒ 拒绝提交**
（依据：章节测验**提交后不可重做**；曾因漏认选中态提交了 23 份作业、只能求老师重置）。

## 每类任务点怎么做

| 类型 | 做法 | 判据 |
|---|---|---|
| **视频** | 真播；选**任务点那个**帧（一个节可能挂两个视频，只有一个是任务点） | 平台标的 `ans-job-finished`（有＝已完成） |
| **文档** | 打开 → 滚到底 | 平台自己的 `checkJobFinish()` / `ans-job-finished` |
| **章节测验** | 读全卷 → 匀速作答 → 回读 → 交卷 | `#answer<qid>` 域有值 |
| **考试** | 同上，但**注意时限** | 同上 + 交卷前预览页对账 |

## 验收口径（别用"我自己说做完了"）

完成度结论**至少要有一条不经过执行者的读数**，而且两条不一致时**要把差异说出来**（以平台口径为准）。
见 `references/runbook.md` §验收。

## 文件清单

```
scripts/
  cx-start.mjs        起浏览器 + 打开登录页（--no-proxy-server / 独立 profile）
  cx-wait-login.mjs   等登录（判据：URL + cookie UID）
  cx-courses.mjs      列课程（DOM + API 两条读数对账）
  cx-exam-list.mjs    列某门课的考试（自动解析 clazzid/cpi）
  cx-play.mjs         视频/文档任务点驱动（真播、倍速只走 UI 档位）
  cx-docs.mjs         文档任务点枚举
  cx-read-paper.mjs   读整卷 → paper.json
  cx-answer.mjs       按节奏作答（每题回读）
  cx-verify.mjs       独立复核（拒绝交卷）
  cx-submit.mjs       交卷（带闸门）
  cx-eval.mjs         通用求值（查平台上一个现成工具答不了的问题时用）
  cx-media-fix.mjs    媒体诊断（窗口最小化 / 倍速实测 / 回拨）
  lib/cdp.mjs         CDP 底座（跨域帧上下文、导航、窗口恢复）
  lib/exam.mjs        考试页操作（跳题 / 作答 / 预览页读全卷）
  lib/pages.mjs       页面脚本加载 + 答案比较
  js/                 注入页面的脚本（字体解码、选项点击、读状态…）
  check-bom.mjs       BOM 检查（.ps1 必须带 UTF-8 BOM，.bat 必须 GBK）
  check-portability.mjs 可移植性检查
references/
  runbook.md          完整跑法：接单 → 交付、验收、报价口径
  pitfalls.md         踩坑速查（每条带现场）
  platform-internals.md 平台机制实测（改脚本前先看这里）
```

## 常见问题

**Q：怎么知道该给用户报什么？**
先给**数字**（还剩几题 / 预计多少分钟），再给依据。**"这取决于…"式的开场会被读成回避。**

**Q：脚本卡住了怎么办？**
先看 `references/pitfalls.md` 的「静默」那几条：
**没有日志的等待与卡死不可区分** —— 缺日志就先补日志再推断。
