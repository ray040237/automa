<template>
  <div ref="root" class="relative min-w-0">
    <div class="cursor-pointer" @click="toggle">
      <slot name="trigger"></slot>
    </div>

    <!--
      absolute 而不是 fixed / 挂到 body 上：本面板只有 320px 宽，装在编辑器侧栏里。
      实测过挂到 body 的 tippy 弹层会出现三种症状 —— ① 下拉顶出侧栏宽度；
      ② 压到 header 右边的新建/删除按钮；③ 在输入区点开后把整个面板撑开。
      三条都出在「内容脱离了本列的宽度约束」上。
      absolute 让它永远不参与布局：点开不会把页面挤开，也不可能越过侧栏边缘。
    -->
    <div
      v-if="modelValue"
      class="absolute z-50 rounded-lg border bg-white shadow-xl text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
      :class="panelClass"
    >
      <slot></slot>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';

/**
 * 面板专用下拉。
 *
 * 为什么不用现成的 UiPopover：它给宽页面里的轻量菜单设计，内容由 tippy 挂到
 * document.body 上自行定位。本面板只有 320px 宽、装在编辑器侧栏里，tippy 的
 * 定位与宽度都不受本列约束（实测三条症状，见模板里的注释）。这里改成留在本列内、
 * absolute 定位 —— 宽度由本列决定，物理上顶不出去，也不会挤动布局。
 *
 * 颜色也在这里显式定死（text-gray-800 / dark:text-gray-100）：菜单底色是
 * bg-white / dark:bg-gray-800，若不显式给字色就会跟着父级继承成「底色同色」，
 * 菜单项看不见 —— 这正是删除按钮消失的原因。
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 贴哪一侧：left 用于「当前值」型下拉，right 用于 ⋯ 这种贴在右边的菜单
  align: { type: String, default: 'left' },
  // 朝哪边展开。面板底部的 chip 必须用 top —— 往下展在矮窗口里会被视口截断
  side: { type: String, default: 'bottom' },
  width: { type: String, default: 'w-64' },
});

const emit = defineEmits(['update:modelValue']);

const root = ref(null);

const panelClass = computed(() =>
  [
    props.width,
    props.align === 'right' ? 'right-0' : 'left-0',
    props.side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
  ].join(' ')
);

function toggle() {
  emit('update:modelValue', !props.modelValue);
}

function close() {
  emit('update:modelValue', false);
}

// 点别处 / 按 Esc 收起。监听挂在 document 上，所以命中判定要问 root
function onDocumentClick(e) {
  if (root.value && !root.value.contains(e.target)) close();
}

function onKeydown(e) {
  if (e.key === 'Escape') close();
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      document.addEventListener('click', onDocumentClick, true);
      document.addEventListener('keydown', onKeydown);
    } else {
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onKeydown);
    }
  }
);

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onKeydown);
});
</script>
