# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/<feature-slug>/`.

> **注意 `.scratch/` 已 gitignore**（`.gitignore:50`）。这意味着 issue 文件不进版本库，
> 换机器就没了。对本仓库的补偿做法：**结论与实测数据写进 `docs/adr/`**，
> `.scratch/` 只放过程材料（PoC 脚本、可重跑的证据、基线快照）。

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## 本仓库的额外约定：进版本库的重构文档

`AGENTS.md` 规定待办走 `docs/backlog.md`，那是**人类待办**。本文件描述的是
`/to-spec`、`/to-tickets`、`/implement` 这一套 agent 工程流水的落点。

**当 spec 或 tickets 描述的是「为什么这么定」而不只是「接下来做什么」时，写进版本库：**

| 内容 | 位置 |
| --- | --- |
| 架构决策与实测依据 | `docs/adr/NNNN-*.md` |
| 重构的 spec 与 tickets | `docs/<feature>-spec.md`、`docs/<feature>/issues/NN-<slug>.md` |
| 一次性探针脚本、基线快照、取证文件 | `.scratch/<feature>/`（不进版本库） |

理由：`docs/backlog-done.md` 里44 条已解决条目每条都带完整实测证据，
「某个坑当初怎么被实测出来的」必须能追溯。纯过程材料留在 `.scratch/`，
结论与数据进版本库。

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/`（creating the directory if needed），
或按上表写进 `docs/`。

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.