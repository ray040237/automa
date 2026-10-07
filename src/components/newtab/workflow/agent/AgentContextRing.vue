<template>
  <!--
    T-153：上下文水位圆环。

    为什么是圆环而不是进度条：这个面板挂在 320px 侧栏里，垂直方向是按像素算的 ——
    进度条要占一整行（条高 + margin），而 14px 的环塞进按钮行就行，垂直代价为 0。
    数字与用量全部收进 title / aria-label，常驻只剩一个环。

    为什么算不出来时整环不渲染、而不是显示 0%：见 `usage.js` 的 contextPercent。
    分母是用户在设置页填的**建议值**，拿不到时 0% 会被读成「完全没占」，
    那比不知道更糟。
  -->
  <span
    v-if="percent !== null"
    class="flex h-10 shrink-0 items-center"
    role="img"
    data-test="context-meter"
    :title="hint"
    :aria-label="short"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      class="-rotate-90"
      :class="tone"
      aria-hidden="true"
    >
      <!-- 轨道用同色淡化而不是另配一个灰：主色在深浅两主题下都跟着走，
           不必维护两套灰阶。 -->
      <circle
        cx="8"
        cy="8"
        :r="RADIUS"
        fill="none"
        stroke="currentColor"
        class="opacity-25"
        :stroke-width="strokeWidth"
      />
      <circle
        cx="8"
        cy="8"
        :r="RADIUS"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        :stroke-width="strokeWidth"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
  </span>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { contextPercent as calcContextPercent, fmtTokens } from '@/agent/usage';

/**
 * 上下文水位圆环（T-153）。
 *
 * 判定一律来自 `@/agent/usage` —— 那里有单测钉着「分母缺失 / 已用为负 / 超过 100」
 * 三种边界，`.vue` 里的分支一条都测不到，所以这里不做任何百分比计算。
 */
const props = defineProps({
  usage: { type: Object, default: null },
  // config.contextWindow：**用户填的建议值**，不是实测窗口
  contextWindow: { type: Number, default: 0 },
});

const { t } = useI18n();

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const percent = computed(() =>
  calcContextPercent(props.usage, props.contextWindow)
);

/**
 * 三档**重量**，不是三种颜色。
 *
 * 项目的 accent 浅色下是 24 24 27（近黑）、深色下是 244 244 245（近白）——
 * 主色本身就是黑白，整套 UI 也只认这一个色。所以档位靠**粗细**递进：
 * 常态细环，接近上限加粗，只有真要到顶（>=90%）才动用红色 —— 红在本面板
 * 里已经有明确语义（T-04 把 error 从琥珀改成红），不该再拿去做装饰。
 */
const strokeWidth = computed(() => (percent.value >= 70 ? 3 : 2));

const tone = computed(() =>
  percent.value >= 90 ? 'text-red-500 dark:text-red-400' : 'text-accent'
);

/**
 * 超过 100 不夹在百分比上（夹了就看不出已经超了），但 dashoffset 必须夹 ——
 * 负值会让环从反方向绕回来，视觉上像「又空了」。
 */
const dashOffset = computed(() => {
  const clamped = Math.min(100, Math.max(0, percent.value ?? 0));
  return CIRCUMFERENCE * (1 - clamped / 100);
});

/**
 * title 与 aria-label 分开，不是同一句：
 * - title 给鼠标 hover，要完整（水位 + 估算说明 + 输入/输出用量）；
 * - aria-label 给读屏，用短句，否则每次播报都念一整段解释。
 *
 * 两句都复用既有文案键（contextShort / contextHint / usage），不新增 i18n 键 ——
 * 水位原本渲染在会话下拉里，搬走后这三个键若没人引用就会变成孤儿。
 */
const short = computed(() =>
  percent.value === null
    ? ''
    : t('workflow.agent.contextShort', { pct: percent.value })
);

const hint = computed(() => {
  if (percent.value === null || !props.usage) return '';

  return [
    t('workflow.agent.contextHint', {
      pct: percent.value,
      win: fmtTokens(props.contextWindow),
    }),
    t('workflow.agent.usage', {
      in: fmtTokens(props.usage.input),
      out: fmtTokens(props.usage.output),
    }),
  ].join('\n');
});
</script>
