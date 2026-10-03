# agent DOM 验证

这些测试在真实 Chromium 里跑 `handlerAgentReadPage.js`，验的是纯逻辑（重复项检测、
detail 三档的取舍、畸形页面不崩），不验扩展的加载流程。

## 为什么单开一个命令

playwright 不是本项目的依赖 —— 它只存在于本机 npx 缓存里。所以不塞进 `npm test`，
否则没装浏览器的人会直接跑挂。

## 跑法

```bash
npm run test:dom
```

## 换机器时的两件事

1. 装 playwright：`npm i -D playwright`（或用 `npx playwright install chromium`）
2. `.agent-test/node_modules` 是一个指向 npx 缓存的目录联接，换机器要重做：

   ```powershell
   Remove-Item .agent-test\node_modules
   New-Item -ItemType Junction -Path .agent-test\node_modules `
     -Target "<playwright 所在的 node_modules>"
   ```

## 文件

| 文件 | 作用 |
|---|---|
| `handler.iife.js` | 由 `handlerAgentReadPage.js` 生成：把 `export default` 换成挂到 `window` 上的赋值，这样能直接 `addScriptTag` 注入。**生成物，不要手改。** |
| `fixture-list.html` | 手工看的示例页，跑测试时其实用的是内联 HTML |
| `dom.test.mjs` | 断言 |
| `verify.mjs` | 不带断言，跑一遍把输出打出来，用来看真实结果长什么样 |

## 重新生成 handler.iife.js

`handlerAgentReadPage.js` 改了之后要重新生成：

```js
const src = fs.readFileSync('src/content/blocksHandler/handlerAgentReadPage.js', 'utf8');
const i = src.indexOf('export default async function readPage');
const bundled = src.slice(0, i) + 'window.__agentReadPage = ' + src.slice(i + 'export default '.length) + ';';
fs.writeFileSync('.agent-test/handler.iife.js', bundled);
```

注意**不要**连函数头一起复制一遍 —— 那样外层函数体里只会剩一个没被调用的声明，
调用返回 `undefined`，而且不报错。
