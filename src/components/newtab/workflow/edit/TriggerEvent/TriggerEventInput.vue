<template>
  <div class="grid grid-cols-2 gap-2">
    <ui-input
      v-model="defaultParams.data"
      :label="t('workflow.blocks.trigger-event.inputData')"
    />
    <ui-input
      v-model="defaultParams.inputType"
      :label="t('workflow.blocks.trigger-event.inputType')"
    />
  </div>
</template>
<script setup>
import { shallowReactive, watch, onMounted } from 'vue';
import { objectHasKey } from '@/utils/helper';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  params: {
    type: Object,
    default: () => ({}),
  },
});
const emit = defineEmits(['update']);

const { t } = useI18n();

const defaultParams = shallowReactive({
  data: '',
  inputType: 'insertText',
});

watch(
  defaultParams,
  (value) => {
    emit('update', value);
  },
  { deep: true }
);

onMounted(() => {
  Object.entries(props.params).forEach(([key, value]) => {
    if (objectHasKey(defaultParams, key)) defaultParams[key] = value;
  });
});
</script>
