import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFacts, countBlocks } from './facts';
import { buildSystemPrompt } from './prompt';
// shared.js 是纯数据、零 import —— 所以能直接拿真的块目录来跑，
// 而不是喂一份我自己造的假数据。
// 但它用了 webpack DefinePlugin 注入的全局 IS_OFFLINE（Node 里不存在），
// 而静态 import 会被提升到注入之前执行，所以只能动态 import。
globalThis.IS_OFFLINE = false;

const { tasks } = await import('../utils/shared');

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');

describe('countBlocks', () => {
  test('块目录是对象 —— 上游 shared.js 就是这个形状', () => {
    assert.equal(
      countBlocks({ trigger: { name: 'T' }, loop: { name: 'L' } }),
      2
    );
  });

  test('空目录与缺失目录都不炸', () => {
    assert.equal(countBlocks({}), 0);
    assert.equal(countBlocks(null), 0);
    assert.equal(countBlocks(undefined), 0);
  });

  test('值是 null 的条目也不能炸', () => {
    assert.equal(countBlocks({ a: null, b: { name: 'x' } }), 2);
  });
});

describe('buildFacts', () => {
  const PARAMS = {
    automaFuncs: {
      automaGetTab: '1',
      automaNextBlock: '2',
      automaExecWorkflow: '3',
    },
    templatingFunctions: { now: '1', uid: '2' },
    catalog: { a: { n: 1 }, b: { n: 2 } },
    tools: [
      { name: 'read_page', class: 'read', group: 'page', description: 'x' },
    ],
    excludeFuncs: ['automaExecWorkflow'],
  };

  test('剔掉运行时没注入的补全项', () => {
    const f = buildFacts(PARAMS);

    assert.ok(f.automaFuncs.includes('automaNextBlock'));
    assert.ok(!f.automaFuncs.includes('automaExecWorkflow'));
  });

  test('模板函数与块数都要算对', () => {
    const f = buildFacts(PARAMS);

    assert.deepEqual(f.templatingFns.sort(), ['now', 'uid']);
    assert.equal(f.blockCount, 2);
  });

  test('工具只暴露那四个字段，别把整个实现泄进提示词', () => {
    const f = buildFacts(PARAMS);

    assert.deepEqual(Object.keys(f.tools[0]), [
      'name',
      'class',
      'group',
      'description',
    ]);
  });

  test('缺参数不炸', () => {
    const f = buildFacts({});

    assert.deepEqual(f.automaFuncs, []);
    assert.equal(f.blockCount, 0);
    assert.deepEqual(f.tools, []);
  });
});

describe('拿真实块目录跑一遍（用户的崩溃就是从这里发出的）', () => {
  test('真实 tasks 走进 facts 不能抛', () => {
    const f = buildFacts({
      automaFuncs: { a: '1', b: '2' },
      templatingFunctions: { now: '1' },
      catalog: tasks,
      tools: [],
      excludeFuncs: [],
    });

    assert.equal(typeof f.blockCount, 'number');
    assert.equal(
      f.blockCount,
      61,
      `真实块目录是 61 个块，实际 ${f.blockCount}`
    );
  });

  test('回归：对 tasks 直接 .reduce 正是用户看到的那个崩溃', () => {
    // 这条把 bug 的原始形状钉死：tasks 是对象，.reduce 是 undefined。
    assert.equal(typeof tasks.reduce, 'undefined');
    assert.throws(
      () => tasks.reduce((n, t) => n + Object.keys(t || {}).length, 0),
      /reduce is not a function/,
      'tasks.reduce 必须是抛的 —— 否则这个守卫就失去意义'
    );
  });

  test('countBlocks 对真实目录数出来的就是块数本身，不是字段数之和（T-01）', () => {
    assert.doesNotThrow(() => countBlocks(tasks));

    // 刻意**不**把实现公式在这里重打一遍：那种断言恒真 —— 公式改错了它也绿，
    // T-01 就是这么漏到今天的。期望值写死成「目录键数」，而键数与字段数之和
    // 恰好差着一个数量级（61 vs 715），所以这条断言对公式错误是灵敏的。
    assert.equal(countBlocks(tasks), Object.keys(tasks).length);
    assert.equal(
      countBlocks(tasks),
      61,
      '真实块目录是 61 个块；曾经算出 715（字段数之和），差 11.7 倍'
    );
  });
});

describe('真实上游的形状守卫', () => {
  // 这两条是这个文件的重点：单测喂的是我自己造的假数据，
  // 挡不住「上游其实是数组 / 其实不是数组」这种假设错误。
  test('shared.js 里的 tasks 是对象字面量，不是数组', () => {
    const src = readFileSync(path.join(ROOT, 'src/utils/shared.js'), 'utf8');

    assert.match(
      src,
      /export const tasks = \{/,
      'tasks 若改成数组，countBlocks 的语义就得跟着改'
    );
    assert.ok(!/export const tasks = \[/.test(src));
  });

  test('装配层不能再出现对 tasks 的裸 reduce', () => {
    const src = readFileSync(path.join(ROOT, 'src/agent/index.js'), 'utf8');

    assert.ok(
      !/[^.\w]tasks\.reduce\(/.test(src),
      '必须走 facts.js 的 countBlocks'
    );
  });
});

describe('instructions（T-81a）', () => {
  const BASE = {
    automaFuncs: { a: '1' },
    templatingFunctions: { now: '1' },
    catalog: {},
    tools: [],
    excludeFuncs: [],
  };

  test('缺省是空串；传了就原样进事实表，由 prompt.js 决定拼不拼 section', () => {
    assert.equal(buildFacts(BASE).instructions, '');

    const f = buildFacts({ ...BASE, instructions: '请用中文回复' });
    assert.equal(f.instructions, '请用中文回复');
  });

  test('非字符串输入归一成字符串，不让 storage 里的坏数据炸掉事实表', () => {
    assert.equal(buildFacts({ ...BASE, instructions: null }).instructions, '');
    assert.equal(buildFacts({ ...BASE, instructions: 42 }).instructions, '42');
  });
});

test('T-01：块数这一路必须一路等于块目录键数，不许在别处再算一遍', () => {
  // 端到端钉一次：从真实 tasks 到系统提示里那一行，中间不许有第二份公式。
  const n = countBlocks(tasks);
  const prompt = buildSystemPrompt({
    automaFuncs: ['automaGetTab'],
    templatingFns: ['now'],
    blockCount: n,
    tools: [],
  });

  assert.equal(n, 61, '真实块目录是 61 个块');
  assert.ok(
    String(prompt).includes('本版共有 61 个块'),
    [
      '系统提示里的块数应与块目录一致，实际那一行：',
      ...String(prompt)
        .split('\n')
        .filter((l) => l.includes('本版共有')),
    ].join('\n')
  );
});
