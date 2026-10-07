import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addBlock,
  updateBlock,
  listCanvas,
  readBlock,
  normalizeReadBlockRange,
  renderNode,
  MAX_FIELD_CHARS,
  MIN_FIELD_CHARS,
  CODE_PREVIEW_CHARS,
} from './canvas';
import { TOOLS } from './index';
import { stripComments } from '../stripComments';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(here, '..');
const ROOT = path.resolve(here, '../../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

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

/* ---------------- T-91：不许静默截断 ----------------
 * 旧实现 `code.slice(0, 200)` 砍完不留任何标记，模型拿 200 字符当全文用，
 * 改出来的 JS 是半截的。下面这组断言要钉死两件事：
 *   1. 凡是没给全值的字段，必须写明「共 N 字符」并指路 read_block；
 *   2. read_block 必须真能拿到全文，且单次输出不越过观察值硬上限 8000。 */

describe('list_canvas：长字段只报长度 + 指路，绝不静默截断', () => {
  const LONG_CODE = 'x'.repeat(1240);

  test('超长 code 必须写明总字符数与「已截断」，并指出用 read_block 读全文', async () => {
    const editor = fakeEditor([
      { id: 'n9', label: 'javascript-code', data: { code: LONG_CODE } },
    ]);

    const r = await listCanvas(ctxFor(editor), {});

    assert.match(r.payload, /共 1240 字符/);
    assert.match(r.payload, /已截断/, '不带截断标记就是静默降级');
    assert.match(r.payload, /read_block\(nodeId="n9", field="code"\)/);
    // 摘要本身还是有限的：清单不该被一个块撑爆
    assert.ok(
      r.payload.length < 400,
      `清单要短，实际 ${r.payload.length} 字符`
    );
  });

  test('code 之外的大字段也要报长度，不能只报 code 和 description', async () => {
    const editor = fakeEditor([
      {
        id: 'n1',
        label: 'element-selector',
        data: { selector: 'y'.repeat(300), timeout: 5000 },
      },
    ]);

    const r = await listCanvas(ctxFor(editor), {});

    assert.match(r.payload, /selector/, '旧实现只输出 code/description');
    assert.match(r.payload, /共 300 字符/);
    assert.match(r.payload, /timeout: 5000/, '短字段照原样给');
  });

  test('短字段原样给出，不被截断规则误伤', async () => {
    const r = renderNode({
      id: 'n1',
      label: 'trigger',
      data: { url: 'https://a.com', description: 'hi' },
    });

    assert.match(r, /url: https:\/\/a\.com/);
    assert.match(r, /description: hi/);
    assert.ok(!r.includes('已截断'));
  });

  test('没字段的节点要说清楚，不能渲染成 undefined', async () => {
    const editor = fakeEditor([{ id: 'n1', label: 'trigger', data: {} }]);
    const r = await listCanvas(ctxFor(editor), {});

    assert.match(r.payload, /没有字段/);
  });
});

describe('read_block', () => {
  const LONG_CODE = 'a'.repeat(1240);

  const editorWith = (data) =>
    fakeEditor([{ id: 'n9', label: 'javascript-code', data }]);

  test('指定 field 时必须拿到全文，一个字符都不能少', async () => {
    const r = await readBlock(ctxFor(editorWith({ code: LONG_CODE })), {
      nodeId: 'n9',
      field: 'code',
    });

    assert.equal(r.status, 'ok');
    // 全文在 payload 里：1240 个 a 连续出现
    assert.ok(r.payload.includes(LONG_CODE), '必须包含完整代码');
    assert.match(r.payload, /共 1240 字符/);
    assert.match(
      r.payload,
      /到这里就是全文/,
      '读完了要说清楚，别让模型再调一次'
    );
  });

  test('超长字段分页：顺着回执给的 offset 一路读到底，能拼回原文', async () => {
    const code = 'b'.repeat(15000);
    const ctx = ctxFor(editorWith({ code }));
    const body = (p) =>
      p.slice(p.indexOf('\n\n') + 2).replace(/\n\[未读完[^\n]*$/, '');

    let { payload } = await readBlock(ctx, { nodeId: 'n9', field: 'code' });
    const collected = [];
    let rounds = 0;

    assert.match(payload, /共 15000 字符/);
    assert.match(payload, /后面还有 \d+ 字符/, '第一次就得说清还剩多少');

    // 顺着回执给的 offset 续读，直到没有续读提示为止（有上限防死循环）
    while (rounds < 10) {
      rounds += 1;
      assert.ok(
        payload.length < 8000,
        `单次输出必须留在观察值硬上限内，第 ${rounds} 次实际 ${payload.length}`
      );
      collected.push(body(payload));

      const m = payload.match(/offset=(\d+)/);
      if (!m) break;

      const next = await readBlock(ctx, {
        nodeId: 'n9',
        field: 'code',
        offset: Number(m[1]),
      });

      assert.equal(next.status, 'ok');
      payload = next.payload;
    }

    assert.ok(rounds >= 3, `15000 字符应分不止一次读完，实际 ${rounds} 次`);
    assert.equal(collected.join(''), code, '所有分片拼起来必须等于原文');
  });

  test('不指定 field：给该节点的字段清单，而不是报错', async () => {
    const r = await readBlock(ctxFor(editorWith({ code: LONG_CODE })), {
      nodeId: 'n9',
    });

    assert.equal(r.status, 'ok');
    assert.match(r.payload, /- n9 \[javascript-code\]/);
    assert.match(r.payload, /共 1240 字符/);
  });

  test('字段不存在：报错并列出现有字段', async () => {
    const r = await readBlock(ctxFor(editorWith({ code: 'x' })), {
      nodeId: 'n9',
      field: 'nope',
    });

    assert.equal(r.status, 'error');
    assert.match(r.payload, /没有字段 nope/);
    assert.match(r.payload, /code/);
  });

  test('节点不存在：列出现有节点', async () => {
    const r = await readBlock(ctxFor(editorWith({ code: 'x' })), {
      nodeId: 'ghost',
      field: 'code',
    });

    assert.equal(r.status, 'error');
    assert.match(r.payload, /现有节点：n9/);
  });

  test('limit 超范围报错，不静默夹取', async () => {
    const ctx = ctxFor(editorWith({ code: LONG_CODE }));

    const tooBig = await readBlock(ctx, {
      nodeId: 'n9',
      field: 'code',
      limit: 99999,
    });
    assert.equal(tooBig.status, 'error');
    assert.match(
      tooBig.payload,
      new RegExp(`${MIN_FIELD_CHARS}–${MAX_FIELD_CHARS}`)
    );

    const tooSmall = await readBlock(ctx, {
      nodeId: 'n9',
      field: 'code',
      limit: 10,
    });
    assert.equal(tooSmall.status, 'error');
    assert.match(tooSmall.payload, /limit 必须是/);
  });

  test('offset 超出字段长度要说明实情，不能返回空串装成功', async () => {
    const r = await readBlock(ctxFor(editorWith({ code: 'x'.repeat(100) })), {
      nodeId: 'n9',
      field: 'code',
      offset: 500,
    });

    assert.equal(r.status, 'error');
    assert.match(r.payload, /只有 100 字符/);
  });

  test('normalizeReadBlockRange：默认取满上限，offset 默认 0', () => {
    assert.deepEqual(normalizeReadBlockRange({}), {
      offset: 0,
      limit: MAX_FIELD_CHARS,
    });
    assert.deepEqual(normalizeReadBlockRange({ offset: 10, limit: 500 }), {
      offset: 10,
      limit: 500,
    });
    assert.ok(normalizeReadBlockRange({ offset: -1 }).error);
    assert.ok(normalizeReadBlockRange({ offset: 1.5 }).error);
  });

  test('上限必须给 untrusted 包装与分页头留余量（低于观察值硬上限 8000）', () => {
    assert.ok(
      MAX_FIELD_CHARS < 8000,
      `顶到 8000 会被 wrapObservation 二次截断，实际 ${MAX_FIELD_CHARS}`
    );
    assert.ok(CODE_PREVIEW_CHARS > 0 && MIN_FIELD_CHARS > 0);
  });
});

describe('update_block 回执', () => {
  test('写入长字符串后要报字符数，便于模型自核对', async () => {
    const editor = fakeEditor([
      { id: 'n1', label: 'javascript-code', data: { code: '' } },
    ]);

    const r = await updateBlock(ctxFor(editor), {
      nodeId: 'n1',
      data: { code: 'z'.repeat(900) },
    });

    assert.equal(r.status, 'ok');
    assert.match(r.payload, /code 现在 900 字符/);
  });

  test('短字段不报字符数，别把回执撑成噪音', async () => {
    const editor = fakeEditor([
      { id: 'n1', label: 'trigger', data: { url: '' } },
    ]);

    const r = await updateBlock(ctxFor(editor), {
      nodeId: 'n1',
      data: { url: 'https://a.com' },
    });

    assert.ok(!/字符/.test(r.payload), '实际回执：' + r.payload);
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

  const FORBIDDEN = [
    'saveWorkflow',
    'workflowStore.update',
    'workflowStore.save',
    'registerWorkflowTrigger',
    'dbStorage.workflows',
  ];

  test('src/agent 下不允许出现任何落盘/触发器注册的符号', () => {
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

  /* --- T-124：上面那条只扫 src/agent 下的 .js，而画布句柄是在 .vue 里构造的 ---
   *
   * 盲区是实测出来的：`[id].vue` 全文确实含 `workflowStore.update` 与
   * `registerWorkflowTrigger`（用户点保存、注册触发器，本该有），所以不能把它
   * 整个丢进上面的黑名单扫描；但**注入块本身**是干净的，那才是 agent 能碰到的
   * 唯一入口。守住注入块就等于守住红线，不必扫全文件。
   *
   * 与 T-128 的盲区不同：那边是 v-if 之类「运行期条件对文本隐形」，这里的
   * 失效形态本身就是文本改动（加一次落盘调用、给 onCanvasChanged 换实现），
   * 文本守卫抓得住。 */
  const VUE = 'src/newtab/pages/workflows/[id].vue';
  const HOST = 'src/composable/agentHost.js';

  /** 取出 `[id].vue` 里 `canvas: {` 那一块 —— 宿主交给 agent 的全部画布能力。 */
  function canvasDepsBlock() {
    const src = read(VUE);
    const start = src.indexOf('\n  canvas: {');

    assert.notEqual(start, -1, `没在 ${VUE} 里找到 canvas: { 注入块`);

    const end = src.indexOf('\n  },', start);

    assert.notEqual(end, -1, 'canvas: { 块没有正常收尾，文件可能改坏了');

    return src.slice(start, end + 5);
  }

  test('画布注入块里不许出现任何落盘符号（[id].vue 的 canvas 块）', () => {
    const block = stripComments(canvasDepsBlock());
    const hits = FORBIDDEN.filter((s) => block.includes(s));

    assert.deepEqual(
      hits,
      [],
      `画布句柄的构造处出现落盘符号：${hits.join(', ')}。` +
        '宿主给 agent 的东西里一旦有保存入口，agent 就能自己落盘，G5 失效'
    );
  });

  test('画布句柄只暴露 4 个键 —— 多一个就是给 agent 开新入口', () => {
    const block = stripComments(canvasDepsBlock());
    const keys = [...block.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*[,:]/gm)].map(
      (m) => m[1]
    );

    assert.deepEqual(
      keys.sort(),
      ['blocks', 'getEditor', 'newId', 'onCanvasChanged'],
      '宿主传给 agent 的画布句柄只该有这 4 个键。新增键前先问：' +
        '这是 agent 执行写工具真正需要的吗，还是只是图方便'
    );
  });

  test('getEditor 仍返回 vue-flow 的 editor ref，不能改成直接引 store', () => {
    const block = stripComments(canvasDepsBlock());

    assert.ok(
      /getEditor:\s*\(\)\s*=>\s*editor\.value/.test(block),
      'getEditor 必须仍是 `() => editor.value`：换成 workflowStore 或预取值，' +
        'agent 拿到的就不再是纯内存画布'
    );
  });

  test('onCanvasChanged 只标未保存，不得顺带做别的', () => {
    const block = stripComments(canvasDepsBlock());

    assert.ok(
      /onCanvasChanged:\s*\(\)\s*=>\s*\{\s*state\.dataChanged\s*=\s*true;\s*\}/.test(
        block
      ),
      'onCanvasChanged 现在只该做 `state.dataChanged = true` —— ' +
        'G5 允许的唯一副作用。多一行就说明 agent 开始替用户落盘了'
    );
  });

  test('注入链上的 agentHost.js 同样不许落盘', () => {
    const src = stripComments(read(HOST));
    const hits = FORBIDDEN.filter((s) => src.includes(s));

    assert.deepEqual(
      hits,
      [],
      `${HOST} 是把画布 deps 送进 runtime 的那一跳，出现落盘符号：${hits.join(
        ', '
      )}`
    );
  });

  test('画布写工具必须全部是 write 类（过确认门）', () => {
    const canvasTools = TOOLS.filter((t) => t.group === 'canvas');

    assert.equal(canvasTools.length, 4);

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
