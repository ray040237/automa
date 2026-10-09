import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * T-194 的守卫：offline 构建的 CSP 收紧必须真的发生，且措辞一变就炸。
 *
 * 这组断言存在的理由：那段替换原先内联在 webpack.config.js 里，跑不到也测不了，
 * 用的是 String.replace 的精确匹配 —— 匹配不到就静默返回原串。所以一个安全加固
 * 可能悄悄失效而全绿。这里把三种情形钉死：该收紧的收紧了、不该动的没动、
 * 目标串找不到时抛错（而不是静默放过）。
 */
const require = createRequire(import.meta.url);
// eslint-disable-next-line import/extensions -- CJS 纯函数，webpack 里也被 test 与构建共用
const { applyOfflineCsp, CSP_REMOTE_SNIPPET } = require('./manifestCsp');

// 与 src/manifest.firefox.json 的实际取值同形（MV2）。
const FIREFOX_CSP =
  "script-src 'self' 'unsafe-inline' https:; object-src 'self'";

const firefoxManifest = () => ({
  manifest_version: 2,
  content_security_policy: FIREFOX_CSP,
});

// Chrome MV3：压根不声明 CSP。
const chromeManifest = () => ({
  manifest_version: 3,
  permissions: ['storage'],
});

test('offline 构建：Firefox manifest 的 CSP 被收紧，remote/inline 段消失', () => {
  const m = firefoxManifest();
  applyOfflineCsp(m, true);

  assert.ok(
    m.content_security_policy.indexOf(CSP_REMOTE_SNIPPET) === -1,
    `offline 构建后不该还留着 ${JSON.stringify(CSP_REMOTE_SNIPPET)}`
  );
  assert.equal(
    m.content_security_policy,
    "script-src 'self'; object-src 'self'",
    '应恰好抠掉那一段，其余原样保留'
  );
});

test('full 构建（offline=false）：CSP 一字不动', () => {
  const m = firefoxManifest();
  applyOfflineCsp(m, false);
  assert.equal(m.content_security_policy, FIREFOX_CSP);
});

test('offline 构建但 manifest 未声明 CSP（Chrome MV3）：原样返回，不抛错', () => {
  const m = chromeManifest();
  applyOfflineCsp(m, true);
  assert.equal(m.content_security_policy, undefined);
  assert.equal(m.manifest_version, 3);
});

test('措辞变了要炸：目标串找不到时抛错，而不是静默放过', () => {
  // 模拟有人改了 manifest 的 CSP 写法（比如换成双引号 / 调整空格），
  // 精确匹配落空 —— 这正是「静默 no-op」最可能发生的场景。
  const drifted = 'script-src "self" "unsafe-inline" https:; object-src "self"';
  const m = {
    manifest_version: 2,
    content_security_policy: drifted,
  };
  assert.throws(
    () => applyOfflineCsp(m, true),
    /找不到要移除的片段/,
    '找不到目标串必须抛错 —— 静默 no-op 会让 offline 版带着 loosened CSP 发布'
  );
  // 抛错时不该留下半改状态
  assert.equal(m.content_security_policy, drifted);
});

test('真实 manifest 文件与常量对得上（防止常量与 manifest 漂移）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const firefox = JSON.parse(
    readFileSync(path.join(here, '../src/manifest.firefox.json'), 'utf8')
  );

  assert.ok(
    firefox.content_security_policy.includes(CSP_REMOTE_SNIPPET),
    `src/manifest.firefox.json 的 CSP 里应含 ${JSON.stringify(
      CSP_REMOTE_SNIPPET
    )} —— 若这条红了，说明 manifest 改了措辞，CSP_REMOTE_SNIPPET 要同步（T-194）`
  );
});
