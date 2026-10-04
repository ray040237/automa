# pie-ai-agent 借鉴实践调研

日期:2026-10-03
调研对象:`pie-ai-agent/`(仓库内参考项目,BYOK Chrome AI agent 扩展,React+TS,MV3)
目的:找出工程实践层面值得移植到 Automa agent 的做法,按"借鉴价值 × 成本"分层。移植类结论(多会话/pin/分片聚合)已在 docs/agent-multi-session-plan.md 落地,本文只收**那次调研没覆盖的、工程与流程层面**的发现。

---

## A. 直接可抄,低成本高收益

### A1. LLM 消息历史的"最后防线"校验 ⭐ 高价值

pie 的 `history-validation.ts` 在模型调用前做纯函数防御:

- `dropEmptyMessages`:删除 wire 上会序列化成空的消息(空 assistant 正文会被 Kimi 400);
- `validateAndRepairAdjacentRoles`:相邻同 role 消息之间插入相反 role 的哨兵消息(Anthropic 400);system-system 不算违规(Anthropic 侧已合并);
- 只对真正不可恢复的输入(空数组、非法 role)抛 `MultiTurnHistoryError`;
- 遥测只记 `idx/role/contentLength/SHA-256 前 8 位`——可关联不可还原,永不落原始内容(隐私不变量写进注释)。

**对照 Automa**:我们有 wire 配对净化(tool_calls 配对),但缺**相邻同 role 修复**和**空消息清洗**——多轮续接 + 插话注入后相邻 user-user 是真实可发生的。约 200 行纯函数,进 `wire.js` 体系。

### A2. Provider 层三件套 ⭐ 高价值

- **连通性测试走真实 chat 流**(maxTokens=16 + 15s AbortController 超时):探针路径 = 生产路径,测出的错误与真实使用一致,不会出现"测试通过、真用报错";
- **模型列表拉取**:`/v1/models` 公共端点归一化,处理 baseUrl 已含 `/vN` 的防重复拼接;
- **模型元数据表**:每个模型带 `vision / tools / contextWindow`,未知字段给保守默认(vision:false, tools:true, 128k)。

**对照 Automa**:设置页没有"测试连接",模型名与 contextWindow 都手填——而 contextWindow 直接驱动 token 裁剪。三件套是设置页最值得补的能力。

### A3. 标题生成的三道防(含我们一个真 bug)🚨

pie 的策略:① **race-guard**——仅当存储的 title 仍等于预期 fallback 才覆盖;② LLM 失败静默保留 fallback,**永不重试**;③ 输出清洗(escape + 去 emoji + 按 locale 截断)。

**对照 Automa 发现一个真 bug**:我们的标题回写(`index.js` generateTitleAsync 的 `.then`)用**整记录 save()**,写入的是首轮捕获的旧 `events`——若用户在标题生成期间发出第二轮,晚到的标题会用首轮事件覆盖第二轮已落盘的事件。修复方向:标题只 patch title 字段,或回写前比对会话的 `lastAccessedAt` 未变。已登记 docs/backlog.md B1。

### A4. 测试基建手法

- 手写 `chrome.storage.local` **内存 mock**:暴露 `__store` 供测试直接 seed,提供 `_resetForTests()`;
- fake-indexeddb;测试**重 IO 语义而非 mock 调用次数**(在真存储上建会话→跑恢复→断言状态翻转);
- 依赖注入(chat 函数作参数)替代 mock import。

**对照 Automa**:我们"纯函数 + IO 注入 + node --test"方向一致;当 agent 测试开始覆盖 storage 语义时,按这个内存 mock 模式补一层。

### A5. 遥测脱敏约定

只记内容长度 + 哈希前 8 位。我们暂无遥测,但约定先入规范(见 CONTEXT.md 与本文档),将来加日志/上报时不泄露页面内容。

## B. 流程与文档,零代码成本 ✅ 已落地

本文档 + `docs/adr/0001~0003` + 根目录 `CONTEXT.md` 术语表(带 Avoid 禁用词)+ `docs/backlog.md` 的 B 编号欠账区(原 `agent-backlog.md`,2026-10-04 并入),即本轮借鉴的直接产物。后续约定:

- **ADR**:一个决策一篇,编号 `NNNN-短名.md`;必须有"被拒备选(含量化理由)"和"已知欠账"两节;
- **CONTEXT.md**:新术语先登记再使用,禁用词出现即改;
- **注释带出处**:踩坑注释引用 issue/实测日期,不写"历史遗留"。

## C. 中期,按需再上

### C1. Eval 轻量版

pie 用 WebArena 812 任务(任务 JSON → 编排器真跑 → 离线判定器 → 聚合脚本),结构好但太重。轻量版对我们现成:把 `.agent-test/` 的三个 live 脚本升级为**固定任务集**(每任务一个 JSON:prompt + 桩 + 断言)+ 汇总脚本——改 prompt 或换模型后一键回归,替代目前的手测。

### C2. 会话恢复

pie 的 SW 冷启动扫描(SW 顶层 import + onStartup + panel-mounted 四触发点,30s 去重;有 pendingConfirm → 先 fail 再清防中间态;stepIndex>0 → paused)对我们**暂不适用**(loop 在 newtab 页)。适用场景:newtab 页被关 = loop 死,重开时若发现会话 status 仍 active 且末尾有未收尾事件 → 提示"上一轮被中断"(wire 净化已保证可安全续接)。

### C3. rewind(编辑重发)与 runtime slot 模式

多会话并发 UI 做深时再抄:rewind = 纯函数构建重发输入 + 写墓碑阻断 synth/abort-resume 桥;slot = `Map<sessionId, 运行时槽>` 管理每个会话各自的流式缓冲。

### C4. log-buffer

patch console.error/warn 存最近 500 条/24h,供"用户反馈附带日志"。按构造不读聊天数据。等有用户反馈通道时上。

## D. 明确不照搬

- **WebArena 全量 812 任务**(9.6GB 站点 + Docker):规模不匹配;
- **daemon / skill 沙箱体系**:差一个量级的功能面;
- **IndexedDB 持久化**:storage.local 对我们的数据量够用;
- **keep-alive**:pie 为 MV3 SW 30s 存活设计;我们 loop 在 newtab 页,页面开着就活着。

## 行动顺序

| 序 | 项 | 成本 | 状态 |
|---|---|---|---|
| 1 | A3 标题竞态真 bug 修复 | ~0.5h | backlog #B1 |
| 2 | A1 历史最后防线(空消息 + 相邻同 role) | ~0.5d | backlog #B2 |
| 3 | A2 设置页三件套(测试连接/模型列表/元数据驱动 contextWindow) | ~1d | backlog #B3 |
| 4 | C1 eval 轻量版 | ~1d | backlog #B4 |
| 5 | A4/A5 测试与遥测约定 | 按需 | 入规范 |
