/**
 * `@business` 的空实现占位（webpack alias 的落点）。
 *
 * 为什么存在：上游把闭源商业代码放在顶层 `business/` 目录，只开源这几个空壳
 * 让 webpack 能解析 `@business` alias。`LICENSE.txt` 的判定是按路径的——顶层
 * `business/` 目录内的源码属 Automa Commercial License，其余属 AGPL。本 fork
 * 不携带商业代码，所以把等价空实现搬到 `src/`（AGPL 区），使仓库里不再有
 * 商业许可文件。
 *
 * 契约：必须是 default export 且返回 undefined —— 调用方拿到的是 `automa`，
 * 上游商业版在此挂载自定义能力，空实现只提供可解析的占位。
 * 改这里之前先看 `webpack.config.js` 里 `@business` 的 alias 指向。
 */
export default function () {}
