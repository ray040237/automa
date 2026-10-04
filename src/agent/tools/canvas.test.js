import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBlock, updateBlock, listCanvas } from './canvas';
import { TOOLS } from './index';
import { stripComments } from '../stripComments';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(here, '..');

/** 造一个够用的假画布。 */
function fakeEditor(nodes) {
  const added = [];

  return {
    getNodes: { value: nodes || [] },
    added,
    addNodes(list) {
      added.push(...list);
      nodes.push(...list);
    },
  };
}

const BLOCKS = {
  'javascript-code': {
    name: 'JavaScript',
    component: 'BlockJavascriptCode',
    data: { code: '', description: '', timeout: 30000 },
  },
  trigger: {
    name: 'Trigger',
    component: 'BlockBasic',
    data: { type: 'manual', url: '' },
  },
};

let seq = 0;
const ctxFor = (editor, extra) => ({
  blocks: BLOCKS,
  editor,
  newId: () => {
    seq += 1;

    return 'n' + seq;
  },
  onCanvasChanged: () => {},
  ...(extra || {}),
});

describe('add_block', () => {
  test('建出来的节点形状要跟拖拽建出来的一致', async () => {
    const editor = fakeEditor([]);
    const r = await addBlock(ctxFor(editor), {
      blockId: 'javascript-code',
      data: { code: 'return 1' },
    });

    assert.equal(r.status, 'ok');
    assert.equal(editor.added.length, 1);

    const n = editor.added[0];

    assert.equal(
      n.label,
      'javascript-code',
      'label 必须是块 id，编辑器靠它选组件'
    );
    assert.equal(n.type, 'BlockJavascriptCode');
    assert.equal(n.data.code, 'return 1', '模型给的字段要盖上去');
    assert.equal(n.data.timeout, 30000, '没给的字段要保留块默认值');
    assert.ok(n.id, '必须有 id');
  });

  test('画布已有节点时，新块不能跟它们叠在一起', async () => {
    const editor = fakeEditor([
      { id: 'a', position: { x: 0, y: 0 }, width: 220 },
      { id: 'b', position: { x: 300, y: 0 }, width: 220 },
    ]);

    await addBlock(ctxFor(editor), { blockId: 'trigger' });

    assert.ok(
      editor.added[0].position.x > 300,
      '新块应排在最右，不能盖住已有的'
    );
  });

  test('块 id 不存在时要把可用的 id 列出来，别让模型瞎猜', async () => {
    const editor = fakeEditor([]);
    const r = await addBlock(ctxFor(editor), { blockId: 'no-such-block' });

    assert.equal(r.status, 'error');
    assert.match(r.payload, /没有名为 no-such-block 的块/);
    assert.match(r.payload, /javascript-code/, '应列出真实存在的块 id');
    assert.equal(editor.added.length, 0, '失败时不能留下半个节点');
  });

  test('明确给的坐标要照用', async () => {
    const editor = fakeEditor([]);

    await addBlock(ctxFor(editor), { blockId: 'trigger', x: 42, y: 99 });

    assert.equal(editor.added[0].position.x, 42);
    assert.equal(editor.added[0].position.y, 99);
  });
});

describe('update_block', () => {
  test('合并字段而不是整个替换', async () => {
    const editor = fakeEditor([
      {
        id: 'n1',
        label: 'javascript-code',
        data: { code: 'old', timeout: 1000 },
      },
    ]);

    const r = await updateBlock(ctxFor(editor), {
      nodeId: 'n1',
      data: { code: 'new' },
    });

    assert.equal(r.status, 'ok');
    assert.equal(editor.getNodes.value[0].data.code, 'new');
    assert.equal(
      editor.getNodes.value[0].data.timeout,
      1000,
      '没提的字段不能被抹掉'
    );
  });

  test('节点不存在时报错并列出现有节点', async () => {
    const editor = fakeEditor([{ id: 'n1', label: 'trigger', data: {} }]);
    const r = await updateBlock(ctxFor(editor), { nodeId: 'ghost', data: {} });

    assert.equal(r.status, 'error');
    assert.match(r.payload, /现有节点：n1/);
  });
});

describe('list_canvas', () => {
  test('空画布要说清楚是空的', async () => {
    const r = await listCanvas(ctxFor(fakeEditor([])), {});

    assert.match(r.payload, /画布是空的/);
  });

  test('要把节点 id 和代码都带出来', async () => {
    const editor = fakeEditor([
      { id: 'n9', label: 'javascript-code', data: { code: 'return 42' } },
    ]);

    const r = await listCanvas(ctxFor(editor), {});

    assert.match(r.payload, /n9/);
    assert.match(r.payload, /return 42/);
  });
});

describe('G5：agent 永远不能保存工作流', () => {
  function walk(dir) {
    return readdirSync(dir).flatMap((f) => {
      const full = path.join(dir, f);

      if (statSync(full).isDirectory())
        return full === AGENT_DIR ? [] : walk(full);

      return full.endsWith('.js') ? [full] : [];
    });
  }

  const FILES = walk(AGENT_DIR).filter((f) => !f.endsWith('.test.js'));

  test('src/agent 下不允许出现任何落盘/触发器注册的符号', () => {
    const FORBIDDEN = [
      'saveWorkflow',
      'workflowStore.update',
      'workflowStore.save',
      'registerWorkflowTrigger',
      'dbStorage.workflows',
    ];
    const offenders = [];

    FILES.forEach((f) => {
      // 必须剥掉注释再扫：loop.js 里有一段注释明确写着「不许碰 saveWorkflow」，
      // 直接子串匹配会把这段警告本身当成违规。
      const src = stripComments(readFileSync(f, 'utf8'));

      FORBIDDEN.forEach((sym) => {
        if (src.includes(sym)) offenders.push(path.basename(f) + ' → ' + sym);
      });
    });

    assert.deepEqual(
      offenders,
      [],
      '这些符号一旦出现，agent 就能自己落盘：' + offenders.join(', ')
    );
  });

  test('画布写工具必须全部是 write 类（过确认门）', () => {
    const canvasTools = TOOLS.filter((t) => t.group === 'canvas');

    assert.equal(canvasTools.length, 3);

    const writeNames = canvasTools
      .filter((t) => t.class === 'write')
      .map((t) => t.name);

    assert.deepEqual(writeNames.sort(), ['add_block', 'update_block']);
  });
});

/* ---------------- 参数校验失败时回显收到的参数（backlog T-36） ----------------
 * 模型经常混用 add_block 的 blockId 与 update_block 的 nodeId，错误里带上
 * 「实际收到了什么」它才能一步自纠——dump 实测过一轮连错 6 次。 */

test('add_block 缺 blockId：回显收到的键，并点破 blockId/nodeId 的分工', async () => {
  const r = await addBlock(
    { blocks: BLOCKS, editor: fakeEditor([]) },
    { nodeId: 'pg8rzgv', data: { code: 'x' } }
  );

  assert.equal(r.status, 'error');
  assert.match(r.payload, /blockId 不能为空/);
  assert.match(r.payload, /"nodeId"/, '要回显实际收到的键');
  assert.match(r.payload, /update_block 才用 nodeId/);
});

test('update_block 缺 nodeId：同样回显并指路', async () => {
  const r = await updateBlock(
    { editor: fakeEditor([]) },
    { blockId: 'create-element', data: { description: 'x' } }
  );

  assert.equal(r.status, 'error');
  assert.match(r.payload, /nodeId 不能为空/);
  assert.match(r.payload, /"blockId"/);
  assert.match(r.payload, /add_block 才用 blockId/);
});

test('长字符串值截断到 60 字符，错误信息不会被大 data 撑爆', async () => {
  const long = 'x'.repeat(500);
  const r = await addBlock(
    { blocks: BLOCKS, editor: fakeEditor([]) },
    { data: { code: long } }
  );

  assert.match(r.payload, /x{10}…/);
  assert.ok(r.payload.length < 400, `实际 ${r.payload.length}`);
});

test('完全没传参数：给占位说明而不是炸', async () => {
  const r = await addBlock({ blocks: BLOCKS, editor: fakeEditor([]) }, {});

  assert.equal(r.status, 'error');
  assert.match(r.payload, /blockId 不能为空/);
});
