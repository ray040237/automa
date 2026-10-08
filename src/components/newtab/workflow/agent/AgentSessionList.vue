<template>
  <!--
    T-168：会话历史列表（无外壳）。

    这一格以前是「会话下拉的内容」（w-72 + max-h-[60vh]）。浮层适合「临时选
    一个」，不适合「浏览 + 搜索 + 管理」—— 会话历史是后者：它只增不减，攒多了
    要靠搜索和时间来认，而切换还会清空插话队列、删除不可逆。现在它变成面板
    正文区里的一整块视图（外壳由 AgentPanel 的 view 切换给）。

    顺带解决一个测试盲区：`agent-dropdown` 在 utils/sfc-render.mjs 的
    GLOBAL_STUBS 里 **slot 不渲染**，所以列表挂在下拉里时，渲染测试根本看不见
    它 —— 只能靠静态 grep。搬出下拉之后，它是真实节点了。
  -->
  <div class="flex h-full min-h-0 flex-col" data-test="session-history">
    <div class="px-2 pb-2">
      <ui-input
        v-model="query"
        :placeholder="t('workflow.agent.session.searchPlaceholder')"
        class="w-full"
      />
    </div>

    <div class="scroll min-h-0 flex-1 overflow-y-auto px-1">
      <p
        v-if="total === 0"
        class="px-2 py-6 text-center text-sm text-gray-500"
        data-test="session-empty"
      >
        {{ t('workflow.agent.session.empty') }}
      </p>

      <!-- 有会话但一条都没中：**说明搜索的边界**而不是留一片空白 ——
           用户会以为搜索坏了。 -->
      <p
        v-else-if="groups.length === 0"
        class="px-3 py-6 text-center text-xs leading-relaxed text-gray-500"
        data-test="session-search-limit"
      >
        {{ t('workflow.agent.session.searchLimit') }}
      </p>

      <template v-for="g in groups" :key="g.key">
        <p
          class="px-2 pb-1 pt-2 text-[10px] text-gray-400"
          :data-test="'session-group-' + g.key"
        >
          {{ groupLabel(g.key) }}
        </p>

        <!--
          两行密度：标题 + 「时间 · N 条消息」。
          索引里一直存着 messageCount，以前没用上；而 24 字的标题区分度很低
          （都是「帮我把这个页面的…」这种开头），认出一条历史真正靠的是时间与规模。
        -->
        <div
          v-for="s in g.items"
          :key="s.id"
          class="flex items-start gap-1 rounded"
          :class="{ 'bg-box-transparent': s.id === currentSessionId }"
          :title="disabled ? t('workflow.agent.session.busyHint') : ''"
        >
          <button
            type="button"
            :disabled="disabled"
            :title="disabled ? t('workflow.agent.session.busyHint') : ''"
            class="hoverable flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
            @click="emit('select', s.id)"
          >
            <span
              class="w-full truncate text-[13px]"
              :class="{ 'text-gray-400': !s.title }"
              >{{ titleOf(s) }}</span
            >
            <span class="text-[10.5px] text-gray-400">{{ subOf(s) }}</span>
          </button>

          <span
            v-if="s.id === currentSessionId"
            class="mt-2 shrink-0 text-[11px] text-accent"
            >✓</span
          >

          <button
            type="button"
            class="mt-1 shrink-0 rounded p-1.5 text-gray-500 hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:text-red-400"
            :disabled="disabled"
            :title="
              disabled
                ? t('workflow.agent.session.busyHint')
                : t('workflow.agent.session.deleteOne')
            "
            :aria-label="
              disabled
                ? t('workflow.agent.session.busyHint')
                : t('workflow.agent.session.deleteOne')
            "
            @click="emit('delete', s.id)"
          >
            <v-remixicon name="riDeleteBin7Line" class="shrink-0" />
          </button>
        </div>
      </template>
    </div>

    <!-- T-09②：模型名是会话级信息，跟着列表走（换 provider / 换模型后要能确认
         「这个答案是谁写的」）。T-153 之后水位不在这里了 —— 它在输入区的圆环上。 -->
    <p
      v-if="model"
      class="truncate border-t border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
      :title="model"
      data-test="model-name"
    >
      {{ model }}
    </p>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  GROUP_TODAY,
  GROUP_YESTERDAY,
  clockOf,
  dateOf,
  dayGroupOf,
  filterSessionsByTitle,
  groupSessionsByDay,
} from '@/agent/sessionGroups';

/**
 * 会话历史列表。
 *
 * 分组、相对时刻、搜索都在 `@/agent/sessionGroups`（纯函数，有单测）——
 * 组件里只做取数与文案，判定不住在这里。
 */
const props = defineProps({
  sessions: { type: Array, default: () => [] },
  currentSessionId: { type: String, default: null },
  disabled: { type: Boolean, default: false },
  // T-09②：当前 provider 的模型名（config.model）
  model: { type: String, default: '' },
});

const emit = defineEmits(['select', 'delete']);

const { t } = useI18n();

const query = ref('');

const total = computed(() => (props.sessions || []).length);

/**
 * 过滤 → 分组，两步都在 sessionGroups 里（纯函数，有单测）。
 *
 * `Date.now()` 不进响应式：列表本身会随 sessions / query 重算，而「现在」在
 * 一次渲染内不必追究 —— 会话历史精确到分钟，没有秒级正确的需求。
 */
const groups = computed(() =>
  groupSessionsByDay(
    filterSessionsByTitle(props.sessions, query.value),
    Date.now()
  )
);

function titleOf(entry) {
  return entry.title || t('workflow.agent.session.untitled');
}

/**
 * 副行：时间 · N 条消息。
 *
 * 「昨天」走 i18n 键而不是拼在这里 —— 它是给人看的词，不是格式。
 * 拿不到时间戳时只出消息数，绝不拼出「 · 」这种半截分隔符。
 */
function subOf(entry) {
  const ts = Number(entry.lastAccessedAt || entry.createdAt) || 0;
  const group = dayGroupOf(ts, Date.now());

  let time = dateOf(ts);
  if (group === GROUP_TODAY) time = clockOf(ts);
  else if (group === GROUP_YESTERDAY)
    time = `${t('workflow.agent.session.groupYesterday')} ${clockOf(ts)}`;

  const count = t('workflow.agent.session.turnCount', {
    n: Number(entry.messageCount) || 0,
  });

  return time ? `${time} · ${count}` : count;
}

function groupLabel(key) {
  if (key === GROUP_TODAY) return t('workflow.agent.session.groupToday');
  if (key === GROUP_YESTERDAY)
    return t('workflow.agent.session.groupYesterday');

  return t('workflow.agent.session.groupEarlier');
}
</script>
