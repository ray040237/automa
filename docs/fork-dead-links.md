# FlowWing — 上游外部服务引用清单（暂缓处置）

> **状态：暂不修改，等自有文档站就绪后统一换基址。**
> 上游域名（`extension.automa.site` / `docs.extension.automa.site` 等）目前仍在线，
> 用户点开能用，所以现在动它收益为零。这份文档的目的是**换基址时不漏项**。

扫描口径：`src/` 下 `*.js` / `*.vue` / `*.json`，排除 `src/locales/`（那是翻译文案，
已随 P1 品牌切换处理）、`__stubs__`、`*.test.js`。
复扫命令见文末。

## 汇总

| 类别 | 数量 | 域名失效后的后果 |
|---|---|---|
| A. 代码级依赖 | 7 | **功能直接坏**（不是链接打不开） |
| B. 文档链接 | 31 | 打不开，影响最小 |
| C. 客服邮箱 | 2 | 用户反馈发去上游 |
| D. UI 功能入口 | 19 | 点了跳转到废弃服务，像产品坏了 |
| E. 未入表的其他依赖 | 6 | 见第 E 节，grep 域名抓不到 |
| **合计** | **65** | 分布在 36 个文件 |

### 域名分布

| 域名 | 引用数 | 性质 |
|---|---|---|
| `docs.extension.automa.site` | 28 | 文档站（新） |
| `extension.automa.site` | 17 | 云端服务主站 |
| `docs.automa.site` | 1 | 文档站（旧版地址） |
| `blog.automa.site` | 2 | 博客 |
| `aipower.automa.site` | 1 | AI Workflow 块控制台 |
| `automa.vercel.app` | 1 | 旧部署域（manifest matches） |

## A. 代码级依赖（域名坏了功能直接失效，不只是链接打不开）

共 **7** 处。

| # | 位置 | URL / 值 | 用途 | 建议处置 |
|---|---|---|---|---|
| 1 | `src/manifest.chrome.dev.json:47` | （行内裸引用，无 URL） | content_scripts 往该域名注入 webService | 删 matches（自治后无网页需要它） |
| 2 | `src/manifest.chrome.dev.json:48` | （行内裸引用，无 URL） | content_scripts 往该域名注入 webService | 删 matches（自治后无网页需要它） |
| 3 | `src/manifest.chrome.json:55` | （行内裸引用，无 URL） | content_scripts 往该域名注入 webService | 删 matches（自治后无网页需要它） |
| 4 | `src/manifest.chrome.json:56` | （行内裸引用，无 URL） | content_scripts 往该域名注入 webService | 删 matches（自治后无网页需要它） |
| 5 | `src/manifest.firefox.json:52` | （行内裸引用，无 URL） | content_scripts 往该域名注入 webService | 删 matches（自治后无网页需要它） |
| 6 | `src/utils/openGDriveFilePicker.js:45` | `https://extension.automa.site/picker?access_token=${accessToken}` | GDrive 块选文件：`postMessage` 的 origin 协作 | 该块不可用：入口隐藏或改写为自己的 picker |
| 7 | `src/utils/openGDriveFilePicker.js:48` | `https://extension.automa.site` | GDrive 块选文件：`postMessage` 的 origin 协作 | 该块不可用：入口隐藏或改写为自己的 picker |


## B. 文档链接（「查看文档」帮助链接，数量最多、影响最小）

共 **31** 处。

| # | 位置 | URL / 值 | 用途 | 建议处置 |
|---|---|---|---|---|
| 1 | `src/components/newtab/logs/LogsHistory.vue:20` | `https://docs.extension.automa.site/reference/workflow-common-errors.html#${errorBlock.messageId}` | 帮助链接 | 换自己文档站同路径 |
| 2 | `src/components/newtab/logs/LogsHistory.vue:144` | `https://docs.extension.automa.site/reference/workflow-common-errors.html#${item.messageId}` | 帮助链接 | 换自己文档站同路径 |
| 3 | `src/components/newtab/workflow/WorkflowBlockList.vue:26` | `https://docs.extension.automa.site/blocks/${block.id}.html` | 帮助链接 | 换自己文档站同路径 |
| 4 | `src/components/newtab/workflow/WorkflowEditBlock.vue:15` | `https://docs.extension.automa.site/blocks/${data.id}.html` | 帮助链接 | 换自己文档站同路径 |
| 5 | `src/components/newtab/workflow/edit/EditCreateElement.vue:74` | `https://docs.extension.automa.site/blocks/javascript-code.html#${func.id}` | 帮助链接 | 换自己文档站同路径 |
| 6 | `src/components/newtab/workflow/edit/EditGoogleDrive.vue:7` | `https://docs.extension.automa.site/integrations/google-drive.html` | 帮助链接 | 换自己文档站同路径 |
| 7 | `src/components/newtab/workflow/edit/EditGoogleSheets.vue:34` | `https://docs.extension.automa.site/blocks/google-sheets.html#spreadsheet-id` | 帮助链接 | 换自己文档站同路径 |
| 8 | `src/components/newtab/workflow/edit/EditGoogleSheets.vue:46` | `https://docs.extension.automa.site/blocks/google-sheets.html#access-to-spreadsheet` | 帮助链接 | 换自己文档站同路径 |
| 9 | `src/components/newtab/workflow/edit/EditGoogleSheets.vue:53` | `https://docs.extension.automa.site/blocks/google-sheets.html#access-to-spreadsheet` | 帮助链接 | 换自己文档站同路径 |
| 10 | `src/components/newtab/workflow/edit/EditGoogleSheets.vue:75` | `https://docs.extension.automa.site/blocks/google-sheets.html#range` | 帮助链接 | 换自己文档站同路径 |
| 11 | `src/components/newtab/workflow/edit/EditGoogleSheetsDrive.vue:6` | `https://docs.automa.site/integrations/google-drive.html` | 帮助链接 | 换自己文档站同路径 |
| 12 | `src/components/newtab/workflow/edit/EditInsertData.vue:259` | `https://docs.extension.automa.site/blocks/insert-data.html#import-file` | 帮助链接 | 换自己文档站同路径 |
| 13 | `src/components/newtab/workflow/edit/EditJavascriptCode.vue:106` | `https://docs.extension.automa.site/blocks/javascript-code.html#${func.id}` | 帮助链接 | 换自己文档站同路径 |
| 14 | `src/components/newtab/workflow/edit/EditUploadFile.vue:52` | `https://docs.extension.automa.site/blocks/upload-file.html#requirements` | 帮助链接 | 换自己文档站同路径 |
| 15 | `src/components/newtab/workflow/edit/EditWebhook.vue:159` | `https://docs.extension.automa.site/workflow/expressions.html` | 帮助链接 | 换自己文档站同路径 |
| 16 | `src/components/newtab/workflow/editor/EditorLocalActions.vue:33` | `https://docs.extension.automa.site/workflow/sharing-workflow.html#host-workflow` | 帮助链接 | 换自己文档站同路径 |
| 17 | `src/components/newtab/workflow/settings/SettingsGeneral.vue:43` | `https://docs.extension.automa.site/workflow/settings.html#workflow-execution` | 帮助链接 | 换自己文档站同路径 |
| 18 | `src/components/newtab/workflow/settings/SettingsGeneral.vue:138` | `https://docs.extension.automa.site/blocks/trigger.html#trigger-using-js-customevent` | 帮助链接 | 换自己文档站同路径 |
| 19 | `src/newtab/App.vue:56` | `https://docs.extension.automa.site/extension-builder/` | 帮助链接 | 换自己文档站同路径 |
| 20 | `src/newtab/pages/Storage.vue:8` | `https://docs.extension.automa.site/reference/storage.html` | 帮助链接 | 换自己文档站同路径 |
| 21 | `src/newtab/pages/Welcome.vue:61` | `https://docs.extension.automa.site` | 帮助链接 | 换自己文档站同路径 |
| 22 | `src/newtab/pages/Welcome.vue:76` | `https://blog.automa.site` | 帮助链接 | 换自己文档站同路径 |
| 23 | `src/newtab/pages/settings/SettingsAbout.vue:87` | `https://docs.extension.automa.site` | 帮助链接 | 换自己文档站同路径 |
| 24 | `src/newtab/pages/settings/SettingsAbout.vue:92` | `https://blog.automa.site` | 帮助链接 | 换自己文档站同路径 |
| 25 | `src/newtab/pages/workflows/[id].vue:571` | `https://docs.extension.automa.site/workflow/table.html` | 帮助链接 | 换自己文档站同路径 |
| 26 | `src/newtab/pages/workflows/[id].vue:623` | `https://docs.extension.automa.site/workflow/global-data.html` | 帮助链接 | 换自己文档站同路径 |
| 27 | `src/newtab/pages/workflows/index.vue:311` | `https://docs.extension.automa.site/guide/quick-start.html#recording-actions` | 帮助链接 | 换自己文档站同路径 |
| 28 | `src/popup/pages/Home.vue:178` | `https://docs.extension.automa.site/workflow/settings.html#workflow-execution` | 帮助链接 | 换自己文档站同路径 |
| 29 | `src/popup/pages/Home.vue:303` | `https://docs.extension.automa.site/guide/quick-start.html#recording-actions` | 帮助链接 | 换自己文档站同路径 |
| 30 | `src/utils/codeEditorAutocomplete.js:89` | `https://docs.extension.automa.site/blocks/javascript-code.html#automanextblock-data` | 帮助链接 | 换自己文档站同路径 |
| 31 | `src/utils/codeEditorAutocomplete.js:140` | `https://docs.extension.automa.site/workflow/expressions.html` | 帮助链接 | 换自己文档站同路径 |


## C. 客服邮箱（用户反馈直接发去上游）

共 **2** 处。

| # | 位置 | URL / 值 | 用途 | 建议处置 |
|---|---|---|---|---|
| 1 | `src/newtab/pages/workflows/index.vue:303` | （行内裸引用，无 URL） | `mailto:` 反馈邮箱 | 换成自己的邮箱（i18n 结构需同步） |
| 2 | `src/newtab/pages/workflows/index.vue:304` | （行内裸引用，无 URL） | `mailto:` 反馈邮箱 | 换成自己的邮箱（i18n 结构需同步） |


## D. UI 功能入口（登录 / marketplace / 分享 / 团队 / 定价）

共 **19** 处。

| # | 位置 | URL / 值 | 用途 | 建议处置 |
|---|---|---|---|---|
| 1 | `src/components/block/BlockPackage.vue:88` | `https://extension.automa.site/packages/${data.id}` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 2 | `src/components/newtab/app/AppSurvey.vue:51` | `https://extension.automa.site/survey` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 3 | `src/components/newtab/workflow/WorkflowShare.vue:15` | `https://extension.automa.site/profile?username=true` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 4 | `src/components/newtab/workflow/WorkflowSharedActions.vue:6` | `https://extension.automa.site/workflow/${workflow.id}` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 5 | `src/components/newtab/workflow/edit/EditAiWorkflow.vue:101` | `https://aipower.automa.site/` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 6 | `src/components/newtab/workflow/editor/EditorLocalSavedBlocks.vue:75` | `https://extension.automa.site/packages/${item.id}` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 7 | `src/components/newtab/workflow/editor/EditorPkgActions.vue:40` | `https://extension.automa.site/packages/${data.id}` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 8 | `src/components/newtab/workflows/WorkflowsUserTeam.vue:7` | `https://extension.automa.site/auth` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 9 | `src/components/newtab/workflows/WorkflowsUserTeam.vue:25` | `http://extension.automa.site/workflows?teamId=${teamId}&workflowsBy=team` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 10 | `src/newtab/App.vue:17` | `https://extension.automa.site/auth` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 11 | `src/newtab/pages/Packages.vue:116` | `https://extension.automa.site/packages/${pkg.id}` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 12 | `src/newtab/pages/Welcome.vue:66` | `https://extension.automa.site/workflows` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 13 | `src/newtab/pages/settings/SettingsAbout.vue:82` | `https://extension.automa.site` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 14 | `src/newtab/pages/settings/SettingsBackup.vue:51` | `https://extension.automa.site/auth` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 15 | `src/newtab/pages/settings/SettingsBackup.vue:61` | `https://extension.automa.site/pricing` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 16 | `src/newtab/pages/workflows/Shared.vue:36` | `https://extension.automa.site/workflow/${workflow.id}` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 17 | `src/newtab/pages/workflows/Shared.vue:364` | `https://extension.automa.site/workflow/${workflow.value.id}` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 18 | `src/newtab/pages/workflows/[id].vue:167` | `https://extension.automa.site/teams/${teamId}/workflows/${workflow.id}` | 外部服务入口 | 入口隐藏或换自己服务基址 |
| 19 | `src/newtab/pages/workflows/index.vue:53` | `https://extension.automa.site/workflows` | 外部服务入口 | 入口隐藏或换自己服务基址 |

## E. 未入表的其他依赖（换基址时最容易漏）

这些不含 `automa.site` 字符串，用域名 grep 抓不到，但同属「上游资产」：

| # | 位置 | 值 | 说明 | 建议处置 |
|---|---|---|---|---|
| 1 | `secrets.blank.js:2` | `baseApiUrl: ''` | **所有云端 API 的请求基址**。`src/utils/api.js:40` 的 `fetchApi` 拼的就是它。现在是空串 → 任何 `fetchApi` 调用打到相对路径 | 已有自有服务时填真实基址；没有就维持空串（`IS_OFFLINE` 会先抛错挡住） |
| 2 | `src/manifest.chrome.json:54` | `http://localhost/*` | webService 的 `matches` 里除 automa 域名外还有 localhost（开发联调用） | 和 A-3 一并判定，本地调试可能正靠它 |
| 3 | `src/newtab/pages/workflows/index.vue:298` | `https://discord.gg/C6khwwTE84` | 首卡帮助文案里的 Discord 邀请（上游服务器），嵌在 i18n 句子 `help / community / helpAfter` 中间 | 要摘需同时改 3 个 i18n value 的句子结构 |
| 4 | `src/newtab/pages/Welcome.vue:69` | `https://youtube.com/channel/UCL3qU64hW0fsIj2vOayOQUQ` | 上游作者的教学频道（无品牌词） | 保留或替换 |
| 5 | `src/newtab/pages/settings/SettingsAbout.vue:101` | `https://api.github.com/repositories/412741449/contributors` | 「贡献者」列表。`412741449` 是**上游 repo 的数字 id**（fork 的 id 不同），所以这里拉的是上游 Automa 的贡献者，不是本 fork 的 | 换成本 fork 的 repo id 或改用 `repos/ray040237/automa/contributors` 路径 |
| 6 | `src/newtab/pages/Welcome.vue:42` / `SettingsAbout.vue:*` | `icon-128.png` 等品牌资源 | 已在 P1 换成 FlowWing 图标 | 已完成 |

## 换基址时的操作要点

按依赖强度从高到低，别只做字符串替换：

1. **A 类先行**：`openGDriveFilePicker.js` 是 `window.open` + `postMessage` 的
   origin 协作（`openGDriveFilePicker.js:45` 打开页面、`:48` 校验 origin）。
   换域名必须两处一起改，且对端页面也得是你的——否则 Google Drive 块的选文件功能静默失效。
2. **manifest 的 3 份都要改**（chrome / chrome.dev / firefox）。注意
   `manifest.chrome.json:46` 的 `<all_urls>` 那条**不是**上游依赖，是 contentScript 本体，别误删。
3. **D 类要么换基址要么隐藏入口**。其中 `AppSurvey.vue`（问卷）、
   `SettingsBackup.vue` 的 pricing 属上游运营活动，自治后大概率直接删入口。
4. **B 类可以最后做**，纯替换零风险，等文档站上线后一条 sed 的事。
   但要保持**路径结构一致**（`/blocks/${block.id}.html`、`#anchor` 等），
   代码里全是模板拼接，路径变了就对不上。
5. **`log.messages` 的 key 不能碰**：`LogsHistory.vue:20/144` 拼的文档 URL 里有
   `${errorBlock.messageId}`，那是日志消息 id，不是品牌词——但它和
   `translateLog` 的 key 机制是两套东西，改文档 URL 不影响日志翻译。

## 复扫命令

```bash
# 全量（含行号）
grep -rn "automa\.site\|automa\.vercel\.app\|automa\.app\|AutomaApp" src \
  --include="*.js" --include="*.vue" --include="*.json" \
  | grep -v "^src/locales/" | grep -v "__stubs__" | grep -v "\.test\.js"

# 只看代码级/隐藏形态（不带 https:// 的）
grep -rn "automa\.site\|automa\.vercel\.app" src \
  --include="*.js" --include="*.vue" --include="*.json" | grep -v "https\?://"
```

脚本版（自动分类输出）：`.scratch/gen_md.py`。

---

*建立于 2026-10-15，P1 之后。处置时请直接在本文件上更新状态列，不要新建一份。*
