<template>
  <ui-tabs
    :model-value="activeTab"
    class="mt-2"
    fill
    @change="$emit('update:activeTab', $event)"
  >
    <ui-tab value="attributes">
      {{ t('content.selectorDetail.attributes') }}
    </ui-tab>
    <ui-tab v-if="selectElements.length > 0" value="options">
      {{ t('content.selectorDetail.options') }}
    </ui-tab>
    <ui-tab v-if="!hideBlocks" value="blocks">
      {{ t('content.selectorDetail.blocks') }}
    </ui-tab>
  </ui-tabs>
  <ui-tab-panels
    :model-value="activeTab"
    class="scroll overflow-y-auto"
    style="max-height: calc(100vh - 17rem)"
  >
    <ui-tab-panel value="attributes">
      <selector-element-list
        :elements="selectedElements"
        @highlight="$emit('highlight', $event)"
      >
        <template #item="{ element }">
          <div
            v-for="(value, name) in element.attributes"
            :key="name"
            class="bg-box-transparent mb-1 rounded-lg py-2 px-3"
          >
            <p
              class="text-overflow text-sm leading-tight text-gray-600"
              :title="t('content.selectorDetail.attributeName')"
            >
              {{ name }}
            </p>
            <ui-input
              :model-value="value"
              :placeholder="!value ? t('content.selectorDetail.empty') : null"
              :data-testid="name"
              :title="name"
              readonly
              class="w-full"
            >
              <template #prepend>
                <button
                  class="absolute ml-2"
                  @click="copySelector(name, value)"
                >
                  <v-remixicon name="riFileCopyLine" />
                </button>
              </template>
            </ui-input>
          </div>
        </template>
      </selector-element-list>
    </ui-tab-panel>
    <ui-tab-panel value="options">
      <selector-element-list
        :elements="selectElements"
        :element-name="t('content.selectorDetail.selectElementOptions')"
        @highlight="
          $emit('highlight', {
            index: $event.element.elIndex,
            highlight: $event.highlight,
          })
        "
      >
        <template #item="{ element }">
          <div
            v-for="option in element.options"
            :key="option.name"
            class="bg-box-transparent mb-1 rounded-lg py-2 px-3"
          >
            <p
              class="text-overflow text-sm leading-tight text-gray-600"
              :title="t('content.selectorDetail.optionName')"
            >
              {{ option.name }}
            </p>
            <input
              :value="option.value"
              :title="t('content.selectorDetail.optionValue')"
              class="text-overflow w-full bg-transparent focus:ring-0"
              readonly
              @click="$event.target.select()"
            />
          </div>
        </template>
      </selector-element-list>
    </ui-tab-panel>
    <ui-tab-panel value="blocks">
      <selector-blocks
        :elements="selectedElements"
        :selector="elSelector"
        @execute="$emit('execute', $event)"
        @update="$emit('update')"
      />
    </ui-tab-panel>
  </ui-tab-panels>
</template>
<script setup>
import { useI18n } from 'vue-i18n';
import { inject } from 'vue';
import {
  copyTextToClipboard,
  fallbackCopyTextToClipboard,
} from '@/utils/clipboard';
import SelectorBlocks from './SelectorBlocks.vue';
import SelectorElementList from './SelectorElementList.vue';

const { t } = useI18n();

const props = defineProps({
  activeTab: {
    type: String,
    default: '',
  },
  selectElements: {
    type: Array,
    default: () => [],
  },
  selectedElements: {
    type: Array,
    default: () => [],
  },
  elSelector: {
    type: String,
    default: '',
  },
  hideBlocks: Boolean,
});
defineEmits(['update:activeTab', 'execute', 'highlight', 'update']);

const rootElement = inject('rootElement');

function copySelector(name, value) {
  rootElement.shadowRoot
    .querySelector(`[data-testid="${name}"] input`)
    ?.select();
  const type = rootElement.shadowRoot.querySelector(`select#select--1`)?.value;
  const tagName = props.selectedElements[0].tagName.toLowerCase();
  const text =
    type === 'css'
      ? `${tagName}[${name}="${value}"]`
      : `//${tagName}[@${name}='${value}']`;

  // 面板注入在用户浏览的页面上，http 站点没有 navigator.clipboard
  // （secure-context-only），裸调会在读 writeText 时同步抛 TypeError。见 T-250。
  copyTextToClipboard(text).catch((error) => {
    console.error(error);
    fallbackCopyTextToClipboard(text);
  });
}
</script>
