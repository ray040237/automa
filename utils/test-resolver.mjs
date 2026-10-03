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

  // webpack alias：@/utils/x → src/utils/x
  if (specifier.startsWith('@/')) {
    const hit = resolveAlias(path.join(SRC, specifier.slice(2)));

    if (hit) return nextResolve(pathToFileURL(hit).href, context);
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
