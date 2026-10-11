import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_EVENTS } from './events';
import { renderSfc } from '../../utils/sfc-render.mjs';

const MD = 'src/components/newtab/workflow/agent/AgentMarkdown.vue';
const LIST = 'src/components/newtab/workflow/agent/AgentSessionList.vue';
const RING = 'src/components/newtab/workflow/agent/AgentContextRing.vue';
const PANEL = 'src/components/newtab/workflow/agent/AgentPanel.vue';
const STEP = 'src/components/newtab/workflow/agent/AgentToolStep.vue';

const read = (p) => readFileSync(p, 'utf8');

/**
 * AgentPanel 的最小 host 替身。
 *
 * 面板只收一个 `host` 对象 prop（T-90），所以渲染它就要造一个——把默认值集中
 * 在这里，免得每条用例各抄一份（抄漏一个 `abort` 就是「渲染时 method 不存在」，
 * 报错指向组件内部，很难看出是用例的问题）。
 */
const panelHost = (over) => ({
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

test('T-128：上下文水位圆环在有实测占用时渲染、分母缺失时整段不渲染', async () => {
  // T-153：水位从会话下拉搬到了输入区的圆环（AgentContextRing），渲染断言
  // 跟着搬 —— 否则守卫盯的还是旧位置，搬走之后它就永远绿了。
  // T-222：水位的分子是实测 contextTokens；usage 只喂 hint 里的计费明细行。
  const withUsage = await renderSfc(RING, {
    // T-163：取 90% 而不是 50% —— 低于 CONTEXT_WARN_AT(80) 时环整段不渲染，
    // 用 50% 测「有用量就该渲染」会红，而且它测的其实已经不是这档的语义了。
    props: {
      usage: { input: 115200, output: 800 },
      contextTokens: 115200,
      contextWindow: 128000,
    },
  });
  assert.ok(
    withUsage.includes('data-test="context-meter"'),
    '有实测占用且填了 contextWindow 时水位不该消失'
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
    props: { usage: null, contextTokens: null, contextWindow: 128000 },
  });
  assert.equal(
    noUsage.includes('data-test="context-meter"'),
    false,
    '没有实测占用时水位整段必须不渲染 —— 显示 0% 会让用户以为「完全没占」'
  );

  const noWindow = await renderSfc(RING, {
    props: {
      usage: { input: 6400, output: 10 },
      contextTokens: 6400,
      contextWindow: 0,
    },
  });
  assert.equal(
    noWindow.includes('data-test="context-meter"'),
    false,
    '分母缺失（contextWindow=0）时水位整段必须不渲染'
  );
});

test('T-163/T-213：水位阈值显示 —— <80% 整段不渲染 / >=80 出环且转 warn / >=95 红并附短词', async () => {
  // 三档全部靠渲染验证：分档是 computed 里的分支，静态守卫看不见，而
  // 「62% 到底还出不出来」正是这次改动要钉住的事。
  const at = (pct) =>
    renderSfc(RING, {
      props: {
        usage: { input: Math.round((200000 * pct) / 100), output: 10 },
        contextTokens: Math.round((200000 * pct) / 100),
        contextWindow: 200000,
      },
    });

  // —— 常态：<80% 整段不出现 ——
  const quiet = await at(62);
  assert.equal(
    quiet.includes('data-test="context-meter"'),
    false,
    '62% 时水位整段不该出现 —— 一个常年显示水位的环不提示任何可行动的事（T-163）'
  );

  // 阈值两侧各测一次，否则「80」这个数本身没被钉住
  const justUnder = await at(79);
  assert.equal(
    justUnder.includes('data-test="context-meter"'),
    false,
    '79% 仍不该出现 —— 阈值是 80，差一个点就得有区别'
  );
  const justAt = await at(80);
  assert.ok(
    justAt.includes('data-test="context-meter"'),
    '80% 要开始出现 —— 提示档的下边界'
  );

  // —— 提示档：出环、转 warn ——
  const warn = await at(84);
  assert.ok(warn.includes('data-test="context-ring"'), '80% 以上要出圆环本身');
  // T-213：百分比**不再常驻**（用户拍板「只用圆环，鼠标移上去有详情就行」）。
  // 精确值改挂 aria-label（读屏）+ title（hover），视觉上不再渲染。
  //
  // 注意：SSR 桩把 t('...') 原样渲染成键名，所以「输出里有没有这个键」并不能
  // 区分 aria-label 与可见文字 —— 两处都会命中。要钉"视觉上不再有数字"，
  // 只能查**可见文本**：`contextShort` 是唯一带 {pct} 插值的键，它出现在
  // aria-label 属性里是合法的，出现在 `>` 与 `<` 之间才是常驻百分比回来了。
  assert.equal(
    />\s*workflow\.agent\.contextShort\s*</.test(warn),
    false,
    'T-213：百分比不该作为可见文字常驻 —— 它只该在 aria-label/title 里'
  );
  assert.ok(
    warn.includes('aria-label="workflow.agent.contextShort'),
    '百分比要挂在 aria-label 上 —— 看得见的人 hover，看不见的人直接听到'
  );
  assert.ok(
    warn.includes('text-warn'),
    '>=80% 转 warn（橙）档 —— 参考实现 pie 的三档里中间那档就是橙'
  );
  assert.equal(
    warn.includes('data-test="context-critical"'),
    false,
    '80~95% 只提级、不告急 —— 两个档位要有区别，否则等于只有一档'
  );
  assert.equal(
    warn.includes('text-danger'),
    false,
    '80~95% 不该已经是 danger —— 那是 >=95% 才有的档'
  );

  // —— 告急档：红 + 短词 ——
  const critical = await at(96);
  assert.ok(critical.includes('text-danger'), '>=95% 要转 danger');
  assert.ok(
    critical.includes('data-test="context-critical"'),
    '>=95% 必须行内附告急文字：只变色不说话，用户不知道该干什么'
  );
  assert.ok(
    critical.includes('workflow.agent.contextCriticalShort'),
    '行内挂的是**短词**键 —— 整句 14 个字会把底行挤换行'
  );
  // 注意：必须带 (?!Short) —— contextCriticalShort 含 contextCritical 前缀，
  // 直接 includes 会被短词那条命中，这条断言就永远绿了。
  assert.equal(
    /workflow\.agent\.contextCritical(?!Short)/.test(critical),
    false,
    '完整那句不该出现在行内 —— 它归点开的明细（AgentPanel 的 dropdown）'
  );
});

test('T-168：会话历史列表渲染 —— 时间分组 / 消息数 / 空态 / 模型名', async () => {
  // T-168 之前这个列表挂在 agent-dropdown 的 slot 里，而 slot 在渲染桩里根本
  // 不渲染 —— 只能靠静态 grep。现在它是真实节点，这些断言终于写得出来了。
  const DAY = 24 * 3600 * 1000;
  // 取「今天 12:00」而不是 Date.now()：否则测试在凌晨跑时「减 1 小时」会落到
  // 昨天，分组断言就成了碰运气。
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const todayTs = noon.getTime();

  const html = await renderSfc(LIST, {
    props: {
      sessions: [
        {
          id: 'a',
          title: '今天的',
          lastAccessedAt: todayTs - 3600e3,
          messageCount: 12,
        },
        {
          id: 'b',
          title: '昨天的',
          lastAccessedAt: todayTs - DAY,
          messageCount: 3,
        },
        {
          id: 'c',
          title: '更早的',
          lastAccessedAt: todayTs - 30 * DAY,
          messageCount: 31,
        },
      ],
      currentSessionId: 'a',
      model: 'gpt-4o-mini',
    },
  });

  assert.ok(html.includes('data-test="session-history"'), '历史列表要渲染出来');
  assert.ok(
    html.includes('data-test="session-group-today"'),
    '要有「今天」分组'
  );
  assert.ok(
    html.includes('data-test="session-group-yesterday"'),
    '要有「昨天」分组'
  );
  assert.ok(
    html.includes('data-test="session-group-earlier"'),
    '要有「更早」分组'
  );
  assert.ok(
    html.includes('workflow.agent.session.turnCount'),
    '消息数要走文案键 —— 索引里的 messageCount 一直存着，以前没用上'
  );
  assert.ok(html.includes('data-test="model-name"'), '模型名要跟着列表走');
  assert.equal(
    html.includes('data-test="context-meter"'),
    false,
    '水位不该出现在历史里（它在输入区的圆环上）'
  );

  const empty = await renderSfc(LIST, { props: { sessions: [], model: 'm' } });
  assert.ok(
    empty.includes('data-test="session-empty"'),
    '没有历史时要出空态文案'
  );
});

test('T-169（2026-10-10 修订）：宽宿主左栏常驻历史；窄宿主只有标题下拉，历史视图已撤', async () => {
  // 形态是 computed 里的分支（`wide`），静态守卫看不见 ——
  // 「把左栏包进 v-if=false」在源码文本上一个字没少，守卫照样绿。
  // 2026-10-10：窄宿主的视图切换（session-chip + 整页历史列表）随
  // 「标题即会话下拉」一起撤掉 —— 同一份列表不该有两张脸（用户实证）。
  const sessions = [
    { id: 'a', title: '一条历史', lastAccessedAt: Date.now(), messageCount: 2 },
  ];

  const wide = await renderSfc(PANEL, {
    props: { host: panelHost({ layout: 'wide', sessions }) },
  });
  assert.ok(
    wide.includes('data-test="session-side"'),
    '宽宿主（独立助手页）要有常驻左栏 —— 历史不该藏在一次点击后面'
  );
  assert.ok(
    wide.includes('workflow.agent.session.history'),
    '左栏要有「历史」这一栏的标题（列表组件本身在 sfc-render 里是通用桩，认不出来）'
  );
  assert.ok(
    // 定位符原先是底行那个 @ 按钮的 data-test（T-177 已随 @ 整套删除）；
    // 换成 composer 里必然存在的输入框 placeholder 键。
    wide.includes('workflow.agent.placeholder'),
    '宽宿主 composer 必须一直在 —— 历史占的是左栏，不是正文区'
  );
  assert.equal(
    wide.includes('data-test="session-chip"'),
    false,
    '历史入口图标已撤：宽宿主不该有，窄宿主也不该再有'
  );

  const narrow = await renderSfc(PANEL, {
    props: { host: panelHost({ sessions }) },
  });
  assert.equal(
    narrow.includes('data-test="session-chip"'),
    false,
    '窄宿主的历史入口已撤 —— 会话浏览全走标题下拉，别再长出第二个入口'
  );
  assert.equal(
    narrow.includes('data-test="session-side"'),
    false,
    '窄宿主不能有左栏：320px 里再切 240px 给列表，对话区只剩 80px'
  );
  assert.equal(
    narrow.includes('data-stub="agent-session-list"') ||
      narrow.includes('workflow.agent.session.history'),
    false,
    '窄宿主默认是对话视图，且不再有可切换的历史视图 —— 「历史会话」四个字只属于宽宿主左栏'
  );

  // 宿主没声明 layout 时按 narrow 兜底（更保守：不占常驻横向空间）。
  // 这一条同时钉住「默认不是 wide」—— 万一以后 reactive 里写成默认 wide，
  // 所有没声明的宿主都会凭空长出左栏。
  const undeclared = await renderSfc(PANEL, {
    props: { host: panelHost({ layout: undefined, sessions }) },
  });
  assert.equal(
    undeclared.includes('data-test="session-side"'),
    false,
    'layout 没声明时必须按 narrow 兜底'
  );
});

test('T-171b：窄宿主渲染出 min-h-0 右栏 + shrink-0 composer（只有中部滚动，输入框常驻底部）', async () => {
  // 这两个 class 都在 AgentPanel 自己的模板里（不是被 stub 的子组件），
  // 所以 SSR 渲染结果里能断言到。它们决定了窄宿主（320px 侧栏）里面板会不会
  // 溢出固定高度的侧栏 → 整页滚动，以及输入框会不会被压没。
  const narrow = await renderSfc(PANEL, {
    props: { host: panelHost({ sessions: [] }) },
  });
  assert.ok(
    narrow.includes('min-h-0'),
    '渲染结果里右栏缺失 min-h-0 —— 整页滚动的根因没修'
  );
  assert.ok(
    narrow.includes('shrink-0'),
    '渲染结果里 composer 表单缺失 shrink-0 —— 窄宿主下输入框可能被压没'
  );
});

test('T-174：工具卡渲染出的根节点带 max-w-full / min-w-0（长串撑不破窄面板）', async () => {
  // 工具卡根节点的这两个 class 决定它在窄宿主（320px 侧栏）里会不会被长观察值
  // 撑得比面板宽。展开体（v-if=expanded）SSR 渲染不到，那一半由 toolStepLayout.test.js
  // 的源码守卫补，两条合起来才闭环。
  const html = await renderSfc(STEP, {
    props: {
      step: {
        name: 'list_tabs',
        status: 'ok',
        args: { detail: 'summary' },
        observation: 'file:///D:/project/automa/docs/agent-ui-toolstep.html',
      },
    },
  });
  assert.ok(
    html.includes('max-w-full'),
    '工具卡根节点缺 max-w-full —— 长串会把卡片撑得比面板宽，出横向滚动条'
  );
  assert.ok(
    html.includes('min-w-0'),
    '工具卡根节点缺 min-w-0 —— flex 子项的 min-content 下界没解除'
  );
});

test('T-175：工具卡头部收敛为 text-xs、图标显式尺寸、折叠态有一行摘要', async () => {
  // 只在**渲染出来的元素属性**上断言，不看整段 html —— 模板里的 HTML 注释
  // 会原样出现在 SSR 输出里（注释里就写着 text-sm/text-xs 这些字面量），
  // 对着整段做 includes 会被注释骗到。
  const html = await renderSfc(STEP, {
    props: {
      step: {
        name: 'list_tabs',
        status: 'ok',
        args: { detail: 'summary' },
        observation: 'ok',
      },
    },
  });

  const button = html.match(/<button[^>]*>/);
  assert.ok(button, '没渲染出工具卡的折叠按钮，守卫本身失效');
  assert.ok(
    button[0].includes('text-xs'),
    '工具卡头部必须 text-xs —— 工具调用是元信息，不该和正文（text-sm）同级'
  );
  assert.equal(
    button[0].includes('text-sm'),
    false,
    '工具卡头部不该是 text-sm（那正是"显示很大"的第二个根因）'
  );

  // v-remixicon 在 SSR 里是 stub，但它把 props 透传成属性 —— 所以这里能确认
  // size **真的传下去了**（源码里写没写是 toolStepLayout/iconSize 那边的事）。
  const icons = [...html.matchAll(/<i data-stub="v-remixicon"[^>]*>/g)].map(
    (m) => m[0]
  );
  assert.equal(icons.length, 2, '工具卡应有 2 个图标（折叠箭头 + 状态徽标）');
  for (const icon of icons) {
    assert.match(
      icon,
      /\bsize="\d+"/,
      '图标必须带显式 size —— v-remixicon 默认 24px 会把 12px 的折叠行顶高'
    );
  }

  assert.ok(
    html.includes('detail=summary'),
    '折叠态应给一行 key=value 摘要（展开后让位给正文）'
  );
  assert.ok(html.includes('font-mono'), '工具名是标识符，应走等宽体');
});

test('T-153：模型名仍在会话列表里渲染（搬走水位时别把它一起丢了）', async () => {
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
  const queued = await renderSfc(PANEL, {
    props: { host: panelHost({ busy: true, pendingInterjections: 2 }) },
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
    props: { host: panelHost({ busy: false, pendingInterjections: 0 }) },
  });
  assert.equal(
    idle.includes('data-test="pending-interjections"'),
    false,
    '不 busy 时不该显示插话提示行'
  );

  const drained = await renderSfc(PANEL, {
    props: { host: panelHost({ busy: true, pendingInterjections: 0 }) },
  });
  assert.equal(
    drained.includes('data-test="pending-interjections"'),
    false,
    '队列已排空（pendingInterjections=0）时提示行必须消失，否则会一直显示「已入队 0 条」'
  );
});

test('T-159 / 重设计：发送与停止共用同一个图标按钮位，两个状态都有 aria-label', async () => {
  // 为什么钉这条：忙碌时原是「■ 停止 + 插话」两个按钮并排，8px gap 全从 textarea
  // 身上扣 —— 320px 侧栏里忙碌态 textarea 只剩 144px（headless Chromium 实测），
  // 而忙碌恰恰是最要打字的时刻。重设计把两个按钮合成**一个位置**：
  // 空闲 → 发送、忙碌 → 停止；插话改由 Enter 提交（send() 本来就放行插话队列）。
  const busy = await renderSfc(PANEL, {
    props: { host: panelHost({ busy: true }) },
  });
  assert.ok(
    /aria-label="workflow\.agent\.stop"/.test(busy),
    '忙碌态停止按钮必须有 aria-label —— 图标按钮没有文字，读屏只能念「按钮」'
  );
  assert.ok(
    /title="workflow\.agent\.stop"/.test(busy),
    '鼠标 hover 要看到「停止」'
  );
  assert.match(
    busy,
    /data-stub="ui-button"[^>]*\bicon\b/,
    '停止按钮要走 icon-only 分支（UiButton 的 icon → p-2，40×40）'
  );
  assert.equal(
    /aria-label="workflow\.agent\.send"/.test(busy),
    false,
    '忙碌态没有「发送」可言 —— 同位置此时是停止'
  );

  const idle = await renderSfc(PANEL, {
    props: { host: panelHost({ busy: false }) },
  });
  assert.ok(
    /aria-label="workflow\.agent\.send"/.test(idle),
    '图标化的发送按钮同样要有 aria-label，不能只留一个箭头'
  );
  assert.equal(
    /aria-label="workflow\.agent\.stop"/.test(idle),
    false,
    '空闲态不该出现停止按钮'
  );
  // 两个状态都得是 icon —— 只要有一侧退回文字按钮，两侧宽度就不一致，
  // 输入框会在忙碌/空闲切换时跳动。
  assert.match(
    idle,
    /data-stub="ui-button"[^>]*\bicon\b/,
    '发送按钮也要走 icon-only 分支，否则与忙碌态宽度不一致'
  );
});

test('T-153/T-213：快捷键提示从常驻行改挂发送键 title，忙碌时改说「插话」', async () => {
  // T-213 把那条常驻的「Enter 发送 · Shift+Enter 换行」提示行删了（省 14px 常驻
  // 高度），整句并进发送键的 title —— hover 才付费。所以这里钉的是**它还在**、
  // 只是换了位置：不能因为「不在页面上」就顺手丢掉，「怎么把话送出去」还是得有说明。
  const idle = await renderSfc(PANEL, {
    props: { host: panelHost({ busy: false }) },
  });
  assert.ok(
    idle.includes('workflow.agent.inputHint'),
    '空闲态仍要能说出 Enter 发送 / Shift+Enter 换行 —— 现在挂在发送键 title 上'
  );
  assert.ok(
    idle.includes('data-test="send-wrap"'),
    '提示挂在 send-wrap 这个 span 的 title 上（不是 disabled 的按钮本身，见 T-160）'
  );
  assert.equal(
    idle.includes('workflow.agent.interjectHint'),
    false,
    '空闲态不该说插话 —— 那时 Enter 走的是普通发送'
  );
  assert.equal(
    idle.includes('data-test="composer-hint"'),
    false,
    'T-213：composer 顶部那条常驻提示行该没了 —— 它已经并进 title'
  );

  const busy = await renderSfc(PANEL, {
    props: { host: panelHost({ busy: true }) },
  });
  // 忙碌时没有 send-wrap（换成停止键），所以插话提示此时**没有宿主**。
  // 这不是回退：忙碌态输入框里打的话由 Enter 进队列，唯一要说的「在排队」
  // 由 transcript 上方的常驻条报（T-12），底行不再重复。
  assert.ok(busy.includes('data-test="stop-button"'), '忙碌态发送位换成停止键');

  const unconfigured = await renderSfc(PANEL, {
    props: {
      host: panelHost({ config: { model: 'm', contextWindow: 128000 } }),
    },
  });
  assert.equal(
    unconfigured.includes('workflow.agent.inputHint'),
    false,
    '未配置 API Key 时发送键不渲染，提示也随之消失'
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
