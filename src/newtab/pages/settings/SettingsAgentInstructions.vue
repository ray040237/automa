<template>
  <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
    <div class="mb-2 flex items-center gap-2">
      <p class="flex-1 font-semibold">
        {{ t('settings.agent.instructions.title') }}
      </p>
      <ui-switch
        v-model="enabled"
        :label="t('settings.agent.instructions.enabled')"
      />
    </div>

    <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">
      {{ t('settings.agent.instructions.hint') }}
    </p>

    <ui-textarea
      v-model="text"
      rows="6"
      :placeholder="t('settings.agent.instructions.placeholder')"
    />

    <div class="mt-2 flex flex-wrap items-center gap-3">
      <span
        class="text-xs"
        :class="
          overLimit
            ? 'font-semibold text-yellow-700 dark:text-yellow-400'
            : 'text-gray-500 dark:text-gray-400'
        "
      >
        {{ charCount }}
      </span>

      <span
        v-if="overLimit"
        class="rounded bg-yellow-500/10 px-2 py-1 text-xs text-yellow-700 dark:text-yellow-400"
      >
        {{
          t('settings.agent.instructions.overLimit', {
            limit: INSTRUCTIONS_SOFT_LIMIT,
          })
        }}
      </span>

      <ui-button
        class="ml-auto"
        variant="accent"
        :loading="saving"
        @click="save"
      >
        {{ t('common.save') }}
      </ui-button>

      <span v-if="saved" class="text-sm text-green-600 dark:text-green-400">
        {{ t('settings.agent.saved') }}
      </span>
    </div>

    <p
      v-if="errors.length"
      class="mt-2 rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400"
    >
      {{ errors.join('；') }}
    </p>
  </div>
</template>

<script setup>
/**
 * 自定义指令管理（T-81a）：一段常驻 system prompt 的用户文本。
 *
 * 与连接配置的「整份文档一个保存按钮」**刻意分开**：指令存自己的 storage key，
 * 有自己的保存按钮 —— 两份数据、两个写者，揉进同一个保存条只会让
 * 「我到底存了哪个」没法回答。
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { configIO } from '@/agent';
import {
  INSTRUCTIONS_SOFT_LIMIT,
  loadInstructions,
  saveInstructions,
} from '@/agent/customizations';

const { t } = useI18n();

const text = ref('');
const enabled = ref(true);
const saving = ref(false);
const saved = ref(false);
const errors = ref([]);

const charCount = computed(() =>
  t('settings.agent.instructions.charCount', { n: text.value.length })
);
const overLimit = computed(() => text.value.length > INSTRUCTIONS_SOFT_LIMIT);

onMounted(async () => {
  const doc = await loadInstructions(configIO);

  text.value = doc.text;
  enabled.value = doc.enabled;
});

async function save() {
  saving.value = true;
  errors.value = [];

  try {
    await saveInstructions(configIO, {
      text: text.value,
      enabled: enabled.value,
    });

    saved.value = true;
    setTimeout(() => {
      saved.value = false;
    }, 2500);
  } catch (err) {
    errors.value = [err && err.message ? err.message : String(err)];
  } finally {
    saving.value = false;
  }
}
</script>
