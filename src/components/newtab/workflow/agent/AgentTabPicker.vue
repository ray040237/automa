<template>
  <ui-modal
    :model-value="visible"
    :title="t('workflow.agent.pickTab.title')"
    content-class="w-[32rem]"
    @close="close"
  >
    <div class="max-h-[60vh] overflow-y-auto">
      <div v-if="loading" class="py-8 text-center text-sm text-gray-500">
        {{ t('workflow.agent.pickTab.loading') }}
      </div>

      <p
        v-else-if="groups.length === 0"
        class="py-8 text-center text-sm text-gray-500"
      >
        {{ t('workflow.agent.pickTab.empty') }}
      </p>

      <template v-else>
        <div v-for="g in groups" :key="g.windowId" class="mb-3">
          <div class="mb-1 px-2 text-xs uppercase text-gray-400">
            {{ windowLabel(g.windowId) }}
          </div>
          <button
            v-for="tab in g.tabs"
            :key="tab.id"
            type="button"
            class="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
            :class="{
              'bg-accent/15': currentId === tab.id,
            }"
            @click="pick(tab)"
          >
            <v-remixicon name="riEarthLine" class="shrink-0 text-gray-400" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{{
                tab.title || tab.url
              }}</span>
              <span class="block truncate text-xs text-gray-400">{{
                tab.url
              }}</span>
            </span>
            <v-remixicon
              v-if="currentId === tab.id"
              name="riCheckLine"
              class="shrink-0 text-accent"
            />
          </button>
        </div>
      </template>
    </div>
  </ui-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  visible: { type: Boolean, default: false },
  currentTab: { type: Object, default: null },
  // 由父组件注入，这样组件本身不必知道 browser API，也便于单测
  listTabs: { type: Function, required: true },
});

const emit = defineEmits(['close', 'pick']);

const { t } = useI18n();

const groups = ref([]);
const loading = ref(false);

// 模板里直接用这个值，不需要再包一层函数
const currentId = computed(() => (props.currentTab ? props.currentTab.id : -1));

watch(
  () => props.visible,
  async (v) => {
    if (!v) return;

    loading.value = true;

    try {
      groups.value = await props.listTabs();
    } catch (e) {
      groups.value = [];
    } finally {
      loading.value = false;
    }
  },
  { immediate: true }
);

function windowLabel(id) {
  return id === 1
    ? t('workflow.agent.pickTab.mainWindow')
    : t('workflow.agent.pickTab.window', { n: id });
}

function close() {
  emit('close');
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
