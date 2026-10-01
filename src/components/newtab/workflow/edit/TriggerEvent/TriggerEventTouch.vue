<template>
  <div class="grid grid-cols-2 gap-2">
    <ui-checkbox
      v-for="item in ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']"
      :key="item"
      v-model="defaultParams[item]"
    >
      {{ t(`workflow.blocks.trigger.keyboard.modifier.${item}`) }}
    </ui-checkbox>
  </div>
</template>
<script setup>
import { shallowReactive, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { objectHasKey } from '@/utils/helper';

const props = defineProps({
  params: {
    type: Object,
    default: () => ({}),
  },
});
const emit = defineEmits(['update']);

const { t } = useI18n();

const defaultParams = shallowReactive({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
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
