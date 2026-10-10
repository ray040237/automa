<template>
  <!--
    T-153：上下文水位圆环（T-213 起**不再常驻百分比**）。

    为什么是圆环而不是进度条：这个面板挂在 320px 侧栏里，垂直方向是按像素算的 ——
    进度条要占一整行（条高 + margin），而 16px 的环塞进文本行里就行，垂直代价为 0。

    T-213：原先环旁边常驻一个「上下文 62%」。那 62% 既不可点、也不提示任何
    可行动的事 —— 用户看完不知道要做什么。参考实现 pie 的 ContextRing 源码里
    有一条很克制的注释：消费级产品不暴露 token 水位，且**不渲染任何数字**。
    现在把精确值挪进 title：想知道的人 hover 一下就有，不想知道的人不必每天
    读一个百分比。320px 底行里这也省下约 60px —— 那可是模型名要用的地方。

    为什么算不出来时整段不渲染、而不是显示 0%：见 `usage.js` 的 contextPercent。
    分母是用户在设置页填的**建议值**，拿不到时 0% 会被读成「完全没占」，
    那比不知道更糟。

    它是**状态，不是按钮**（重设计 A 条）：样式上无填充、无边框，视觉重量与右侧的
    发送键差一档，不和它争夺注意力。可点开是因为外层
    AgentDropdown 的 trigger 包着它 —— 点开后是 token 明细与「新建会话」，
    见 AgentPanel 的 §元信息行。
  -->
  <!--
    T-163：整段渲染的条件加了「>= CONTEXT_WARN_AT」。

    原先是「算得出来就渲染」，于是 320px 的底行上常年挂着一个环 —— 而 62%
    这件事对用户没有任何可行动的含义（既不提示该压缩、也不提示该开新会话）。
    消费级产品（Dia / Atlas / Gemini in Chrome）一律不暴露 token 水位，只有
    Cursor、Claude Code 这类开发者工具才暴露；我们是 BYOK 侧栏，保留这个诚实的
    信息，但改成**平时不打扰、要紧时才说话**。
  -->
  <span
    v-if="visible"
    class="inline-flex min-w-0 items-center"
    data-test="context-meter"
  >
    <button
      type="button"
      class="flex min-w-0 items-center rounded-chip p-0.5"
      :title="hint"
      :aria-label="ariaLabel"
      data-test="context-ring"
    >
      <!-- T-213：14px → 16px，与参考实现一致。14px 是"塞在文字旁的小点"，
           16px 才是"一个能读的水位表"。 -->
      <svg
        width="16"
        height="16"
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

      <!--
        T-213：常态**不渲染百分比**（用户拍板：「还是用那个圆环展示，
        鼠标移上去会有详情就行」）。精确值在 title 里。

        唯一的例外是 >=95%：那时附上「将满」两个字。这不是"百分比"，
        是**一句可行动的话**（去开新会话）—— 而那正是这个环唯一值得
        常驻出声的时刻。环变红本身就是信号，两个字补上"该怎么办"。

        整句「上下文将满，建议新建会话」仍留给点开的明细：14 个字在
        底行里会把模型名挤到换行，而明细里它本来就在（AgentPanel 的
        dropdown 里）。
      -->
      <span
        v-if="critical"
        class="whitespace-nowrap pl-0.5 text-[11px] leading-none text-danger"
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

/**
 * 三档颜色（T-213 起改用语义色 token）。
 *
 * 参考实现 pie 的 ContextRing 用三档色：正常灰 / ≥60 橙 / ≥80 红。
 * 本仓原先写的是「常态灰 → ≥80 accent 黑/白 + 加粗 → ≥95 红」，中间档刻意
 * 避开琥珀（因为它在本面板已被 notice / 确认门 / 未配置横幅三种语义共用）。
 * T-213 新增了 `warn` token，正是为这个中间档准备的 —— 参考实现证明橙档
 * 是有效的（"接近但还没到"就该有自己的一档），而把它命名为 warn 而不是
 * 沿用 amber，也让它与那三处语义区分开。
 *
 * 环没有文字时，颜色是**唯一的**信息通道 —— 三档必须彼此可辨：
 *   fg-2（灰，弱） → warn（橙，接近） → danger（红，该开新会话了）
 */
const ringTone = computed(() => {
  if (percent.value >= CONTEXT_CRITICAL_AT) return 'text-danger';
  if (percent.value >= CONTEXT_WARN_AT) return 'text-warn';
  return 'text-fg-2';
});

/** ≥80 加粗一档：颜色之外再给一条非色彩的冗余信号（色盲用户） */
const strokeWidth = computed(() => (critical.value ? 2.5 : 2));

/**
 * 超过 100 不夹在百分比上（夹了就看不出已经超了），但 dashoffset 必须夹 ——
 * 负值会让环从反方向绕回来，视觉上像「又空了」。
 */
const dashOffset = computed(() => {
  const clamped = Math.min(100, Math.max(0, percent.value ?? 0));
  return CIRCUMFERENCE * (1 - clamped / 100);
});

/**
 * T-213：读屏念的短句。
 *
 * 原先这个位置直接复用 `short`（也就是渲染出来的那个百分比），环不再渲染
 * 文字之后 `short` 就成了孤儿计算属性 —— 但**不能删**：视觉上省掉的信息，
 * 读屏用户仍然该拿到（他们无法 hover，title 对他们不存在）。
 * 所以把它接到 aria-label 上：看得见的人 hover，看不见的人直接听到。
 */
const ariaLabel = computed(() =>
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
