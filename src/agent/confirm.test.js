import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildConfirmation,
  canRememberSession,
  countLines,
  nextSessionAuth,
  normalizeAnswer,
  shouldSkipConfirmation,
} from './confirm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ---------------- 展示载荷 ---------------- */

test('test_js：代码全文进 detail，行数剥掉尾部空行', () => {
  const c = buildConfirmation(
    { name: 'test_js', args: { code: 'const a = 1;\nreturn a;\n' } },
    { targetTitle: '商品列表' }
  );

  assert.equal(c.kind, 'code');
  assert.equal(c.targetTitle, '商品列表');
  assert.equal(c.canRemember, true);
  assert.equal(c.lines, 2);
  assert.equal(c.detail, 'const a = 1;\nreturn a;\n');
});

test('T-27 回归：只认 args.code，顶层的旧 code 字段不许覆盖', () => {
  const c = buildConfirmation({
    name: 'test_js',
    code: '',
    args: { code: 'real()' },
  });

  assert.equal(c.detail, 'real()', 'detail 必须来自 args.code');
});

test('T-27 回归：args 缺失时给空串而不是 undefined', () => {
  const c = buildConfirmation({ name: 'test_js' });

  assert.equal(c.detail, '');
  assert.equal(c.lines, 0);
});

test('highlight_selector / open_url：选择器与地址原样进 detail', () => {
  const hl = buildConfirmation(
    { name: 'highlight_selector', args: { selector: '.row .title' } },
    { targetTitle: '列表页' }
  );

  assert.equal(hl.kind, 'selector');
  assert.equal(hl.canRemember, false);
  assert.equal(hl.detail, '.row .title');
  assert.equal(hl.targetTitle, '列表页');

  const url = buildConfirmation({
    name: 'open_url',
    args: { url: 'https://a.example/x' },
  });

  assert.equal(url.kind, 'url');
  assert.equal(url.detail, 'https://a.example/x');
});

test('画布写工具：id + 变更字段都摊在 detail 里', () => {
  const add = buildConfirmation({
    name: 'add_block',
    args: { blockId: 'javascript-code', data: { code: '1+1' } },
  });

  assert.equal(add.kind, 'canvas');
  assert.equal(add.action, 'add');
  assert.equal(add.blockId, 'javascript-code');
  assert.ok(add.detail.includes('blockId: javascript-code'));
  assert.ok(add.detail.includes('"code"'), '变更字段必须可见');

  const upd = buildConfirmation({
    name: 'update_block',
    args: { nodeId: 'node-1', data: { code: '2+2' } },
  });

  assert.equal(upd.action, 'update');
  assert.equal(upd.nodeId, 'node-1');
  assert.ok(upd.detail.includes('nodeId: node-1'));
  assert.ok(upd.detail.includes('"code"'));
});

test('画布块 data 带循环引用时兜底成字符串，不抛', () => {
  const data = { code: 'x' };
  data.self = data;

  const add = buildConfirmation({
    name: 'add_block',
    args: { blockId: 'javascript-code', data },
  });

  assert.ok(add.detail.includes('blockId: javascript-code'));
});

test('未知写工具兜底成 generic，把参数原样摊开', () => {
  const c = buildConfirmation({ name: 'mystery_tool', args: { a: 1 } });

  assert.equal(c.kind, 'generic');
  assert.equal(c.canRemember, false);
  assert.ok(c.detail.includes('"a": 1'));
});

test('载荷整体缺失时不抛', () => {
  const c = buildConfirmation(null);

  assert.equal(c.kind, 'generic');
  assert.equal(c.name, '');
  assert.equal(c.detail, '{}');
});

test('countLines：空串 0 行，单行 1 行，CRLF 不多算', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('\n\n'), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\r\nb\r\n'), 2);
});

/* ---------------- 会话级授权（B5） ---------------- */

test('canRememberSession：只有 test_js 能给会话授权', () => {
  assert.equal(canRememberSession('test_js'), true);
  assert.equal(canRememberSession('add_block'), false);
  assert.equal(canRememberSession('update_block'), false);
  assert.equal(canRememberSession('open_url'), false);
  assert.equal(canRememberSession('highlight_selector'), false);
});

test('shouldSkipConfirmation：workflow 写操作永不跳过确认', () => {
  assert.equal(shouldSkipConfirmation('test_js', true), true);
  assert.equal(shouldSkipConfirmation('test_js', false), false);
  assert.equal(
    shouldSkipConfirmation('add_block', true),
    false,
    '授权在手也不能免掉画布写操作的确认（docs/adr/0002）'
  );
});

test('nextSessionAuth：只有「批准 + 勾选 + test_js」才置真', () => {
  assert.equal(
    nextSessionAuth(false, 'test_js', { approved: true, remember: true }),
    true
  );
  assert.equal(
    nextSessionAuth(false, 'test_js', { approved: true, remember: false }),
    false
  );
  assert.equal(
    nextSessionAuth(false, 'test_js', { approved: false, remember: true }),
    false,
    '拒绝了就不能留下授权'
  );
  assert.equal(
    nextSessionAuth(false, 'add_block', { approved: true, remember: true }),
    false
  );
});

test('nextSessionAuth：已授权不因别的工具的答案被撤', () => {
  assert.equal(nextSessionAuth(true, 'add_block', false), true);
  assert.equal(
    nextSessionAuth(true, 'add_block', { approved: false, remember: false }),
    true
  );
});

/* ---------------- 答案归一化 ---------------- */

test('normalizeAnswer：对象与布尔两种载荷都能吃', () => {
  assert.deepEqual(normalizeAnswer({ approved: true, remember: true }), {
    approved: true,
    remember: true,
  });
  assert.deepEqual(normalizeAnswer({ approved: true }), {
    approved: true,
    remember: false,
  });
  assert.deepEqual(normalizeAnswer(true), { approved: true, remember: false });
  assert.deepEqual(normalizeAnswer(false), {
    approved: false,
    remember: false,
  });
  assert.deepEqual(normalizeAnswer(undefined), {
    approved: false,
    remember: false,
  });
  assert.deepEqual(normalizeAnswer('yes'), {
    approved: false,
    remember: false,
  });
  assert.deepEqual(normalizeAnswer({ approved: 'yes' }), {
    approved: false,
    remember: false,
  });
});

/* ---------------- 接线守卫 ---------------- */

/**
 * T-02：确认卡渲染在 AgentPanel 里，编辑器侧栏的三处 v-if（切走助手面板 /
 * 打开某个块的编辑卡 / 收起整个侧栏）会把面板连同卡片一起卸载，而宿主
 * useAgentHost 的 onBeforeUnmount 只兜「整页卸载」—— 面板被藏起来时没人
 * resolve，loop 永远 await，表现与「助手卡死」无异。
 *
 * 本仓没有组件测试基建（T-26），所以退而钉住源码接线：卸载钩子在、钩子里
 * 判了挂起的确认门、发的是否。少任何一环这条 bug 就回来了。
 */
test('T-02 接线守卫：AgentPanel 卸载前必须拒掉挂起的确认门', () => {
  const src = readFileSync(
    join(ROOT, 'src/components/newtab/workflow/agent/AgentPanel.vue'),
    'utf8'
  );

  // 用调用形状定位，避免命中上面注释里提到的同名宿主钩子
  const hookAt = src.indexOf('onBeforeUnmount(() => {');
  assert.ok(hookAt > 0, 'AgentPanel 必须有 onBeforeUnmount 钩子');

  const block = src.slice(hookAt, hookAt + 300);
  assert.match(block, /props\.pendingConfirm/, '钩子必须先判有没有挂起的确认');
  assert.match(
    block,
    /emit\('confirm-answer', false\)/,
    '必须发否 —— 宿主的 answerConfirm 会 resolve，loop 才能收尾'
  );
});
