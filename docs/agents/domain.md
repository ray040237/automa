# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root —— **本项目的术语表叫这个名字，不叫 `GLOSSARY.md`**
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

> ⚠️ 标准 skill 模板让读 `GLOSSARY.md` / `GLOSSARY-MAP.md`，**本仓库两者都不存在**，
> 术语与禁用词在 `CONTEXT.md`。读到 `GLOSSARY.md` 缺失时**不要报错、也不要新建**，
> 直接读 `CONTEXT.md`。

如果上述文件不存在，**静默继续**。不要提前flag 它们的缺失。

## File structure

Single-context repo（本仓库）:

```
/
├── CONTEXT.md          <- 术语表 + 禁用词 + 文档地图
├── AGENTS.md           <- 红线、命令与本机坑、发现即登记流程
├── docs/
│   ├── adr/            <- 0001~0004
│   ├── agents/         <- 本目录，工程流水线的配置
│   ├── backlog.md      <- 未完成的待办（T 编号 + B 编号）
│   └── backlog-done.md <- 已完成档案，只用于追溯
└── src/
```

Multi-context（`GLOSSARY-MAP.md` 存在时）:本仓库不适用。

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

`CONTEXT.md` 的 `_Avoid_:` 段落列的是**禁用词**，本仓库最容易踩的几个：

| 别用 | 用 |
| --- | --- |
| transcript（已废弃） | 展示折叠内联在渲染层 |
| activeTab | 目标页 / targetTab |
| 闸门 / 校验失败 | 预检 / preStepNotice |
| result | 观察值 / observation |
| 「卡片被藏起来了先挂着」 | 确认门必须 `resolve(false)` |

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

本仓库最相关的两条：

- **ADR 0001** 助手独立入口 —— 决定宿主①独立助手页的存在
- **ADR 0002** 工具确认门分级 —— `class: read|write`，缺失或未知一律按需确认
- **ADR 0003** SSE 解析器用外部依赖 —— **pi 迁移会推翻这条**，已在 ADR 0004 里记录偏离理由
- **ADR 0004** pi-agent-core 迁移 —— 本次重构的边界与三条红线约束

## 本仓库的额外要求

- **实测优先**：结论要么带实测输出，要么明确标注「推断，未实测」。拿推测冒充结论在本项目是最严重的错。
- **发现即登记**：读代码/跑测试时发现的 bug、用户提到的改进、新想法，先落 `docs/backlog.md` 再动手。