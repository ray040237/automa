<template>
  <div
    class="max-w-full min-w-0 rounded border border-gray-200 dark:border-gray-700"
  >
    <!-- T-175：头部从 text-sm 降到 text-xs —— 工具调用是**元信息**，不该跟
         助手正文（AgentMarkdown 根节点 text-sm = 14px）抢同一档大小。
         图标同步给显式 size：v-remixicon 默认 24px，一条 text-xs 的折叠行里
         塞 24px 图标，行高被图标顶起来，"看起来很大"的主因其实在这里。
         工具名是标识符（list_tabs），用等宽体和代码块读法一致。 -->
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <v-remixicon
        :name="expanded ? 'riArrowDropDownLine' : 'riArrowRightLine'"
        size="16"
        class="shrink-0 text-gray-400 dark:text-gray-500"
      />
      <span class="shrink-0 font-mono font-medium">{{ step.name }}</span>
      <!-- 折叠态给一行摘要，展开后让位给正文。truncate + min-w-0 保证它
           不会把状态徽标挤出去（320px 侧栏里参数可能是长 URL）。 -->
      <span
        v-if="!expanded && summary"
        class="min-w-0 flex-1 truncate text-gray-400 dark:text-gray-500"
        >{{ summary }}</span
      >
      <span
        class="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px]"
        :class="statusClass"
      >
        <v-remixicon :name="statusIcon" size="12" class="shrink-0" />
        {{ statusLabel }}
      </span>
    </button>

    <div
      v-if="expanded"
      class="max-h-56 overflow-y-auto overflow-x-hidden border-t border-gray-200 px-2 py-1.5 dark:border-gray-700"
    >
      <!-- T-157 修了一件，T-174 补上另一件，T-175 加上标签 —— 前两件缺一不可。
           T-157：观察值/参数里会出现长 URL、base64、data URI、单行压缩 JSON 这类
           **无空格长串**。`whitespace-pre-wrap` 只在空格处断行，断不了就横向撑开。
           T-174：`break-words`（overflow-wrap: break-word）**不参与 min-content
           计算** —— 工具卡在 flex 列里带 self-start，非 stretch 子项按 fit-content
           定宽、其下界正是 min-content，于是长串把**卡片本身**撑到比面板还宽，
           叶子上的 overflow-x-auto 救不了（被撑宽的是容器，不是叶子）。
           改用 `[overflow-wrap:anywhere]` 参与 min-content，长串就地折断；
           外层只留纵向滚动 —— 横向溢出必须靠断行解决，不靠滚动条藏起来。
           T-175：两段内容原先没有任何标签，用户分不清哪段是参数、哪段是返回。 -->
      <template v-if="argRows.length">
        <p class="mb-0.5 text-[11px] text-gray-400 dark:text-gray-500">
          {{ t('workflow.agent.tool.args') }}
        </p>
        <dl class="mb-1.5 flex flex-col gap-0.5">
          <div
            v-for="row in argRows"
            :key="row.key"
            class="flex min-w-0 gap-1.5 text-xs"
          >
            <dt class="shrink-0 font-mono text-gray-400 dark:text-gray-500">
              {{ row.key }}
            </dt>
            <dd
              class="min-w-0 flex-1 whitespace-pre-wrap font-mono text-gray-700 [overflow-wrap:anywhere] dark:text-gray-200"
            >
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </template>
      <pre
        v-if="prettyArgs"
        class="mb-2 whitespace-pre-wrap font-mono text-xs text-gray-700 [overflow-wrap:anywhere] dark:text-gray-200"
        >{{ prettyArgs }}</pre
      >

      <template v-if="displayObservation">
        <p class="mb-0.5 text-[11px] text-gray-400 dark:text-gray-500">
          {{ t('workflow.agent.tool.observation') }}
        </p>
        <pre
          class="whitespace-pre-wrap font-mono text-xs text-gray-700 [overflow-wrap:anywhere] dark:text-gray-200"
          >{{ displayObservation }}</pre
        >
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { TOOL_STATUS } from '@/agent/events';
import { stripUntrustedForDisplay } from '@/agent/untrusted';

const props = defineProps({
  step: { type: Object, required: true },
});

const { t } = useI18n();
const expanded = ref(false);

/**
 * 超过这么多键的扁平对象就不再铺键值行，退回 JSON（不然卡片会长得没边）。
 */
const MAX_INLINE_ARGS = 4;

/**
 * 参数里「一层扁平的小对象」铺成键值行（T-175）：
 * `{ "limit": 20, "tabId": 81 }` 比 JSON 少一层括号与引号，窄面板里也省一截缩进。
 * 只要出现嵌套对象/数组就**整体**退回 JSON —— 两行键值接一段 JSON 的混排比
 * 统一 JSON 更难扫。`prettyArgs` 与这里互斥（见下）。
 */
const argRows = computed(() => {
  const { args } = props.step;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const keys = Object.keys(args);
  if (!keys.length || keys.length > MAX_INLINE_ARGS) return [];
  const rows = keys.map((key) => {
    const { [key]: value } = args;
    if (value !== null && typeof value === 'object') return null;
    return { key, value: value === null ? 'null' : String(value) };
  });
  return rows.every(Boolean) ? rows : [];
});

/**
 * 折叠态的一行摘要（T-175）：取前两个标量参数拼 `key=value`。
 * **不做翻译** —— 它渲染的是参数本身，键名就是工具契约里的键，语言无关。
 * 全是对象/数组参数时为空，头部就只剩工具名，不会硬凑一句话出来。
 */
const summary = computed(() => {
  const { args } = props.step;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const parts = [];
  for (const key of Object.keys(args)) {
    const { [key]: value } = args;
    // 只取标量：对象/数组参数拼成一行读不出意思，直接跳过
    const scalar = value !== null && typeof value !== 'object';
    const text = scalar ? String(value) : '';
    if (text) parts.push(`${key}=${text}`);
    if (parts.length === 2) break;
  }
  return parts.join(' ');
});

/**
 * 参数块的 **JSON 渲染文本**。小对象已经铺成键值行了，这里必须让位
 * （否则同一份参数在卡片里渲染两遍）。
 * 守卫（panelUi.test.js）钉的是「参数块由 prettyArgs 驱动」这条语义，
 * 所以这里保留 `<pre v-if="prettyArgs">` 的形式。
 */
const prettyArgs = computed(() => {
  if (argRows.value.length) return '';
  const { args } = props.step;
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch (e) {
    return String(args);
  }
});

// 被拒绝和出错必须一眼能分出来：前者不是模型的错，后者模型还能自纠
//
// T-172 之后，琥珀在本面板里**只剩这一个语义**「工具被你拒绝了」：
// notice 退了中性灰、确认门升了 accent、未配置横幅改了红。
// 所以这里的琥珀不再是「三种警示里的一种」，它就是「拒绝」的专用色 ——
// 改它之前先想清楚它会被谁撞上。
const STATUS_STYLE = {
  [TOOL_STATUS.OK]: 'bg-green-500/15 text-green-700 dark:text-green-400',
  [TOOL_STATUS.ERROR]: 'bg-red-500/15 text-red-600 dark:text-red-400',
  [TOOL_STATUS.REJECTED]: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

const STATUS_LABEL = {
  [TOOL_STATUS.OK]: 'workflow.agent.tool.ok',
  [TOOL_STATUS.ERROR]: 'workflow.agent.tool.error',
  [TOOL_STATUS.REJECTED]: 'workflow.agent.tool.rejected',
  [TOOL_STATUS.RUNNING]: 'workflow.agent.tool.running',
  [TOOL_STATUS.PENDING]: 'workflow.agent.tool.running',
};

const statusLabel = computed(() =>
  t(STATUS_LABEL[props.step.status] || 'workflow.agent.tool.running')
);

/**
 * 展示用的观察值（T-07）。
 *
 * step.observation 是**给模型看**的字符串：外面裹着 untrusted_* 标签（红线 2 的
 * 不可信边界标记），截断时还带一句写给模型的 note。原样渲染等于把这些内部标记
 * 摊给用户看，人会当成乱码或漏洞。
 *
 * 只在展示层剥：events.js 的包装一行没动，模型侧继续看到标签。
 */
const displayObservation = computed(() =>
  stripUntrustedForDisplay(props.step.observation, {
    noteText: t('workflow.agent.tool.truncatedNote'),
  })
);

const statusClass = computed(
  () =>
    STATUS_STYLE[props.step.status] ||
    'bg-gray-500/15 text-gray-600 dark:text-gray-400'
);

/**
 * 状态不能只靠颜色区分（T-13）：色觉障碍用户分不出「失败」与「被拒绝」，
 * 暗色模式下两档红/琥珀的对比度也接近。徽标上再挂一个**形状不同**的图标，
 * 颜色退成冗余通道。
 *
 * ✕（失败）与 ⊗（被拒）刻意选得不一样：这两个状态最容易混，前者是模型的错、
 * 它还能自纠，后者是用户或策略挡下的，重试的意义完全不同。
 */
const STATUS_ICON = {
  [TOOL_STATUS.OK]: 'riCheckLine',
  [TOOL_STATUS.ERROR]: 'riCloseLine',
  [TOOL_STATUS.REJECTED]: 'riCloseCircleLine',
  [TOOL_STATUS.RUNNING]: 'riLoader4Line',
  [TOOL_STATUS.PENDING]: 'riLoader4Line',
};

const statusIcon = computed(
  () => STATUS_ICON[props.step.status] || 'riInformationLine'
);
</script>
