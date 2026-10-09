<template>
  <div
    class="max-w-full min-w-0 rounded border border-gray-200 dark:border-gray-700"
  >
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <v-remixicon
        :name="expanded ? 'riArrowDropDownLine' : 'riArrowRightLine'"
        class="shrink-0"
      />
      <span class="font-medium">{{ step.name }}</span>
      <span
        class="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
        :class="statusClass"
      >
        <v-remixicon :name="statusIcon" class="shrink-0" />
        {{ statusLabel }}
      </span>
    </button>

    <div
      v-if="expanded"
      class="max-h-56 overflow-y-auto overflow-x-hidden border-t border-gray-200 px-3 py-2 text-xs dark:border-gray-700"
    >
      <!-- T-157 修了一件，T-174 补上另一件 —— 两者缺一不可。
           T-157：观察值/参数里会出现长 URL、base64、data URI、单行压缩 JSON 这类
           **无空格长串**。`whitespace-pre-wrap` 只在空格处断行，断不了就横向撑开。
           T-174：`break-words`（overflow-wrap: break-word）**不参与 min-content
           计算** —— 工具卡在 flex 列里带 self-start，非 stretch 子项按 fit-content
           定宽、其下界正是 min-content，于是长串把**卡片本身**撑到比面板还宽，
           叶子上的 overflow-x-auto 救不了（被撑宽的是容器，不是叶子）。
           改用 `[overflow-wrap:anywhere]` 参与 min-content，长串就地折断；
           外层只留纵向滚动 —— 横向溢出必须靠断行解决，不靠滚动条藏起来。 -->
      <pre
        v-if="prettyArgs"
        class="mb-2 whitespace-pre-wrap [overflow-wrap:anywhere]"
        >{{ prettyArgs }}</pre
      >
      <pre
        v-if="displayObservation"
        class="whitespace-pre-wrap [overflow-wrap:anywhere]"
        >{{ displayObservation }}</pre
      >
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

const prettyArgs = computed(() => {
  const a = props.step.args;
  if (!a || typeof a !== 'object' || !Object.keys(a).length) return '';
  try {
    return JSON.stringify(a, null, 2);
  } catch (e) {
    return String(a);
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
