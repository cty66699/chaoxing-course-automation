# 跑法：从接单到交付（含考试全流程）

> 这是**照着做**的顺序手册。机制细节见 `platform-internals.md`，报错见 `pitfalls.md`。

## 0）接单前的三件事

1. **一次一账号、一 profile、一端口** —— profile 不共用（cookie 会互相覆盖）。
2. **问清交付边界** —— 只做课程学习与考试？还是要导出证书/做别的？
   （平台不同，交付物不同，流程差别很大。）
3. **确认账号能登** —— 让对方自己在浏览器里输密码；**你不去解密他的密码库**。

### 环境自检（一次性）

```powershell
node scripts\check-bom.mjs <脚本目录>
node scripts\check-portability.mjs <脚本目录>
```

---

## 1）起浏览器 → 等登录

```powershell
node scripts\cx-start.mjs --port 9223 --profile D:\work\cx-profile
node scripts\cx-wait-login.mjs --port 9223 --timeout 300
```

★ **单终端**：开跑前确认对方**没在电脑浏览器 / 手机 App 上开着学习通**。
★ 中间态**要主动报进度**："现在只差你登录"（不要说"环境已就绪"，那会被读成"我这边开始干了"）。

---

## 2）列课程 → 圈定范围

```powershell
node scripts\cx-courses.mjs --port 9223 --out courses.json
```

★ 两条读数对账通过才用。**以文件为准，别用记忆里的课程表。**

---

## 3）逐课盘点（区分三类任务点）

```powershell
node scripts\cx-exam-list.mjs --port 9223 --course <courseid>      # 考试
node scripts\cx-docs.mjs    --port 9223 --course <courseid> --clazz <clazzid>  # 文档
node scripts\cx-play.mjs    --port 9223 --course <courseid> --rate 2            # 视频（顺带跑）
```

★ **报工期用区间**（平台送流波动大），**别给单点**。

---

## 4）视频 / 文档：真做

```powershell
node scripts\cx-play.mjs --port 9223 --course <courseid> --rate 2 --gap-min 8 --gap-max 25 --until-ts <epoch毫秒>
```

* 倍速**只用平台 UI 给出的档位**（`--rate` 给的是"想用几倍"，脚本会实测并自动降级到 1）。
* 小节之间随机停顿（`--gap-min/--gap-max`），避免"一节接一节毫不停歇"的机械节奏。
* `--until-ts` 到点收工。**深夜学习是风控触发项。**
* ⚠ **状态文件 `state-<tag>.json` 里的 `skip` 是"永久跳过"** ——
  写入后**再也不会重试**，是**故障期误判的主要藏身处**。
  **遇到"某门课莫名 todo 0"，第一件事就是看 `partial`**。

---

## 5）考试 / 章节测验：完整四步（★ 最重要的一段）

### 5.1 进入考试（需要人参与）

1. 课程页 →「考试」标签 → 点那张卷子。
2. **考试说明页**：把「我已阅读并同意」勾上 → 「进入考试」→ 弹窗点「确定」。
3. **若弹出滑块验证码 ⇒ 让用户自己拖**（反自动化检测，不代过）。
4. 记下**答题页 URL**（后面每一步都要它）。

★ 考试**有时限**（实测 60 分钟）且**离开界面不停表** ⇒ **先读全卷再答**。

### 5.2 读全卷

```powershell
node scripts\cx-read-paper.mjs --port 9223 --type exam --url <答题页URL> --out paper.json
```
* 逐题跳着读，**每跳一次约 3 秒** ⇒ 50 题约 3～4 分钟。
* `paper.json` 里每题含 `i / qid / stem / options[] / stored`。

### 5.3 算答案 → 匀速作答

* **一次算好全部答案**，写成 `answers.json`：`{"1":"A","2":"D",...}`（或按 `qid` 键，更稳）。
* 单选/多选/判断都按**选项字母**；判断题可用 `true/false` 或 `对/错`。

```powershell
node scripts\cx-answer.mjs --port 9223 --type exam --paper paper.json --answers answers.json --pace-min 14 --pace-max 26
```
* 每题点完**立刻回读** `#answer<qid>`；对不上的题记为失败并计入 `failed`。
* **本步不交卷。**

### 5.4 独立复核（交卷前的闸门）

```powershell
node scripts\cx-verify.mjs --port 9223 --type exam --paper paper.json --answers answers.json
```
* 走**另一条读数**：逐题跳过去重新读。
* **任何一题对不上 ⇒ 退出码 1 ⇒ 不要交卷**，先修答案。

### 5.5 交卷

```powershell
node scripts\cx-submit.mjs --port 9223 --type exam --answers answers.json --yes
```
* 交卷前**再从服务端渲染的整卷预览页**读一遍全部已存答案并对账（**第三条独立读数**）。
* 不带 `--yes` 只复核不交。
* 成功的判据：URL 变成 `/exam/test/look` 或页面出现「交卷成功」。

### 5.6 作业（章节测验）路径

```powershell
node scripts\cx-read-paper.mjs --port 9223 --type work --url <作业页URL> --out paper.json
node scripts\cx-answer.mjs   --port 9223 --type work --paper paper.json --answers answers.json --url <作业页URL>
node scripts\cx-submit.mjs   --port 9223 --type work --answers answers.json --url <作业页URL> --yes
```
★ 作业的"有题没选中就拒绝提交"闸门在 `work-apply.js` 里，已经内建。

---

## 6）验收（两条读数 + 差异说明）

```powershell
node scripts\cx-courses.mjs --port 9223 --out courses-after.json   # 平台侧待办
node scripts\cx-docs.mjs    --port 9223 --course <courseid> --clazz <clazzid>
```

★ **完成度结论至少要有一条不经过执行者的读数。**
★ 两条对不上时：**把差异说出来 + 说明按哪个口径判**，**不要抹平**。
★ 报格式：**已做 N / 共 M（平台口径）· 用了多少时间 · 哪些没做及原因**。

---

## 7）收工

```powershell
node scripts\cx-start.mjs --port 9223 --profile <同上> --stop
```
★ **关掉自动化浏览器** —— 留着就等于**多一个终端**。
★ 留档：状态文件、日志、`paper.json` / `answers.json` / `verify-result.json` / `submit-result.json`。

---

## 附：排期与报价口径

* **平台送流波动是吞吐的第一变量**（不可控）；**并行路数是第二**；**倍速在刷视频上无可测收益**。
* 同一批账号**课程结构与题库完全相同** ⇒ 题库可跨账号复用、零重收割。
* ★ **一律报区间，并说明"取决于平台窗口"**；报过单点、后来被更长的观测证伪过很多次。
* ★ **深夜学习是风控触发项**；校方建议**学习周期至少一周以上** ⇒
  **接单排期不要压成一两天**，宁可跨周。
