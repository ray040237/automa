<template>
  <!--
    T-153：上下文水位圆环 + 常驻百分比。

    为什么是圆环而不是进度条：这个面板挂在 320px 侧栏里，垂直方向是按像素算的 ——
    进度条要占一整行（条高 + margin），而 14px 的环塞进文本行里就行，垂直代价为 0。

    为什么算不出来时整段不渲染、而不是显示 0%：见 `usage.js` 的 contextPercent。
    分母是用户在设置页填的**建议值**，拿不到时 0% 会被读成「完全没占」，
    那比不知道更糟。

    它是**状态，不是按钮**（重设计 A 条）：样式上无填充、无边框，视觉重量与右侧的
    「Enter 发送」提示同级，不和发送键争夺注意力。可点开是因为外层
    AgentDropdown 的 trigger 包着它 —— 点开后是 token 明细与「新建会话」，
    见 AgentPanel 的 §元信息行。
  -->
  <span
    v-if="percent !== null"
    class="inline-flex min-w-0 items-center"
    data-test="context-meter"
  >
    <button
      type="button"
      class="flex min-w-0 items-center gap-1 rounded px-0.5 py-0.5"
      :title="hint"
      :aria-label="short"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        class="-rotate-90 shrink-0"
        :class="ringTone"
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

      <!-- 百分比常驻（重设计 B 条）：原先只有 hover 才看得到，而「要不要按发送」
           正取决于它。文案复用 contextShort，它本来就是「上下文 {pct}%」。 -->
      <span
        class="whitespace-nowrap text-[11px] leading-none"
        :class="textTone"
      >
        {{ short }}
      </span>

      <!-- >=95% 才附这一句（重设计 C 条）：平时零干扰，真要到顶时主动说清后果。
           红色在本面板已有语义（T-04 把 error 从琥珀改成红），这里是它第二个
           合法用途 —— 中间档不引入琥珀，理由见 script 里的 tone 注释。 -->
      <span
        v-if="critical"
        class="whitespace-nowrap text-[11px] leading-none text-red-500 dark:text-red-400"
        data-test="context-critical"
      >
        {{ t('workflow.agent.contextCritical') }}
      </span>
    </button>
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

// 重设计的阈值：80 起提示、95 起告急。比原先的 70/90 更晚 —— 用户实测反馈是
// 「平时零干扰」比「早预警」更值钱，水面下那 10 个点不足以打断输入。
const WARN_AT = 80;
const CRITICAL_AT = 95;

const percent = computed(() =>
  calcContextPercent(props.usage, props.contextWindow)
);

const critical = computed(
  () => percent.value !== null && percent.value >= CRITICAL_AT
);

const elevated = computed(
  () => percent.value !== null && percent.value >= WARN_AT
);

/**
 * 三档**重量 + 明度**，不是三种颜色。
 *
 * 项目的 accent 浅色下是 24 24 27（近黑）、深色下是 244 244 245（近白）——
 * 主色本身就是黑白，整套 UI 也只认这一个色。所以：
 *   常态 灰（弱化到和快捷键提示同级）
 *   >=80 accent 黑/白 + 环加粗（提级，但仍是无彩色）
 *   >=95 红
 *
 * 中间档**刻意不引入琥珀**：琥珀在本面板已被 notice / 确认门 / 未配置横幅三种
 * 语义共用（T-152 待审），再多一处会继续稀释它的警示力；而黑白提级在灰色常态
 * 旁边的对比度已经足够。
 */
const ringTone = computed(() => {
  if (percent.value >= CRITICAL_AT) return 'text-red-500 dark:text-red-400';
  if (percent.value >= WARN_AT) return 'text-accent';
  return 'text-gray-400 dark:text-gray-500';
});

const textTone = computed(() => {
  if (percent.value >= CRITICAL_AT)
    return 'text-red-500 dark:text-red-400 font-medium';
  if (percent.value >= WARN_AT) return 'text-accent font-medium';
  return 'text-gray-500 dark:text-gray-400';
});

const strokeWidth = computed(() => (elevated.value ? 2.5 : 2));

/**
 * 超过 100 不夹在百分比上（夹了就看不出已经超了），但 dashoffset 必须夹 ——
 * 负值会让环从反方向绕回来，视觉上像「又空了」。
 */
const dashOffset = computed(() => {
  const clamped = Math.min(100, Math.max(0, percent.value ?? 0));
  return CIRCUMFERENCE * (1 - clamped / 100);
});

/**
 * 可见文本与 aria-label 同源（都是 short），title 才是完整那句：
 * - title 给鼠标 hover，要完整（水位 + 估算说明 + 输入/输出用量）；
 * - 读屏念的是 aria-label 短句，不把整段解释再念一遍。
 *
 * 三句都复用既有文案键（contextShort / contextHint / usage），只多了
 * contextCritical 一句（>=95% 行内提示）—— 水位原本渲染在会话下拉里，
 * 搬走后前三个键若没人引用就会变成孤儿（T-109 踩过）。
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
