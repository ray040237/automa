/**
 * T-262：引擎错误文案的语言包契约。
 *
 * 背景：工作流引擎抛出的每条错误都会进工作流日志，`translateLog`
 * 拿 `log.message` 当 key 去查 `log.messages.<message>`，并把**整个日志对象**
 * 当插值参数传进去（`{ message, ...error.data, ...error.ctxData }`）。
 * 所以「抛 slug + 挂 error.data + 语言包写 {占位符}」三件事必须同时成立，
 * 缺一条用户看到的就是 slug 本身或没填上的 `{占位符}`。
 *
 * 这里钉住后两件事：key 在 en/zh 都存在，且占位符能从日志形状的对象里插出来。
 * 第一件事（error.data 真的挂上了）由 `workflowEngine/blocksHandler.test.js` 的
 * 断言负责；「每个引擎错误字面量都是 key」由 `utils/check-engine-errors.js` 负责。
 *
 * 注意：**不 import `@/utils/getTranslateLog`** —— 它经 `getSharedData` 拉
 * `@business/blocks`（webpack 外部包），Node 里解不出来。所以这里直接调
 * `i18n.global.t(path, params)`，与 `getTranslateLog` 内部的调用形状逐字一致
 * （见 src/utils/getTranslateLog.js:37-40）。
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobals } from '../agent/__stubs__/globals';

// shared.js 顶层读构建期全局 IS_OFFLINE，必须在动态 import 之前注入
// （静态 import 来不及，T-228 的教训）。
installGlobals();
const { default: i18n } = await import('@/lib/vueI18n');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.resolve(HERE, '../locales');

const readLocale = (lang) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'newtab.json'), 'utf8'));

// [slug, error.data（即日志对象上多出来的字段）, 期望的 zh 渲染结果]
const CASES = [
  ['event-not-found', { eventName: 'click' }, '找不到 "click" 事件'],
  ['variable-not-found', { variableName: 'foo' }, '找不到 "foo" 变量'],
  ['block-not-found', { targetBlockId: 'b1' }, '找不到 ID 为 "b1" 的模块'],
  ['loop-not-found', { loopId: 'l1' }, '找不到 ID 为 "l1" 的循环'],
  ['tab-not-found', { tabIndex: 3 }, '找不到索引为 "3" 的标签页'],
  [
    'download-item-not-found',
    { downloadId: '42' },
    '找不到 ID 为 "42" 的下载项',
  ],
  [
    'invalid-map-data-type',
    { dataType: 'string' },
    '无法映射 "string" 类型的数据',
  ],
  [
    'invalid-sort-data-type',
    { dataType: 'string' },
    '无法排序 "string" 类型的数据',
  ],
  [
    'invalid-variable-number',
    { variableName: 'foo' },
    '"foo" 变量的值不是数字',
  ],
  [
    'invalid-variable-string',
    { variableName: 'foo' },
    '"foo" 变量的值不是字符串/文本',
  ],
  [
    'webhook-response-error',
    { status: 404, statusText: 'Not Found' },
    '请求失败，状态码 (404) Not Found',
  ],
  ['block-handler-not-found', {}, '此模块没有对应的处理器'],
  ['active-tab-not-found', {}, '找不到活动标签页'],
  ['no-connection-to-tab', {}, '无法与活动标签页建立连接'],
  ['tab-load-timeout', {}, '等待标签页加载超时'],
  ['block-timeout', {}, '模块执行超时'],
  ['ai-workflow-offline', {}, '离线模式下无法使用 AI 工作流模块'],
  ['ai-power-token-missing', {}, '未设置 AI Power 令牌'],
  ['ai-workflow-failed', {}, 'AI 工作流执行失败'],
  ['input-not-found', {}, '找不到输入'],
  ['block-for-input-not-found', {}, '找不到此输入对应的模块'],
  ['clipboard-background-unsupported', {}, '后台执行时不支持剪贴板模块'],
  ['invalid-json-format', {}, 'JSON 格式无效'],
  ['google-drive-offline', {}, '离线模式下无法使用 Google Drive 模块'],
  ['google-drive-not-connected', {}, '您尚未连接 Google Drive'],
  ['google-sheets-offline', {}, '离线模式下无法使用 Google Sheets 模块'],
  ['download-permission-missing', {}, '下载功能需要下载权限'],
  ['invalid-download-id', {}, '下载 ID 不是数字'],
  ['invalid-fetch-type', {}, '"type" 必须为 "text" 或 "json"'],
  ['no-workflow-selected', {}, '未选择工作流'],
  ['no-flow-selected', {}, '未选择特定流程'],
  ['workflow-stopped-manually', {}, '工作流已手动停止'],
  ['invalid-form-data-body', {}, '请求体必须是二维数组'],
  ['file-not-found', {}, '找不到文件'],
  ['element-not-a-link', {}, '元素不是链接'],
];

describe('引擎错误文案（T-262）', () => {
  before(() => {
    i18n.global.setLocaleMessage('en', readLocale('en'));
    i18n.global.setLocaleMessage('zh', readLocale('zh'));
  });

  test('每条引擎错误 slug 在 en/zh 都有关键词条', () => {
    for (const [slug] of CASES) {
      assert.ok(
        i18n.global.te(`log.messages.${slug}`, 'en'),
        `en 缺 log.messages.${slug}`
      );
      assert.ok(
        i18n.global.te(`log.messages.${slug}`, 'zh'),
        `zh 缺 log.messages.${slug}`
      );
    }
  });

  test('zh：占位符能从日志形状的对象里插出来，不留 {…}', () => {
    i18n.global.locale.value = 'zh';

    for (const [slug, data, expected] of CASES) {
      // 与 translateLog 一致：params 是整条日志对象，message 也在里面。
      const log = { message: slug, ...data };
      const rendered = i18n.global.t(`log.messages.${slug}`, log);

      assert.equal(rendered, expected, `log.messages.${slug}`);
      assert.ok(
        !/\{[a-zA-Z]+\}/.test(rendered),
        `${slug} 残留占位符: ${rendered}`
      );
    }
  });

  test('en：占位符同样能插出来，不留 {…}', () => {
    i18n.global.locale.value = 'en';

    for (const [slug, data] of CASES) {
      const rendered = i18n.global.t(`log.messages.${slug}`, {
        message: slug,
        ...data,
      });

      assert.ok(rendered.length > 0, `log.messages.${slug}`);
      assert.ok(
        !/\{[a-zA-Z]+\}/.test(rendered),
        `${slug} 残留占位符: ${rendered}`
      );
    }
  });

  test('占位符名字必须避开日志对象的保留字段', () => {
    // name / id / description / type / blockId … 是日志条目自己的字段，
    // 且 addBlockLog / addLogHistory 会在 error.data 之后覆写它们。
    // 一旦某个 slug 用了 {name}，插出来的就是块名而不是错误数据。
    const RESERVED = [
      'name',
      'id',
      'description',
      'type',
      'blockId',
      'workerId',
      'timestamp',
      'activeTabUrl',
      'replacedValue',
      'duration',
      'message',
      'ctxData',
    ];

    for (const [slug] of CASES) {
      const en = i18n.global.t(`log.messages.${slug}`, {});
      const used = [...en.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);

      for (const field of used) {
        assert.ok(
          !RESERVED.includes(field),
          `log.messages.${slug} 用了保留字段 {${field}}`
        );
      }
    }
  });
});
