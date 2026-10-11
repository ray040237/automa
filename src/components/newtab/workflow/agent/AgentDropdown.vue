<template>
  <div ref="root" class="relative min-w-0">
    <div
      ref="triggerWrap"
      class="cursor-pointer"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <slot name="trigger" :aria="triggerAria"></slot>
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
      ref="panel"
      class="absolute z-50 rounded-card border border-line bg-surface shadow-xl text-fg-1"
      :class="panelClass"
      :role="role || undefined"
    >
      <slot></slot>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

/**
 * 面板专用下拉。
 *
 * 为什么不用现成的 UiPopover：它给宽页面里的轻量菜单设计，内容由 tippy 挂到
 * document.body 上自行定位。本面板只有 320px 宽、装在编辑器侧栏里，tippy 的
 * 定位与宽度都不受本列约束（实测三条症状，见模板里的注释）。这里改成留在本列内、
 * absolute 定位 —— 宽度由本列决定，物理上顶不出去，也不会挤动布局。
 *
 * 颜色也在这里显式定死（text-fg-1）：菜单底色是 bg-surface（亮 = 白 / 暗 =
 * #1F1F23，T-209 起归三层灰家族、T-230 起对齐 zinc），若不显式给字色就会跟着父级继承成
 * 「底色同色」，菜单项看不见 —— 这正是删除按钮消失的原因。
 *
 * T-155 a11y 契约：
 *  - aria-expanded / aria-haspopup 经 **scoped slot** 交给消费方绑到 trigger
 *    的真实按钮上（挂在包装 div 上读屏不认），本组件不猜 trigger 长什么样；
 *  - 面板角色走 `role` prop（默认 'menu'，条目配 role="menuitem"）；混排内容
 *    （提示文字 + 按钮）的下拉传空串退成 disclosure——只有 aria-expanded；
 *  - 键盘：↑↓/Home/End 在条目间移动（首末回绕）、Esc 收起并把焦点送回
 *    trigger、Tab 走人即收起。条目由 slot 渲染、组件不知道其形状，所以
 *    移动用 **DOM 焦点**在「弹层内可聚焦元素」上现查现走——条目是按钮时
 *    Enter/点击天然生效，消费方零配合。
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 贴哪一侧：left 用于「当前值」型下拉，right 用于 ⋯ 这种贴在右边的菜单
  align: { type: String, default: 'left' },
  // 朝哪边展开。面板底部的 chip 必须用 top —— 往下展在矮窗口里会被视口截断
  side: { type: String, default: 'bottom' },
  width: { type: String, default: 'w-64' },
  // 弹层语义（T-155）：'menu'（默认，条目 menuitem）；混排内容传 '' 退 disclosure
  role: { type: String, default: 'menu' },
});

const emit = defineEmits(['update:modelValue']);

const root = ref(null);
const triggerWrap = ref(null);
const panel = ref(null);

const panelClass = computed(() =>
  [
    props.width,
    props.align === 'right' ? 'right-0' : 'left-0',
    props.side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
  ].join(' ')
);

// haspopup 的取值 = 弹层角色（'menu'）；无角色的 disclosure 不给 haspopup
const triggerAria = computed(() => ({
  'aria-expanded': String(!!props.modelValue),
  ...(props.role ? { 'aria-haspopup': props.role } : {}),
}));

function toggle() {
  emit('update:modelValue', !props.modelValue);
}

function close() {
  emit('update:modelValue', false);
}

// 弹层里可聚焦的条目。条目由消费方经 slot 渲染，只能按「可聚焦按钮/链接」
// 现查 DOM；:not([disabled]) 把禁用项排掉。
function focusableItems() {
  if (!panel.value) return [];
  return Array.from(
    panel.value.querySelectorAll(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )
  );
}

function focusTrigger() {
  const el = triggerWrap.value
    ? triggerWrap.value.querySelector(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    : null;
  if (el) el.focus();
}

/** 在条目间移动焦点；当前焦点不在条目里时 next=首条、prev=末条（首末回绕） */
function focusItem(position) {
  const items = focusableItems();
  if (!items.length) return;

  const idx = items.indexOf(document.activeElement);
  let next;
  if (position === 'first') next = 0;
  else if (position === 'last') next = items.length - 1;
  else if (position === 'next')
    next = idx === -1 ? 0 : (idx + 1) % items.length;
  else
    next =
      idx === -1 ? items.length - 1 : (idx - 1 + items.length) % items.length;
  items[next].focus();
}

// trigger 上的方向键：**关着**就顺势打开并落焦到首/末条（ARIA menu 惯例）。
// 开着时这里不接——事件冒泡到 document 的统一处理器，避免双跳。
function onTriggerKeydown(e) {
  if (props.modelValue) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  emit('update:modelValue', true);
  nextTick(() => focusItem(e.key === 'ArrowDown' ? 'first' : 'last'));
}

// 点别处 / 按 Esc 收起。监听挂在 document 上，所以命中判定要问 root
function onDocumentClick(e) {
  if (root.value && !root.value.contains(e.target)) close();
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    close();
    // ARIA APG：菜单用 Esc 收起后焦点回触发器，否则用户「失位」
    focusTrigger();
    return;
  }
  if (e.key === 'Tab') {
    // Tab 离开菜单即收起（ARIA APG）：焦点自然走，不拦截
    close();
    return;
  }

  const moves = {
    ArrowDown: 'next',
    ArrowUp: 'prev',
    Home: 'first',
    End: 'last',
  };
  const position = moves[e.key];
  if (!position || !panel.value) return;

  // 焦点在 trigger 上时也接管（点开后按 ↑↓ 进入条目）；在弹层外的键不碰
  const inPanel = focusableItems().includes(document.activeElement);
  const inTrigger = triggerWrap.value
    ? triggerWrap.value.contains(document.activeElement)
    : false;
  if (!inPanel && !inTrigger) return;

  e.preventDefault();
  focusItem(position);
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
      // 条目点击后弹层卸载，焦点会掉到 body —— 送回 trigger。点别处关闭时
      // 焦点已在别处，不动它（偷焦点比丢焦点更恼人）。
      nextTick(() => {
        if (document.activeElement === document.body) focusTrigger();
      });
    }
  }
);

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onKeydown);
});
</script>
