/**
 * 在 node 里把 `.vue` 渲成 HTML 字符串（T-128① 档）。
 *
 * 为什么需要：本仓面板的验证手段是「读源文本」（readFileSync + 正则），
 * 于是**运行期条件对守卫隐形** —— T-16 的变异测试里，「把复制按钮包进
 * v-if=false」是 8 条变异中唯一测不出来的一条：按钮永不渲染，源码文本一字没少。
 * 有了渲染，「这个按钮到底在不在 DOM 里」就是可断言的事实。
 *
 * 这一档只求「渲出来」，**不跑浏览器**：
 *   - parse + compileScript({ inlineTemplate: true }) 把 SFC 编成渲染函数；
 *   - vue/server-renderer 的 renderToString 出 HTML。
 * 能盖住：v-if 有没有生效、class 有没有、组件有没有渲染、引用了哪个文案键。
 * **盖不住**：
 *   - 点击、剪贴板、真实布局、滚动、hover 视觉 —— 要 T-128②（test-utils + jsdom）；
 *   - **watcher 驱动的状态**。SSR 不跑 watcher（AgentTranscript 的槽位折算就靠
 *     `watch(() => [props.events, ...])`），所以「有事件之后空态消失」这类断言在
 *     这里测不到 —— 浏览器里 post-flush 在首帧前就跑完了，用户看不到中间态，
 *     不是产品缺陷，是这一档的边界。测这类要用 ②。
 *
 * 最要紧的一个能力是 `source` 覆盖：调用方可以传一份**改过的源码**进来，于是
 * 「把按钮包进 v-if=false 之后渲染结果里应当没有它」能写成普通单测，不必像静态
 * 守卫那样靠变异探针在磁盘上真改文件。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sfc from '@vue/compiler-sfc';
import { h, createSSRApp } from 'vue';
// vue 的 exports map 只暴露不带扩展名的这个说明符（node_modules/vue/package.json
// 里有 "./server-renderer" 键），而仓库的 import/extensions 规则要求带扩展名 ——
// 加 .mjs 反而解析不到，这里按实际情况豁免。
// eslint-disable-next-line import/extensions
import { renderToString } from 'vue/server-renderer';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT = path.join(ROOT, '.scratch', 'sfc-render');

// webpack 的 DefinePlugin 常量（webpack.config.js:151）在 node 里不存在：
// `src/utils/shared.js:55` 直接引用 IS_OFFLINE，不补就在导入期 ReferenceError。
// 取 true —— 与默认 offline 构建一致（AGENTS.md「命令与本机坑」）。
// eslint-disable-next-line no-undef -- webpack 的编译期常量，node 里本来就不存在
globalThis.IS_OFFLINE = true;
// 同上（webpack.config.js:151 那一组 DefinePlugin 常量）：`src/utils/message.js:4`
// 引用 BROWSER_TYPE。渲染测试只关心组件结构，取 chrome 分支。
// eslint-disable-next-line no-undef -- 同上
globalThis.BROWSER_TYPE = 'chrome';

// 全局组件（项目用 kebab-case 全局注册的那些）。SSR 里未注册的组件只会渲成一段
// 警告 + 注释节点，既吵又让断言看不准，统一换成带 data-stub 的占位。
const GLOBAL_STUBS = [
  'v-remixicon',
  'ui-textarea',
  'ui-button',
  'ui-dropdown',
  'ui-input',
  'agent-markdown',
  'agent-tool-step',
  'agent-session-list',
  'agent-dropdown',
  'agent-tab-picker',
  'agent-confirm-card',
];

// 说明符用 (.) + 反向引用匹配引号，单双引号两种写法都能吃到，不用写两套。
// **字符类里必须排除引号与换行**：只写 [^\\] 的话它能跨行，于是
// `from 'vue';\nimport X from './Foo.vue'` 会被当成一条说明符
// （`vue';` 后面一直吃到 `.vue` 才遇上闭合引号）—— 于是 `{ computed }` 被从
// 占位模块里 import，渲染直接报「does not provide an export named 'computed'」。
const FROM_RE = /(from\s+)(.)([^'"\\]*?)\2/g;
const VUE_FROM_RE = /(from\s+)(.)([^'"\\\r\n]*\.vue)\2/g;

const I18N_STUB = [
  '// 生成的桩：渲染测试不跑真的 vue-i18n。t 返回键名本身 —— 断言要看的是',
  '// 「渲染出来没有」，不是文案；文案由 check:i18n 与静态守卫管。',
  'export const useI18n = () => ({ t: (key) => key });',
  'export const createI18n = () => ({ global: { t: (key) => key } });',
  'export default { useI18n, createI18n };',
].join('\n');

const STUB_MODULE = [
  "import { h } from 'vue';",
  "export default { name: 'Stub', render: () => h('i', { 'data-stub': 'component' }) };",
].join('\n');

let seq = 0;

/**
 * 把无扩展名的说明符补成真实文件：`@/agent` 是**目录**，补 `.js` 会得到不存在的
 * `src/agent.js`（ERR_MODULE_NOT_FOUND），得回落到 `index.js`。
 */
function resolveSrc(base) {
  for (const cand of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return `${base}.js`;
}

/** 把编译产物里的 import 说明符改成 node 能解析的 URL。 */
function rewriteImports(code, sfcPath) {
  return code.replace(FROM_RE, (m, from, q, spec) => {
    let target = spec;
    if (spec === 'vue-i18n') {
      target = pathToFileURL(path.join(OUT, 'i18n-stub.mjs')).href;
    } else if (spec.startsWith('@/')) {
      target = pathToFileURL(
        resolveSrc(path.join(ROOT, 'src', spec.slice(2)))
      ).href;
    } else if (spec.startsWith('.')) {
      target = pathToFileURL(
        resolveSrc(path.resolve(path.dirname(sfcPath), spec))
      );
    }
    return from + q + target + q;
  });
}

/**
 * 编译一个 SFC 并返回组件对象。`source` 可传改过的源码（变异场景）。
 */
export async function compileSfc(relPath, source) {
  const abs = path.join(ROOT, relPath);
  const text = source ?? readFileSync(abs, 'utf8');
  const parsed = sfc.parse(text, { filename: relPath });
  if (parsed.errors && parsed.errors.length) {
    throw new Error(`解析 ${relPath} 失败：${parsed.errors[0].message}`);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'i18n-stub.mjs'), I18N_STUB);
  writeFileSync(path.join(OUT, 'stub-module.mjs'), STUB_MODULE);

  const compiled = sfc.compileScript(parsed.descriptor, {
    id: relPath,
    inlineTemplate: true,
  });
  const stubUrl = pathToFileURL(path.join(OUT, 'stub-module.mjs')).href;
  // 子组件（相对导入的 .vue）先换成占位组件；@/ 与相对 .js 交给 rewriteImports
  let code = compiled.content.replace(
    VUE_FROM_RE,
    (m, from, q) => from + q + stubUrl + q
  );
  code = rewriteImports(code, abs);

  const outFile = path.join(OUT, `c-${(seq += 1)}.mjs`);
  writeFileSync(outFile, code);
  // 绕开 ESM 缓存：同一进程里连着渲多个版本时，否则第二次拿到的还是上一次的
  // 编译结果 —— 变异用例会因此假绿。
  const mod = await import(`${pathToFileURL(outFile).href}?v=${seq}`);
  return mod.default ?? mod;
}

/**
 * 把组件渲成 HTML。
 *
 * @param {string} relPath 相对仓库根的 .vue 路径
 * @param {Object} [opts]
 * @param {Object} [opts.props] 组件 props
 * @param {string} [opts.source] 改过的源码（变异场景），不给就读磁盘
 * @returns {Promise<string>} 渲染出的 HTML
 */
export async function renderSfc(relPath, opts = {}) {
  const component = await compileSfc(relPath, opts.source);
  const app = createSSRApp(component, opts.props ?? {});
  for (const name of GLOBAL_STUBS) {
    app.component(name, {
      name,
      // 占位组件要如实声明收到的 prop（数组写法会触发 vue/require-prop-types 警告）
      props: {
        raw: { type: String, default: '' },
        model: { type: String, default: '' },
        step: { type: [Object, Number], default: null },
        sessions: { type: Array, default: () => [] },
      },
      setup: (p) => () => h('i', { 'data-stub': name }, p.raw ?? ''),
    });
  }
  return renderToString(app);
}
