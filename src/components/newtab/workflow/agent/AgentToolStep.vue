<template>
  <div class="rounded border border-gray-200 dark:border-gray-700">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      @click="expanded = !expanded"
    >
      <v-remixicon
        :name="expanded ? 'riArrowDownSLine' : 'riArrowRightSLine'"
        class="shrink-0"
      />
      <span class="font-medium">{{ step.name }}</span>
      <span class="ml-auto rounded px-1.5 py-0.5 text-xs" :class="statusClass">
        {{ statusLabel }}
      </span>
    </button>

    <div
      v-if="expanded"
      class="max-h-80 overflow-auto border-t border-gray-200 px-3 py-2 text-xs dark:border-gray-700"
    >
      <pre v-if="prettyArgs" class="mb-2 whitespace-pre-wrap">{{
        prettyArgs
      }}</pre>
      <pre v-if="step.observation" class="whitespace-pre-wrap">{{
        step.observation
      }}</pre>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { TOOL_STATUS } from '@/agent/events';

const props = defineProps({
  step: { type: Object, required: true },
});

const { t } = useI18n();
const expanded = ref(false);

const prettyArgs = computed(() => {
  const a = props.step.args;
  if (!a || typeof a !== 'object' || !Object.keys(a).length) return '';
  try {
    return JSON.stringify(a, null, 2);
  } catch (e) {
    return String(a);
  }
});

// 被拒绝和出错必须一眼能分出来：前者不是模型的错，后者模型还能自纠
const STATUS_STYLE = {
  [TOOL_STATUS.OK]: 'bg-green-500/15 text-green-700 dark:text-green-400',
  [TOOL_STATUS.ERROR]: 'bg-red-500/15 text-red-600 dark:text-red-400',
  [TOOL_STATUS.REJECTED]: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

const STATUS_LABEL = {
  [TOOL_STATUS.OK]: 'workflow.agent.tool.ok',
  [TOOL_STATUS.ERROR]: 'workflow.agent.tool.error',
  [TOOL_STATUS.REJECTED]: 'workflow.agent.tool.rejected',
  [TOOL_STATUS.RUNNING]: 'workflow.agent.tool.running',
  [TOOL_STATUS.PENDING]: 'workflow.agent.tool.running',
};

const statusLabel = computed(() =>
  t(STATUS_LABEL[props.step.status] || 'workflow.agent.tool.running')
);

const statusClass = computed(
  () =>
    STATUS_STYLE[props.step.status] ||
    'bg-gray-500/15 text-gray-600 dark:text-gray-400'
);
</script>
