<template>
  <div class="scroll scroll-xs max-h-[60vh] w-64 max-w-[80vw] overflow-y-auto">
    <div v-if="loading" class="py-6 text-center text-sm text-gray-500">
      {{ t('workflow.agent.pickTab.loading') }}
    </div>

    <p
      v-else-if="groups.length === 0"
      class="px-2 py-6 text-center text-sm text-gray-500"
    >
      {{ t('workflow.agent.pickTab.empty') }}
    </p>

    <template v-else>
      <div v-for="g in groups" :key="g.windowId" class="mb-2 last:mb-0">
        <div class="mb-1 px-2 text-xs uppercase text-gray-400">
          {{ windowLabel(g.windowId) }}
        </div>
        <button
          v-for="tab in g.tabs"
          :key="tab.id"
          v-close-popover
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hoverable"
          :class="{ 'bg-box-transparent': isCurrent(tab) }"
          @click="pick(tab)"
        >
          <v-remixicon name="riEarthLine" class="shrink-0 text-gray-400" />
          <span class="min-w-0 flex-1">
            <span class="block truncate">{{ tab.title || tab.url }}</span>
            <span class="block truncate text-xs text-gray-400">
              {{ tab.url }}
            </span>
          </span>
          <v-remixicon
            v-if="isCurrent(tab)"
            name="riCheckLine"
            class="shrink-0 text-accent"
          />
        </button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 标签页列表（无容器）：
 * 只管渲染，选中后 emit 出去 —— 外壳由调用方决定（面板用的是 ui-popover）。
 *
 * 之前这个列表内嵌在 AgentTabPicker 的 ui-modal 里，而那个 modal 宽 w-[32rem]
 * （512px），比它所在的 320px 侧栏还宽 —— 用弹窗是被逼的，不是设计选择。
 * 抽出来之后外壳换成 popover，列表本身一行没改。
 */
const props = defineProps({
  groups: { type: Array, default: () => [] },
  currentTab: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(['pick']);

const { t } = useI18n();

// 模板里直接用，省一层函数
const currentId = computed(() => (props.currentTab ? props.currentTab.id : -1));

function isCurrent(tab) {
  return currentId.value === tab.id;
}

function windowLabel(id) {
  return id === 1
    ? t('workflow.agent.pickTab.mainWindow')
    : t('workflow.agent.pickTab.window', { n: id });
}

function pick(tab) {
  emit('pick', {
    id: tab.id,
    url: tab.url,
    title: tab.title || tab.url,
    windowId: tab.windowId,
  });
}
</script>
