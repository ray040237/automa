<template>
  <div>
    <ui-textarea
      :model-value="data.description"
      :placeholder="t('common.description')"
      class="w-full"
      @change="updateData({ description: $event })"
    />
    <ui-input
      :model-value="data.variableName"
      :label="t('workflow.variables.name')"
      :title="t('workflow.variables.name')"
      class="mt-2 w-full"
      @change="updateData({ variableName: $event })"
    />
    <ui-select
      :model-value="data.method"
      :label="t('workflow.blocks.regex-variable.method')"
      class="mt-2 w-full"
      @change="updateData({ method: $event })"
    >
      <option v-for="method in methods" :key="method" :value="method">
        {{ t(`workflow.blocks.regex-variable.methods.${method}`) }}
      </option>
    </ui-select>
    <ui-input
      v-if="data.method === 'replace'"
      :model-value="data.replaceVal"
      :label="t('workflow.blocks.regex-variable.replaceWith')"
      :placeholder="t('workflow.blocks.regex-variable.replacePlaceholder')"
      class="mt-2 w-full"
      @change="updateData({ replaceVal: $event })"
    />
    <div class="mt-3 flex items-end">
      <div class="mr-2 flex-1">
        <label
          class="ml-1 block text-sm text-gray-600 dark:text-gray-200"
          for="var-expression"
        >
          {{ t('workflow.blocks.regex-variable.regex') }}
        </label>
        <div
          class="bg-input flex items-center rounded-lg px-4 transition-colors"
        >
          <span>/</span>
          <input
            id="var-expression"
            :value="data.expression"
            :placeholder="
              t('workflow.blocks.regex-variable.expressionPlaceholder')
            "
            class="w-11/12 bg-transparent py-2 px-1 focus:ring-0"
            @input="updateData({ expression: $event.target.value })"
          />
          <span class="text-right">/</span>
        </div>
      </div>
      <ui-popover>
        <template #trigger>
          <button
            class="bg-input rounded-lg p-2"
            :title="t('workflow.blocks.regex-variable.flagsTitle')"
          >
            {{
              data.flag.length === 0
                ? t('workflow.blocks.regex-variable.flagsEmpty')
                : data.flag.join('')
            }}
          </button>
        </template>
        <p>{{ t('workflow.blocks.regex-variable.flagsTitle') }}</p>
        <ul class="mt-2 space-y-1">
          <li v-for="flag in flags" :key="flag">
            <ui-checkbox
              :model-value="data.flag.includes(flag)"
              @change="updateFlag($event, flag)"
            >
              {{ t(`workflow.blocks.regex-variable.flags.${flag}`) }}
            </ui-checkbox>
          </li>
        </ul>
      </ui-popover>
    </div>
  </div>
</template>
<script setup>
import { useI18n } from 'vue-i18n';

const props = defineProps({
  data: {
    type: Object,
    default: () => ({}),
  },
});
const emit = defineEmits(['update:data']);

const methods = ['match', 'replace'];
const flags = ['g', 'i', 'm'];

const { t } = useI18n();

function updateData(value) {
  emit('update:data', { ...props.data, ...value });
}
function updateFlag(include, flag) {
  const copyFlag = [...props.data.flag];

  if (include) {
    copyFlag.push(flag);
  } else {
    const index = copyFlag.indexOf(flag);
    copyFlag.splice(index, 1);
  }

  updateData({ flag: copyFlag });
}
</script>
<style>
.log-data .block-variable {
  margin-top: 4px;
}
</style>
