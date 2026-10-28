# 学习通平台机制实测（2026-09-22 ~ 2026-10-20，跨 3 周、8 门课、2 场考试）

> **用法**：改脚本、加功能、判断"这个读数可不可信"之前先看这里。
> 每条都是**实测**，不是文档抄的；带日期的是当时的读数。

## 一、页面结构：顶层 + 多个**跨域** iframe

| 位置 | 域 | 能不能从顶层读 |
|---|---|---|
| 课程页 | `mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu` | 顶层 |
| **章节列表** iframe | `mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse`（**带 sandbox**） | ❌ 顶层 `contentDocument` 读不到（SecurityError）⇒ **必须用该帧自己的 executionContextId** |
| 考试列表 iframe | `mooc1.chaoxing.com/exam-ans/mooc2/exam/exam-list` | ❌ 跨域 ⇒ 同上 |
| 答题页 | `mooc1.chaoxing.com/exam-ans/exam/test/reVersionTestStartNew` | 顶层（但题在一页一题里） |
| 作业页 | `mooc1.chaoxing.com/mooc-ans/...` | 顶层 + 内含作业 iframe |

★ **正解**：拿该帧的 `executionContextId` 再 `Runtime.evaluate`（`lib/cdp.mjs` 的 `frameCtx()` / `lib/exam.mjs`）。
★ **换 URL 后执行上下文会被销毁** ⇒ 每次导航后要重新求值（不能复用旧 ctxId）。
★ **`iframe.src` 属性 ≠ 帧真的加载了** —— 属性只写"意图"；判"帧在不在"要看 `Page.getFrameTree`
（失败时 URL 是 `chrome-error://chromewebdata/`）。

## 二、题目与答案的权威字段

| 场景 | 读什么 | 备注 |
|---|---|---|
| **考试答题页** | 题干 `.questionLi h3.mark_name`；选项 `.stem_answer > .answerBg`（字母取 `span.addChoice[data]`）；**已选答案 `#answer<qid>`** | `#isAnswered` **不可靠**（点完仍是 `false`，要整页提交才变） |
| **整卷预览页** | 服务端渲染，**同时**带全部题干与全部 `answer<qid>` | ★ 这是**独立于"我刚点的"**的一条读数，交卷前对账用 |
| **作业页** | 题干 `.TiMu .font-cxsecret`（**反爬字体**）；选项 `.Zy_ulTop li`；选中态 `span[data].check_answer` | 单选给 `check_answer`、多选给 `check_answer_dx` ⇒ **只认后者会认不出单选已选中**，于是连点两次把答案取消掉 |

★ **判断"答了没有"永远读平台的答案域，不要读 class 名。**
★ 判断题选项的标签是 `true/false`，不是字母。

## 三、反爬字体（`.font-cxsecret`）

* 页面里有一份 base64 的 TTF，把部分汉字**换成自造字形**；题干**和选项都可能被换**。
* 解码流程：解析 `cmap` 拿到被覆盖的码位 → canvas 渲染候选字 → 逐像素比对 → 得到映射表。
* 实现见 `scripts/js/glyph-pool.js`（建字形池）+ `scripts/js/work-read.js`（用池子解码）。
* ★ **字形池必须建在顶层帧**（`window.top.__glyphPool_v1`），作业帧去顶层取。

## 四、`knowledge/cards` 是**分页**的

* 一张卡只装**一个**任务点；用 `num=0/1/2…` 翻页。
* ★ 实测：古典音乐「2.1 巴赫的故事与作品」`num=0` 附件 0 个，**`num=1` 才是那段 899 秒的视频**。
* ⇒ 只读 `num=0` 会把真任务点整段漏掉（曾导致 9 节真视频被判"无任务点"并被永久冻结）。
* 实现：改 `cards` iframe 的 `src` 里的 `num=`（`JS_HOOK.flipCard`）。

## 五、一个「节」可以挂**多个**任务点

平台自己会写：`音乐治疗 1视频 2章节测验` ⇒ 视频播完、只要同节的测验没做，**该节永远显示未完成**。
⇒ **侧栏"待办节数"与平台"待办任务点数"不是同一个单位，不能互相换算。**
⇒ 选节要用**自己记的 done（按任务点 id 去重）**，不要只看侧栏计数。

## 六、一个节里可能有**多个**视频，只有一个是任务点

| 附件 | `job` | 时长 | 平台标的状态 |
|---|---|---|---|
| `[0]` | undefined（非任务点） | 609s | 祖先容器 class 含 **`ans-job-finished`** |
| `[1]` | **true（任务点）** | 127s | 祖先容器**没有** `ans-job-finished` |

⇒ **选帧判据 = 祖先容器有没有 `ans-job-finished`**（平台自己标的完成状态）。
★ 踩过：驱动一直在播那个**非任务点**（平台早标它 passed）⇒ 侧栏待办永远不掉 ⇒ 干等到超时（一次白烧 2 小时 18 分）。

## 七、文档任务点（`insertdoc`）的完成条件 = **把文档滚到底**

* 平台自己的完成逻辑在查看器页的脚本里：`getScrollTop() > scrollHeight - clientHeight - 100` ⇒ `finishJob()`。
* 文档查看器真实路径是 **`/ananas/modules/pdf/index.html`**（**不是** `modules/zt/pdf/` —— 那是推断错的）。
* ★ **判据用平台自己的 `checkJobFinish()` 与 `ans-job-finished`**，不要用"我滚了多少"，
  也不要拿 `modules` 当判据（它给出的是 `pdf`，不是 `insertdoc`，会漏整类）。
* ★ **绝不直接调 `/mooc-ans/job/document`** —— 那是"跳过内容却标记已完成"，是红线。

## 八、进入考试的链（每一步都是一个静默陷阱）

```
课程页 →「考试」标签 → exam-list iframe → goTest(...) → 考试说明页 examnotes
  → 勾「我已阅读并同意」(.face_agreement，加 agree_checked 类、去掉 .entrybtn 的 opa40)
  → preEnterExam() → 弹 #confirmEnterWin → enterExamCallBack() → enterExam()
  → startTest() → jumpExam() → preCheckAction() / showCXCaptcha()
  → location.href = $('#startBtn').attr('data')  ← 答题页
```
* `#examCheck` 是 **hidden input**（点它没用）。
* 页面上**有两个 `#tabIntoexam2`**，外层那个 `onclick` 是**空串**（点了什么都不发生、也不报错）。
* 弹窗 `display:none` 时点它无效 ⇒ **直接调函数**最可靠。
* 交卷按钮**不在答题页**，在**整卷预览页**（`.completeBtn` → `finalSubmit()`），且要点弹窗里的「确定」。

## 九、答题页的机制

* **一页只渲染一题**（`.questionLi`），整卷数据不在页面里。
* 要读全卷只能**用题号面板一题一题跳**（`.topicNumber` 的数字）⇒ **每次跳 = 一次整页重载**。
* ★ **题干开头自带题号**（"12. (单选题, 2.0 分)"）⇒ 用它判断"跳到位了没有"，比等固定时间可靠。
* `getTheNextQuestion(1)` 会先调 `checkQuestionAnswer()` ⇒ **本题没答就不翻页**（也不报错）；
  **但题号面板可以绕过这个限制**。
* 考试时长从 `#remainTime` 读；**离开界面计时不停**。

## 十、倍速：因课而异，**只用平台 UI 给出的档位**

* 播放器是 Video.js；**加载/切源后会把 `playbackRate` 重置回 1** ⇒ 必须每轮重申。
* 实测：心理健康档位 [0.75,1,1.25,1.5,2] 可用 2x；信息素养 `playbackRates=false` **官方未开倍速**，
  强设 2x 会被重置**并顺手暂停视频**（判成异常）。
* ★ 强设平台没提供的倍速，属于越线（有研究称平台能监控倍速并作为证据上报）。

## 十一、监考 / 验证码怎么认

| 要看的字段 | 在哪 | 含义 |
|---|---|---|
| `#snapshotMonitor` | 考试说明页 / 隐藏域 | `1` = 有抓拍监控 |
| `#electronSnapshotMonitor` | 同上 | 客户端抓拍 |
| `#checkSecondDeviceLive` | 同上 | `1` = 查第二设备（多终端） |
| `#needCode` | 同上 | `1` = 要考试码 |
| `#captchaCheck` | 同上 | `1` = **要滑块验证码** |
| `window.cef` | 全局 | **人脸识别 `OpenFaceCheck` 只在超星客户端里存在** ⇒ 浏览器里那条分支走不到 |

★ 判"有没有监考"**看这些字段，不要读说明文字**（说明文字可能不含全部）。
★ 滑块 = 反自动化检测 ⇒ **不代过**；人脸/摄像头 = 监考 ⇒ **不绕过**，停下告诉用户。

## 十二、环境层（症状 ≥2 且分散在不同子系统时，先查这一层）

顺序：**系统代理 / 环境变量 → 窗口状态 → 网络可达性**。
* 本机系统代理常开（Clash，`127.0.0.1:7897`）⇒ 它开着时 Chrome 的子资源加载失败
  （iframe 变 `chrome-error://`、导航 30 秒超时、视频拿不到 duration）。
  ⇒ **正解是给 Chrome 加 `--no-proxy-server`**，不是去改用户的系统代理。
* 窗口**最小化** ⇒ 浏览器**暂停视频**（`paused=true`、`currentTime` 不走，而 `readyState=4`、缓冲充足）
  ⇒ 无人值守时**静默卡死**。恢复窗口即恢复。
