<template>
  <div id="agent" class="mt-12">
    <p class="mb-1 font-semibold">{{ t('settings.agent.title') }}</p>

    <p class="mb-3 max-w-2xl text-sm text-gray-600 dark:text-gray-200">
      {{ t('settings.agent.description') }}
    </p>

    <form class="flex max-w-2xl flex-col gap-3" @submit.prevent="save">
      <ui-select
        v-model="form.provider"
        :label="t('settings.agent.provider')"
        class="w-80"
        @change="onProviderChange"
      >
        <option v-for="p in providers" :key="p.id" :value="p.id">
          {{ p.label }}
        </option>
      </ui-select>

      <ui-input
        v-model="form.baseUrl"
        :label="t('settings.agent.baseUrl')"
        class="w-80"
        placeholder="https://api.openai.com/v1"
      />

      <!-- 模型参数：这三个是一组 —— 换服务商时窗口按预设跟着变（T-94），
           输出上限留空即不限制（T-96） -->
      <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <p
          class="mb-3 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400"
        >
          {{ t('settings.agent.modelParams') }}
        </p>

        <div class="flex flex-col gap-3">
          <div>
            <ui-input
              v-model="form.model"
              :label="t('settings.agent.model')"
              :list="modelListId"
              class="w-80"
              autocomplete="off"
              :placeholder="t('settings.agent.modelPlaceholder')"
            />

            <!-- 自由填写。预设模型只是提示，不是限制：
                 自建服务、反代、本地推理的模型名五花八门，下拉框根本列不完。 -->
            <datalist :id="modelListId">
              <option v-for="m in models" :key="m" :value="m" />
            </datalist>
          </div>

          <div class="w-80">
            <ui-input
              v-model="form.contextWindow"
              :label="t('settings.agent.contextWindow')"
              type="number"
              min="1024"
              autocomplete="off"
            />

            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ t('settings.agent.contextWindowHint') }}
            </p>
          </div>

          <div class="w-80">
            <ui-input
              v-model="form.maxTokens"
              :label="t('settings.agent.maxTokens')"
              type="number"
              min="256"
              autocomplete="off"
              :placeholder="t('settings.agent.maxTokensPlaceholder')"
            />

            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ t('settings.agent.maxTokensHint') }}
            </p>
          </div>
        </div>
      </div>

      <!--
        API Key 单独存、加密，不进主设置表。
        主设置是明文 JSON，还会跟着备份走；密钥放进去等于跟着导出走。
      -->
      <div class="w-80">
        <ui-input
          v-model="form.apiKey"
          :label="t('settings.agent.apiKey')"
          :type="showKey ? 'text' : 'password'"
          autocomplete="off"
          :placeholder="hasKey ? t('settings.agent.apiKeySet') : 'sk-…'"
        >
          <template #append>
            <v-remixicon
              :name="showKey ? 'riEyeOffLine' : 'riEyeLine'"
              class="absolute right-2 cursor-pointer"
              @click="showKey = !showKey"
            />
          </template>
        </ui-input>

        <button
          v-if="hasKey && !form.apiKey"
          type="button"
          class="mt-1 text-xs text-gray-500 underline"
          @click="clearKey"
        >
          {{ t('settings.agent.clearKey') }}
        </button>
      </div>

      <p
        class="rounded bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400"
      >
        {{ t('settings.agent.privacy') }}
      </p>

      <ul
        v-if="errors.length"
        class="rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400"
      >
        <li v-for="e in errors" :key="e">
          {{ e }}
        </li>
      </ul>

      <div class="flex items-center gap-3">
        <ui-button variant="accent" type="submit" :disabled="saving">
          {{ t('common.save') }}
        </ui-button>

        <span v-if="saved" class="text-sm text-green-600 dark:text-green-400">
          {{ t('settings.agent.saved') }}
        </span>
      </div>
    </form>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, shallowReactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from '@/stores/main';
import { configIO } from '@/agent';
import {
  clearApiKey,
  loadConfig,
  saveConfig,
  PROVIDERS,
  resolveContextWindow,
} from '@/agent/config';

const { t } = useI18n();
const store = useStore();

const providers = PROVIDERS;
const modelListId = 'automa-agent-models';
const form = shallowReactive({
  provider: 'openai',
  baseUrl: '',
  model: '',
  contextWindow: 32000,
  // 空 = 不限制（交给端点默认）。用空串而不是 0，输入框里才不会显示一个 0
  // 让人以为「上限是 0」。
  maxTokens: '',
  apiKey: '',
});

const showKey = ref(false);
const saving = ref(false);
const saved = ref(false);
const hasKey = ref(false);
const errors = ref([]);

const models = computed(() => {
  const found = PROVIDERS.find((x) => x.id === form.provider);

  return found ? found.models : [];
});

onMounted(async () => {
  // 表单从 loadConfig（STORAGE_KEY）单源读取：store.settings.agent 只是
  // 同一份配置的备份镜像（随主设置导出），曾经两边都读，必然漂移。
  const c = await loadConfig(configIO);

  form.provider = c.provider || 'openai';
  form.baseUrl = c.baseUrl || '';
  form.model = c.model || '';
  form.contextWindow = c.contextWindow || 32000;
  form.maxTokens = c.maxTokens ? String(c.maxTokens) : '';

  hasKey.value = Boolean(c.apiKey);
});

function onProviderChange(id) {
  const found = PROVIDERS.find((x) => x.id === id);

  if (!found) return;

  // 窗口跟着服务商走（T-94），但**只在用户没手动改过时**才覆盖：当前值若等于
  // 上一处的建议值，说明他没动过这个数字。
  const prevSuggested = resolveContextWindow(form.provider, form.model);
  const untouchedWindow =
    !form.contextWindow || form.contextWindow === prevSuggested;

  form.baseUrl = found.baseUrl;

  // 模型是手填的，所以只在「空着」或「还是上一个服务商的默认模型」时才补默认值。
  // 用户已经敲进去的自定义模型名不能被切换动作冲掉。
  const [first] = found.models;

  const untouched = !form.model || found.models.includes(form.model);

  if (first && untouched) form.model = first;

  if (untouchedWindow) {
    form.contextWindow = resolveContextWindow(id, form.model);
  }
}

async function save() {
  errors.value = [];

  const payload = {
    provider: form.provider,
    baseUrl: form.baseUrl,
    model: form.model,
    contextWindow: Number(form.contextWindow) || undefined,
    // 0 = 不限制。用户留空时就不往请求里带 maxTokens，端点用自己的默认
    maxTokens: Number(form.maxTokens) || 0,
  };

  // 没动密钥就别把空串写回去，否则会把已存的密钥清掉
  if (form.apiKey) payload.apiKey = form.apiKey;
  else if (!hasKey.value) payload.apiKey = '';

  const r = await saveConfig(configIO, payload);

  if (!r.ok) {
    errors.value = r.errors;

    return;
  }

  await store.updateSettings({ agent: payload });

  hasKey.value = true;
  form.apiKey = '';
  saved.value = true;
  setTimeout(() => {
    saved.value = false;
  }, 2500);
}

async function clearKey() {
  await clearApiKey(configIO);
  await store.updateSettings({ agent: { apiKey: '' } });

  form.apiKey = '';
  hasKey.value = false;
}
</script>
