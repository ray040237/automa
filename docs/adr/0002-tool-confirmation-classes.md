# 0002 — 工具确认门分级偏离技术方案:write 以外的实际归类

日期:2026-10-03
状态:已实施(未提交)
关联:docs/agent-assist-tech-design.md §7.2 / §8.2、src/agent/tools/(index.js 顶部注释为契约原文)

## 背景

技术方案 §7.2 规定工具按 read/write 分级,write 必须过用户确认门,并给出初始分类。实施过程中有两个工具的分类与方案不一致,且有实测依据。本 ADR 把偏离本身记录成决策,避免后来者"纠正回 spec"时无意削弱或破坏交互。

## 决定

1. **`highlight_selector` 归 `write`(过确认门),偏离方案的 read 分类。**
   理由:它确实修改用户正在看的页面(描边 + 自动滚动)。"只是展示性改动"不构成免确认的理由——"模型每说一句就改一次你的页面"本身应当由用户点头;且确认卡上直接显示选择器,用户点「允许」恰好回答了"你说的是这个吗"。把它算成 read 是拿一致性换方便(见 highlight.js 顶部注释)。

2. **`focus_tab` 归 `read`(免确认),偏离 multi-session plan §2.3 的 write 分类。**
   理由:它只改 agent 内部的目标页指针,不改用户浏览器的任何状态(不 activate、不导航),风险面与 query_elements 相同;过确认门会把跨页任务的确认次数翻倍而无信息增益。需要让**用户**看到某页时的行为(activate_tab)本版未实现,将来实现时归 `write`。

3. `test_js`、`open_url`、`add_block`、`update_block` 维持 `write`;所有 read 类工具免确认——与方案一致,此处仅存档。

**兜底不变式**(不因分类调整而动摇):分类缺失或未知工具一律按需确认处理(`requiresConfirmation` 对未知工具返回 true);`validateTools` 在模块加载期强制每个工具显式声明 class,缺声明直接 throw,不存在"默认放行"。

## 被拒备选

- **方案原文的分类(highlight=read / focus_tab=write)**:见上文各自理由;highlight 的 read 分类会把页面改动藏进免确认通道,focus_tab 的 write 分类在跨页任务里制造无信息确认。
- **引入第三档 "soft-write"(展示性改动免确认)**:多一个分类就多一条要审的边界,当前只有 highlight 一个候选,不值得为一例开档。若未来出现批量展示性工具再重评。

## 已知欠账

- 方案 Q4 的「本会话允许试跑代码」会话级授权复选框未实现(每轮确认),确认卡也未按 §8.2 展示目标页标题/代码行数/CSP 提示——记入 docs/backlog.md B 区。
