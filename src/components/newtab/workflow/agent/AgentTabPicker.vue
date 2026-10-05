<template>
  <!-- side="top"：chip 贴着面板底部，往下展开在矮窗口里会被视口截断 -->
  <agent-dropdown v-model="open" align="left" side="top" width="w-72">
    <template #trigger>
      <button
        type="button"
        class="bg-box-transparent hover:bg-opacity-10 flex max-w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
        :title="t('workflow.agent.pickTab.title')"
      >
        <v-remixicon name="riEarthLine" class="shrink-0 text-gray-400" />
        <span class="truncate text-xs" :class="{ 'text-gray-400': !targetTab }">
          {{ label }}
        </span>
        <v-remixicon name="riArrowDownSLine" class="shrink-0 text-gray-400" />
      </button>
    </template>

    <agent-tab-list
      :groups="groups"
      :current-tab="targetTab"
      :loading="loading"
      @pick="onPick"
    />
  </agent-dropdown>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AgentDropdown from './AgentDropdown.vue';
import AgentTabList from './AgentTabList.vue';

/**
 * 目标页 chip：显示当前助手在读哪一页，点开是一份标签页列表。
 *
 * 这一格以前是「标题 + 一个按钮，按钮点开一个 512px 宽的 ui-modal」。
 * 而它在编辑器侧栏里的可用宽度只有 320px（`sidebarCss.width` 360 − padding 40）——
 * 弹窗比宿主还宽，所以「用弹窗」从来不是设计选择，是被逼的。
 *
 * 中间试过用项目现成的 `ui-popover`，实测三条症状：下拉顶出侧栏、压到 header
 * 的按钮、在输入区点开会把面板撑开（tippy 把内容挂到 body 上定位，脱离本列）。
 * 现在改用本文件夹里的 AgentDropdown（留在本列、absolute）。
 *
 * chip 不做「✕ 解除」：`resolveTargetTab` 永远会解析出一个目标页
 * （pinned → lastAccessed → 当前窗口 → 其他窗口），没有「无目标」这个状态可表达，
 * 硬塞一个解除按钮会造出运行时不支持的假状态。
 */
const props = defineProps({
  targetTab: { type: Object, default: null },
  // 由父组件注入，组件本身不必知道 browser API，也便于单测
  listTabs: { type: Function, required: true },
});

const emit = defineEmits(['pick', 'no-target']);

const { t } = useI18n();

const groups = ref([]);
const loading = ref(false);
const open = ref(false);

const label = computed(() =>
  props.targetTab
    ? props.targetTab.title || props.targetTab.url
    : t('workflow.agent.noTarget')
);

/**
 * 每次打开才拉一次。
 *
 * 一个可读页面都没有时照样把空列表显示出来（列表自带更具体的解释），
 * 同时发 no-target 让宿主弹 toast —— 原来那条路径是「先预检、为空就不开弹窗」，
 * 换成下拉之后已经开了，藏起来反而更别扭。
 */
async function load() {
  loading.value = true;

  try {
    groups.value = await props.listTabs();
    if (groups.value.length === 0) emit('no-target');
  } catch (e) {
    groups.value = [];
    emit('no-target');
  } finally {
    loading.value = false;
  }
}

// 打开时才拉一次。面板可能开着放很久，标签页状态随时会变
watch(open, (v) => {
  if (v) load();
});

function onPick(tab) {
  open.value = false;
  emit('pick', tab);
}
</script>
