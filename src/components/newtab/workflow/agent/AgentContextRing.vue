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
  <!--
    T-163：整段渲染的条件加了「>= CONTEXT_WARN_AT」。

    原先是「算得出来就渲染」，于是 320px 的元信息行上常年挂着一个 60px 的
    圆环 + 「上下文 62%」，而 62% 这件事对用户没有任何可行动的含义 —— 它既不
    提示该压缩、也不提示该开新会话。消费级产品（Dia / Atlas / Gemini in Chrome）
    一律不暴露 token 水位，只有 Cursor、Claude Code 这类开发者工具才暴露；我们
    是 BYOK 侧栏，保留这个诚实的信息，但改成**平时不打扰、要紧时才说话**。
  -->
  <span
    v-if="visible"
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

      <!--
        >=95% 才附这两个字（T-163：由整句改成短词）。

        整句「上下文将满，建议新建会话」是 14 个字，在 288px 的底行里会把
        「@ 选页 + 水位 + hint + 发送」挤到换行 —— 实测元信息行从 24px 撑到
        46px，恰恰在最需要看正文的时候吃掉 22px。改成「将满」两个字，单行
        稳在 32px；完整那句（含估算说明与 token 用量）留给点开的明细，它本来
        就在那儿（AgentPanel 的 dropdown 里）。
      -->
      <span
        v-if="critical"
        class="whitespace-nowrap text-[11px] leading-none text-red-500 dark:text-red-400"
        data-test="context-critical"
      >
        {{ t('workflow.agent.contextCriticalShort') }}
      </span>
    </button>
  </span>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  CONTEXT_CRITICAL_AT,
  CONTEXT_WARN_AT,
  contextPercent as calcContextPercent,
  fmtTokens,
} from '@/agent/usage';

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
 * 要不要渲染（T-163）。
 *
 * 两道条件：算得出来（分母与用量都在）+ 到了提示档。低于 80% 就整段不出现 ——
 * 「整段」而不是「置灰」：一个常年显示 62% 的环是噪音，它不提示任何可行动的事。
 */
const visible = computed(
  () => percent.value !== null && percent.value >= CONTEXT_WARN_AT
);

const critical = computed(
  () => percent.value !== null && percent.value >= CONTEXT_CRITICAL_AT
);

const elevated = computed(
  () => percent.value !== null && percent.value >= CONTEXT_WARN_AT
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
  if (percent.value >= CONTEXT_CRITICAL_AT)
    return 'text-red-500 dark:text-red-400';
  if (percent.value >= CONTEXT_WARN_AT) return 'text-accent';
  return 'text-gray-400 dark:text-gray-500';
});

const textTone = computed(() => {
  if (percent.value >= CONTEXT_CRITICAL_AT)
    return 'text-red-500 dark:text-red-400 font-medium';
  if (percent.value >= CONTEXT_WARN_AT) return 'text-accent font-medium';
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
 * 三句都复用既有文案键（contextShort / contextHint / usage）—— 水位原本渲染在
 * 会话下拉里，搬走后这三个键若没人引用就会变成孤儿（T-109 踩过）。
 *
 * 行内那两个字的告急提示走 contextCriticalShort（T-163），**不复用
 * contextCritical**：后者是完整一句「上下文将满，建议新建会话」，太长会把底行
 * 挤换行；它现在由 AgentPanel 的明细面板引用（点开环之后），两边各取所需，
 * 谁也不是孤儿键。
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
