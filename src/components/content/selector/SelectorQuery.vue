<template>
  <div>
    <div class="flex items-center">
      <ui-select
        :model-value="selectorType"
        :disabled="selectList"
        class="w-full"
        @change="$emit('update:selectorType', $event)"
      >
        <option value="css">
          {{ t('content.selectorQuery.cssSelector') }}
        </option>
        <option value="xpath">
          {{ t('content.selectorQuery.xpath') }}
        </option>
      </ui-select>
      <template v-if="selectorType === 'css'">
        <ui-button
          :class="{ 'text-primary': selectList }"
          icon
          class="ml-2"
          :title="t('content.selectorQuery.selectListOfElements')"
          @click.stop.prevent="$emit('update:selectList', !selectList)"
        >
          <v-remixicon name="riListUnordered" />
        </ui-button>
        <ui-button
          icon
          class="ml-2"
          :title="t('content.selectorQuery.selectorSettings')"
          @click="$emit('settings', !settingsActive)"
        >
          <v-remixicon
            :name="settingsActive ? 'riCloseLine' : 'riSettings3Line'"
          />
        </ui-button>
      </template>
    </div>
    <div class="mt-2 flex items-center">
      <ui-input
        :model-value="selector"
        :placeholder="t('content.selectorQuery.elementSelector')"
        class="element-selector h-full flex-1 leading-normal"
        @change="$emit('selector', $event)"
      >
        <template #prepend>
          <button
            class="absolute left-0 ml-2"
            @click.stop.prevent="copySelector"
          >
            <v-remixicon name="riFileCopyLine" />
          </button>
        </template>
      </ui-input>
      <template v-if="selectedCount === 1 && !selector.includes('|>')">
        <button
          class="mr-1 ml-2"
          :title="t('content.selectorQuery.parentElement')"
          @click.stop.prevent="$emit('parent')"
        >
          <v-remixicon rotate="90" name="riArrowLeftLine" />
        </button>
        <button
          :title="t('content.selectorQuery.childElement')"
          @click.stop.prevent="$emit('child')"
        >
          <v-remixicon rotate="-90" name="riArrowLeftLine" />
        </button>
      </template>
    </div>
  </div>
</template>
<script setup>
import { useI18n } from 'vue-i18n';
import { inject } from 'vue';
import {
  copyTextToClipboard,
  fallbackCopyTextToClipboard,
} from '@/utils/clipboard';
import UiInput from '@/components/ui/UiInput.vue';

const { t } = useI18n();

const props = defineProps({
  selector: {
    type: String,
    default: '',
  },
  selectedCount: {
    type: Number,
    default: 0,
  },
  selectorType: {
    type: String,
    default: '',
  },
  selectList: {
    type: Boolean,
    default: false,
  },
  settingsActive: Boolean,
});
defineEmits([
  'change',
  'list',
  'parent',
  'child',
  'selector',
  'settings',
  'update:selectorType',
  'update:selectList',
]);

const rootElement = inject('rootElement');

function copySelector() {
  rootElement.shadowRoot.querySelector('input')?.select();

  // 同 SelectorElementsDetail：http 站点上 navigator.clipboard 不存在。见 T-250。
  copyTextToClipboard(props.selector).catch((error) => {
    console.error(error);
    fallbackCopyTextToClipboard(props.selector);
  });
}
</script>
