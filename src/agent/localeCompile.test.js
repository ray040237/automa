/**
 * 文案必须真的能被 vue-i18n 编译（T-170 回归）。
 *
 * 教训：给 pickTab.attach 写了 "@ 选择目标页"，vue-i18n 把开头的 `@` 当成
 * **链接消息**（`@:key` / `@.modifier:key`）的前缀 —— 编译报 "Invalid linked
 * format"；而 @intlify/vue-i18n-loader 处理编译错误时去读 `error.message`，
 * 读到 undefined，于是抛「Cannot read properties of undefined (reading
 * 'message')」，整个 locale 模块构建失败；webpack 的 NoEmitOnErrorsPlugin
 * 跟着**什么都不 emit**。
 *
 * 最坏的是它全程静默：utils/build.js 只 throw 致命 err、不检查
 * stats.hasErrors()，命令行 exit 0、进度条照常打到 100%，而 build/ 是空的 ——
 * 打进 zip 的会是上一次的旧产物。check:i18n 只查「键是否对齐、有没有硬编码
 * 串」，查不出一条值的语法；渲染测试里 i18n 是桩（t 返回键名），也查不出。
 * 于是这一类只能靠**真的拿编译器把每条值编一遍**来守。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

/**
 * 找到 @intlify/message-compiler。
 *
 * 它不是本项目的顶层依赖（是 vue-i18n-loader 带进来的），pnpm 布局下藏在
 * node_modules/.pnpm/<pkg>@<ver>/node_modules/ 里，版本目录会变 —— 所以先试
 * 正常解析，再扫 .pnpm，都找不到就**让守卫失败**而不是跳过：跳过等于这条
 * 教训下次还会再踩一遍。
 */
function loadCompiler() {
  for (const id of ['@intlify/message-compiler']) {
    try {
      // 同下：这里也刻意走变量而不是字面量 require，让「先按包名解析」
      // 和「按 .pnpm 目录拼路径」两条路走同一份代码。
      // eslint-disable-next-line import/no-dynamic-require
      return require(id);
    } catch {
      /* 落到下面扫 .pnpm */
    }
  }

  const store = join(ROOT, 'node_modules/.pnpm');
  if (existsSync(store)) {
    const dirs = readdirSync(store)
      .filter((d) => d.startsWith('@intlify+message-compiler@'))
      .sort();
    for (const d of dirs) {
      const p = join(store, d, 'node_modules/@intlify/message-compiler');
      if (existsSync(join(p, 'package.json'))) {
        // 这一处必须是动态的：@intlify/message-compiler 不是顶层依赖，
        // 路径里的版本目录（9.14.5 之类）随 lockfile 变，写成字面量等于
        // 把这个守卫绑死在某一个版本上。所以 import/no-dynamic-require 在此豁免。
        // eslint-disable-next-line import/no-dynamic-require
        return require(p);
      }
    }
  }

  return null;
}

/** 把所有叶子字符串摊平成 [路径, 值]。 */
function flatten(obj, prefix, acc) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') acc.push([path, value]);
    else if (value && typeof value === 'object') flatten(value, path, acc);
  }
  return acc;
}

function localeFiles() {
  const dir = join(ROOT, 'src/locales');
  const out = [];

  for (const lang of readdirSync(dir)) {
    const langDir = join(dir, lang);
    if (!statSync(langDir).isDirectory()) continue;

    for (const f of readdirSync(langDir)) {
      if (f.endsWith('.json')) out.push([`${lang}/${f}`, join(langDir, f)]);
    }
  }
  return out;
}

/**
 * 读一个 locale 文件：先按严格 JSON 读，读不出来再按 JSON5 读。
 *
 * 为什么要 JSON5：webpack 那条规则是 `test: /\.(json5?|ya?ml)$/` + `type:
 * 'javascript/auto'`，交给 @intlify/vue-i18n-loader **自己**解析，它吃的是
 * JSON5 —— vi/common.json 里就有不加引号的键，严格 JSON.parse 直接失败。
 * 只按 JSON 读会把 vi 整门语言静默跳过（守卫变成只守我们手写的那三门）。
 */
function parseLocale(file) {
  const text = readFileSync(file, 'utf8');

  try {
    return JSON.parse(text);
  } catch {
    return require('json5').parse(text);
  }
}

test('T-170：每条文案都要能被 vue-i18n 编译（构建期 i18n-loader 会静默崩）', () => {
  const compiler = loadCompiler();
  assert.ok(
    compiler && typeof compiler.baseCompile === 'function',
    '找不到 @intlify/message-compiler，守卫失效 —— 这条断言不能跳过'
  );

  const bad = [];
  for (const [name, file] of localeFiles()) {
    let json;
    try {
      json = parseLocale(file);
    } catch (e) {
      bad.push(`${name}: 解析失败 ${e.message}`);
      continue;
    }

    for (const [key, value] of flatten(json, '', [])) {
      let first = null;
      try {
        compiler.baseCompile(value, {
          onError: (e) => {
            first = first || e;
          },
          onWarn: () => {},
          location: false,
        });
      } catch (e) {
        first = first || e;
      }
      // 只报第一条：一条值有多个错时，第一处就是根因
      if (first) {
        bad.push(
          `${name} :: ${key} :: ${value.slice(0, 30)} :: ${
            first.message || first
          }`
        );
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    [
      '这些文案编译不过 —— 构建时 @intlify/vue-i18n-loader 会崩，',
      'webpack 于是什么都不 emit（exit 0、build/ 空，打进 zip 的是旧产物）：',
      ...bad,
    ].join('\n')
  );
});
