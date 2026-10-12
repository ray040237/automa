<template>
  <!--
    T-185：卡头（图标 + 名称 + 描述）整行删除 —— 名称与描述只是顶栏信息的
    重复展示，图标选择器并进了顶栏「更多 → 重命名」弹窗（EditorLocalActions），
    那里本就是改这两样字的唯一入口。块库面板从搜索框直接开始，多让出一行高度。
  -->
  <ui-input
    id="search-input"
    v-model="query"
    :placeholder="`${t('common.search')}... (${
      shortcut['action:search'].readable
    })`"
    prepend-icon="riSearch2Line"
    class="mt-4 mb-2 w-full px-4"
  />
  <div class="scroll relative flex-1 overflow-auto bg-scroll px-4">
    <workflow-block-list
      v-if="pinnedBlocksList.length > 0"
      :model-value="true"
      :blocks="pinnedBlocksList"
      :category="pinnedCategory"
      :pinned="pinnedBlocks"
      @pin="pinBlock"
    />
    <workflow-block-list
      v-for="(items, catId) in blocks"
      :key="catId"
      :model-value="true"
      :blocks="items"
      :category="categories[catId]"
      :category-id="catId"
      :pinned="pinnedBlocks"
      @pin="pinBlock"
    />
  </div>
</template>
<script setup>
import { computed, ref, onMounted, watch, toRaw } from 'vue';
import { useI18n } from 'vue-i18n';
import browser from 'webextension-polyfill';
import { useShortcut } from '@/composable/shortcut';
import { categories } from '@/utils/shared';
import { getBlocks } from '@/utils/getSharedData';
import WorkflowBlockList from './WorkflowBlockList.vue';

const { t, te } = useI18n();
const shortcut = useShortcut('action:search', () => {
  const searchInput = document.querySelector('#search-input input');

  searchInput?.focus();
});

const pinnedCategory = {
  name: t('workflow.detailsCard.pinnedBlocks'),
  color: 'bg-accent',
};

const copyBlocks = getBlocks();
delete copyBlocks['block-package'];
if (IS_OFFLINE) {
  // Cloud-backed blocks are unusable offline; keep existing workflows
  // renderable but stop offering them in the palette.
  delete copyBlocks['ai-workflow'];
  delete copyBlocks['google-sheets'];
  delete copyBlocks['google-sheets-drive'];
  delete copyBlocks['google-drive'];
}

const blocksArr = Object.entries(copyBlocks).map(([key, block]) => {
  const localeKey = `workflow.blocks.${key}.name`;

  return {
    ...block,
    id: key,
    name: te(localeKey) ? t(localeKey) : block.name,
  };
});

const query = ref('');
const pinnedBlocks = ref([]);

const blocks = computed(() =>
  blocksArr.reduce((arr, block) => {
    if (
      block.name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())
    ) {
      (arr[block.category] = arr[block.category] || []).push(block);
    }

    return arr;
  }, {})
);
const pinnedBlocksList = computed(() =>
  pinnedBlocks.value
    .filter((id) => copyBlocks[id])
    .map((id) => {
      const namePath = `workflow.blocks.${id}.name`;

      return {
        ...copyBlocks[id],
        id,
        name: te(namePath) ? t(namePath) : copyBlocks[id].name,
      };
    })
    .filter(({ name }) =>
      name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())
    )
);

function pinBlock({ id }) {
  const index = pinnedBlocks.value.indexOf(id);

  if (index !== -1) pinnedBlocks.value.splice(index, 1);
  else pinnedBlocks.value.push(id);
}

watch(
  pinnedBlocks,
  () => {
    browser.storage.local.set({
      pinnedBlocks: toRaw(pinnedBlocks.value),
    });
  },
  { deep: true }
);

onMounted(() => {
  browser.storage.local.get('pinnedBlocks').then((item) => {
    pinnedBlocks.value = item.pinnedBlocks || [];
  });
});
</script>
