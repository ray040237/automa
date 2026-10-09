# 代码审查 · 第四批：存量低风险区（收尾）

审查日期：2026-10-10
范围：本分支相对 `main` 的**全部剩余源码改动**——非 agent、非测试、非文档、非 locales，且排除已弃用的 `handlerAgentReadPage.js`
基线：沿用前三批

---

## 一、范围如何收敛

前三批之后，本批的正确做法不是「按目录抽样读」，而是**用 `git diff` 先把改动量算出来**——因为第三批已经证明「文件数」会严重误导。结果：

本分支改动最大的 30 个文件依次是：`backlog-done.md`、两个新手教程 HTML、`loop.test.js`、`panelUi.test.js`、多份 `docs/agent-*.html`、`handlerAgentReadPage.js`（已排除）、`loop.js`、`assembly.test.js`、`index.js`、`config.js`、`AgentPanel.vue`、`skills.js`……

→ **前排全是 agent 代码（一、二批已审）、测试、文档、locales**。

排除这些后，剩余源码改动的**实际体量**（`git diff --numstat`）：

| 文件 | 增/删 | 性质 |
| --- | --- | --- |
| `src/background/index.js` | +363 | **agent 页面执行通道（二批已审）** |
| `utils/sfc-render.mjs` | +184 | 新测试基建 |
| `utils/check-i18n.js` | +144 | 新工具 |
| `utils/test-resolver.mjs` | +122 | 新测试基建 |
| `.eslintrc.js` | +32 | agent eslint 例外 |
| `utils/build.js` | +29 | offline 构建 |
| `.eslintrc.js` / `package.json` | +32 / +18 | 脚本、依赖 |
| `webpack.config.js` | +15 | offline 构建（**本批主发现**） |
| `src/utils/api.js` | +14 | offline 门 |
| `src/content/index.js` | +13 | offline 门 |
| `src/newtab/router.js` | +10 | offline 路由 |
| `src/stores/*`（4 个） | +7 / +3 / +1 / +1 | offline 门 |
| `src/utils/shared.js` | +3 / −1 | offline 图标 |
| `src/newtab/App.vue` | +2 / −1 | offline 门 |
| 其余 ~150 个 `.vue` / `.js` | 多为 1–3 行 | offline 门 |

**关键结论**：`src/background/index.js` 的 +363 整个就是 agent 页面执行通道（单个 hunk `@@ -511,6 +517,363 @@`），**第二批已完整审过**。因此本批真正的新增内容 = **构建/测试工具链 + 一组 1–14 行的 offline 门**。

---

## 二、结论摘要

| 维度 | 结论 |
| --- | --- |
| blocker / high / medium | **0 / 0 / 0** |
| low | **1**（T-194，已登记） |
| offline 门抽查 | 全部正确 |

---

## 三、offline 门抽查（全部正确，逐条记录）

- **`stores/user.js`** — offline 下 `user=null` + `retrieved=true` + **`browser.storage.local.remove('user')`**。主动清掉已落盘的云端用户，避免陈旧 profile 泄进离线态。正确且有价值。
- **`utils/shared.js:55`** — `ai-workflow` 块图标从**远程 myqcloud.com URL** 换成 `riRobotLine`。这正是离线正确性修复：远程图标在离线环境必然 404。作者抓得准。
- **`newtab/router.js:112`** — `/profile` 路由用条件展开 `...(IS_OFFLINE ? [] : [{...}])` 整体移除，而不是留一个渲染报错的空页。模式正确。
- **`stores/main.js`**（2 处）、**`stores/package.js`**、**`stores/hostedWorkflow.js`**、**`newtab/App.vue:351`** — 均在云端调用前 `IS_OFFLINE ||` 短路。位置正确。
- **`utils/api.js`**（4 处）— `fetchApi`/`fetchGapi` 抛错，`getSharedWorkflows`/`getUserWorkflows` 返回 `{}`，`validateOauthToken` 返回 `Promise.resolve(null)`。**返回形状的分歧正是 T-193 的成因**（见第三批）。

---

## 四、构建与测试工具链核查（本批主要内容）

### 4.1 `webpack.config.js` — CSP 加固（**本批唯一发现，T-194**）

offline 构建会收紧 manifest 的 CSP，用的是硬编码精确字符串替换：

```js
if (process.env.OFFLINE_MODE === '1' && manifestObj.content_security_policy) {
  manifestObj.content_security_policy =
    manifestObj.content_security_policy.replace(" 'unsafe-inline' https:", '');
}
```

**我一开始怀疑的「只对 Firefox 生效」不是 bug**——交叉核对后确认这是**正确的按浏览器分流**：
- `'unsafe-inline' https:` **只在 `manifest.firefox.json:68`**（MV2）；两个 Chrome manifest 的 `content_security_policy` 出现次数为 **0**（`grep -c`）。
- Chrome 是 **MV3**：不声明 CSP 时用最严默认值（`script-src 'self'`），本就无 `'unsafe-inline' https:` 可收紧。Firefox 是 **MV2**，默认较松，才需要这句。

**真正的缺口**：全仓 `grep content_security_policy|unsafe-inline`（排除 manifest 本身）**零命中** → 这次替换**没有任何测试**。`String.replace` 匹配不到时静默返回原串，所以将来一旦有人改动 `manifest.firefox.json` 的 CSP 措辞，offline 构建会**带着 loosened CSP 发布**而测试全绿。

- **登记**：**T-194**（待审核 → 改进）

### 4.2 `utils/sfc-render.mjs`（+184）— SSR 渲染断言

在 node 里把 `.vue` 渲成 HTML 字符串，解决「读源文本验不了运行期条件」的老问题。**边界写得极诚实**（头注 `:18-25`）：明确列出**盖不住**的东西——点击/剪贴板/真实布局/滚动/hover，以及 **watcher 驱动的状态**（SSR 不跑 watcher，`AgentTranscript` 的槽位折算就靠 `watch`）。这种「把能力边界写成事实」的注释风格与 `blocksHandler.test.js` 一致，质量高。

### 4.3 `utils/test-resolver.mjs`（+122）— ESM 解析钩子

三件事：补无扩展名相对导入 → 处理 `@/` 别名 → 用测试桩替换 `webextension-polyfill`。注释点明动机：「`src/agent/index.js` 曾经是整个 agent 里唯一测不到的文件……用户报的 `tasks.reduce is not a function` 就住在那里」。桩放在 `src/agent/__stubs__`（`eslint` 的 webpack resolver 解析不了 `src` 之外的路径，放里面才不会刷 parse error）。设计有据。

### 4.4 `utils/check-i18n.js`（+144）— 文案守卫

en 为真源、zh-TW 仅参考、检测硬编码英文 UI 串与 en/zh 漂移。与 `package.json` 新增的 `check:i18n` 脚本配套。**注**：该守卫与 backlog 里待审的 **T-184**（块库分类标题硬编码英文）是同一类问题——T-184 若修，应能被此守卫覆盖；实施 T-184 时值得顺带确认守卫的扫描范围是否覆盖 `src/utils/shared.js` 的 `tasks` 分类名。

### 4.5 `.eslintrc.js`（+32）

为 agent 模块开了三个**带理由的** airbnb 例外（`prefer-template` / `no-continue` / `no-use-before-define`），理由集中写在 overrides 里便于评审。其中 `prefer-template` 的理由尤其具体：这些模块拼的字符串是「喂给模型的文本」，含双大括号与字面 `${}` 序列，用模板字符串会让「文本内容」与「真实插值」在源码里长得一样；且文件本身是模板字符串生成的，两层嵌套会让内层插值写入时被提前求值（注释称「已踩过一次，见 prompt.js 的 TICK 定义」）。这是有事实支撑的例外，不是随手关规则。

### 4.6 `package.json` 脚本

新增 `build`/`build:offline`/`build:full` 三分（`OFFLINE_MODE=1|0`）、`test`、`check:i18n`、`test:dom`、`test:eval`。依赖新增 `@earendil-works/pi-agent-core`/`pi-ai`（1.0.2）、`eventsource-parser`、`jszip`、`marked`，devDep 新增 `@babel/parser`——与第 1/2 批读到的模块（`provider.js` 动态 import pi、`markdown.js` 用 marked、`skills.js` 用 jszip、`stripComments.js` 用 @babel/parser）**一一对应**，无孤立依赖。

---

## 五、四批 review 汇总

| 批次 | 范围 | 新增问题 | 备注 |
| --- | --- | --- | --- |
| 1 | `src/agent` 核心（~10,200 行） | T-190 | 红线全绿；`ensurePiAgent` 陈旧假设证伪 |
| 2 | agent 集成缝 | T-191 | T-02 三入口全部正确；`src/composable/` 无测试 |
| 3 | `workflowEngine` 上游受影响区 | T-192、T-193 | 实为上游原样代码，改动仅 478 行 |
| 4 | 存量低风险区 | T-194 | 实为构建/测试工具链 |

**累计：5 条新发现，全部为改进级（low），无 bug 级缺陷。** 四条红线（G5 落盘禁令、untrusted 包装、class/ctx 声明、`pi/` 只读）在全部四批中**未发现任何违规**。

一个贯穿性主题：**offline 相关逻辑（构建期 CSP 加固 + 运行期 27 处 `IS_OFFLINE` 门）零测试覆盖**（T-192、T-194 同源）。这是本分支投入最大、却最缺断言的一块。

---

## 附录 · 本轮核查命令

- `git diff --stat main...HEAD | sort -rn | head -32`
- `git diff --name-only main...HEAD` + 过滤 → 剩余源码清单
- `git diff --numstat main...HEAD -- <各文件>` → 逐文件量化
- `git diff main...HEAD -- src/background/index.js` → 单 hunk `@@ -511,6 +517,363 @@`（即二批已审的 agent 通道）
- `grep -c content_security_policy src/manifest.chrome.json src/manifest.chrome.dev.json` → 0 / 0
- `grep -rn "content_security_policy|unsafe-inline" src utils`（排除 manifest）→ 零命中（无测试）
