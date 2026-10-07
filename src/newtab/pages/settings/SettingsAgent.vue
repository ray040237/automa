<template>
  <div>
    <p class="mb-6 font-semibold">{{ t('settings.agent.title') }}</p>

    <!-- 当前在用：这是「我现在用的是哪个」的唯一真相。改动要等点保存才落盘，
         所以这里明写「下一轮生效」——否则用户以为切了就换了。 -->
    <p
      v-if="activeProvider"
      class="mb-4 rounded-lg bg-box-transparent px-3 py-2 text-sm"
    >
      <span class="text-gray-600 dark:text-gray-200">
        {{ t('settings.agent.currentInUse') }}
      </span>
      <span class="font-semibold">{{
        activeProvider.name || t('settings.agent.unnamed')
      }}</span>
      <span class="mx-1 text-gray-600 dark:text-gray-200">·</span>
      <span>{{ activeModelId || '—' }}</span>
      <span class="ml-2 text-gray-600 dark:text-gray-200">
        {{ t('settings.agent.nextTurnTakesEffect') }}
      </span>
    </p>

    <div
      v-if="!providers.length"
      class="rounded-lg border border-gray-200 p-6 dark:border-gray-700"
    >
      <p class="mb-4 font-semibold">{{ t('settings.agent.empty') }}</p>
      <ui-button variant="accent" @click="addProvider">
        {{ t('settings.agent.addConnection') }}
      </ui-button>
    </div>

    <!-- 连接平铺：每条一张卡，卡头是摘要，卡体才是表单。全部连接在一列里排开、
         滚动浏览 —— 不再左右分栏，也不需要「先点左边选中才看得见右边」。
         默认只展开正在用的那条，但允许多张同时展开（用户要对照两条配置时用得上）。 -->
    <div v-else class="flex flex-col gap-3">
      <div
        v-for="p in providers"
        :key="p.id"
        class="rounded-lg border dark:border-gray-700"
        :class="isActive(p) ? 'border-green-500/70' : 'border-gray-200'"
      >
        <div class="flex items-center gap-2 px-3 py-2">
          <v-remixicon
            :name="isExpanded(p.id) ? 'riArrowDownSLine' : 'riArrowRightSLine'"
            class="cursor-pointer text-gray-500"
            @click="toggleExpanded(p.id)"
          />

          <button
            type="button"
            class="min-w-0 flex-1 text-left"
            @click="toggleExpanded(p.id)"
          >
            <span class="font-semibold">{{
              p.name || t('settings.agent.unnamed')
            }}</span>
            <span class="ml-2 text-xs opacity-70">{{
              t('settings.agent.modelCount', { n: p.models.length })
            }}</span>
            <!-- 收起时也要看得见接口地址：不然几条连接长得一模一样 -->
            <span
              v-if="!isExpanded(p.id) && p.baseUrl"
              class="ml-2 truncate text-xs opacity-50"
            >
              {{ p.baseUrl }}
            </span>
          </button>

          <v-remixicon
            v-if="isActive(p)"
            name="riCheckboxCircleLine"
            size="18"
            class="shrink-0 text-green-600 dark:text-green-400"
            :title="t('settings.agent.inUse')"
          />
          <button
            v-else
            type="button"
            class="shrink-0 text-xs underline"
            :class="hasCardError(p.id) ? 'text-red-500' : 'text-gray-500'"
            @click="useConnection(p)"
          >
            {{ t('settings.agent.setAsCurrent') }}
          </button>

          <v-remixicon
            name="riDeleteBin7Line"
            class="shrink-0 cursor-pointer text-gray-600 hover:text-red-500 dark:text-gray-200"
            @click="removeProvider(p)"
          />
        </div>

        <!-- 每张卡的错误渲染在卡内：平铺之后「是哪条连接半填了」必须一眼可见，
             而不是把一屏错误堆在页面最底下让人自己找。 -->
        <ul
          v-if="hasCardError(p.id)"
          class="mx-3 mb-3 rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400"
        >
          <li v-for="(e, ei) in cardErrors[p.id]" :key="ei">
            {{ e }}
          </li>
        </ul>

        <div
          v-if="isExpanded(p.id)"
          class="flex flex-col gap-3 border-t border-gray-200 px-3 py-3 dark:border-gray-700"
        >
          <ui-select
            :model-value="p.templateId"
            :label="t('settings.agent.template')"
            class="max-w-xs"
            @change="onTemplateChange(p, $event)"
          >
            <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">
              {{ tpl.label }}
            </option>
          </ui-select>

          <ui-input
            v-model="p.name"
            :label="t('settings.agent.name')"
            class="max-w-xs"
            :placeholder="t('settings.agent.namePlaceholder')"
          />

          <ui-input
            v-model="p.baseUrl"
            :label="t('settings.agent.baseUrl')"
            class="max-w-xs"
            autocomplete="off"
            placeholder="https://api.openai.com/v1"
          />

          <div class="max-w-xs">
            <ui-input
              v-model="p.apiKey"
              :label="t('settings.agent.apiKey')"
              :type="keyVisible[p.id] ? 'text' : 'password'"
              autocomplete="off"
              :placeholder="p.hasKey ? t('settings.agent.apiKeySet') : 'sk-…'"
            >
              <template #append>
                <v-remixicon
                  :name="keyVisible[p.id] ? 'riEyeOffLine' : 'riEyeLine'"
                  class="absolute right-2 cursor-pointer"
                  @click="keyVisible[p.id] = !keyVisible[p.id]"
                />
              </template>
            </ui-input>

            <button
              v-if="p.hasKey"
              type="button"
              class="mt-1 text-xs text-gray-500 underline"
              @click="clearKey(p)"
            >
              {{ t('settings.agent.clearKey') }}
            </button>
          </div>

          <!-- 测试连接：打的是生产同一条路（同 baseUrl / 模型 / 鉴权头），测出的错
               就是用户真用时会看到的错。结果内联在卡内，与 fetchErrors 同一出口。 -->
          <div class="flex flex-wrap items-center gap-3">
            <ui-button
              :loading="probe[p.id] && probe[p.id].state === 'testing'"
              @click="testConnection(p)"
            >
              {{
                probe[p.id] && probe[p.id].state === 'testing'
                  ? t('settings.agent.test.testing')
                  : t('settings.agent.test.button')
              }}
            </ui-button>

            <span
              v-if="probe[p.id] && probe[p.id].state === 'ok'"
              class="text-xs text-green-600 dark:text-green-400"
            >
              {{ t('settings.agent.test.ok', { model: probe[p.id].model }) }}
            </span>
            <span
              v-else-if="probe[p.id] && probe[p.id].state === 'needModel'"
              class="text-xs text-gray-500 dark:text-gray-400"
            >
              {{ t('settings.agent.test.needModel') }}
            </span>
            <span
              v-else-if="probe[p.id] && probe[p.id].state === 'fail'"
              class="text-xs text-red-600 dark:text-red-400"
            >
              {{
                t('settings.agent.test.' + probe[p.id].errorKey, {
                  status: probe[p.id].status,
                  msg: probe[p.id].message,
                })
              }}
            </span>
          </div>

          <!-- 每个模型一份上下文窗口与输出上限：同一条连接下不同模型差得很远，
               挂连接级就必然有填错的那几个（Q7） -->
          <div
            class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <p
              class="mb-3 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400"
            >
              {{ t('settings.agent.models') }}
            </p>

            <ul v-if="p.models.length" class="mb-3 flex flex-col gap-3">
              <li
                v-for="(m, mi) in p.models"
                :key="m.id"
                class="rounded-lg bg-box-transparent p-2"
              >
                <div class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate font-mono text-sm">{{
                    m.id
                  }}</span>
                  <button
                    type="button"
                    class="shrink-0 text-xs underline"
                    :class="
                      isActiveModel(p, m)
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-gray-500'
                    "
                    @click="useModel(p, m)"
                  >
                    {{
                      isActiveModel(p, m)
                        ? t('settings.agent.inUse')
                        : t('settings.agent.useThis')
                    }}
                  </button>
                  <v-remixicon
                    name="riDeleteBin7Line"
                    class="shrink-0 cursor-pointer text-gray-600 hover:text-red-500 dark:text-gray-200"
                    @click="removeModel(p, mi)"
                  />
                </div>
                <div class="mt-2 flex flex-wrap gap-2">
                  <ui-input
                    v-model="m.contextWindow"
                    :label="t('settings.agent.contextWindow')"
                    type="number"
                    min="1024"
                    autocomplete="off"
                    class="w-56"
                  />
                  <ui-input
                    v-model="m.maxTokens"
                    :label="t('settings.agent.maxTokens')"
                    type="number"
                    min="256"
                    autocomplete="off"
                    class="w-44"
                    :placeholder="t('settings.agent.maxTokensPlaceholder')"
                  />
                </div>
              </li>
            </ul>

            <!-- 输入 → 添加 → 抓取：一条「往列表里加模型」的动线走到底。
                 抓取按钮原先排在最前，读起来像是要先抓才能手填，实际两者并列。 -->
            <div class="flex flex-wrap items-start gap-2">
              <ui-input
                v-model="newModelNames[p.id]"
                class="w-64"
                autocomplete="off"
                :label="t('settings.agent.addModelManually')"
                :placeholder="t('settings.agent.modelPlaceholder')"
                @keydown.enter.prevent="addManualModel(p)"
              />
              <ui-button class="mt-6" @click="addManualModel(p)">
                {{ t('settings.agent.add') }}
              </ui-button>

              <ui-button
                class="mt-6"
                :loading="fetching[p.id]"
                @click="fetchModels(p)"
              >
                {{
                  fetching[p.id]
                    ? t('settings.agent.fetching')
                    : t('settings.agent.fetchModels')
                }}
              </ui-button>
            </div>

            <p
              v-if="fetchErrors[p.id]"
              class="mt-3 rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400"
            >
              {{ fetchErrors[p.id] }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建连接：列表下方常驻。上一次平铺改版把入口只留在了空态分支里，
         于是「已经有连接 → 想再加一条」这条路整个消失了 —— 改版时必须对着
         「每条已有连接时，用户怎么再加一条」把路走一遍。 -->
    <ui-button v-if="providers.length" class="mt-3" @click="addProvider">
      {{ t('settings.agent.addConnection') }}
    </ui-button>

    <!-- 文档级错误（temperature 越界、连接重名）：不属于任何单张卡，排在保存条上方 -->
    <ul
      v-if="errors.length"
      class="mt-3 rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400"
    >
      <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
    </ul>

    <p
      class="mt-6 rounded bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400"
    >
      {{ t('settings.agent.privacy') }}
    </p>

    <!-- 保存一次写的是整份文档（所有连接一起落盘）。这件事以前被左右分栏藏住了：
         保存按钮在「当前选中那条」的表单里，用户却会以为只存了它。现在按钮移到
         页面底部并明写出来，界面的承诺才和数据模型对得上。 -->
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <ui-button variant="accent" :loading="saving" @click="save">
        {{ t('common.save') }}
      </ui-button>

      <span class="text-xs text-gray-500 dark:text-gray-400">
        {{ t('settings.agent.saveAllHint') }}
      </span>

      <span v-if="saved" class="text-sm text-green-600 dark:text-green-400">
        {{ t('settings.agent.saved') }}
      </span>
    </div>

    <!-- 下面三块是用户自定义内容（T-81a/T-81b），与上面的连接配置互不相干：
         各存各的 storage key、各有各的保存按钮。放在连接区之后，
         视觉上从「怎么连」过渡到「让它像什么」。 -->
    <settings-agent-instructions class="mt-6" />
    <settings-agent-commands class="mt-3" />
    <settings-agent-skills class="mt-3" />

    <!-- 抓回来的模型勾选添加：一次性快照，不与端点自动同步（Q9） -->
    <ui-modal
      v-model="picker.show"
      :title="t('settings.agent.picker.title')"
      content-class="max-w-2xl"
    >
      <ul
        v-if="picker.list.length"
        class="max-h-96 flex flex-col gap-1 overflow-y-auto"
      >
        <li v-for="id in picker.list" :key="id">
          <ui-checkbox v-model="picker.picked[id]">
            <span class="font-mono text-sm">{{ id }}</span>
          </ui-checkbox>
        </li>
      </ul>

      <p v-else class="py-4 text-sm text-gray-600 dark:text-gray-200">
        {{ t('settings.agent.picker.empty') }}
      </p>

      <ui-button variant="accent" @click="addPickedModels">
        {{ t('settings.agent.picker.addSelected', { n: pickedCount }) }}
      </ui-button>
    </ui-modal>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from 'vue-toastification';
import { useDialog } from '@/composable/dialog';
import { configIO } from '@/agent';
import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  PROVIDER_TEMPLATES,
  loadConfigDoc,
  newProviderId,
  probeConnection,
  resolveContextWindow,
  revealApiKey,
  saveConfig,
  validateConfig,
} from '@/agent/config';
import SettingsAgentInstructions from './SettingsAgentInstructions.vue';
import SettingsAgentCommands from './SettingsAgentCommands.vue';
import SettingsAgentSkills from './SettingsAgentSkills.vue';

const { t } = useI18n();
const toast = useToast();
const dialog = useDialog();

const templates = PROVIDER_TEMPLATES;

/** 表单从 loadConfigDoc 单源读取：每条的 apiKey 是空的，密文在 encryptedKey 里 */
const providers = ref([]);
const activeProviderId = ref('');
const activeModelId = ref('');
const temperature = ref(DEFAULT_CONFIG.temperature);

/**
 * 展开的连接 id。用数组而不是单个 id：用户经常要对照两条连接的配置，
 * 单开单合会让这种场景变成「改一个关一个」。
 */
const expanded = ref([]);

/** 文档级错误（temperature 越界、连接重名），不属于任何单张卡 */
const errors = ref([]);
/** 连接 id -> 该条自己的校验错误，直接渲染在卡内 */
const cardErrors = reactive({});
const saved = ref(false);
const saving = ref(false);

/**
 * 下面四样按连接分开存。
 *
 * 平铺之后可以同时展开多张卡，共用一份的会被另一张卡的输入覆写：
 * 在 A 卡点「显示 Key」，去 B 卡手填模型名，A 卡的可见状态就跟着翻了。
 */
const keyVisible = reactive({});
const newModelNames = reactive({});
const fetchErrors = reactive({});
const fetching = reactive({});

/**
 * 「测试连接」的结果，按连接分开存，与 fetchErrors 同一套理由（多张卡同时展开）。
 * 形状：`{state: 'testing'|'ok'|'fail'|'needModel', model?, errorKey?, status?, message?}`
 */
const probe = reactive({});

const picker = reactive({ show: false, targetId: '', list: [], picked: {} });

const activeProvider = computed(
  () => providers.value.find((p) => p.id === activeProviderId.value) || null
);
const pickedCount = computed(
  () => Object.values(picker.picked).filter(Boolean).length
);

onMounted(async () => {
  const d = await loadConfigDoc(configIO);

  providers.value = d.providers;
  activeProviderId.value = d.activeProviderId;
  activeModelId.value = d.activeModelId;
  temperature.value = d.temperature;

  // 默认只展开正在用的那条：它在页面上排第几是随意的，但一定是最该先看见的
  if (d.activeProviderId) expanded.value = [d.activeProviderId];
});

function isExpanded(id) {
  return expanded.value.includes(id);
}

function toggleExpanded(id) {
  expanded.value = isExpanded(id)
    ? expanded.value.filter((x) => x !== id)
    : [...expanded.value, id];
}

function isActive(p) {
  return p.id === activeProviderId.value;
}

function hasCardError(id) {
  return Boolean(cardErrors[id] && cardErrors[id].length);
}

function isActiveModel(p, m) {
  return p.id === activeProviderId.value && m.id === activeModelId.value;
}

function addProvider() {
  const id = newProviderId();

  // 新连接一律从「自定义」起步：默认塞一个厂商进去等于替用户猜他要连哪
  providers.value.push({
    id,
    name: '',
    templateId: 'custom',
    baseUrl: '',
    apiKey: '',
    encryptedKey: '',
    hasKey: false,
    models: [],
  });
  expanded.value = [...expanded.value, id];
}

/**
 * 把这条连接设为「正在用」。
 *
 * 顺带把模型对上：当前 activeModelId 若不在这条连接里（切连接前的常态），
 * 落到它的第一个模型，否则助手会拿着别的连接的模型名去请求新连接。
 */
function useConnection(p) {
  activeProviderId.value = p.id;

  if (!p.models.some((m) => m.id === activeModelId.value)) {
    activeModelId.value = p.models.length ? p.models[0].id : '';
  }
}

function useModel(p, m) {
  useConnection(p);
  activeModelId.value = m.id;
}

function onTemplateChange(p, nextId) {
  const tpl = templates.find((x) => x.id === nextId);
  if (!tpl) return;

  const prev = templates.find((x) => x.id === p.templateId);

  // 模板只预填空着的东西：用户手敲过的接口地址与模型一个都不动。
  // 切到 custom（baseUrl 为空）时也**不能**去清空已填的地址 —— 那是破坏而不是重置。
  if (
    tpl.baseUrl &&
    (!p.baseUrl.trim() || p.baseUrl.trim() === (prev && prev.baseUrl))
  ) {
    p.baseUrl = tpl.baseUrl;
  }
  if (
    tpl.id !== 'custom' &&
    (!p.name.trim() || p.name.trim() === (prev && prev.label))
  ) {
    p.name = tpl.label;
  }
  if (p.models.length === 0 && tpl.models.length) {
    p.models = tpl.models.map((m) => ({
      id: m,
      contextWindow: resolveContextWindow(tpl.id, m),
      maxTokens: 0,
    }));
  }
  p.templateId = tpl.id;
}

function removeProvider(p) {
  dialog.confirm({
    title: t('settings.agent.deleteConnection'),
    okVariant: 'danger',
    body:
      p.id === activeProviderId.value
        ? t('settings.agent.deleteConnectionConfirmActive', {
            name: p.name || t('settings.agent.unnamed'),
          })
        : t('settings.agent.deleteConnectionConfirm', {
            name: p.name || t('settings.agent.unnamed'),
          }),
    onConfirm: () => {
      const idx = providers.value.findIndex((x) => x.id === p.id);

      providers.value.splice(idx, 1);
      expanded.value = expanded.value.filter((x) => x !== p.id);
      delete cardErrors[p.id];

      // 删掉的正是当前在用的：自动落到剩下的第一条，别把助手留在「指向空气」的状态
      if (activeProviderId.value === p.id) {
        const next = providers.value[0];

        activeProviderId.value = next ? next.id : '';
        activeModelId.value =
          next && next.models.length ? next.models[0].id : '';
      }
    },
  });
}

function removeModel(p, index) {
  p.models.splice(index, 1);

  // 删掉的正是当前在用的：同一条连接里换到第一个
  if (p.id === activeProviderId.value && activeModelId.value === index.id) {
    activeModelId.value = p.models.length ? p.models[0].id : '';
  }
}

/** 从模板/默认值给一个模型名配上建议的上下文窗口 */
function newModel(id, templateId) {
  return {
    id,
    contextWindow: resolveContextWindow(templateId, id),
    maxTokens: 0,
  };
}

function addManualModel(p) {
  const id = String(newModelNames[p.id] || '').trim();

  // 空输入原来直接 return，点了没反应 —— 用户分不清是按钮坏了还是自己漏填。
  // 这里跟重名一样用 toast：两件事同属「加不进去」，错误出口保持一致。
  if (!id) {
    toast.error(t('settings.agent.modelNameRequired'));

    return;
  }

  if (p.models.some((m) => m.id === id)) {
    toast.error(t('settings.agent.modelExists', { id }));

    return;
  }
  p.models.push(newModel(id, p.templateId));
  newModelNames[p.id] = '';
}

function clearKey(p) {
  // 只清表单字段，随「保存」一起落盘。直接改存储的话，用户改完还没保存的
  // 名字会被存储里的旧文档吃掉（两个写者必然漂移）。
  p.apiKey = '';
  p.encryptedKey = '';
  p.hasKey = false;
}

/**
 * 拉端点上的模型列表。
 *
 * 裸 fetch，不走 pi：这是设置页的一次性交互，错误要能直接说给人话（哪一种失败、
 * 什么状态码），而 pi 的 ModelsError 只给一个 code。三种失败长得完全不一样，
 * 所以分开说 —— 但**手填模型的入口永远留着**，端点不支持 /models 不是用户的问题。
 */
async function fetchModels(p) {
  fetchErrors[p.id] = '';

  const baseUrl = p.baseUrl.trim();

  if (!/^https?:\/\//.test(baseUrl)) {
    fetchErrors[p.id] = t('settings.agent.fetch.badUrl');

    return;
  }

  fetching[p.id] = true;
  try {
    // 表单里敲了就用敲的；没敲就用这把连接已存的那把（只为这一次网络请求解开）
    const key = p.apiKey.trim() || (await revealApiKey(configIO, p.id));

    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });

    if (res.status === 401 || res.status === 403) {
      fetchErrors[p.id] = t('settings.agent.fetch.keyRejected', {
        status: res.status,
      });

      return;
    }
    if (res.status === 404 || res.status === 405) {
      fetchErrors[p.id] = t('settings.agent.fetch.notSupported');

      return;
    }
    if (!res.ok) {
      fetchErrors[p.id] = t('settings.agent.fetch.httpError', {
        status: res.status,
      });

      return;
    }

    const data = await res.json();
    const ids = Array.isArray(data && data.data)
      ? [
          ...new Set(
            data.data
              .map((m) => String((m && m.id) || '').trim())
              .filter(Boolean)
          ),
        ]
      : [];

    if (!ids.length) {
      fetchErrors[p.id] = t('settings.agent.fetch.unknownShape');

      return;
    }

    const existing = new Set(p.models.map((m) => m.id));

    picker.targetId = p.id;
    picker.list = ids.sort();
    picker.picked = ids.reduce((acc, id) => {
      acc[id] = existing.has(id);

      return acc;
    }, {});
    picker.show = true;
  } catch (err) {
    // 网络层失败（地址写错、证书问题、被 CORS 挡下）—— 都不是「模型列表为空」
    fetchErrors[p.id] = t('settings.agent.fetch.network', { msg: err.message });
  } finally {
    fetching[p.id] = false;
  }
}

/**
 * 测试这条连接能不能真对话（A2）。
 *
 * 与「获取可用模型」不同：这一步**必须**有模型才测得了 —— 没有就给明确提示，
 * 而不是随便编一个模型名去撞（那只会得到一个与真实使用无关的 404）。用的模型：
 * 当前连接优先用正在用的那个，否则用列表第一个，结果里会写明测的是哪个。
 */
async function testConnection(p) {
  let model = '';

  if (isActive(p) && p.models.some((m) => m.id === activeModelId.value)) {
    model = activeModelId.value;
  } else if (p.models.length) {
    model = p.models[0].id;
  }

  if (!model) {
    probe[p.id] = { state: 'needModel' };

    return;
  }

  probe[p.id] = { state: 'testing' };

  // 表单里敲了就用敲的；没敲就用已存的那把（只为这一次探针解开），与 fetchModels 一致
  const key = p.apiKey.trim() || (await revealApiKey(configIO, p.id));

  const r = await probeConnection({
    baseUrl: p.baseUrl.trim(),
    apiKey: key,
    model,
  });

  probe[p.id] = { state: r.ok ? 'ok' : 'fail', model, ...r };
}

function addPickedModels() {
  const p = providers.value.find((x) => x.id === picker.targetId);
  if (!p) return;

  const existing = new Set(p.models.map((m) => m.id));

  picker.list.forEach((id) => {
    if (picker.picked[id] && !existing.has(id))
      p.models.push(newModel(id, p.templateId));
  });
  picker.show = false;
}

/**
 * 去掉「连接名：」这类前缀 —— 卡头已经写着名字了，再重复一遍是噪音。
 * 前缀认不出来时原样返回（最多多一句前缀，不会把报错吞掉）。
 */
function stripTag(msg, p, index) {
  const name = p.name.trim();
  const tag = name ? `「${name}」：` : `第 ${index + 1} 条：`;

  return msg.startsWith(tag) ? msg.slice(tag.length) : msg;
}

/**
 * 把整份文档的校验错误归到各自的连接上。
 *
 * 做法是**再单条校验一次**，而不是去猜哪句报错属于谁 —— validateConfig 产出的
 * 字符串都带「连接名」/「第 N 条」的前缀，按前缀反解等于把格式复述一遍，将来
 * 改了措辞就会错位。这里用同一份代码重新跑一遍，归属是算出来的，不是认出来的。
 */
function attributeErrors(allErrors) {
  Object.keys(cardErrors).forEach((k) => delete cardErrors[k]);

  const owned = new Set();

  providers.value.forEach((p, i) => {
    const own = validateConfig({
      providers: [p],
      activeProviderId: p.id,
      activeModelId: p.models.length ? p.models[0].id : '',
      temperature: temperature.value,
    }).errors;

    if (!own.length) return;

    own.forEach((e) => owned.add(e));
    cardErrors[p.id] = own.map((e) => stripTag(e, p, i));
  });

  errors.value = allErrors.filter((e) => !owned.has(e));

  // 有错就展开出错的那几张：卡片收起时错误看不见，等于没报
  const bad = Object.keys(cardErrors);
  if (bad.length) expanded.value = [...new Set([...expanded.value, ...bad])];
}

async function save() {
  errors.value = [];
  Object.keys(cardErrors).forEach((k) => delete cardErrors[k]);

  // loading 以前是死的：按钮 type=submit，绑着 saving 却没人置 true，
  // 于是用户连点两下就是两次保存。按钮改成 click 后这里必须真的转起来。
  saving.value = true;

  try {
    const r = await saveConfig(configIO, {
      version: CONFIG_VERSION,
      providers: providers.value,
      activeProviderId: activeProviderId.value,
      activeModelId: activeModelId.value,
      temperature: temperature.value,
    });

    if (!r.ok) {
      attributeErrors(r.errors);

      return;
    }

    // 重读一次：已存的密文归位，用户敲进来的明文从表单里消失
    const d = await loadConfigDoc(configIO);

    providers.value = d.providers;
    activeProviderId.value = d.activeProviderId;
    activeModelId.value = d.activeModelId;

    saved.value = true;
    setTimeout(() => {
      saved.value = false;
    }, 2500);
  } finally {
    saving.value = false;
  }
}
</script>
