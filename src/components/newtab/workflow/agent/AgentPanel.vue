<template>
  <div class="flex h-full flex-col">
    <!--
      header 只有两个控件：会话 chip（点开 = 切换 / 用量 / 删除当前）与新建。
      页面上下文不在这里 —— 它在下面的输入区顶上，见 §chip。

      两个控件都带 bg-box-transparent（项目通用的「这是个可点的盒子」底色，
      工作流块、Autocomplete、Packages 等 46+ 处在用）。只有 hover 而没有底色的
      控件会和面板背景糊在一起，用户看不出哪里能点。
    -->
    <!-- T-158：py-1 而不是 py-1.5 —— 面板是 flex-col + transcript flex-1，
         常驻行每省 1px，正文就多 1px。 -->
    <div class="flex items-center gap-1.5 px-2 py-1">
      <!-- w-72 = 288px < 侧栏内容区 320px，右侧仍留 12px -->
      <agent-dropdown
        v-model="sessionMenuOpen"
        align="left"
        side="bottom"
        width="w-72"
        class="min-w-0 flex-1"
      >
        <template #trigger>
          <button
            type="button"
            class="group bg-box-transparent hover:bg-opacity-10 flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
            :title="t('workflow.agent.session.placeholder')"
          >
            <v-remixicon
              name="riChatHistoryLine"
              class="shrink-0 text-gray-500 dark:text-gray-400"
            />
            <span class="min-w-0 flex-1 truncate text-sm">
              {{ sessionLabel }}
            </span>
            <!-- T-158：箭头只在 hover / 键盘 focus 时出现。320px 侧栏里这 20px
                 等于标题多显示两三个字，而标题正是被 truncate 截断最狠的地方。
                 「可以点开」的暗示由 bg-box-transparent 承担（全项目 46+ 处在用），
                 箭头不是唯一线索。focus-within 兜住键盘用户 —— 没有它，纯键盘
                 用户永远看不到自己正停在哪个控件上。 -->
            <v-remixicon
              name="riArrowDownSLine"
              class="shrink-0 text-gray-500 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 dark:text-gray-400"
            />
          </button>
        </template>

        <!-- T-09②③：模型名挂在会话下拉里（会话级信息），值来自 host.config ——
             config 以前只被用来判断 apiKey 存不存在。
             T-153：上下文水位与用量**不在这里**了，它们搬到了输入区的圆环上
             （见 §form）—— 那是「发送前」要知道的信息，藏在下拉里等于逼用户
             先开菜单才能决定要不要按发送。 -->
        <agent-session-list
          :sessions="host.sessions"
          :current-session-id="host.sessionId"
          :model="host.config.model"
          :disabled="host.busy"
          @select="onSelectSession"
          @delete="onDeleteSession"
        />
      </agent-dropdown>

      <!-- T-11：busy 时 title 换成「为什么点不动」。原先 title 恒是「新建会话」，
           disabled 之后这句仍然在说功能名，用户看到的是「有按钮但不给理由」。 -->
      <button
        type="button"
        class="bg-box-transparent hover:bg-opacity-10 shrink-0 rounded-md px-2 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="host.busy"
        :title="
          host.busy
            ? t('workflow.agent.session.busyHint')
            : t('workflow.agent.session.new')
        "
        @click="host.newSession()"
      >
        <v-remixicon name="riAddLine" class="shrink-0" />
      </button>
    </div>

    <!-- T-04：错误卡上的「重试」把出错那一轮的原文交回宿主重发。
         刻意不碰 draft —— 用户可能正在打下一句，替他清空是越权。 -->
    <!-- T-10：空态要告诉用户「这里能问什么」与「这个宿主开了什么」。
         groups / 示例都从 host.groups 推导，组件自己不含任何能力知识。 -->
    <agent-transcript
      class="flex-1"
      :events="host.events"
      :busy="host.busy"
      :groups="host.groups"
      :examples="exampleList"
      @retry="host.send($event)"
      @pick-example="draft = $event"
    />

    <!-- 没配 API Key 时把入口摆在正中：
         这个状态下发消息只会回一句「请先配置」，让人以为功能坏了。 -->
    <!-- T-158：横幅压成一行（p-3 text-sm → px-2 py-1.5 text-xs，省约 16px）。
         它只需要说清「发送已禁用、去哪配」—— 发送按钮本身就 disabled 了，
         不需要用一整块的篇幅去重复这件事。
         注：配色仍是黄（T-152 的「黄/琥珀三义共用」尚未批准，此处不动颜色）。 -->
    <div
      v-if="!configured"
      class="border-b border-yellow-300 bg-yellow-500/10 px-2 py-1.5 text-xs text-yellow-800 dark:text-yellow-300"
    >
      <button type="button" class="underline" @click="goSettings">
        {{ t('workflow.agent.goSettings') }}
      </button>
    </div>

    <!-- 确认门放在流内、输入框上方，而不是 absolute 浮层：
         浮层会盖住输入区与发送按钮，往回翻历史时还一直悬着（T-06）。
         这里是文档流，面板高度不够时压缩的是 transcript，输入框永远点得到。 -->
    <agent-confirm-card
      v-if="host.pendingConfirm"
      class="mx-3 mb-3"
      :confirm="host.pendingConfirm"
      @answer="host.answerConfirm($event)"
    />

    <!--
      chip：助手正在读哪一页。
      放在输入区顶上而不是 header，是因为这里正是「我正要问这个页面」这个决定发生的地方
      —— Cursor 的 Listening pill 与 VS Code 的 chat-input 配置行都是这个位置。
      它紧贴输入框，中间不留缝，读起来是输入区的一部分而不是浮在上面的控件。
    -->
    <agent-tab-picker
      class="mx-2 mb-1"
      :target-tab="host.targetTab"
      :state="host.targetState"
      :pinned="host.targetPinned"
      :list-tabs="host.listTabs"
      @pick="host.pickTab($event)"
      @no-target="host.noTarget()"
    />

    <!-- / 模板菜单（T-81a）：draft 以 / 开头时出现。放文档流里不盖正文，
         与确认卡同一立场（T-06）。回车/点击选中后整框替换为模板正文。 -->
    <div
      v-if="slashMenuOpen"
      class="mx-2 mb-1 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
    >
      <ul class="scroll max-h-48 overflow-y-auto py-1">
        <li v-for="(c, i) in matchedCommands" :key="c.id">
          <button
            type="button"
            class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm"
            :class="i === highlightIndex ? 'bg-box-transparent' : ''"
            @click="pickCommand(c)"
            @mousemove="commandIndex = i"
          >
            <span class="shrink-0 font-mono">/{{ c.name }}</span>
            <span class="min-w-0 truncate text-xs opacity-60">{{
              c.description
            }}</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- T-12：插话已入队的常驻确认。事件流里那条「已排队」是一次性的 notice，
         面板滚动一屏就没了；这条钉在输入框正上方，队列排空前一直在。 -->
    <p
      v-if="host.busy && host.pendingInterjections > 0"
      class="mx-2 mb-1 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400"
      data-test="pending-interjections"
    >
      <v-remixicon name="riStackLine" class="shrink-0" />
      {{
        t('workflow.agent.queuedPending', {
          n: host.pendingInterjections,
        })
      }}
    </p>

    <form class="p-2 pt-0" @submit.prevent="send">
      <div class="flex items-end gap-2">
        <ui-textarea
          v-model="draft"
          autoresize
          class="min-h-[68px] max-h-[128px] flex-1 overflow-y-auto scroll scroll-xs"
          :placeholder="t('workflow.agent.placeholder')"
          @keydown="onDraftKeydown"
        />

        <!--
          发送 / 停止共用同一个图标按钮位（T-159 + 重设计）：
          - 空闲：→ 发送（icon，40×40）
          - 忙碌：■ 停止生成；**插话改由 Enter 提交** —— 输入框忙碌时仍可打字，
            send() 本来就放行插话队列（P3），排队的条数由上方常驻提示行报。
          原先忙碌时是「■ 停止 + 插话」两个按钮并排，8px gap 全从 textarea 身上扣，
          320px 侧栏里 textarea 只剩 144px（headless Chromium 实测），而忙碌恰恰是
          最要打字的时刻。合并成一个按钮位后，忙碌与空闲的 textarea 宽度一致。
        -->
        <ui-button
          v-if="host.busy"
          variant="default"
          icon
          type="button"
          :title="t('workflow.agent.stop')"
          :aria-label="t('workflow.agent.stop')"
          @click="host.abort()"
        >
          <v-remixicon name="riStopLine" class="shrink-0" />
        </ui-button>

        <ui-button
          v-else
          variant="accent"
          icon
          type="submit"
          :disabled="!draft.trim() || !configured"
          :title="t('workflow.agent.send')"
          :aria-label="t('workflow.agent.send')"
        >
          <v-remixicon name="riArrowRightLine" class="shrink-0" />
        </ui-button>
      </div>

      <!--
        元信息行（重设计 B 条）：水位与快捷键提示同属「输入区的元信息」，合成一行
        放在输入框**下方**。贴长内容之前视线正落在这一行，是水位最该出现的时机。

        左：圆环 + 常驻百分比（点开 = token 明细 + 新建会话，重设计 D 条）；
        右：快捷键提示（忙碌时改说「Enter 插话」，因为这时 Enter 走的是插话队列）。

        没配 API Key 时整行隐藏 —— 发送已禁用，水位此刻没有意义，省下约 22px
        给正文（重设计里这行是新增的，不省就白丢了 T-158 攒下的空间）。
      -->
      <div
        v-if="configured"
        class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5"
      >
        <agent-dropdown
          v-if="contextVisible"
          v-model="contextOpen"
          align="left"
          side="top"
          width="w-72"
          class="shrink-0"
        >
          <template #trigger>
            <agent-context-ring
              :usage="host.usage"
              :context-window="Number(host.config.contextWindow) || 0"
            />
          </template>

          <!-- 明细：水位 + 用量 + 「新建会话」。
               两行文案复用 contextHint / usage 两个既有键（圆环的 title 也是它们），
               不另造一套说法，免得同一个数字两处措辞不一致。 -->
          <div class="p-2 text-xs text-gray-700 dark:text-gray-200">
            <p>{{ contextHintLine }}</p>
            <p class="mt-1">{{ usageLine }}</p>
            <hr class="my-2 border-gray-200 dark:border-gray-700" />
            <button
              type="button"
              class="hoverable flex w-full items-center gap-1.5 rounded px-1 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="host.busy"
              :title="
                host.busy ? t('workflow.agent.session.busyHint') : undefined
              "
              @click="startNewSession"
            >
              <v-remixicon name="riAddLine" class="shrink-0" />
              <span class="min-w-0 flex-1">{{
                t('workflow.agent.session.new')
              }}</span>
            </button>
            <!-- 副注：host 上没有「原地清空上下文」的能力，最接近的是 newSession
                 —— 它会开一条新会话、把当前这条留在历史里。不写成「清空上下文」
                 是因为那不是它的真实行为（文案撒谎比功能少一个按钮更糟）。 -->
            <p class="px-1 pt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
              {{ t('workflow.agent.contextNewNote') }}
            </p>
          </div>
        </agent-dropdown>

        <span
          class="ml-auto shrink-0 text-[11px] text-gray-400 dark:text-gray-500"
        >
          {{
            host.busy
              ? t('workflow.agent.interjectHint')
              : t('workflow.agent.inputHint')
          }}
        </span>
      </div>
    </form>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { sessionOptionLabel } from '@/agent/sessions';
import { suggestExamples } from '@/agent/examples';
// 元信息行要问「水位算不算得出来」与格式化 token 数：判定与格式化都在纯模块里
// （有单测），组件只消费结果 —— .vue 里写的分支一条都测不到。
import { contextPercent as calcContextPercent, fmtTokens } from '@/agent/usage';
import { configIO } from '@/agent';
import {
  filterCommands,
  loadCommands,
  parseSlashDraft,
} from '@/agent/customizations';
import AgentTranscript from './AgentTranscript.vue';
import AgentTabPicker from './AgentTabPicker.vue';
import AgentSessionList from './AgentSessionList.vue';
import AgentDropdown from './AgentDropdown.vue';
import AgentConfirmCard from './AgentConfirmCard.vue';
import AgentContextRing from './AgentContextRing.vue';

/**
 * 面板收单个 `host` 对象 prop（T-90）—— 就是 useAgentHost 返回的那个
 * reactive agent：状态（events / busy / pendingConfirm / …）与方法（send /
 * pickTab / answerConfirm / …）都在它身上，面板直调方法，不再走 9 个 emits。
 *
 * 为什么收整对象而不是逐个 props + emits：两个宿主页面原本逐字重复 20 行绑定，
 * 加一个绑定要改 3 处；host 对象由 agentHost 组装，加绑定只改 agentHost 一处
 * —— 删码测试过关（删掉这层，复杂度不在任何调用点重新长出来）。
 *
 * 响应式：host 就是 reactive 对象，模板里 host.busy 等照常追踪。
 */
const props = defineProps({
  host: { type: Object, required: true },
});

const { t } = useI18n();

const draft = ref('');

// T-10：示例问法按本宿主开放的能力挑。点击只填入草稿、**不自动发送** ——
// 示例是猜的，用户要先能改再决定发不发。
const exampleList = computed(() => suggestExamples(props.host.groups));

/**
 * 元信息行的上下文水位。
 *
 * 判定本身在 `@/agent/usage`（那里有单测钉住分母缺失 / 已用为负 / 超过 100
 * 三种边界），这里只问一句「算不算得出来」—— 算不出来就整行不显示，
 * 而不是显示 0%（`usage.js` 的注释里有完整理由）。
 */
const contextPct = computed(() =>
  calcContextPercent(
    props.host.usage,
    Number(props.host.config && props.host.config.contextWindow) || 0
  )
);
const contextVisible = computed(() => contextPct.value !== null);
const contextOpen = ref(false);

/** 展开面板里的两行：水位（含估算说明）与 token 用量，文案键与圆环的 title 同源。 */
const contextHintLine = computed(() =>
  contextPct.value === null
    ? ''
    : t('workflow.agent.contextHint', {
        pct: contextPct.value,
        win: fmtTokens(Number(props.host.config.contextWindow) || 0),
      })
);
const usageLine = computed(() =>
  props.host.usage
    ? t('workflow.agent.usage', {
        in: fmtTokens(props.host.usage.input),
        out: fmtTokens(props.host.usage.output),
      })
    : ''
);

/**
 * 展开面板里的「新建会话」。
 *
 * host 上没有「原地清空当前会话上下文」的能力，最接近的就是 newSession —— 它开一条
 * 新会话、把当前这条留在历史里。副注（contextNewNote）在 UI 上把这层差异说清，
 * 所以按钮文案用 session.new 而不是编一个「清空上下文」。
 */
function startNewSession() {
  contextOpen.value = false;
  props.host.newSession();
}

// header 只剩这一个下拉（切换 / 用量 / 删除都在里面）
const sessionMenuOpen = ref(false);

// 只有存在 apiKey 才算配好了。没配就发消息，用户只会收到一句「请先配置」，
// 看起来像功能坏了 —— 所以入口要显眼，发送按钮直接禁用。
const configured = computed(() =>
  Boolean(props.host.config && props.host.config.apiKey)
);

/**
 * header 上那个 chip 显示什么。
 *
 * 与列表共用 sessions.js 的 sessionOptionLabel，所以 chip 与列表里的文案一致，
 * 不会出现「上面写 A、下面写 B」。
 */
const sessionLabel = computed(() => {
  const entry = props.host.sessions.find((s) => s.id === props.host.sessionId);

  if (!entry) return t('workflow.agent.session.placeholder');

  return sessionOptionLabel(entry, t('workflow.agent.session.untitled'));
});

/**
 * 面板被卸载前，先把挂着的确认门拒掉（backlog T-02）。
 *
 * 确认卡就渲染在这个组件里，而编辑器侧栏有三处 v-if 会把面板连同卡片一起
 * 卸载：切走助手面板（`sidebarPanel` 换成 details）、打开某个块的编辑卡
 * （`editState.editing` 优先级更高）、收起整个侧栏（`showSidebar`）。loop
 * 那侧正 await 着确认门的 promise —— 宿主 useAgentHost 的 onBeforeUnmount
 * 只在整个页面卸载时才触发，兜不住这种「面板被藏起来」：不在这儿发否，
 * 那一轮永不收尾、不落盘，用户看到的就是「助手卡死了」。
 *
 * 发出去的 false 走宿主的 answerConfirm（内部判空，重复发也安全），
 * loop 拿到「用户拒绝」的 error 观察值照常收尾。
 */
onBeforeUnmount(() => {
  if (props.host.pendingConfirm) props.host.answerConfirm(false);
});

// 设置放在项目的设置页里，不在面板上就地改：
// 一个 API Key 是全局的，不属于某一个工作流。
function goSettings() {
  props.host.goToSettings();
}

/**
 * 会话列表里选中一项。
 *
 * UiSelect 的 change emit 出去的是字符串 value，不是原生 DOM 事件 ——
 * 早先这里写 `$event.target.value`，取到 undefined 再读 .value 直接抛
 * TypeError，用户点了没有任何反应（切换入口等于不存在）。
 * 现在列表项 emit 的就是 id 本身，但空值仍然要挡掉。
 */
function onSelectSession(id) {
  if (!id) return;
  sessionMenuOpen.value = false;
  props.host.openSession(id);
}

/**
 * 删除指定会话。先收起下拉，否则确认弹窗叠在一个还开着的浮层上。
 * id 由列表每行的删除按钮带上来（不是「当前会话」）—— 见 AgentSessionList 注释。
 */
function onDeleteSession(id) {
  if (!id) return;
  sessionMenuOpen.value = false;
  props.host.deleteSession(id);
}

function send() {
  const text = draft.value.trim();
  if (!text || !configured.value) return;
  // busy 时也放行 —— 宿主会把它送进插话队列（P3）
  props.host.send(text);
  draft.value = '';
}

// —— / 模板菜单（T-81a）——
// 解析与过滤逻辑在 @/agent/customizations（纯函数，有单测）；这里只做接线。

const commands = ref([]);
const commandIndex = ref(0);
// Esc 关掉后到 draft 离开触发态之前不再自动弹出 —— 关了又弹等于关不掉
const slashDismissed = ref(false);

const slashQuery = computed(() => parseSlashDraft(draft.value));
const matchedCommands = computed(() =>
  filterCommands(commands.value, slashQuery.value || '')
);
const slashMenuOpen = computed(
  () =>
    slashQuery.value !== null &&
    !slashDismissed.value &&
    matchedCommands.value.length > 0
);
// 列表因继续输入变短时，高亮不能悬在已不存在的行上
const highlightIndex = computed(() =>
  Math.min(commandIndex.value, matchedCommands.value.length - 1)
);

watch(slashQuery, (q) => {
  slashDismissed.value = false;
  commandIndex.value = 0;
  // 触发时才拉列表：模板是低频配置数据，面板挂载不必预载；
  // 每次触发现读一次，设置页改完立即生效，无同步问题。
  if (q !== null) {
    loadCommands(configIO).then((list) => {
      commands.value = list;
    });
  }
});

function pickCommand(c) {
  if (!c) return;

  draft.value = c.body;
  slashDismissed.value = true; // 正文本身以 / 开头时不能让菜单又弹回来
}

/**
 * 输入框键盘路由。菜单开着时 ↑↓ 移高亮、回车选中、Esc 关闭；
 * 没开时回车 = 发送（与原 @keydown.enter.exact.prevent 等价：
 * 带修饰键的回车留给换行/浏览器默认行为）。
 */
function onDraftKeydown(e) {
  const plainEnter =
    e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;

  if (!slashMenuOpen.value) {
    if (plainEnter) {
      e.preventDefault();
      send();
    }

    return;
  }

  const n = matchedCommands.value.length;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const dir = e.key === 'ArrowDown' ? 1 : -1;

    commandIndex.value = (highlightIndex.value + dir + n) % n;
  } else if (e.key === 'Escape') {
    e.preventDefault();
    slashDismissed.value = true;
  } else if (plainEnter) {
    e.preventDefault();
    pickCommand(matchedCommands.value[highlightIndex.value]);
  }
}
</script>
