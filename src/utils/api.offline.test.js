import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * `src/utils/api.js` 的 offline 门契约测试（T-192）。
 *
 * 背景：全仓 `IS_OFFLINE` 27 处、散布 21 文件，但**所有测试里它恒为 false**
 * （`blocksHandler.test.js:43`、`facts.test.js:12`）—— 所有 offline 分支在测试中
 * 永不执行。这一套只收敛到最要紧的一类：**返回形状契约**。因为调用方是按形状
 * 消费的，形状错了就是静默出错（`App.vue:141` 判了空、`SettingsBackup.vue:309`
 * 没判空，同一个 `{}` 两种处理 —— 那就是 T-193）。
 *
 * 注意：`IS_OFFLINE` 是 webpack DefinePlugin 注入的编译期全局，模块体在 import
 * 时就会求值 `if (IS_OFFLINE)`。ESM 的 import 是提升的、先于 test body 执行，
 * 所以**必须在 import 之前**把 globalThis 设好。这里用动态 import 保证顺序。
 */
// eslint-disable-next-line no-undef -- webpack DefinePlugin 注入的编译期全局
globalThis.IS_OFFLINE = true;

// eslint-disable-next-line import/extensions -- 显式要 api.js 本体，见文件头
const api = await import('./api.js');

test('fetchApi：offline 下抛错，带可识别文案', async () => {
  await assert.rejects(
    () => api.fetchApi('/workflows'),
    /disabled in offline mode/,
    'offline 下 fetchApi 必须抛错 —— 云端能力应被剥掉而不是静默失败'
  );
});

test('fetchGapi：offline 下抛错（Google 服务）', async () => {
  await assert.rejects(
    () => api.fetchGapi('https://www.googleapis.com/x'),
    /Google services are disabled in offline mode/
  );
});

test('getSharedWorkflows：offline 下返回可安全解构的形状', async () => {
  const res = await api.getSharedWorkflows();
  assert.equal(typeof res, 'object');
  assert.notEqual(res, null, '不能返回 null —— 调用方直接读属性会抛');
});

test('getUserWorkflows：offline 返回值必须能被 { backup, hosted } 解构', async () => {
  // 这是 T-193 的根因所在：调用方拿 `const { backup, hosted } = await ...`，
  // 若返回 null 会当场抛。返回 {} 时两个字段是 undefined —— 调用方必须判空，
  // 但至少解构本身不能炸。本断言把这个「解构安全」契约钉住。
  const res = await api.getUserWorkflows();
  assert.equal(typeof res, 'object');
  assert.notEqual(res, null);

  const { backup, hosted } = res;
  assert.equal(
    backup,
    undefined,
    'offline 下没有云端备份，应是 undefined 而非别的假值'
  );
  assert.equal(hosted, undefined);
});

test('validateOauthToken：offline 下返回 null（不是 reject）', async () => {
  // 形状契约：调用方 await 它并判真值决定是否继续，抛错会打断调用方流程。
  assert.equal(await api.validateOauthToken(), null);
});
