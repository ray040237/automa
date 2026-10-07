import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_EVENTS } from './events';
import { renderSfc } from '../../utils/sfc-render.mjs';

const MD = 'src/components/newtab/workflow/agent/AgentMarkdown.vue';
const LIST = 'src/components/newtab/workflow/agent/AgentSessionList.vue';
const RING = 'src/components/newtab/workflow/agent/AgentContextRing.vue';
const PANEL = 'src/components/newtab/workflow/agent/AgentPanel.vue';

const read = (p) => readFileSync(p, 'utf8');

/**
 * T-128①：面板 UI 的**渲染**断言。
 *
 * 这一组测试存在的理由：静态守卫（panelUi.test.js 读源文本）看不见运行期条件 ——
 * 「把按钮包进 v-if=false」在源码层面一个字没少，守卫照样绿，而按钮其实永不渲染。
 * 这里把组件真的渲成 HTML，再断言「它在不在 DOM 里」。
 *
 * 覆盖范围（说清楚，别让人以为这里能测一切）：
 *   能：v-if 分支、class、组件有没有渲染、引用了哪个文案键、props 驱动的文案。
 *   不能：点击、剪贴板、真实布局/滚动/hover 视觉 —— 那些要 T-128②；
 *   也不能：watcher 驱动的状态（SSR 不跑 watcher，详见 utils/sfc-render.mjs 头注）。
 */

test('T-128：AgentMarkdown 渲染出「复制全文」按钮，且带 hover/focus 显形 class', async () => {
  const html = await renderSfc(MD, { props: { raw: '正文一段。' } });

  assert.ok(
    html.includes('workflow.agent.copyAll'),
    '渲染结果里没有「复制全文」文案键 —— 按钮根本没渲染出来'
  );
  assert.ok(
    html.includes('group-hover:opacity-100'),
    '按钮缺少 hover 显形 class'
  );
  assert.ok(
    html.includes('focus:opacity-100'),
    '按钮缺少 focus 显形 class（键盘用户永远看不到它）'
  );
});

test('T-128（盲区回归）：把按钮包进 v-if=false，渲染结果里必须没有它', async () => {
  // 这一条是静态守卫**测不出来**的那一类：源码文本一个字没少，只有渲染能区分。
  // 变异源直接传给 renderSfc，不落盘。
  // 变异写成给按钮**加一个 v-if 属性**，而不是包一层 <template>：后者会多出
  // 一个没闭合的标签，编译期就报「Element is missing end tag」，测不到渲染。
  const src = read(MD).replace('    <button', '    <button v-if="false"');
  const mutated = await renderSfc(MD, {
    props: { raw: '正文一段。' },
    source: src,
  });

  assert.equal(
    mutated.includes('workflow.agent.copyAll'),
    false,
    '按钮被 v-if=false 挡住了却还在渲染结果里 —— 渲染断言本身失效了，这条测试要重写'
  );
  assert.ok(
    mutated.includes('正文'),
    '突变后的 HTML 里连正文都没了 —— 说明整个组件没渲染出来，上面那条断言是假通过'
  );
});

test('T-128：上下文水位圆环在有 usage 时渲染、分母缺失时整段不渲染', async () => {
  // T-153：水位从会话下拉搬到了输入区的圆环（AgentContextRing），渲染断言
  // 跟着搬 —— 否则守卫盯的还是旧位置，搬走之后它就永远绿了。
  const withUsage = await renderSfc(RING, {
    props: { usage: { input: 64000, output: 800 }, contextWindow: 128000 },
  });
  assert.ok(
    withUsage.includes('data-test="context-meter"'),
    '有 usage 且填了 contextWindow 时水位不该消失'
  );
  assert.ok(
    withUsage.includes('workflow.agent.contextShort'),
    '水位短文案没有被渲染 —— 它是圆环的 aria-label，读屏读的就是这一句'
  );
  assert.ok(
    withUsage.includes('workflow.agent.contextHint'),
    'tooltip 没走 contextHint —— 那句里写着「这是估算」，丢了等于假装这个百分比是准的'
  );

  const noUsage = await renderSfc(RING, {
    props: { usage: null, contextWindow: 128000 },
  });
  assert.equal(
    noUsage.includes('data-test="context-meter"'),
    false,
    '没有 usage 时水位整段必须不渲染 —— 显示 0% 会让用户以为「完全没占」'
  );

  const noWindow = await renderSfc(RING, {
    props: { usage: { input: 6400, output: 10 }, contextWindow: 0 },
  });
  assert.equal(
    noWindow.includes('data-test="context-meter"'),
    false,
    '分母缺失（contextWindow=0）时水位整段必须不渲染'
  );
});

test('T-153：模型名仍在会话下拉里渲染（搬走水位时别把它一起丢了）', async () => {
  const html = await renderSfc(LIST, {
    props: {
      sessions: [],
      currentSessionId: null,
      model: 'gpt-4o-mini',
    },
  });

  assert.ok(
    html.includes('data-test="model-name"'),
    '模型名没有被渲染（T-09②）'
  );
  assert.equal(
    html.includes('data-test="context-meter"'),
    false,
    '水位不该再出现在会话下拉里 —— 它在输入区的圆环上'
  );
});

test('T-128：常驻插话提示只在 busy 且队列非空时渲染（T-12）', async () => {
  const host = (over) => ({
    events: [],
    busy: false,
    pendingInterjections: 0,
    config: { apiKey: 'k', model: 'gpt-4o-mini', contextWindow: 128000 },
    sessions: [],
    sessionId: null,
    usage: null,
    pendingConfirm: null,
    targetTab: null,
    targetState: 'none',
    targetPinned: false,
    groups: [],
    send: () => {},
    abort: () => {},
    init: () => Promise.resolve(),
    ...over,
  });

  const queued = await renderSfc(PANEL, {
    props: { host: host({ busy: true, pendingInterjections: 2 }) },
  });
  assert.ok(
    queued.includes('data-test="pending-interjections"'),
    'busy 且有入队插话时，常驻提示行应该渲染出来'
  );
  assert.ok(
    queued.includes('workflow.agent.queuedPending'),
    '提示文案键没有被渲染'
  );

  const idle = await renderSfc(PANEL, {
    props: { host: host({ busy: false, pendingInterjections: 0 }) },
  });
  assert.equal(
    idle.includes('data-test="pending-interjections"'),
    false,
    '不 busy 时不该显示插话提示行'
  );

  const drained = await renderSfc(PANEL, {
    props: { host: host({ busy: true, pendingInterjections: 0 }) },
  });
  assert.equal(
    drained.includes('data-test="pending-interjections"'),
    false,
    '队列已排空（pendingInterjections=0）时提示行必须消失，否则会一直显示「已入队 0 条」'
  );
});

test('T-128：空态渲染出示例问法按钮（T-10），有事件后空态消失', async () => {
  const TRANSCRIPT = 'src/components/newtab/workflow/agent/AgentTranscript.vue';
  const examples = [
    { id: 'e1', text: '这个页面在做什么？' },
    { id: 'e2', text: '帮我总结一下要点' },
  ];

  const empty = await renderSfc(TRANSCRIPT, {
    props: { events: [], busy: false, groups: [{ id: 'page' }], examples },
  });
  assert.ok(empty.includes('workflow.agent.empty'), '没有事件时空态没渲染');
  assert.ok(empty.includes('这个页面在做什么？'), '示例问法没有被渲染成按钮');
  assert.ok(
    empty.includes('data-test="capability-groups"'),
    '能力组徽标没有渲染'
  );

  // 事件用的 kind 必须是 AGENT_EVENTS.USER_MESSAGE 的真值，字符串写错了组件
  // 认不出来，用户气泡就不会渲染（断言会跟着一起空转）。
  const withEvent = await renderSfc(TRANSCRIPT, {
    props: {
      events: [{ kind: AGENT_EVENTS.USER_MESSAGE, text: '刚才那个页面' }],
      busy: false,
      groups: [{ id: 'page' }],
      examples,
    },
  });
  assert.ok(withEvent.includes('刚才那个页面'), '有事件时用户气泡应当渲染');
});
