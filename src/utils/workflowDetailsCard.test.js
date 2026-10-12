import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGlobals } from '../agent/__stubs__/globals';

// shared.js 顶层读构建期全局 IS_OFFLINE，必须在动态 import 之前注入
// （静态 import 来不及——assembly.test.js 同款模式，T-228 的教训）。
installGlobals();
const { workflowIcons } = await import('./shared');

/**
 * 工作流详情卡收编守卫（T-185）。
 *
 * 卡头（图标 + 名称 + 描述）曾是顶栏重命名弹窗的重复第二份；方案 B 把卡头
 * 整行删除、图标选择器并入重命名弹窗（那里本就是改名/改描述的唯一入口，
 * 也是全仓唯一能改工作流图标的地方）。这里钉三件事：
 *  ① 卡头确实删了——组件里不得再出现 workflow 展示/图标编辑的痕迹；
 *  ② 图标选择器确实在弹窗里且走 updateWorkflow 落盘（含 icon 字段）；
 *  ③ 父组件绑定同步清干净，组件只挂块库。
 */

const DIR = dirname(fileURLToPath(import.meta.url));
// 传入的路径从仓库根起（src/...），从 src/utils 上跳两级到根
const read = (p) => readFileSync(join(DIR, '../..', p), 'utf8');

test('T-185：详情卡头已删——组件里不再有图标编辑与工作流信息展示', () => {
  const card = read('src/components/newtab/workflow/WorkflowDetailsCard.vue');

  assert.ok(
    !card.includes('workflowIcon') && !card.includes('updateWorkflowIcon'),
    '卡头的图标选择器必须搬走（现在住在 EditorLocalActions 的重命名弹窗里）'
  );
  assert.ok(
    !card.includes('workflow.icon') && !card.includes('workflow.name'),
    '卡头的名称/描述/图标展示是顶栏的重复第二份（T-185），不得回潮'
  );
  assert.ok(
    !card.includes('defineProps'),
    '卡头删掉后组件不再需要 workflow/dataChanged props'
  );
  // 块库本体不受影响：分类 id 绑定仍在（blockCategories 守卫的依赖）
  assert.ok(
    card.includes(':category-id="catId"'),
    '块库的分类 id 绑定必须保留'
  );
});

test('T-185：图标选择器住在重命名弹窗里，updateWorkflow 带 icon 落盘', () => {
  const actions = read(
    'src/components/newtab/workflow/editor/EditorLocalActions.vue'
  );

  assert.ok(
    actions.includes('workflowIcons'),
    '预定义图标清单来自 shared.js 的 workflowIcons（与卡头时代同一份）'
  );
  assert.ok(
    /icon:\s*renameState\.icon/.test(actions),
    'renameWorkflow 必须把 icon 一并写进 updateWorkflow——它是图标编辑的唯一出口'
  );
  assert.ok(
    /renameState\.icon = icon/.test(actions),
    '预定义图标点选要写回 renameState'
  );
  assert.ok(
    /setRenameIconUrl/.test(actions) && /startsWith\('http'\)/.test(actions),
    '自定义图标 URL 要过 http 校验（沿用卡头时代的约束）'
  );
  assert.ok(
    actions.includes("'workflow.detailsCard.iconUrl'"),
    'URL 输入的 label 复用既有文案键，不留孤儿键'
  );
});

test('T-185：父组件绑定清干净——详情卡只挂块库', () => {
  const page = read('src/newtab/pages/workflows/[id].vue');

  assert.doesNotMatch(
    page,
    /<workflow-details-card[^>]*:workflow=/s,
    '组件已删 props，父组件不得再传 workflow'
  );
  assert.doesNotMatch(
    page,
    /<workflow-details-card[^>]*@update=/s,
    'update 事件已删（图标编辑走 EditorLocalActions 自己的 updateWorkflow）'
  );
});

test('T-185：workflowIcons 清单完整且无重复', () => {
  assert.equal(workflowIcons.length, 13, '预定义图标 13 个（与卡头时代一致）');
  assert.equal(
    new Set(workflowIcons).size,
    workflowIcons.length,
    '清单里不该有重复项'
  );
});
