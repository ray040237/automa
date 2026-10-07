<template>
  <div class="relative min-h-0 flex-1">
    <!-- role=log + aria-live：这是「助手说过的话」这条时间线。新到的回答、
         工具结果、压缩摘要都是追加进来的，屏幕阅读器据此逐条播报；
         aria-relevant=additions 表示只有新增内容需要播报，翻回旧消息不重复念。
         T-13 之前这里只有一个滚动容器，读屏软件完全读不到流里的内容。 -->
    <div
      ref="scroller"
      class="scroll scroll-xs flex h-full flex-col gap-3 overflow-y-auto p-3"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      @scroll.passive="onScroll"
    >
      <template v-for="(item, i) in items" :key="item.key">
        <div
          v-if="item.type === 'user'"
          class="self-end whitespace-pre-wrap rounded-lg bg-blue-500/15 px-3 py-2 text-sm"
        >
          {{ item.text }}
        </div>

        <!-- T-09：轮次分隔线。刻意做得很轻（一条线 + 时间），长会话里每轮都
             要有一条锚点，太重会盖过正文；「第 n 轮」那种更强的锚点等真需要
             再说（已登记的取舍）。 -->
        <div
          v-else-if="item.type === 'turn'"
          class="flex items-center gap-2 pt-1 text-[11px] text-gray-400 dark:text-gray-500"
          data-test="turn-divider"
        >
          <span class="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          <time v-if="item.at" :datetime="new Date(item.at).toISOString()">
            {{ clockAt(item.at) }}
          </time>
          <span class="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
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
            :aria-expanded="item.open"
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

        <!-- 预检/插队这类 advisory 提示：琥珀色，权重刻意压低 -->
        <div
          v-else-if="item.type === 'notice'"
          class="rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {{ item.text }}
        </div>

        <!-- T-04：失败独立成类。
             早先 agent:error 与 system-notice 共用同一条琥珀色提示
             （push({type:'notice'})），断流 / provider 401 / config 缺失在视觉上
             与「一句善意提醒」等同，权重还不如旁边的工具卡状态徽标。
             「重试」用出错这一轮之前最近的那条用户消息，不是重新打一遍。 -->
        <div
          v-else-if="item.type === 'error'"
          class="rounded border border-red-500/40 bg-red-500/10 px-3 py-2"
        >
          <div class="flex items-start gap-2">
            <v-remixicon
              name="riErrorWarningLine"
              class="mt-0.5 shrink-0 text-red-500"
            />
            <div class="min-w-0 flex-1">
              <div
                class="flex flex-wrap items-baseline gap-2 text-xs font-medium text-red-700 dark:text-red-400"
              >
                <span>{{ kindLabel(item.kind) }}</span>
                <span v-if="item.httpStatus" class="text-[10px] opacity-80">
                  HTTP {{ item.httpStatus }}
                </span>
              </div>
              <p
                class="mt-1 whitespace-pre-wrap break-words text-xs text-red-700/90 dark:text-red-400/90"
              >
                {{ item.text }}
              </p>
              <div class="mt-2 flex items-center gap-3 text-[11px]">
                <button
                  v-if="item.retryText"
                  type="button"
                  class="flex items-center gap-1 text-red-700 hover:underline dark:text-red-400"
                  @click="emit('retry', item.retryText)"
                >
                  <v-remixicon name="riRefreshLine" />
                  {{ t('workflow.agent.errorDetail.retry') }}
                </button>
                <button
                  type="button"
                  class="text-red-700 hover:underline dark:text-red-400"
                  @click="copyDetail(item)"
                >
                  {{ t('workflow.agent.errorDetail.copyDetail') }}
                </button>
                <span
                  v-if="item.key === copiedKey"
                  class="text-red-600/80 dark:text-red-300/80"
                >
                  {{ t('workflow.agent.copied') }}
                </span>
                <span
                  v-else-if="item.key === copyFailedKey"
                  class="text-red-600/90 dark:text-red-300/90"
                >
                  {{ t('workflow.agent.errorDetail.copyFailed') }}
                </span>
              </div>
            </div>
          </div>
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
            :aria-expanded="item.open"
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

      <!-- 空态（T-109 补回一句，T-10 加上示例与能力徽标）：items 为空时正文区
           原本一片空白，成因是 T-103 删说明段落时把 workflow.agent.empty 一起
           删掉了 —— 键还在 locale 里，全仓却零引用。
           示例点击只填入草稿（pick-example），**不自动发送**：示例是猜的，
           用户得能先改再决定发不发。
           放在滚动容器内：内容少时它就落在可视区中间，而不是贴在顶上。 -->
      <div
        v-if="items.length === 0"
        class="flex flex-col items-center gap-3 py-8 text-center"
      >
        <p class="text-sm text-gray-500 dark:text-gray-400">
          {{ t('workflow.agent.empty') }}
        </p>

        <ul v-if="examples.length" class="flex w-full flex-col gap-1.5">
          <li v-for="ex in examples" :key="ex.id">
            <button
              type="button"
              class="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              @click="emit('pick-example', ex.text)"
            >
              {{ ex.text }}
            </button>
          </li>
        </ul>

        <ul
          v-if="groups.length"
          class="flex flex-wrap items-center justify-center gap-1"
          data-test="capability-groups"
        >
          <li
            v-for="g in groups"
            :key="g.id"
            class="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
          >
            {{ t('workflow.agent.group.' + g.id) }}
          </li>
        </ul>
      </div>

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
import { AGENT_EVENTS } from '@/agent/events';
import { clockAt } from '@/agent/usage';
// T-53：折叠层（事件流 -> 渲染槽位）已抽成纯模块，本组件只负责摆位置与滚动
import { createFolder } from '@/agent/fold';
import AgentMarkdown from './AgentMarkdown.vue';
// T-09：时刻格式化在纯模块里（有单测），组件只负责摆位置
import AgentToolStep from './AgentToolStep.vue';

const props = defineProps({
  events: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  // T-10：空态用的工具组徽标与示例问法。都由宿主从 enabledGroups 推导后传进来 ——
  // 组件自己不含任何「这个宿主有什么能力」的知识，否则两处会各说各话。
  groups: { type: Array, default: () => [] },
  examples: { type: Array, default: () => [] },
});

/** 「重试」按钮：把出错那一轮的原文交回宿主重发，本组件不碰 draft */
const emit = defineEmits(['retry', 'pick-example']);

const { t } = useI18n();

/**
 * 渲染槽位由 fold.js 折出来（T-53）。**items 必须传 reactive 数组** —— 折叠层要
 * push 与就地并槽（delta 追加、工具卡合并），普通数组的改动 Vue 追踪不到。
 * 为什么是增量式而不是 computed：text/thinking 的 raw 逐字增长，用 computed 每来
 * 一个 delta 就要把整段历史重新折一遍（T-14 同型的 O(n²)）；fold 里保留游标语义，
 * 同一数组只处理游标之后的新事件，换会话才整表重放。
 */
const items = reactive([]);
const scroller = ref(null);
const stickToBottom = ref(true);

const folder = createFolder({ items, t });

/** 离底部多近还算「贴着底」：太严格的话流式输出会误判成用户滚上去了 */
const TAIL_THRESHOLD = 32;

// ---------------------------------------------------------------- T-04 错误卡

/**
 * 错误归类 -> 文案键。与 AgentToolStep 的 STATUS_LABEL 同款：值是键的尾段，
 * 前缀一律 workflow.agent.errorKind。
 *
 * events.js 的 ERROR_KIND 是这套表的唯一来源；panelUi.test.js 的守卫要求它
 * 每新增一档这里就得跟上，漏了就退到兜底文案（宁可少一句分类，也不显示原始键名）。
 */
const ERROR_KIND_LABEL = {
  config: 'config',
  network: 'network',
  provider: 'provider',
  tool: 'tool',
  'no-target-tab': 'noTargetTab',
  internal: 'internal',
};

function kindLabel(kind) {
  const key = ERROR_KIND_LABEL[kind];
  return key ? t(`workflow.agent.errorKind.${key}`) : t('workflow.agent.error');
}

/** 复制用的详情：归类 + HTTP 状态 + 时间 + 原文，供用户粘去反馈/工单 */
function errorDetail(item) {
  return [
    t('workflow.agent.errorDetail.detailTitle'),
    `${t('workflow.agent.errorDetail.kindField')}: ${
      ERROR_KIND_LABEL[item.kind] || 'unknown'
    }`,
    item.httpStatus !== undefined ? `HTTP ${item.httpStatus}` : '',
    `${t('workflow.agent.errorDetail.timeField')}: ${new Date().toISOString()}`,
    item.text,
  ]
    .filter(Boolean)
    .join('\n');
}

const copiedKey = ref(0);
const copyFailedKey = ref(0);

/**
 * 复制失败要说出来（不静默降级）：剪贴板不可用时给一句提示 ——
 * 静默「什么都没发生」与「已经复制好了」在用户眼里没有区别。
 */
async function copyDetail(item) {
  copyFailedKey.value = 0;
  try {
    await navigator.clipboard.writeText(errorDetail(item));
    copiedKey.value = item.key;
  } catch (err) {
    copiedKey.value = 0;
    copyFailedKey.value = item.key;
    console.error('agent: 复制错误详情失败', err);
  }
}

/**
 * 折叠规则都在 fold.js（T-53）。这里只留一个同名薄封装 —— watch 调它，模板不用改，
 * 而「组件里仍留着一份折叠逻辑」这件事会被静态守卫一眼看出。
 *
 * 只剩 sync 一个：applyEvent 曾是 sync 的内部步骤，现在 sync 直接调 folder.apply，
 * 再留一层只会让 eslint 报未使用。
 */
function sync(source) {
  folder.sync(source);
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
