<template>
  <div class="scroll scroll-xs max-h-[60vh] w-72 overflow-y-auto p-1">
    <p
      v-if="sessions.length === 0"
      class="px-2 py-6 text-center text-sm text-gray-500"
    >
      {{ t('workflow.agent.session.empty') }}
    </p>

    <template v-else>
      <!--
        每行 = 一组：行主体点开切换，行尾垃圾桶删掉「这一条」。
        不用列表底部的「删除当前会话」：想删一条旧会话时就得先切过去，而切换会
        丢掉当前上下文（还要过 guardAgentSwitch），为了删一条历史记录被迫先搬过去。
        垃圾桶与行主体是两个独立 button，点删除不会连带触发切换。
      -->
      <!-- T-11：行容器上也挂 title —— disabled 按钮在部分浏览器里不派发鼠标
           事件，title 只挂在按钮上有时弹不出来；容器不是 disabled，稳。 -->
      <div
        v-for="s in sessions"
        :key="s.id"
        class="flex items-center rounded"
        :class="{ 'bg-box-transparent': s.id === currentSessionId }"
        :title="disabled ? t('workflow.agent.session.busyHint') : ''"
      >
        <button
          type="button"
          :disabled="disabled"
          class="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hoverable disabled:cursor-not-allowed disabled:opacity-60"
          :title="disabled ? t('workflow.agent.session.busyHint') : ''"
          @click="emit('select', s.id)"
        >
          <v-remixicon
            name="riChatHistoryLine"
            class="shrink-0 text-gray-400"
          />
          <span class="min-w-0 flex-1 truncate">
            {{ optionText(s) }}
          </span>
          <v-remixicon
            v-if="s.id === currentSessionId"
            name="riCheckLine"
            class="shrink-0 text-accent"
          />
        </button>

        <button
          type="button"
          class="shrink-0 rounded p-1.5 text-gray-500 hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:text-red-400"
          :disabled="disabled"
          :title="
            disabled
              ? t('workflow.agent.session.busyHint')
              : t('workflow.agent.session.delete')
          "
          :aria-label="
            disabled
              ? t('workflow.agent.session.busyHint')
              : t('workflow.agent.session.delete')
          "
          @click="emit('delete', s.id)"
        >
          <v-remixicon name="riDeleteBin7Line" class="shrink-0" />
        </button>
      </div>
    </template>

    <!-- token 用量是会话级信息，跟「当前是哪个会话」一起看最自然，
         所以并进这个下拉，而不是在 header 再挂一个角标控件 -->
    <p
      v-if="usage"
      class="mt-1 border-t border-gray-200 px-2 pt-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
      :title="t('workflow.agent.usage', { in: usage.input, out: usage.output })"
    >
      {{ fmtTokens(usage.input) }}/{{ fmtTokens(usage.output) }}
    </p>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n';
import { sessionOptionLabel } from '@/agent/sessions';

/**
 * 会话下拉的内容：会话列表（每行自带删除）+ token 用量。
 *
 * 原本 header 上还有一个「⋯」溢出菜单，专门用来装 token 用量与删除 —— 为了两个
 * 功能多出一层菜单、多一个按钮，删除要点两次。已收掉：这三件事本来就都属于
 * 「会话」，全放进这一个下拉。删除进一步改成**每行自带垃圾桶**（见模板里的注释）。
 *
 * 文案不在这里拼 —— 复用 sessions.js 的 sessionOptionLabel（已有单测钉住，
 * 它产出「标题 · 相对时间」）。更早那行原生 <select> 是靠给标题追加「（当前）」
 * 这种字符串后缀来标记当前会话的，换成列表后用勾选图标，不再往标题里塞字。
 */
// 模板里直接用 props 的字段，不需要挂到变量上（optionText 是按项取值的）
defineProps({
  sessions: { type: Array, default: () => [] },
  currentSessionId: { type: String, default: null },
  usage: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(['select', 'delete']);

const { t } = useI18n();

function optionText(entry) {
  return sessionOptionLabel(entry, t('workflow.agent.session.untitled'));
}

/** token 数缩写：1234 -> 1.2k */
function fmtTokens(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
</script>
