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
    <!-- T-213：mode='popover' 时不渲染搜索框。
         搜索是「在几十条里找一条」的工具，而下拉是「看最近几条、挑一条接着聊」
         的入口 —— 塞进去会让浮层高出一行，且列表通常只有 5~8 条，
         用不着搜。要看全部 / 要搜，走底部的「全部历史会话」。 -->
    <div v-if="mode === 'view'" class="px-4 pb-2">
      <ui-input
        v-model="query"
        :placeholder="t('workflow.agent.session.searchPlaceholder')"
        class="w-full"
      />
    </div>

    <div
      class="scroll min-h-0 flex-1 overflow-y-auto"
      :class="mode === 'view' ? 'px-2' : 'px-1'"
    >
      <p
        v-if="total === 0"
        class="px-2 py-6 text-center text-sm text-fg-2"
        data-test="session-empty"
      >
        {{ t('workflow.agent.session.empty') }}
      </p>

      <!-- 有会话但一条都没中：**说明搜索的边界**而不是留一片空白 ——
           用户会以为搜索坏了。 -->
      <p
        v-else-if="groups.length === 0"
        class="px-3 py-6 text-center text-xs leading-relaxed text-fg-2"
        data-test="session-search-limit"
      >
        {{ t('workflow.agent.session.searchLimit') }}
      </p>

      <template v-for="g in groups" :key="g.key">
        <!-- 分组小标与模型弹层的规范形态统一（text-[10.5px] + font-medium +
             tracking-wide，2026-10-10「不要长长短短」）。px-2 不动：
             view 模式下 8+8=16px、popover 模式下 4+8=12px，与行的有效缩进对齐。 -->
        <p
          class="px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-fg-3"
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
          class="session-row group/row flex items-start gap-1 rounded-chip"
          :class="{ 'bg-box-transparent': s.id === currentSessionId }"
          :title="disabled ? t('workflow.agent.session.busyHint') : ''"
        >
          <button
            type="button"
            :disabled="disabled"
            :title="disabled ? t('workflow.agent.session.busyHint') : ''"
            class="hoverable flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-chip px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
            @click="emit('select', s.id)"
          >
            <span
              class="w-full truncate text-[13px]"
              :class="{ 'text-fg-3': !s.title }"
              >{{ titleOf(s) }}</span
            >
            <span
              class="text-[10.5px] text-fg-3 transition duration-fast ease-panel group-hover/row:opacity-0"
              >{{ subOf(s) }}</span
            >
          </button>

          <!-- T-213：当前会话的 ✓ 与删除键**占同一个位置**（都是右侧 22px），
               所以悬停时 ✓ 让位给删除键，而不是两个并排把标题挤窄。
               这是参考实现 pie 的做法：常态只给「哪条是当前」，
               鼠标进来才把「能删」露出来。

               2026-10-10 用户实证的 bug：这个槽位容器**必须自己有尺寸**。
               ✓ 只给当前会话渲染，删除键又是 absolute —— 于是在非当前会话
               的行里，容器里没有任何静态内容，塌成 0×0，`inset-0` 跟着
               0×0：删除键存在、hover 态也对，但点击区域是零，**怎么点都
               点不到**。表现为「只有当前会话那行能删，别的行悬停没反应」。
               给容器钉死 h-5 w-5，✓ 和删除键各自填满同一格。 -->
          <div
            class="relative mr-1 mt-1 flex h-5 w-5 shrink-0 items-center justify-center"
          >
            <span
              v-if="s.id === currentSessionId"
              class="grid h-5 w-5 place-items-center text-[11px] text-accent transition duration-fast ease-panel group-hover/row:opacity-0"
              >✓</span
            >
            <button
              type="button"
              class="absolute inset-0 grid place-items-center rounded-chip text-fg-3 opacity-0 transition duration-fast ease-panel hover:bg-danger/15 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 group-hover/row:opacity-100"
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
              <v-remixicon name="riDeleteBin7Line" size="14" class="shrink-0" />
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- T-09②：模型名是会话级信息，跟着列表走（换 provider / 换模型后要能确认
         「这个答案是谁写的」）。T-153 之后水位不在这里了 —— 它在输入区的圆环上。
         T-213：mode='popover' 时不渲染 —— 下拉底部那行要留给「全部历史会话」，
         而模型状态已经搬到 composer 底行的模型芯片上，不必两处都显示。 -->
    <p
      v-if="model && mode === 'view'"
      class="truncate border-t border-line px-3 py-2 text-xs text-fg-2"
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
  /**
   * T-213：两种密度。
   *   'view'    = 面板正文里的整块历史视图（默认）：带搜索框 + 底部模型名。
   *   'popover' = 标题下拉里的列表：去掉搜索与模型名，行更紧，底部留给
   *               「全部历史会话」。
   * 同一个组件吃两种密度，是为了让「列表长什么样」只有一处实现 ——
   * 下拉与视图里的行高、两行结构、删除交互保持一致。
   */
  mode: {
    type: String,
    default: 'view',
    validator: (v) => ['view', 'popover'].includes(v),
  },
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
