<template>
  <!--
    T-169：根容器按**宿主形态**分轴，不看视口宽度。
    宽宿主（独立助手页）横向：左 240px 是常驻历史，右边对话；
    窄宿主（编辑器侧栏）纵向：历史走「整块替换正文区」的视图切换。

    为什么是 host.layout 而不是 `md:` 断点：面板宽度取决于宿主，不取决于视口 ——
    侧栏能被拖到 800px 宽（[id].vue:431 下限 360、只能拖宽），独立助手页的窗口
    也能被拖到 400px 窄。用断点会在「拖宽的侧栏」上错误地长出左栏（正文被挤成
    一条），也会在「拖窄的独立页」上把左栏挤没（240+320 横向溢出）。
  -->
  <div class="flex h-full" :class="wide ? 'flex-row' : 'flex-col'">
    <!--
      左栏（仅宽宿主）：常驻历史。
      窄宿主不做这个 —— 320px 里再切 240px 给列表，对话区只剩 80px。
    -->
    <div
      v-if="wide"
      class="flex w-60 shrink-0 flex-col border-r border-gray-200 dark:border-gray-700"
      data-test="session-side"
    >
      <!-- 与右侧 header 同构（同样的 py-1 行 + py-1.5 内容），否则两栏顶边不齐 -->
      <div class="flex items-center gap-1.5 px-2 py-1">
        <span class="min-w-0 flex-1 truncate py-1.5 text-sm font-medium">
          {{ t('workflow.agent.session.history') }}
        </span>
      </div>

      <agent-session-list
        class="flex-1"
        :sessions="host.sessions"
        :current-session-id="host.sessionId"
        :model="host.config.model"
        :disabled="host.busy"
        @select="onSelectSession"
        @delete="onDeleteSession"
      />
    </div>

    <div class="flex min-w-0 flex-1 flex-col">
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
        <!--
        T-168：chat 视图下的会话 chip。**点它是「进历史视图」，不再是「打开一个
        下拉列表」** —— 会话历史需要浏览 + 搜索 + 管理，而浮层（max-h-[60vh]）
        装不下这些：它适合「临时选一个」，历史是「翻旧账 + 删」。
        箭头也跟着从 ▾ 改成 ▸：这个动作是「进入」，不是「展开」。
      -->
        <button
          v-if="!wide && view === 'chat'"
          type="button"
          class="group bg-box-transparent hover:bg-opacity-10 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
          :title="t('workflow.agent.session.placeholder')"
          data-test="open-history"
          @click="view = 'history'"
        >
          <v-remixicon
            name="riChatHistoryLine"
            class="shrink-0 text-gray-500 dark:text-gray-400"
          />
          <span class="min-w-0 flex-1 truncate text-sm">
            {{ sessionLabel }}
          </span>
          <!-- T-158：箭头只在 hover / 键盘 focus 时出现。320px 侧栏里这 20px
             等于标题多显示两三个字，而标题正是被 truncate 截断最狠的地方。 -->
          <v-remixicon
            name="riArrowRightSLine"
            class="shrink-0 text-gray-500 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 dark:text-gray-400"
          />
        </button>

        <!-- 历史视图的 header：返回 + 标题。新建按钮两个视图共用（在下面）。 -->
        <template v-else-if="!wide">
          <button
            type="button"
            class="hover:bg-box-transparent shrink-0 rounded-md px-1.5 py-1.5"
            :title="t('workflow.agent.session.history')"
            data-test="close-history"
            @click="view = 'chat'"
          >
            <v-remixicon name="riArrowLeftSLine" />
          </button>
          <span class="min-w-0 flex-1 truncate text-sm font-medium">
            {{ t('workflow.agent.session.history') }}
          </span>
        </template>

        <!--
          宽宿主：标题是**纯文本**。切换会话在左栏点一下就到了，这里再挂一个
          「进历史」的按钮等于给一个不存在的动作画入口（点了会跳到一个已经
          显示在屏幕上的列表）。
        -->
        <span v-else class="min-w-0 flex-1 truncate py-1.5 text-sm">
          {{ sessionLabel }}
        </span>

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
        v-if="!inHistory"
        class="flex-1"
        :events="host.events"
        :busy="host.busy"
        :groups="host.groups"
        :examples="exampleList"
        @retry="host.send($event)"
        @pick-example="draft = $event"
      />

      <!--
      T-168：历史视图 —— 正文区整块替换，而不是弹一层浮层。
      切视图不卸载 transcript 的数据（events 还在 host 上），回来不用重放；
      但 transcript 组件本身会被卸载重建，这是「整块替换」的代价，可接受
      （历史是低频操作，回来时滚动位置本来也该回到底部）。
      宽宿主走不到这里 —— 它的历史是左栏常驻（见 §session-side）。
    -->
      <agent-session-list
        v-else
        class="flex-1"
        :sessions="host.sessions"
        :current-session-id="host.sessionId"
        :model="host.config.model"
        :disabled="host.busy"
        @select="onSelectSession"
        @delete="onDeleteSession"
      />

      <!-- 下面这些只在对话视图里出现：历史视图下 composer 隐藏 ——
         这时候不该让人以为能打字。 -->
      <template v-if="!inHistory">
        <!-- 没配 API Key 时把入口摆在正中：
         这个状态下发消息只会回一句「请先配置」，让人以为功能坏了。 -->
        <!-- T-158：横幅压成一行（p-3 text-sm → px-2 py-1.5 text-xs，省约 16px）。
         它只需要说清「发送已禁用、去哪配」—— 发送按钮本身就 disabled 了，
         不需要用一整块的篇幅去重复这件事。
         T-172：配色从黄改红。它是**阻塞态**（功能不可用），不是一个提醒 ——
         黄在这里会让人以为「将就着也能用」。改红后与 error 同族（都表示
         「这事现在不成」），琥珀则收敛为单一语义「工具被你拒绝了」。 -->
        <div
          v-if="!configured"
          class="border-b border-red-300 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:border-red-700 dark:text-red-400"
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
      T-166：@ 菜单（选目标页）。与 / 菜单同一立场 —— 文档流内、输入框上方，
      不盖正文（T-06），面板高度不够时压缩的是 transcript。键盘导航整套复用
      onDraftKeydown 已有的 ↑↓ / Enter / Esc。

      目标页的**常驻 chip 不在这一行了**：它搬进了下面的 composer 卡片顶上
      （见 §form），从「面板底部又一行控件」变成「输入区里的一个附件」——
      Dia 的 composer 内 @ 与 Gemini 的 composer 左下角 + 都是这个结构。
    -->
        <div
          v-if="atMenuOpen"
          class="mx-2 mb-1 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
          data-test="at-menu"
        >
          <ul class="scroll max-h-48 overflow-y-auto py-1">
            <li v-for="(tab, i) in matchedTabs" :key="tab.id">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
                :class="i === atHighlight ? 'bg-box-transparent' : ''"
                @click="pickAtTab(tab)"
                @mousemove="atIndex = i"
              >
                <img
                  v-if="tab.favIconUrl"
                  :src="tab.favIconUrl"
                  class="h-4 w-4 shrink-0 rounded-sm"
                  :alt="t('workflow.agent.pickTab.faviconAlt')"
                />
                <v-remixicon
                  v-else
                  name="riEarthLine"
                  class="shrink-0 text-gray-400"
                />
                <span class="min-w-0 flex-1 truncate">{{
                  tab.title || tab.url
                }}</span>
                <span class="shrink-0 text-[10px] text-gray-400">
                  {{ t('workflow.agent.pickTab.window', { n: tab.windowId }) }}
                </span>
              </button>
            </li>
          </ul>
        </div>

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
          <!--
        T-166：composer 卡片。chip、输入框、底行共用一个边框 —— 目标页从「面板
        底部常驻的一行控件」变成「输入区里的一个附件」。省掉 chip 那一行约 30px，
        textarea 也从 256px 拿回全宽 288px（原结构里发送按钮与它并排抢宽）。
      -->
          <div
            class="rounded-lg border border-gray-200 px-2 py-1.5 dark:border-gray-700"
          >
            <agent-tab-picker
              class="mb-1"
              :target-tab="host.targetTab"
              :state="host.targetState"
              :pinned="host.targetPinned"
              :list-tabs="host.listTabs"
              @pick="host.pickTab($event)"
              @unpin="host.unpinTab()"
              @no-target="host.noTarget()"
            />

            <!--
              `!px-1 !py-1 !bg-transparent` 的感叹号不是随手写的：UiTextarea 根节点自带
              `px-4 py-2 bg-input`，而 Tailwind 生成的 CSS 按「工具组 + 刻度」排序 ——
              `.bg-input`(110753) 永远排在 `.bg-transparent`(96687) 之后，`.px-4` 永远排在
              `.px-1` 之后，同优先级下后来者赢。不加 `!` 的话这三项会被静默吃掉：
              左右各多 12px、上下各多 4px（量得出、看不出），以及输入区里多一块
              比卡片略深的矩形（黑 5% / 白 5%），把「一条边框包住整个输入区」的设计
              拆成「边框里又有个框」。项目里已有 `!px-3` / `!py-2` 的用法
              （SettingsEvents.vue / EditorDebugging.vue），沿用同一手法。
            -->
            <ui-textarea
              ref="draftEl"
              v-model="draft"
              autoresize
              class="w-full min-h-[60px] max-h-[128px] overflow-y-auto scroll scroll-xs border-0 !bg-transparent !px-1 !py-1"
              :placeholder="t('workflow.agent.placeholder')"
              @keydown="onDraftKeydown"
            />

            <!--
          底行（T-166）：@ 入口 + 水位 + 快捷键提示 + 发送。

          水位只在 >=80% 时出现（T-163），平时这一行只有 @ 与发送 —— 车道很空
          正是对的状态：没有坏事要汇报的时候，不该有东西占着视线。
        -->
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="shrink-0 rounded border border-gray-200 px-1.5 text-[11px] text-gray-500 hover:bg-box-transparent dark:border-gray-700 dark:text-gray-400"
                :title="t('workflow.agent.pickTab.attach')"
                :aria-label="t('workflow.agent.pickTab.attach')"
                data-test="at-trigger"
                @click="startAtMenu"
              >
                @
              </button>

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

                <!-- 明细：水位 + 用量 + 「新建会话」。两行文案复用 contextHint /
               usage 两个既有键（圆环的 title 也是它们），不另造一套说法。 -->
                <div class="p-2 text-xs text-gray-700 dark:text-gray-200">
                  <p>{{ contextHintLine }}</p>
                  <p class="mt-1">{{ usageLine }}</p>
                  <!-- T-163：完整那句「上下文将满，建议新建会话」从行内搬到这里 ——
                 行内改挂两个字的短词，整句会把底行挤换行。 -->
                  <p
                    v-if="contextCritical"
                    class="mt-1 text-red-500 dark:text-red-400"
                  >
                    {{ t('workflow.agent.contextCritical') }}
                  </p>
                  <hr class="my-2 border-gray-200 dark:border-gray-700" />
                  <button
                    type="button"
                    class="hoverable flex w-full items-center gap-1.5 rounded px-1 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="host.busy"
                    :title="
                      host.busy
                        ? t('workflow.agent.session.busyHint')
                        : undefined
                    "
                    @click="startNewSession"
                  >
                    <v-remixicon name="riAddLine" class="shrink-0" />
                    <span class="min-w-0 flex-1">{{
                      t('workflow.agent.session.new')
                    }}</span>
                  </button>
                  <p
                    class="px-1 pt-0.5 text-[11px] text-gray-500 dark:text-gray-400"
                  >
                    {{ t('workflow.agent.contextNewNote') }}
                  </p>
                </div>
              </agent-dropdown>

              <!-- T-166：这一句从「元信息行」搬到了底行。没配 API Key 时照样隐藏 ——
             发送已禁用，教人按 Enter 没有意义（重设计里省下的那 22px 就是它）。 -->
              <span
                v-if="configured"
                class="ml-auto min-w-0 truncate text-[11px] text-gray-400 dark:text-gray-500"
              >
                {{
                  host.busy
                    ? t('workflow.agent.interjectHint')
                    : t('workflow.agent.inputHint')
                }}
              </span>

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

              <!--
                T-160：title 挂在**外层 span** 上，不是按钮上。
                按钮 disabled 时带 pointer-events-none，鼠标事件根本不落到它身上，
                挂在它上面的 title 永远弹不出来（T-11 已在会话列表里踩过这条）。
                span 不是 disabled 元素，事件正常，title 才说得出原因。
              -->
              <span
                v-else
                class="flex shrink-0"
                :title="sendTitle"
                data-test="send-wrap"
              >
                <ui-button
                  variant="accent"
                  icon
                  type="submit"
                  :disabled="!canSend"
                  :aria-label="t('workflow.agent.send')"
                >
                  <v-remixicon name="riArrowRightLine" class="shrink-0" />
                </ui-button>
              </span>
            </div>
          </div>
        </form>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { sessionOptionLabel } from '@/agent/sessions';
import { suggestExamples } from '@/agent/examples';
// 元信息行要问「水位算不算得出来」与格式化 token 数：判定与格式化都在纯模块里
// （有单测），组件只消费结果 —— .vue 里写的分支一条都测不到。
import {
  CONTEXT_CRITICAL_AT,
  CONTEXT_WARN_AT,
  contextPercent as calcContextPercent,
  fmtTokens,
} from '@/agent/usage';
import { configIO } from '@/agent';
import {
  filterCommands,
  loadCommands,
  parseSlashDraft,
} from '@/agent/customizations';
import {
  filterTabs,
  parseAtDraft,
  stripAtToken,
  tabPickPayload,
} from '@/agent/at';
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

/**
 * 环要不要出现（T-163）：算得出来 **且** 到了提示档。
 *
 * 与 AgentContextRing 内部的 visible 是同一个条件（同一份常量），各挡一次是
 * 有意的：这里挡的是「别渲染一个空的 dropdown」—— 环整段不渲染时 trigger 位
 * 置会剩一个空按钮；组件里那道挡的是「环自己出不出来」，也是渲染测试唯一能
 * 够到的地方（`agent-dropdown` 在 sfc-render 里是 slot 不渲染的桩，环挂在它
 * 的 trigger slot 里，从面板这一层根本断言不到）。
 */
const contextVisible = computed(
  () => contextPct.value !== null && contextPct.value >= CONTEXT_WARN_AT
);
const contextCritical = computed(
  () => contextPct.value !== null && contextPct.value >= CONTEXT_CRITICAL_AT
);
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

/**
 * 面板当前的视图（T-168）：'chat' 对话 / 'history' 会话历史。
 *
 * 窄宿主（320px 侧栏）下历史是**整块替换正文区**，不是弹一层浮层 —— 浮层适合
 * 「临时选一个」，历史需要浏览 + 搜索 + 管理。宽宿主走左栏常驻，不切视图
 * （见 layout）。
 */
const view = ref('chat');

/**
 * T-169：宿主形态。'wide' 时历史是左栏常驻（不做视图切换），否则是视图切换。
 *
 * 只认 host.layout：**不许退回窗口宽度断点**。宿主形态是宿主声明的事实，
 * 面板宽度与视口宽度没有对应关系（侧栏可拖宽、独立页窗口可拖窄）。
 * 宿主没声明时按 narrow 兜底 —— 窄是更保守的那个（不占常驻横向空间）。
 */
const wide = computed(() => props.host.layout === 'wide');

/**
 * 正文区当前显示的是历史而不是对话。
 *
 * 宽宿主恒为 false：它的历史在左栏，正文区永远是对话，composer 也永远在。
 */
const inHistory = computed(() => !wide.value && view.value === 'history');

// 只有存在 apiKey 才算配好了。没配就发消息，用户只会收到一句「请先配置」，
// 看起来像功能坏了 —— 所以入口要显眼，发送按钮直接禁用。
const configured = computed(() =>
  Boolean(props.host.config && props.host.config.apiKey)
);

/**
 * T-160：发送按钮为什么点不动，要说得出原因。
 *
 * 原先按钮上挂着恒定的 title「发送」—— disabled 之后这句仍然在说功能名，
 * 用户看到的是「有按钮但不给理由」（和 T-11 同一类问题：T-11 只在会话列表与
 * 新建按钮上贯彻了，发送按钮漏了）。
 *
 * 更要命的是 UiButton 在 disabled 时还加了 `pointer-events-none`
 * （见 `src/components/ui/UiButton.vue` 的 class 绑定）—— 元素**完全不接收**
 * 鼠标事件，title 根本不可能弹出来。所以必须照 T-11 的做法，把 title 挂到
 * **非 disabled 的包裹层**（AgentSessionList.vue:17-18 的注释里有这条经验的原文）。
 *
 * 两种原因分开说：没配 Key 是环境问题（要去设置），空草稿只是还没打字。
 */
const canSend = computed(() => Boolean(draft.value.trim()) && configured.value);
const sendTitle = computed(() => {
  if (!configured.value) return t('workflow.agent.sendBlockedNoKey');
  if (!draft.value.trim()) return t('workflow.agent.sendBlockedEmpty');
  return t('workflow.agent.send');
});

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
  // 选中即回对话视图：用户要的是「打开这条会话」，历史列表只是通往它的路
  view.value = 'chat';
  props.host.openSession(id);
}

/**
 * 删除指定会话。先收起下拉，否则确认弹窗叠在一个还开着的浮层上。
 * id 由列表每行的删除按钮带上来（不是「当前会话」）—— 见 AgentSessionList 注释。
 */
function onDeleteSession(id) {
  if (!id) return;
  // 删完留在历史里继续翻：删除是浏览过程中的动作，不是「选一条」的替代品
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

// —— @ 目标页菜单（T-166）——
// 解析、过滤、载荷形状全在 @/agent/at（纯函数，有单测）；这里只做接线。

const draftEl = ref(null);
const atGroups = ref([]);
const atIndex = ref(0);
// 与 slashDismissed 同一件事：Esc 关掉之后，到 draft 离开触发态之前不再自动弹
const atDismissed = ref(false);

/**
 * 光标处的 @ token。**不传 caret**（按草稿末尾算）：边打边筛的场景里光标本来
 * 就在末尾，而跟踪 selectionStart 要在 textarea 上挂额外的事件监听；
 * parseAtDraft 的 caret 参数留着，等真要做「光标停在句中」那天直接用。
 */
const atToken = computed(() => parseAtDraft(draft.value));
const atActive = computed(() => atToken.value !== null);

// 展平成一维才能用 ↑↓ 高亮；windowId 由分组补上（列表项自己有时不带）
const matchedTabs = computed(() =>
  filterTabs(atGroups.value, atToken.value ? atToken.value.query : '').flatMap(
    (g) => (g.tabs || []).map((tab) => tabPickPayload(tab, g.windowId))
  )
);
const atHighlight = computed(() =>
  Math.min(atIndex.value, matchedTabs.value.length - 1)
);

/**
 * 开合条件。
 *
 * `/` 优先：它是「整框以 / 开头」的**整框态**，语义强于词内的 @。两者在形状上
 * 本就不重叠（`/@` 里 @ 的前面是 `/` 不是空白，parseAtDraft 不认它），这里再
 * 显式挡一次，免得以后改任一侧的判定时撞车。
 */
const atMenuOpen = computed(
  () =>
    atActive.value &&
    !atDismissed.value &&
    !slashMenuOpen.value &&
    matchedTabs.value.length > 0
);

/** 进入触发态才拉一次 —— 与标签页下拉同一立场：打开时才读，列表随时会变。 */
watch(atActive, (on) => {
  if (!on) return;

  atDismissed.value = false;
  atIndex.value = 0;

  Promise.resolve()
    .then(() => props.host.listTabs())
    .then((list) => {
      atGroups.value = Array.isArray(list) ? list : [];
    })
    .catch(() => {
      // 读不出来就当没有可选项：菜单本来就有「为空不弹」这条
      atGroups.value = [];
    });
});

/** 底行那个 @ 按钮：把把手补进草稿，焦点交回输入框 —— 接下来就是打字筛选。 */
function startAtMenu() {
  const needSpace = draft.value.length > 0 && !/\s$/.test(draft.value);
  draft.value += needSpace ? ' @' : '@';
  atDismissed.value = false;

  const el = draftEl.value && draftEl.value.textarea;
  if (el && el.focus) el.focus();
}

/**
 * 选中目标页。
 *
 * 与 `/` 不同：@ 的副作用是**改目标页**，正文里那个 `@淘宝` 只是输入时的把手，
 * 摘掉再发 —— 留着会把一串「@淘宝」一起送进模型。
 */
function pickAtTab(tab) {
  if (!tab) return;

  props.host.pickTab(tab);
  draft.value = stripAtToken(draft.value, atToken.value);
  atDismissed.value = true;
}

/**
 * 输入框键盘路由。菜单开着时 ↑↓ 移高亮、回车选中、Esc 关闭；
 * 没开时回车 = 发送（与原 @keydown.enter.exact.prevent 等价：
 * 带修饰键的回车留给换行/浏览器默认行为）。
 */
function onDraftKeydown(e) {
  // 输入法组合期间的按键不是最终文本：中文输入法下 `@` 可能还停在候选状态，
  // 这时就判定会让菜单闪一下再消失 —— compositionend 才是文本落定的时刻。
  if (e.isComposing) return;

  const plainEnter =
    e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;

  // / 优先（T-166 的互斥规则）：整框态强于词内的 @
  if (!slashMenuOpen.value) {
    if (atMenuOpen.value) {
      const n = matchedTabs.value.length;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;

        atIndex.value = (atHighlight.value + dir + n) % n;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        atDismissed.value = true;
      } else if (plainEnter) {
        e.preventDefault();
        pickAtTab(matchedTabs.value[atHighlight.value]);
      }

      return;
    }

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
