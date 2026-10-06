import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS_KEY,
  INSTRUCTIONS_KEY,
  INSTRUCTIONS_SOFT_LIMIT,
  filterCommands,
  getActiveInstructions,
  getActiveInstructionsFrom,
  loadCommands,
  loadInstructions,
  normalizeCommand,
  normalizeInstructions,
  parseSlashDraft,
  saveCommands,
  saveInstructions,
  validateCommands,
} from './customizations';

/** 内存 IO 桩：与 configIO / sessionIO 的 get/set 同形状。 */
function createIO(initial = {}) {
  const store = new Map(Object.entries(initial));

  return {
    store,
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

// —— 指令 ——

test('normalizeInstructions：对象形状、缺省 enabled=true、非对象输入不炸', () => {
  assert.deepEqual(normalizeInstructions({ text: 'x', enabled: false }), {
    text: 'x',
    enabled: false,
  });
  assert.deepEqual(normalizeInstructions({ text: 'x' }), {
    text: 'x',
    enabled: true,
  });
  assert.deepEqual(normalizeInstructions(undefined), {
    text: '',
    enabled: true,
  });
  assert.deepEqual(normalizeInstructions('legacy 直存字符串'), {
    text: 'legacy 直存字符串',
    enabled: true,
  });
});

test('getActiveInstructions：关闭时回空串但保留文本（开关是暂时的，文本是财产）', () => {
  assert.equal(getActiveInstructions({ text: 'abc', enabled: true }), 'abc');
  assert.equal(getActiveInstructions({ text: 'abc', enabled: false }), '');
});

test('指令落盘读写 roundtrip', async () => {
  const io = createIO();

  await saveInstructions(io, { text: '请用中文回复', enabled: true });
  assert.equal(io.store.get(INSTRUCTIONS_KEY).text, '请用中文回复');

  const doc = await loadInstructions(io);
  assert.equal(doc.text, '请用中文回复');
  assert.equal(doc.enabled, true);
});

test('getActiveInstructionsFrom：一步取到该进 prompt 的文本', async () => {
  const io = createIO();
  io.store.set(INSTRUCTIONS_KEY, { text: 'abc', enabled: false });
  assert.equal(await getActiveInstructionsFrom(io), '');

  io.store.set(INSTRUCTIONS_KEY, { text: 'abc', enabled: true });
  assert.equal(await getActiveInstructionsFrom(io), 'abc');
});

// —— 模板 ——

test('normalizeCommand：坏字段归一不抛，缺 id 自动补', () => {
  const c = normalizeCommand({ name: ' review ', body: '正文' });

  assert.equal(c.name, 'review');
  assert.ok(c.id.startsWith('c_'), '缺 id 时自动生成');
  assert.equal(c.enabled, true);
  assert.equal(c.description, '');
});

test('validateCommands：缺名称、缺正文、重名都报错', () => {
  assert.ok(!validateCommands([{ name: '', body: 'x' }]).ok);
  assert.ok(!validateCommands([{ name: 'a', body: '  ' }]).ok);

  const dup = validateCommands([
    { name: 'a', body: 'x' },
    { name: 'A', body: 'y' },
  ]);
  assert.ok(!dup.ok, '重名（大小写不敏感）必须报错');
  assert.equal(dup.errors.length, 1);
  assert.ok(dup.errors[0].includes('重复'));
});

test('validateCommands：合法列表通过并归一', () => {
  const r = validateCommands([{ name: 'a', body: 'x', description: 'd' }]);

  assert.ok(r.ok);
  assert.equal(r.errors.length, 0);
  assert.equal(r.commands[0].name, 'a');
  assert.equal(r.commands[0].enabled, true);
});

test('saveCommands：校验不过不写盘；过了就整份落盘', async () => {
  const io = createIO();
  io.store.set(COMMANDS_KEY, [{ name: 'old', body: 'old-body' }]);

  const bad = await saveCommands(io, [
    { name: 'old', body: 'old-body' },
    { name: '', body: 'x' },
  ]);
  assert.ok(!bad.ok);
  assert.equal(
    io.store.get(COMMANDS_KEY).length,
    1,
    '校验失败时旧数据原样保留'
  );

  const good = await saveCommands(io, [
    { name: 'old', body: 'old-body' },
    { name: 'new', body: 'new-body' },
  ]);
  assert.ok(good.ok);
  assert.equal(io.store.get(COMMANDS_KEY).length, 2);
});

test('loadCommands：存储为空/坏形状时回空数组，不让列表加载失败', async () => {
  assert.deepEqual(await loadCommands(createIO()), []);

  const io = createIO();
  io.store.set(COMMANDS_KEY, '垃圾数据');
  assert.deepEqual(await loadCommands(io), []);
});

// —— / 触发解析 ——

test('parseSlashDraft：/ 开头的单 token 才触发', () => {
  assert.equal(parseSlashDraft('/rev'), 'rev');
  assert.equal(parseSlashDraft('  /rev'), 'rev', '前导空白容忍');
  assert.equal(parseSlashDraft('/'), '');

  assert.equal(parseSlashDraft('rev'), null, '没有斜杠');
  assert.equal(parseSlashDraft('hi /rev'), null, '斜杠不在开头');
  assert.equal(parseSlashDraft('/rev 请看'), null, '带空格是普通消息');
  assert.equal(parseSlashDraft('/rev\n第二行'), null, '带换行是普通消息');
  assert.equal(parseSlashDraft(''), null);
  assert.equal(parseSlashDraft(null), null);
});

test('filterCommands：只回启用且有正文的，按名称与描述过滤', () => {
  const list = [
    normalizeCommand({ name: 'review', description: '审查代码', body: 'x' }),
    normalizeCommand({ name: 'translate', description: '翻译', body: 'y' }),
    normalizeCommand({ name: 'draft', body: 'z', enabled: false }),
    normalizeCommand({ name: 'empty', body: '   ' }),
  ];

  assert.equal(filterCommands(list, '').length, 2, '空匹配 = 全部可用项');
  assert.equal(filterCommands(list, 'rev')[0].name, 'review');
  assert.equal(
    filterCommands(list, '翻译')[0].name,
    'translate',
    '描述也参与匹配'
  );
  assert.equal(
    filterCommands(list, 'REVIEW')[0].name,
    'review',
    '大小写不敏感'
  );
  assert.equal(filterCommands(list, 'draft').length, 0, '停用项不出现');
  assert.equal(filterCommands(list, 'empty').length, 0, '无正文不出现');
});

test('软限常量是给 UI 警告用的正数（钉住存在性，防止被顺手删掉）', () => {
  assert.ok(
    Number.isInteger(INSTRUCTIONS_SOFT_LIMIT) && INSTRUCTIONS_SOFT_LIMIT >= 4096
  );
});
