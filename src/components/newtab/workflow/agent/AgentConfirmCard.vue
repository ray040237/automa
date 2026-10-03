<template>
  <div
    class="rounded border border-amber-300 bg-amber-500/10 p-3 dark:border-amber-700"
  >
    <div class="mb-1 flex items-center gap-2 text-sm font-medium">
      <v-remixicon name="riAlertLine" />
      {{ t('workflow.agent.confirm.title') }}
    </div>
    <p class="mb-2 text-xs text-gray-600 dark:text-gray-300">
      {{ t('workflow.agent.confirm.hint') }}
    </p>
    <pre
      class="max-h-48 overflow-auto rounded bg-black/5 p-2 text-xs dark:bg-black/30"
      >{{ code }}</pre
    >
    <div class="mt-2 flex justify-end gap-2">
      <ui-button variant="default" @click="answer(false)">
        {{ t('workflow.agent.confirm.deny') }}
      </ui-button>
      <ui-button variant="accent" @click="answer(true)">
        {{ t('workflow.agent.confirm.allow') }}
      </ui-button>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n';

defineProps({
  code: { type: String, default: '' },
});

const emit = defineEmits(['answer']);
const { t } = useI18n();

function answer(approved) {
  emit('answer', approved);
}
</script>
