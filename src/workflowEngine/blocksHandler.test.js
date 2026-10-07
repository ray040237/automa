/**
 * `src/workflowEngine/blocksHandler/` 的**行为**测试（T-116）。
 *
 * 归属说明：这一套放在引擎自己目录下（engineHandlers.test.js 的头注一直写着
 * 「真正的归属应是引擎自己的测试套件」）。为此给 npm test 加了第二个 glob
 * （src/workflowEngine 下的 .test.js）—— 原来只有 src/agent 下的，引擎下的测试
 * 进不了 CI，写了也不会跑。
 *
 * 两类测试，边界写清楚：
 *   1. **行为测试**（下面 describe('处理器行为')）：用假的 worker 当 `this` 直接调
 *      处理器，验它到底改没改变量/表格。原来这一层完全没有 —— engineHandlers.test.js
 *      是源码文本守卫，验不了「它到底写没写变量」。
 *   2. **契约与可导入性**（describe('处理器契约')）：覆盖全部 53 个处理器，包括
 *      **在 node 里根本 import 不进来的那些**。
 *
 * 实测的覆盖上限（2026-10-07，node --import ./utils/test-loader.mjs）：
 *   53 个处理器里 **13 个能在 node 里加载**。其余 40 个失败于三类原因：
 *     - 模块顶层就读 `chrome.*`（经 @/service/browser-api）—— 补了 Proxy 桩仍是
 *       「Cannot read properties of undefined (reading 'get')」，即顶层就解构了
 *       真实 API 的返回值；
 *     - webpack externals 的 `secrets` 包在 node 里解析不到（handlerAiWorkflow /
 *       handlerExecuteWorkflow / handlerGoogle* 等 6 个）；
 *     - `@business/blocks`、`@/lib` 走 webpack alias，node 解析不到。
 *   这份清单**被测试钉住**（见「可导入清单」）：加了新处理器而没更新清单，测试会红。
 *   笼统说「引擎处理器没有测试」不如把边界写成事实 —— 哪些测了、哪些测不了、
 *   为什么测不了，都在这里。
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'blocksHandler');
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();

// webpack DefinePlugin 注入的全局（不补就在 import 期 ReferenceError，与
// facts.test.js 同一招）；module-type 警告无关紧要。
// eslint-disable-next-line no-undef -- webpack 的编译期常量
globalThis.IS_OFFLINE = false;
// eslint-disable-next-line no-undef -- 同上
globalThis.BROWSER_TYPE = 'chrome';

/**
 * 假 worker：处理器只用到这几样 —— engine.referenceData / engine.columns、
 * getBlockConnections、activeTab、repeatedTasks、loopList。
 */
function fakeWorker(over = {}) {
  const connections = new Map();
  return {
    id: 'worker-1',
    engine: {
      id: 'wf-1',
      referenceData: { variables: {}, table: [] },
      // 初值刻意非 0：列游标归零那条断言写成 index === 0 的话，初值也是 0 时
      // 就算处理器不归零它照样过（变异测试实测过这条）。
      columns: { col1: { name: '标题', type: 'any', index: 4 } },
      columnsId: {},
      connectionsMap: connections,
      packagesCache: {},
      states: { getAll: [], stop: async () => {} },
      addRefDataSnapshot: () => {},
      addLogHistory: () => {},
      updateState: async () => {},
      isDestroyed: false,
      referenceDataKeys: [],
    },
    activeTab: { id: 1, url: 'https://example.com/' },
    loopEls: [],
    loopList: {},
    repeatedTasks: {},
    getBlockConnections: (id, outputIndex = 1) => [`next-${id}-${outputIndex}`],
    ...over,
  };
}

const load = async (file) => (await import(`./blocksHandler/${file}`)).default;

describe('处理器行为（假 worker 当 this）', () => {
  test('increase-variable：数字自增，并把新值写回变量', async () => {
    const increaseVariable = await load('handlerIncreaseVariable.js');
    const worker = fakeWorker();
    worker.engine.referenceData.variables = { counter: 2 };

    const result = await increaseVariable.call(worker, {
      id: 'b1',
      data: { variableName: 'counter', increaseBy: 3 },
    });

    assert.equal(worker.engine.referenceData.variables.counter, 5);
    assert.equal(result.data, 5);
    assert.deepEqual(result.nextBlockId, ['next-b1-1']);
  });

  test('increase-variable：变量不存在 / 不是数字时抛错，而不是静默写坏数据', async () => {
    const increaseVariable = await load('handlerIncreaseVariable.js');

    const missing = fakeWorker();
    await assert.rejects(
      () =>
        increaseVariable.call(missing, {
          id: 'b1',
          data: { variableName: 'nope', increaseBy: 1 },
        }),
      /Cant find "nope" variable/
    );

    const notNumber = fakeWorker();
    notNumber.engine.referenceData.variables = { text: 'abc' };
    await assert.rejects(
      () =>
        increaseVariable.call(notNumber, {
          id: 'b1',
          data: { variableName: 'text', increaseBy: 1 },
        }),
      /is not a number/
    );
  });

  test('slice-variable：切片写回变量；变量不是数组时原样通过', async () => {
    const sliceData = await load('handlerSliceVariable.js');

    const worker = fakeWorker();
    worker.engine.referenceData.variables = { list: [1, 2, 3, 4, 5] };
    const sliced = await sliceData.call(worker, {
      id: 'b2',
      data: {
        variableName: 'list',
        startIdxEnabled: true,
        startIndex: 1,
        endIdxEnabled: true,
        endIndex: 3,
      },
    });
    assert.deepEqual(
      worker.engine.referenceData.variables.list,
      [2, 3],
      '切片必须写回变量，否则下一个块读到的是旧值'
    );
    assert.deepEqual(sliced.data, [2, 3]);

    const passthrough = fakeWorker();
    passthrough.engine.referenceData.variables = { n: 7 };
    const plain = await sliceData.call(passthrough, {
      id: 'b3',
      data: { variableName: 'n' },
    });
    assert.equal(plain.data, 7, '不可切的变量不该变成 undefined');
  });

  test('regex-variable：replace 与 match 两种方法的结果不同，且都写回变量', async () => {
    const regexVariable = await load('handlerRegexVariable.js');

    const replaceWorker = fakeWorker();
    replaceWorker.engine.referenceData.variables = {
      text: '订单号 A-123 已发货',
    };
    await regexVariable.call(replaceWorker, {
      id: 'b4',
      data: {
        variableName: 'text',
        method: 'replace',
        expression: '[A-Z]-(\\d+)',
        flag: ['g'],
        replaceVal: '#$1#',
      },
    });
    assert.equal(
      replaceWorker.engine.referenceData.variables.text,
      '订单号 #123# 已发货'
    );

    const matchWorker = fakeWorker();
    matchWorker.engine.referenceData.variables = { text: '订单号 A-123' };
    const matched = await regexVariable.call(matchWorker, {
      id: 'b5',
      data: {
        variableName: 'text',
        method: 'match',
        expression: '[A-Z]-\\d+',
        flag: [],
      },
    });
    assert.equal(matched.data, 'A-123');
  });

  test('regex-variable：变量不存在或不是字符串时抛错', async () => {
    const regexVariable = await load('handlerRegexVariable.js');

    const missing = fakeWorker();
    await assert.rejects(
      () =>
        regexVariable.call(missing, {
          id: 'b6',
          data: { variableName: 'nope', expression: 'x', flag: [] },
        }),
      /Cant find "nope" variable/
    );

    const notString = fakeWorker();
    notString.engine.referenceData.variables = { n: 5 };
    await assert.rejects(
      () =>
        regexVariable.call(notString, {
          id: 'b6',
          data: { variableName: 'n', expression: 'x', flag: [] },
        }),
      /is not a string/
    );
  });

  test('delete-data：按列清空时列游标归零，删变量时要记快照', async () => {
    const deleteData = await load('handlerDeleteData.js');
    const snapshots = [];
    const worker = fakeWorker({
      engine: undefined,
    });
    const base = fakeWorker();
    worker.engine = base.engine;
    worker.engine.referenceData.table = [{ 标题: '一' }, { 标题: '二' }];
    worker.engine.addRefDataSnapshot = (k) => snapshots.push(k);

    await deleteData.call(worker, {
      id: 'b7',
      data: {
        deleteList: [
          { type: 'table', columnId: 'col1' },
          { variableName: 'gone', type: 'variable' },
        ],
      },
    });

    assert.equal(
      worker.engine.columns.col1.index,
      0,
      '列游标必须归零，否则后面新增的行会跳过第 0 行'
    );
    assert.deepEqual(
      snapshots,
      ['variables'],
      '删变量后要记快照，否则历史回看还是旧值'
    );
    assert.equal('gone' in worker.engine.referenceData.variables, false);
  });

  test('delete-data：columnId=[all] 清空整张表并把每列游标归零', async () => {
    const deleteData = await load('handlerDeleteData.js');
    const worker = fakeWorker();
    worker.engine.columns = {
      a: { name: '甲', type: 'any', index: 3 },
      b: { name: '乙', type: 'any', index: 7 },
    };
    worker.engine.referenceData.table = [{ 甲: 1 }, { 乙: 2 }];

    await deleteData.call(worker, {
      id: 'b8',
      data: { deleteList: [{ type: 'table', columnId: '[all]' }] },
    });

    assert.deepEqual(worker.engine.referenceData.table, []);
    assert.deepEqual(
      [worker.engine.columns.a.index, worker.engine.columns.b.index],
      [0, 0]
    );
  });

  test('repeat-task：超过次数后走出口，否则走循环出口', async () => {
    const repeatTask = await load('handlerRepeatTask.js');
    const worker = fakeWorker();

    const first = await repeatTask.call(worker, {
      id: 'b9',
      data: { repeatFor: 2 },
    });
    assert.deepEqual(
      first.nextBlockId,
      ['next-b9-2'],
      '没到次数时应走 output-2 回到循环'
    );

    await repeatTask.call(worker, { id: 'b9', data: { repeatFor: 2 } });
    const third = await repeatTask.call(worker, {
      id: 'b9',
      data: { repeatFor: 2 },
    });
    assert.deepEqual(
      third.nextBlockId,
      ['next-b9-1'],
      '到次数后走出口 output-1'
    );
    assert.equal(worker.repeatedTasks.b9, undefined, '退出时要清掉计数');

    // 没有循环出口（output-2 不存在）时必须立刻退出。「重复任务」的判据是
    // 「次数超了 || 没有循环出口」，少后半个条件就会变成死循环 —— 而只测
    // 上面那条（假 worker 总是返回真数组）根本发现不了。
    const noLoop = fakeWorker({
      getBlockConnections: (id, outputIndex = 1) =>
        outputIndex === 2 ? null : [`next-${id}-1`],
    });
    const firstRun = await repeatTask.call(noLoop, {
      id: 'b11',
      data: { repeatFor: 5 },
    });
    assert.deepEqual(
      firstRun.nextBlockId,
      ['next-b11-1'],
      '没有循环出口却还在 output-2 上绕 = 死循环'
    );
  });

  test('trigger：透传出口连接', async () => {
    const trigger = await load('handlerTrigger.js');
    const worker = fakeWorker();
    const result = await trigger.call(worker, { id: 'b10', data: {} });
    assert.deepEqual(result.nextBlockId, ['next-b10-1']);
    assert.equal(result.data, '');
  });
});

describe('处理器契约（覆盖全部 53 个，含 node 里 import 不进来的）', () => {
  test('每个处理器都有 default 导出，且是 arity ≤ 2 的函数', async () => {
    const problems = [];

    for (const f of FILES) {
      const src = readFileSync(path.join(DIR, f), 'utf8');
      const hasDefault = /export\s+default\s/.test(src);
      const namedThenDefault = /export default [A-Za-z0-9_$]+;/.test(src);

      if (!hasDefault && !namedThenDefault) {
        problems.push(`${f} 没有 default 导出`);
      } else {
        // node 里加载不了的（见下面「可导入清单」）静态形状已查过，行为校验跳过。
        // 这里**不用 continue**：本仓 eslint 禁 continue（no-continue），所以把
        // 后半段夹进 else —— 加载失败时 mod 保持 null，不能去摸 mod.default。
        let mod = null;
        try {
          mod = await import(`./blocksHandler/${f}`);
        } catch {
          mod = null;
        }

        if (mod) {
          if (typeof mod.default !== 'function') {
            problems.push(
              `${f} 的 default 不是函数（实际 ${typeof mod.default}）`
            );
          } else if (mod.default.length > 2) {
            problems.push(
              `${f} 的 default 有 ${mod.default.length} 个形参，工作流只传 (block, execParam)`
            );
          }
        }
      }
    }

    assert.deepEqual(problems, [], `处理器契约问题：\n${problems.join('\n')}`);
  });

  test('文件名与注册表键一一对应（blocksHandler.js 按 toCamelCase(文件名) 建键）', () => {
    const registry = readFileSync(path.join(HERE, 'blocksHandler.js'), 'utf8');
    assert.match(
      registry,
      /toCamelCase\(name\)/,
      '注册表不再用 toCamelCase 建键，测试里的键推导要跟着改'
    );

    // 重复检测：两个文件折出同一个键 = 后者静默覆盖前者
    const seen = new Map();
    const clashes = [];
    for (const f of FILES) {
      const key = f.replace(/^handler/, '').replace(/\.js$/, '');
      const camel = key
        .split('-')
        .map((part, i) =>
          i === 0 ? part : part[0].toUpperCase() + part.slice(1)
        )
        .join('');
      if (seen.has(camel)) clashes.push(`${camel}：${seen.get(camel)} 与 ${f}`);
      seen.set(camel, f);
    }
    assert.deepEqual(
      clashes,
      [],
      '两个处理器折出同一个注册表键 = 后者被静默覆盖'
    );
  });

  test('可导入清单被钉住：node 里加载不了的处理器有明确名单与原因', async () => {
    const IMPORTABLE = [
      'handlerBlockPackage.js',
      'handlerBlocksGroup.js',
      'handlerDelay.js',
      'handlerDeleteData.js',
      'handlerElementExists.js',
      'handlerIncreaseVariable.js',
      'handlerLoopElements.js',
      'handlerRegexVariable.js',
      'handlerRepeatTask.js',
      'handlerSliceVariable.js',
      'handlerTrigger.js',
      'handlerWaitConnections.js',
      'handlerWorkflowState.js',
    ];

    const importable = [];
    const failed = [];
    for (const f of FILES) {
      try {
        await import(`./blocksHandler/${f}`);
        importable.push(f);
      } catch (err) {
        failed.push(f);
      }
    }

    const missingFromNode = IMPORTABLE.filter((f) => !importable.includes(f));
    assert.deepEqual(
      missingFromNode,
      [],
      '这些处理器现在能在 node 里加载了（依赖改动/桩改动），把它们的行为测试补上，然后更新本清单'
    );

    // 反方向也要查：只查「实测能加载但没列」的话，**从清单里删掉一项**不会被
    // 发现（变异测试实测过这条）。
    const notPinned = importable.filter((f) => !IMPORTABLE.includes(f));
    assert.deepEqual(
      notPinned,
      [],
      '这些处理器在 node 里能加载却没写进可导入清单 —— 要么补清单（并补行为测试），' +
        '要么说明为什么不给它写行为测试'
    );
    const pinnedButFailed = IMPORTABLE.filter((f) => failed.includes(f));
    assert.deepEqual(pinnedButFailed, [], '清单说能加载，实测加载不了');

    // 数量变化本身也要报出来 —— 加了新处理器却没决定「测还是写进为什么测不了」
    assert.equal(
      FILES.length,
      53,
      `blocksHandler 下处理器数量变了：${
        FILES.length - 53
      } 个。新增的要么补行为测试，要么写进 IMPORTABLE 的反面清单并说明原因`
    );
    assert.equal(
      importable.length,
      13,
      'node 里可导入的处理器数量变了，先弄清为什么，再更新清单'
    );
  });
});
