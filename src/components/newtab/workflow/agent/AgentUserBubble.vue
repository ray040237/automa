<template>
  <!--
    T-205：长提问自动折叠。

    助手场景里「贴一大段东西进来问」是高频用法（贴报错、贴 HTML、贴表格），
    一条长输入能把 320px 侧栏的一屏占满，助手的回答要滚很久才看得到。

    折叠阈值判定在 `@/agent/foldText`（纯模块，有单测）；这里只负责
    「量高度 → 消费判定 → 摆位置」，不自己写阈值比较 —— 见该模块头注的三个边界。
  -->
  <div class="max-w-full self-end" data-test="user-bubble">
    <!--
      观感：用户气泡从 `bg-blue-500/15` 换成 `bg-accent/10`。
      蓝色透明是「标签/通知」的语义色（错误横幅、未配 Key 提示、上下文将满），
      用户自己的提问用它就把"我说了什么"读成"系统提示"。`bg-accent/10` 借
      的是 accent 家族的底色（一档很淡的灰蓝），亮暗两套 accent 都过得去，
      落在 canvas/surface 上是「同色系的浅一档」——读作「这是我发的」，
      不是「这是条提示」。
      内边距从 px-3 py-2 升到 px-3.5 py-2.5：3% 明度差的浅气泡 + 紧边距 = 卡片
      效果；留多 4px 后文字才像在「说」，不在「贴」。
    -->
    <div
      ref="bodyEl"
      class="relative max-w-full self-end whitespace-pre-wrap rounded-card bg-accent/10 px-3.5 py-2.5 text-sm [overflow-wrap:anywhere]"
      :class="collapsed ? 'overflow-hidden' : ''"
      :style="collapsed ? { maxHeight: `${maxPx}px` } : null"
      data-test="user-bubble-body"
    >
      {{ text }}
      <!-- 底部渐隐：折叠时提示「下面还有」。pointer-events-none 让它不吃点击，
           叠在最后一行文字上只做视觉提示。 -->
      <div
        v-if="collapsed"
        class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-accent/10 to-transparent"
        aria-hidden="true"
        data-test="user-bubble-fade"
      />
    </div>
    <button
      v-if="foldable"
      type="button"
      class="mt-1 text-xs text-fg-2 hover:text-fg-1"
      :aria-expanded="!collapsed"
      data-test="user-bubble-toggle"
      @click="expanded = !expanded"
    >
      {{
        collapsed
          ? t('workflow.agent.expandUserMessage')
          : t('workflow.agent.collapseUserMessage')
      }}
    </button>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { foldDecision, USER_FOLD_MAX_PX } from '@/agent/foldText';

const props = defineProps({
  text: { type: String, default: '' },
});

const { t } = useI18n();

const bodyEl = ref(null);
// 量到的内容高度。0 = 还没量到（首帧/未挂载）—— foldDecision 对 0 明确返回
// 「不折」，见模块头注①。
const measuredPx = ref(0);
const expanded = ref(false);

const maxPx = USER_FOLD_MAX_PX;

const fold = computed(() =>
  foldDecision({
    measuredPx: measuredPx.value,
    expanded: expanded.value,
    maxPx,
  })
);
const foldable = computed(() => fold.value.foldable);
const collapsed = computed(() => fold.value.collapsed);

/**
 * 量内容高度。
 *
 * 用 scrollHeight 而不是 offsetHeight：折叠态下外层被 maxHeight 夹住，
 * offsetHeight 只能量到被夹之后的高度（永远等于阈值），量不出「本来多高」。
 * scrollHeight 是内容的全高，不受 max-height 影响 —— 所以展开/收起都能量到同一个真值。
 */
function measure() {
  const el = bodyEl.value;
  if (!el) return;
  measuredPx.value = el.scrollHeight;
}

onMounted(measure);
// 文本变化（流式 / 换会话）后重测；nextTick 等 DOM 更新完再量。
watch(
  () => props.text,
  async () => {
    // 文本一变，先前「已展开」的选择对它未必还成立（有时一条消息的 text 会被
    // 原地改写）；重置成折叠是更保守的一侧，避免留下一个悬空的展开态。
    expanded.value = false;
    await nextTick();
    measure();
  }
);
</script>
