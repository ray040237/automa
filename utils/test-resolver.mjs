/**
 * 测试用的 ESM 解析钩子。做三件事：
 *
 * 1. 把无扩展名的相对导入补成 .js —— airbnb-base 的 import/extensions: 'never'
 *    强制源码写 from './events' 而非 './events.js'，webpack 能解析，Node 不能。
 *    改源码会违背仓库约定，加钩子则源码原样、测试零依赖。
 * 2. 处理 @/ 别名（webpack alias → src/）。
 * 3. 把 webextension-polyfill 换成测试桩。
 *
 * 后两条是为了让装配层 src/agent/index.js 也能进测试。
 * 它曾经是整个 agent 里唯一测不到的文件 —— 不是因为逻辑复杂，
 * 纯粹是因为 import 了别名和浏览器 API。
 * 用户报的「tasks.reduce is not a function」就住在那里。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const CANDIDATES = ['', '.js', '/index.js'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
// 桩放在 src/agent/__stubs__：eslint 的 webpack resolver 解析不了 src 之外的路径，
// 放进去就不会对每个 import 到桩的测试文件刷 parse error。
// webpack 构建不会打包它们 —— 只有测试文件会 import。
const STUB = path.resolve(HERE, '../src/agent/__stubs__');

/**
 * 只桩掉会把整个应用层拖进来的那三个模块。
 *
 * 试过别的办法：直接注入 chrome / BROWSER_TYPE 等全局，结果依赖闭包一路走到
 * BrowserAPIService —— 那已经是在 Node 里重建浏览器了，迟早还要补下一个全局。
 * 按边界桩掉才可控。
 *
 * 注意 @/utils/shared 不在名单里：真实块目录正是要验的对象，不能桩。
 */
const STUBBED = new Set([
  '@/utils/credentialUtil',
  '@/utils/codeEditorAutocomplete',
  '@/workflowEngine/templating/templatingFunctions',
]);

/**
 * T-192：offline 门契约测试要 import `src/utils/api.js`，而它顶层就引
 * `secrets`（webpack externals，Node 解析不到）与 BrowserAPIService（读浏览器 API）。
 *
 * **刻意只对 api.js / helper.js 生效**：给这两个模块全局加桩会让一批 workflowEngine
 * 处理器（handlerAiWorkflow / handlerGoogleSheets…）也变成「能在 node 里加载」，
 * 从而打破 `blocksHandler.test.js` 的「可导入清单被钉住」守卫 —— 那条守卫明确
 * 把「桩改动」列为要察觉的变化。T-192 的范围是 api.js 的返回形状契约，
 * 不该顺手扩大引擎侧的可导入面，所以按 parent 精确限定。
 */
const SCOPED_STUBS = new Set([
  'secrets',
  '@/service/browser-api/BrowserAPIService',
]);

/**
 * 放行名单要连 `helper.js` 一起算 —— 它不是 api.js 本身，但住在 api.js 的
 * 依赖链上（`api.js` → `./helper`），而 helper.js 顶层同样 import 了
 * BrowserAPIService。只认 api.js 的话，真实 BrowserAPIService 会从 helper.js
 * 这一侧被拉进来，一路走到 @/utils/message 的顶层 `BROWSER_TYPE`。
 *
 * **必须按绝对路径匹配，不能按 basename。** 曾经按 basename('api.js') 放行，
 * 结果 `workflowEngine/blocksHandler/handlerGoogleSheets.js` →
 * `@/utils/googleSheetsApi` → `./api`（同样叫 api.js）也吃到了桩，
 * 于是 13 个处理器凭空变成「node 里可导入」，打红 blocksHandler 的可导入清单守卫。
 * 引擎侧 import api.js 是为了做真实的 cloud 调用（fetchApi/fetchGapi），
 * 它该继续在 `secrets` 那一步失败 —— 那不是本测试要放开的面。
 */
const SCOPED_STUB_PARENTS = new Set([
  path.resolve(SRC, 'utils/api.js'),
  path.resolve(SRC, 'utils/api.offline.test.js'),
]);

/**
 * `helper.js` 有两条进入路径，形状不同：
 *   - `api.js` → `'./helper'`（相对）—— api 的依赖链，必须发桩；
 *   - 引擎处理器 → `'@/utils/helper'`（别名）—— 只取 parseJSON/isObject，
 *     不碰 BrowserAPIService（那里只用在 clearCache 内），不该吃到桩。
 *
 * 难点：helper.js 自己 import BrowserAPIService 用的 specifier 两条路完全一样，
 * 光看 specifier 分不开。所以用一张「记账表」——在解析 `./helper` 且进口方是
 * api.js 时，把 helper.js 的绝对路径记下来；等 helper.js 去 import
 * BrowserAPIService 时再查表，命中才发桩。别名侧进来的 helper 不入表，
 * 于是 handlerGoogleSheets / handlerDataMapping / handlerLoopData /
 * handlerSortData / handlerGoogleSheetsDrive 照旧加载失败，
 * blocksHandler 的可导入清单守卫保持原义。
 */
const RELATIVE_HELPER = new Set(['./helper', './helper.js']);

/** api 依赖链上的 helper.js 绝对路径（解析 './helper' 时登记）。 */
const apiChainHelperPaths = new Set();

/** 只有 api.js 自己（及它的测试）在放行名单里。 */
function isApiJsImporter(parentURL) {
  if (!parentURL) return false;
  return SCOPED_STUB_PARENTS.has(path.resolve(fileURLToPath(parentURL)));
}

function resolveAlias(base) {
  for (const suffix of ['', '.js', '/index.js']) {
    const full = base + suffix;

    if (existsSync(full)) return suffix === '' ? null : full;
  }

  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // 浏览器 API 在 Node 里不存在，换成测试桩
  if (specifier === 'webextension-polyfill') {
    return {
      url: pathToFileURL(path.join(STUB, 'webextension-polyfill.js')).href,
      shortCircuit: true,
    };
  }

  // 按边界桩掉重依赖，避免把整个应用层拖进测试
  if (STUBBED.has(specifier)) {
    return {
      url: pathToFileURL(path.join(STUB, path.basename(specifier) + '.js')).href,
      shortCircuit: true,
    };
  }

  // T-192：scoped 桩，仅对 src/utils/api.js 这条链生效（见 SCOPED_STUBS 注释）。
  if (SCOPED_STUBS.has(specifier)) {
    const parent = context.parentURL ? path.resolve(fileURLToPath(context.parentURL)) : null;
    const fromApi = isApiJsImporter(context.parentURL);
    // api.js 用相对路径拉起 helper.js 时，把 helper.js 记进「api 链」，
    // 等它 import BrowserAPIService 时才能认出来（specifier 两条路一样）。
    const fromApiChainHelper = parent !== null && apiChainHelperPaths.has(parent);

    if (fromApi || fromApiChainHelper) {
      return {
        url: pathToFileURL(path.join(STUB, path.basename(specifier) + '.js')).href,
        shortCircuit: true,
      };
    }
  }

  // webpack alias：@/utils/x → src/utils/x
  if (specifier.startsWith('@/')) {
    const target = path.join(SRC, specifier.slice(2));
    const hit = resolveAlias(target);

    // api.js 用相对路径拉起 helper 时，Node 也会走到这里（'./helper' 不是别名，
    // 见下面相对分支），故此处的别名命中不需要登记 —— 登记统一放在相对分支。
    if (hit) return nextResolve(pathToFileURL(hit).href, context);
  }

  // api.js 用相对路径 import './helper'：把 helper.js 记进 api 链，
  // 这样它随后 import BrowserAPIService 时才发桩（specifier 两条路一样，
  // 只能靠「谁拉起的」区分）。
  if (RELATIVE_HELPER.has(specifier) && isApiJsImporter(context.parentURL)) {
    const hit = resolveAlias(path.resolve(SRC, 'utils/helper'));

    if (hit) apiChainHelperPaths.add(path.resolve(hit));
  }

  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // 裸模块：CJS 包的深路径在 Node ESM 下常缺扩展名（dayjs/plugin/relativeTime）。
    // webpack 能解析，Node 不能，所以在这里补。
    const relative = specifier.startsWith('.') || specifier.startsWith('/');

    if (!relative) {
      for (const suffix of ['.js', '/index.js']) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {
          // 试下一个
        }
      }

      throw err;
    }

    for (const suffix of CANDIDATES) {
      if (!suffix) continue;

      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        // 试下一个
      }
    }

    const parent = context.parentURL ? fileURLToPath(context.parentURL) : '(unknown)';

    throw new Error(
      '无法解析 "' +
      specifier +
      '"（来自 ' +
      parent +
      '）。纯模块必须在 src/agent 内自包含，不能 import 浏览器 API。',
      { cause: err }
    );
  }
}

// eslint-disable-next-line no-unused-vars
export function exists(p) {
  return existsSync(p);
}
