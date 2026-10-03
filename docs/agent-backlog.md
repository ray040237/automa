# Agent 已知欠账登记

每项一条:编号、来源、内容、为什么缓、重开的触发条件。修掉的项目移到文末"已清"。新增欠账先登记再排期,不允许"口头知道但不记录"。

## B1 — 标题异步回写可能覆盖并发写入的会话事件 🚨 bug

来源:docs/pie-agent-borrowing-practices.md A3(2026-10-03 对 pie 调研发现)。
内容:`src/agent/index.js` 的 `generateTitleAsync().then` 用**整记录 save()** 回写,`events` 是首轮捕获的快照。若用户在标题生成期间发出第二轮,晚到的标题保存会用首轮事件覆盖第二轮已落盘的事件(最终一致性受损;标题本身正确)。
缓决原因:窗口小(标题请求只发一次、通常秒回),需要用户在亚秒级内发第二轮才触发。
重开条件:立即修——改为只 patch title 字段,或回写前校验会话 `lastAccessedAt`/事件数未增长。
状态:**待修**。

## B2 — LLM 历史最后防线:空消息清洗 + 相邻同 role 修复

来源:同上 A1。pie `history-validation.ts` 的机制:发送前 drop 空消息(Kimi 对空 assistant 400)、相邻同 role 之间插哨兵消息(Anthropic 400),system 对不算违规;不可恢复输入抛专用错误;遥测只记长度+哈希。
缓决原因:当前主用模型(ModelScope/OpenAI 兼容)未实测出这两类 400,属纵深防御。
重开条件:接 Anthropic/Kimi 类严格端点,或多轮续接+插话组合后出现不明 400。
状态:待排期(~0.5d)。

## B3 — 设置页 provider 三件套

来源:同上 A2。①「测试连接」按钮走真实 chat 流(16 token + 15s 超时);②「拉取模型列表」(/v1/models 归一化);③模型元数据(vision/tools/contextWindow)驱动 token 预算,替代手填 contextWindow。
缓决原因:功能增量,不影响正确性。
重开条件:下一轮设置页改造。
状态:待排期(~1d)。

## B4 — eval 轻量回归集

来源:同上 C1。把 `.agent-test/*.mjs` 三个 live 脚本升级为固定任务集(每任务 JSON:prompt/桩/断言)+ 汇总,支持改 prompt 或换模型后一键回归。
缓决原因:目前 prompt 变更频率低,手测可覆盖。
重开条件:prompt 开始频繁迭代、或接入第二个 provider 需要对比。
状态:待排期(~1d)。

## B5 — 技术方案 Q4:确认卡会话级授权

来源:docs/agent-assist-tech-design.md §8.2 / docs/adr/0002 已知欠账。
内容:test_js 确认卡加「本会话允许试跑代码」复选框(面板卸载/中止即失效);确认卡按 §8.2 展示目标页标题、代码行数、CSP 提示。方案语义:仅 test_js 可用会话授权,workflow 写操作永不允许。
缓决原因:每轮确认的摩擦尚可接受;会话授权扩大了免确认面,需要与 T2"知情执行"再对齐一次。
重开条件:用户反馈确认过于频繁。
状态:待决策。

## B6 — agent:run-js 完整执行路径

来源:tech-design §7.4;code-review Spec 轴 (c)2。
内容:现实现为 `new Function` 同步求值(async 已补,10s 超时已补),方案中的 CSP 违规监听、严格 CSP 页面走 chrome.debugger 降级、Firefox 守卫、console 捕获未做。
缓决原因:目标页多为普通站点,executeScript MAIN world 可用;debugger 降级会引入调试横幅等 UI 代价,需要单独设计。
重开条件:用户报告在严格 CSP 页面 test_js 全部失败。
状态:待决策。

## B7 — 中止后的"上一轮被中断"提示

来源:docs/agent-multi-session-plan.md P3。
内容:newtab/助手页被关 = loop 消失;重开页面时若发现当前会话末尾有未收尾事件(悬空 tool_calls 已被 wire 净化,可安全续接),给一条 system-notice 告知用户。
缓决原因:净化已保证不炸,只是缺提示。
重开条件:与 P3 插话/会话 UI 下一轮迭代一起做。
状态:待排期(小)。

## B8 — 编辑器 activeUiTab 高亮(agent tab 时代遗留)

来源:tech-design 接线表。原指编辑器内 agent tab 的激活态,agent 入口已迁主面板(docs/adr/0001),本项**随迁移作废**,除非独立助手页引入编辑器联动。
状态:已作废。

---

## 已清

- (暂无;2026-10-03 code-review 的 14 项修复不在本登记范围,见 git 历史与 docs/adr/0001~0003)
