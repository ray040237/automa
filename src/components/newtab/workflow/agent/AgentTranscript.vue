<template>
  <div class="relative min-h-0 flex-1">
    <div
      ref="scroller"
      class="scroll scroll-xs flex h-full flex-col gap-3 overflow-y-auto p-3"
      @scroll.passive="onScroll"
    >
      <div
        v-if="items.length === 0"
        class="m-auto max-w-sm text-center text-sm text-gray-500"
      >
        {{ t('workflow.agent.empty') }}
      </div>

      <template v-for="(item, i) in items" :key="item.key">
        <div
          v-if="item.type === 'user'"
          class="self-end whitespace-pre-wrap rounded-lg bg-blue-500/15 px-3 py-2 text-sm"
        >
          {{ item.text }}
        </div>

        <agent-markdown v-else-if="item.type === 'text'" :raw="item.raw" />

        <!-- 思考过程默认折叠：它解释模型怎么想，但通常不该抢正文的位置 -->
        <div
          v-else-if="item.type === 'thinking'"
          class="rounded border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/40"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-500 dark:text-gray-400"
            @click="toggleThinking(item)"
          >
            <v-remixicon
              :name="item.open ? 'riArrowDropDownLine' : 'riArrowRightLine'"
              class="shrink-0"
            />
            <span class="shrink-0">{{ thinkingLabel(item, i) }}</span>
            <span
              v-if="!item.open"
              class="ml-2 truncate text-gray-400 dark:text-gray-500"
            >
              {{ previewOf(item) }}
            </span>
          </button>
          <div
            v-if="item.open"
            class="border-t border-gray-200 px-3 py-2 text-gray-600 dark:border-gray-700 dark:text-gray-300"
          >
            <agent-markdown :raw="item.raw" />
          </div>
        </div>

        <agent-tool-step
          v-else-if="item.type === 'tool'"
          class="self-start"
          :step="item.step"
        />

        <div
          v-else-if="item.type === 'notice'"
          class="rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {{ item.text }}
        </div>

        <!-- T-76 压缩摘要：折叠卡与思考卡同一交互。默认收起——它记录的是
             「上面那些消息」的摘要，展开看内容的人是少数 -->
        <div
          v-else-if="item.type === 'compaction'"
          class="rounded border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/40"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-500 dark:text-gray-400"
            @click="item.open = !item.open"
          >
            <v-remixicon
              :name="item.open ? 'riArrowDropDownLine' : 'riArrowRightLine'"
              class="shrink-0"
            />
            <span class="shrink-0">{{
              t('workflow.agent.compacted', { n: item.turns })
            }}</span>
          </button>
          <div
            v-if="item.open"
            class="border-t border-gray-200 px-3 py-2 text-gray-600 dark:border-gray-700 dark:text-gray-300"
          >
            <agent-markdown :raw="item.raw" />
          </div>
        </div>
      </template>

      <!-- 工具跑完到下一个字之间是空窗期，不给点反馈用户只能去看输入框才知道还在跑 -->
      <div
        v-if="pendingHint"
        class="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500"
      >
        <v-remixicon name="riLoader4Line" class="animate-spin" />
        {{ t('workflow.agent.thinking') }}
      </div>
    </div>

    <!-- 用户往上翻之后不再抢滚动条，但要留一条回来的路 -->
    <button
      v-if="items.length > 0 && !stickToBottom"
      type="button"
      class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center rounded-full border border-gray-200 bg-white px-3 py-1 text-xs shadow-sm transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
      @click="jumpToLatest"
    >
      <v-remixicon name="riArrowDownLine" size="14" class="mr-1" />
      {{ t('workflow.agent.scrollToBottom') }}
    </button>
  </div>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AGENT_EVENTS, TOOL_STATUS } from '@/agent/events';
import AgentMarkdown from './AgentMarkdown.vue';
import AgentToolStep from './AgentToolStep.vue';

const props = defineProps({
  events: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
});

const { t } = useI18n();

/**
 * 渲染槽位。
 *
 * 为什么不是 computed：text/thinking 的 raw 是逐字增长的，用 computed 每来一个
 * delta 就要把整段历史重新折一遍。这里改成增量追加 —— 只处理游标之后的新事件，
 * 会话切换时（宿主换了个新数组）才整表重放。
 */
const items = reactive([]);
const scroller = ref(null);
const stickToBottom = ref(true);

let cursor = 0;
let previousSource = null;
let seed = 0;

/** 离底部多近还算「贴着底」：太严格的话流式输出会误判成用户滚上去了 */
const TAIL_THRESHOLD = 32;

function push(item) {
  seed += 1;
  item.key = seed;
  items.push(item);
}

/** 同类型的连续 delta 追加到同一个槽位，不另起一块 */
function appendDelta(type, text) {
  const last = items[items.length - 1];
  if (last && last.type === type) {
    last.raw += text;
    return;
  }
  push({ type, raw: text, open: false });
}

function applyEvent(ev) {
  if (!ev) return;

  switch (ev.kind) {
    case AGENT_EVENTS.TEXT_DELTA:
      appendDelta('text', ev.text || '');
      return;
    case AGENT_EVENTS.THINKING:
      appendDelta('thinking', ev.text || '');
      return;
    case AGENT_EVENTS.USER_MESSAGE:
      push({ type: 'user', text: ev.text || '' });
      return;
    case AGENT_EVENTS.SYSTEM_NOTICE:
      push({ type: 'notice', text: ev.text || '' });
      return;
    case AGENT_EVENTS.COMPACTION:
      push({
        type: 'compaction',
        raw: ev.summary || '',
        turns: ev.summarizedTurns || 0,
        open: false,
      });
      return;
    case AGENT_EVENTS.ERROR:
      push({ type: 'notice', text: ev.message || t('workflow.agent.error') });
      return;
    case AGENT_EVENTS.TOOL_CALL:
    case AGENT_EVENTS.TOOL_RESULT: {
      const step = {
        name: ev.name,
        step: ev.step,
        toolCallId: ev.toolCallId,
        args: ev.args,
        status: ev.status || TOOL_STATUS.RUNNING,
        observation: ev.observation,
      };
      // 同一次调用（按 toolCallId 配对）的 call 与 result 合并成一张卡。
      // 旧键是 name+step：同名并行调用（一条消息里两次 read_page）会互相
      // 覆盖参数与观察值；事件流已按调用拆开（T-74 方案 B），这里按 id
      // 从后往前找归属卡 —— 并行时事件交错，归属卡不一定就是最后一张。
      let target = null;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i];
        if (it.type === 'tool' && it.step.toolCallId === ev.toolCallId) {
          target = it.step;
          break;
        }
      }
      if (target) {
        Object.assign(target, {
          status: step.status,
          observation:
            ev.observation !== undefined ? ev.observation : target.observation,
          args: ev.args !== undefined ? ev.args : target.args,
        });
      } else {
        push({ type: 'tool', step });
      }
      break;
    }
    default:
      // start / done / target-tab 不产生对话内容
      break;
  }
}

function sync(source) {
  if (source !== previousSource) {
    // 换了会话：宿主给的是另一个数组，整表重放
    items.splice(0);
    cursor = 0;
    previousSource = source;
  }

  for (; cursor < source.length; cursor += 1) {
    applyEvent(source[cursor]);
  }
}

async function followTail(kind) {
  await nextTick();
  const el = scroller.value;
  if (!el) return;

  // 自己发的消息永远要看得见 —— 这是用户主动期待的结果
  if (kind === AGENT_EVENTS.USER_MESSAGE) stickToBottom.value = true;
  if (!stickToBottom.value) return;

  el.scrollTop = el.scrollHeight;
}

watch(
  () => [props.events, props.events.length],
  ([events]) => {
    const source = events || [];
    sync(source);
    followTail(source[source.length - 1]?.kind);
  },
  { immediate: true }
);

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  stickToBottom.value = distance <= TAIL_THRESHOLD;
}

function jumpToLatest() {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  stickToBottom.value = true;
}

function toggleThinking(item) {
  item.open = !item.open;
}

function thinkingLabel(item, index) {
  const streaming = props.busy && index === items.length - 1;
  return streaming
    ? t('workflow.agent.thinking')
    : t('workflow.agent.thinkingResult');
}

/** 折叠时给一行摘要，让人知道里面大概在盘算什么 */
function previewOf(item) {
  const first = (item.raw || '').trim().split('\n')[0];
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/**
 * 正文正在往外吐的时候不显示「思考中」——那一行只会打扰阅读。
 * 只在工具调用之后、下一个字还没来的空窗期提示。
 */
const pendingHint = computed(() => {
  if (!props.busy) return false;
  const last = items[items.length - 1];
  return !last || last.type === 'tool';
});
</script>
