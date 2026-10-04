<template>
  <div class="flex h-full flex-col">
    <!-- 目标页：这一栏很重要，用户必须知道模型看的是哪个标签页 -->
    <div
      class="flex items-center gap-2 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-700"
    >
      <v-remixicon name="riEarthLine" class="shrink-0" />
      <span class="truncate" :title="targetTab ? targetTab.url : ''">
        {{
          targetTab
            ? targetTab.title || targetTab.url
            : t('workflow.agent.noTarget')
        }}
      </span>
      <ui-button
        variant="text"
        class="ml-auto shrink-0 text-xs"
        @click="openPicker"
      >
        {{ t('workflow.agent.pickTab.title') }}
      </ui-button>
    </div>

    <agent-transcript class="flex-1" :events="events" :busy="busy" />

    <!-- 会话切换：同一工作流的多轮对话。切换由宿主把关（busy / 待确认时拦下） -->
    <div
      class="flex items-center gap-1 border-b border-gray-200 px-3 py-1.5 text-xs dark:border-gray-700"
    >
      <v-remixicon name="riChatHistoryLine" class="shrink-0 text-gray-400" />
      <ui-select
        :model-value="currentSessionId || ''"
        :disabled="busy"
        class="min-w-0 flex-1"
        @change="onSelectSession"
      >
        <option v-if="!currentSessionId" value="">
          {{ t('workflow.agent.session.placeholder') }}
        </option>
        <option v-for="s in sessions" :key="s.id" :value="s.id">
          {{ sessionOptionText(s) }}
        </option>
      </ui-select>

      <!-- 会话 token 用量（网关回传 usage 才有数） -->
      <span
        v-if="usage"
        class="shrink-0 text-[10px] text-gray-400"
        :title="
          t('workflow.agent.usage', { in: usage.input, out: usage.output })
        "
      >
        {{ fmtTokens(usage.input) }}/{{ fmtTokens(usage.output) }}
      </span>
      <ui-button
        variant="text"
        class="shrink-0 text-xs"
        :disabled="busy"
        :title="t('workflow.agent.session.new')"
        @click="emit('new-session')"
      >
        <v-remixicon name="riAddLine" class="shrink-0" />
      </ui-button>
      <ui-button
        variant="text"
        class="shrink-0 text-xs"
        :disabled="busy || !currentSessionId"
        :title="t('workflow.agent.session.delete')"
        @click="emit('delete-session')"
      >
        <v-remixicon name="riDeleteBinLine" class="shrink-0" />
      </ui-button>
    </div>

    <!-- 没配 API Key 时把入口摆在正中：
         这个状态下发消息只会回一句「请先配置」，让人以为功能坏了。 -->
    <div
      v-if="!configured"
      class="border-b border-yellow-300 bg-yellow-500/10 p-3 text-sm text-yellow-800 dark:text-yellow-300"
    >
      <p class="mb-2">{{ t('workflow.agent.notConfiguredHint') }}</p>
      <button type="button" class="text-sm underline" @click="goSettings">
        {{ t('workflow.agent.goSettings') }}
      </button>
    </div>

    <form
      class="flex items-end gap-2 border-t border-gray-200 p-3 dark:border-gray-700"
      @submit.prevent="send"
    >
      <ui-textarea
        v-model="draft"
        class="flex-1"
        rows="3"
        :placeholder="t('workflow.agent.placeholder')"
        @keydown.enter.exact.prevent="send"
      />
      <ui-button
        v-if="busy"
        variant="default"
        type="button"
        :title="t('workflow.agent.stop')"
        @click="emit('abort')"
      >
        <v-remixicon name="riStopLine" class="shrink-0" />
      </ui-button>

      <ui-button
        variant="accent"
        type="submit"
        :disabled="!draft.trim() || !configured"
      >
        {{ busy ? t('workflow.agent.interject') : t('workflow.agent.send') }}
      </ui-button>
    </form>

    <agent-tab-picker
      :visible="pickerVisible"
      :current-tab="targetTab"
      :list-tabs="listTabs"
      @close="pickerVisible = false"
      @pick="onPick"
    />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { sessionOptionLabel } from '@/agent/sessions';
import AgentTranscript from './AgentTranscript.vue';
import AgentTabPicker from './AgentTabPicker.vue';

const props = defineProps({
  events: { type: Array, default: () => [] },
  targetTab: { type: Object, default: null },
  config: { type: Object, default: () => ({}) },
  busy: { type: Boolean, default: false },
  listTabs: { type: Function, required: true },
  sessions: { type: Array, default: () => [] },
  currentSessionId: { type: String, default: null },
  usage: { type: Object, default: null },
});

const emit = defineEmits([
  'send',
  'pick-tab',
  'no-target',
  'go-settings',
  'select-session',
  'new-session',
  'delete-session',
  'abort',
]);

const { t } = useI18n();

const draft = ref('');
const pickerVisible = ref(false);

// 只有存在 apiKey 才算配好了。没配就发消息，用户只会收到一句「请先配置」，
// 看起来像功能坏了 —— 所以入口要显眼，发送按钮直接禁用。
const configured = computed(() => Boolean(props.config && props.config.apiKey));

// 设置放在项目的设置页里，不在面板上就地改：
// 一个 API Key 是全局的，不属于某一个工作流。
function goSettings() {
  emit('go-settings');
}

/**
 * 会话下拉选中一项。
 *
 * UiSelect 的 change emit 出去的是字符串 value，不是原生 DOM 事件 ——
 * 早先这里写 `$event.target.value`，取到 undefined 再读 .value 直接抛
 * TypeError，用户点了没有任何反应（切换入口等于不存在）。
 * 空串是那个「选择历史会话」占位项，不算一次切换。
 */
function onSelectSession(value) {
  if (!value) return;
  emit('select-session', value);
}

/**
 * 选项文案：标题 · 最后访问时间；当前会话再套一层「（当前）」，
 * 下拉收起时显示的就是这一行，用户能直接看出自己停在哪个会话。
 */
function sessionOptionText(entry) {
  const label = sessionOptionLabel(entry, t('workflow.agent.session.untitled'));

  return entry.id === props.currentSessionId
    ? t('workflow.agent.session.currentLabel', { label })
    : label;
}

/**
 * 打开弹窗前先扫一遍有没有可注入的页面：一个都没有的话，
 * 与其让用户点进去看一个空列表，不如直接告诉他为什么。
 */
async function openPicker() {
  try {
    const groups = await props.listTabs();
    const n = groups.reduce((m, g) => m + g.tabs.length, 0);

    if (n === 0) {
      emit('no-target');

      return;
    }
  } catch (e) {
    emit('no-target');

    return;
  }

  pickerVisible.value = true;
}

function onPick(tab) {
  pickerVisible.value = false;
  emit('pick-tab', tab);
}

function send() {
  const text = draft.value.trim();
  if (!text || !configured.value) return;
  // busy 时也放行 —— 宿主会把它送进插话队列（P3）
  emit('send', text);
  draft.value = '';
}

/** token 数缩写：1234 -> 1.2k */
function fmtTokens(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
</script>
