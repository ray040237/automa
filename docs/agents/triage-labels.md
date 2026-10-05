# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## 本仓库的落地形式

本仓库用本地 markdown（`.scratch/<feature>/issues/NN-<slug>.md`），没有 GitHub label。
角色以每个 ticket 文件顶部的 `Status:` 行记录，取值同上表。

`/to-spec` 产出的 spec 标 `ready-for-agent`（无需额外 triage）。

注意：本仓库另有一套**人类待办**体系 `docs/backlog.md`（T 编号 + B 编号），
那是 `AGENTS.md`「发现即登记」流程的落点，与本文件的五个角色**是两件事**：

| | `docs/backlog.md` | `.scratch/<feature>/issues/` |
| --- | --- | --- |
| 记什么 | 发现的 bug / 改进 / 新想法 | 一次重构的 spec 与实施票据 |
| 谁写 | 任何人，会话中随时追加 | 规划阶段一次成型 |
| 进版本库 | 是 | 否（结论与实测数据另写进 `docs/adr/`） |
| 状态词 | 待审核 / 已批准 / 进行中 | 上表五档 |