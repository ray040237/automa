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
  <!--
    观感（T-213）：面板根统一 bg-canvas，不再按宿主壳色分档。
    T-212 曾让浏览器侧栏宿主走"透明 + 父级铺 bg-shell"，想让面板与 chrome
    续成一整块；但代价是把底色家族劈成两套（shell 一套、canvas/surface/field
    一套），顶栏降层后还要多垫一层过渡。现在删掉 shell，面板根自画 canvas，
    内部仍走 surface/field 三层，暗色由 :root.dark 接管。
    `dark:` 不在这里用 —— 主题深浅由 :root.dark 决定。
  -->
  <div
    class="flex h-full bg-canvas text-fg-1"
    :class="[wide ? 'flex-row' : 'flex-col']"
  >
    <!--
      左栏（仅宽宿主）：常驻历史。
      窄宿主不做这个 —— 320px 里再切 240px 给列表，对话区只剩 80px。
    -->
    <div
      v-if="wide"
      class="flex w-60 shrink-0 flex-col border-r border-line"
      data-test="session-side"
    >
      <!-- T-213：左栏 header 的总高度必须与右侧那次两行 header 相同，
           否则两栏的 border-b 不在一条水平线上，一眼就能看出错位。
           右侧行 1 = py-1.5 (12px) + 36px 标题钮 = 48px；
           行 2 = AgentTabPicker 的 26px + mb-2 (8px) = 34px；合计 82px。
           （2026-10-10 用户反馈「header 太挤」，行 1 从 py-1/36px 放到
           py-1.5/36px 标题钮 py-2，高度随之 74 → 82px。）
           这里用一个 min-h-[82px] 的容器 + 底对齐，让「历史会话」四个字
           落在行 1 的垂直中线上，与右侧标题同高。
           T-208：底色仍走 canvas（T-213 降层后与右侧一致）；
           T-187：px-4 与右侧同一条左边缘。 -->
      <div
        class="flex min-h-[82px] items-center gap-1.5 border-b border-line bg-canvas px-4"
      >
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

    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <!--
      T-213：header 拆成两行。
        行 1 = 会话入口 + 标题 + 新建。会话入口是个 28px 的图标按钮（不再是
               占满左半边的 chip），标题居中区可点 —— 点开是会话下拉（切换 /
               删除 / 进全部历史），所以「会话管理」不再单独占一行。
        行 2 = 标签页切换（整行宽 chip，见 AgentTabPicker）。

      底色用 canvas 而不是 surface（T-213 降层）：header 是"容器的一部分"，
      不是"浮在上面的条"。参考实现 pie-ai-agent 的 TopBar 也是 bg-canvas +
      border-b。原先抬到 surface 之后，canvas→surface→field 三层里 header
      与 composer 同为 surface，顶底两头重、中间轻，反而看不出层次。

      横向仍是 px-4（T-187 的统一左边缘），但两行各自收一点的右侧留白，
      让 + 按钮与右边缘的呼吸与下面 composer 的卡对齐。
    -->
      <div class="shrink-0 border-b border-line bg-canvas">
        <!-- 行 1：标题 / 新建。
             2026-10-10：撤掉左侧的历史入口图标与它打开的「历史视图」——
             T-213 让标题本身成了会话下拉（列表就在里面，全部会话可滚可删），
             再保留一个跳到整页列表的入口就是同一份列表的第二张脸（用户实证：
             「这个页面其实没有用了」）。窄宿主的会话浏览、切换、删除全部
             收进标题下拉一处。 -->
        <div class="flex items-center gap-2 px-4 py-1.5">
          <!--
          T-213：标题即会话下拉。
          点标题弹出会话列表（切换 / 删除 / 看全部），所以标题必须看起来
          「可点」：hover 出淡底 + 右侧箭头淡入并翻转，is-open 时保持底色。
          箭头常态 opacity-0 —— 320px 里这 12px 等于标题多显示一两个字，
          而标题正是被截断最狠的地方。
        -->
          <agent-dropdown
            v-model="titleOpen"
            align="left"
            width="w-72"
            class="min-w-0 flex-1"
          >
            <template #trigger>
              <button
                type="button"
                class="titlebar group flex min-w-0 w-full items-center gap-1 rounded-chip bg-box-transparent px-2.5 py-2 text-left transition duration-fast ease-panel hover:bg-field"
                :class="titleOpen ? 'bg-field' : ''"
                data-test="session-title"
              >
                <span class="min-w-0 flex-1 truncate text-sm">
                  {{ sessionLabel }}
                </span>
                <v-remixicon
                  name="riArrowDownSLine"
                  size="14"
                  class="chev shrink-0 text-fg-3 opacity-0 transition duration-fast ease-panel group-hover:opacity-100"
                  :class="titleOpen ? 'rotate-180 opacity-100' : ''"
                />
              </button>
            </template>

            <!-- 会话下拉：列表复用 AgentSessionList 的密度与两行式，
                 底部一行进「全部历史会话」。 -->
            <div class="max-h-[60vh] overflow-y-auto scroll scroll-xs py-1">
              <p
                class="px-3 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-fg-3"
              >
                {{ t('workflow.agent.session.switchTitle') }}
              </p>
              <agent-session-list
                mode="popover"
                :sessions="host.sessions"
                :current-session-id="host.sessionId"
                :disabled="host.busy"
                @select="onPickSession"
                @delete="onDeleteSession"
              />
            </div>
          </agent-dropdown>

          <!-- T-11：busy 时 title 换成「为什么点不动」。原先 title 恒是「新建会话」，
             disabled 之后这句仍然在说功能名，用户看到的是「有按钮但不给理由」。 -->
          <button
            type="button"
            class="grid h-7 w-7 shrink-0 place-items-center rounded-chip bg-box-transparent text-fg-2 transition duration-fast ease-panel hover:bg-field hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-2"
            :disabled="host.busy"
            :title="
              host.busy
                ? t('workflow.agent.session.busyHint')
                : t('workflow.agent.session.new')
            "
            data-test="new-session"
            @click="host.newSession()"
          >
            <v-remixicon name="riAddLine" size="16" class="shrink-0" />
          </button>
        </div>

        <!-- 行 2：标签页切换（整行宽 chip）。只在已配置时渲染。 -->
        <agent-tab-picker
          v-if="configured"
          class="mx-4 mb-2"
          :target-tab="host.targetTab"
          :state="host.targetState"
          :pinned="host.targetPinned"
          :list-tabs="host.listTabs"
          @pick="host.pickTab($event)"
          @unpin="host.unpinTab()"
          @no-target="host.noTarget()"
        />
      </div>

      <!-- T-04：错误卡上的「重试」把出错那一轮的原文交回宿主重发。
         刻意不碰 draft —— 用户可能正在打下一句，替他清空是越权。 -->
      <!--
        T-207：没配 API Key 时，正文区整块换成引导页 —— **composer 根本不渲染**。

        原先的做法是保留输入框 + 顶部一条红色横幅，发送按钮 disabled。问题是：
        用户面对一个能打字、能按回车、但永远发不出去的输入框，要读完那条小字
        才明白「不是坏了，是没配」。这是把「环境没准备好」这件事说成了一个小提示。

        空态（没有消息时）本来就做对了这件事 —— 居中、说明、给示例。缺配置
        只是同一个问题的更前置版本：连「这里能问什么」都还轮不到，得先能问。
        所以走同一种形态：整块居中 + 一个明确的动作。

        顺带解决 T-203 —— 用户配置成功后横幅消失、面板里再没有进设置的路。
        现在引导页本身就是设置入口，且它是「缺配置」这一状态的唯一形态，
        不存在「入口在自己消失」的问题。

        配置好的用户完全看不到这一支（`configured` 为真时下面的 transcript
        照常渲染），不会因为这条改动少任何一个像素。
      -->
      <div
        v-if="!configured"
        class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        data-test="not-configured-guide"
      >
        <v-remixicon name="riKey2Line" size="16" class="text-fg-3" />
        <p class="text-sm font-medium">
          {{ t('workflow.agent.notConfigured') }}
        </p>
        <p class="max-w-[260px] text-xs text-fg-2">
          {{ t('workflow.agent.notConfiguredHint') }}
        </p>
        <ui-button
          variant="accent"
          data-test="not-configured-cta"
          class="text-accent"
          @click="goSettings"
        >
          {{ t('workflow.agent.goSettings') }}
        </ui-button>
      </div>

      <!--
        2026-10-10：撤掉窄宿主的「历史视图」（原 v-else-if="inHistory" 一整块
        agent-session-list）。T-213 让标题成了会话下拉之后，这个整页列表与
        下拉是同一份数据的两张脸（用户实证「重复了、没有用了」）；它的搜索框
        也没什么可搜的 —— 下拉里的列表本就只有几条。窄宿主的会话浏览、切换、
        删除全部收进标题下拉。宽宿主不受影响：左栏是常驻栏，不是这个视图。
      -->

      <!-- T-10：空态要告诉用户「这里能问什么」与「这个宿主开了什么」。
         groups / 示例都从 host.groups 推导，组件自己不含任何能力知识。 -->
      <agent-transcript
        v-else
        class="flex-1"
        :events="host.events"
        :busy="host.busy"
        :groups="host.groups"
        :examples="exampleList"
        @retry="host.send($event)"
        @pick-example="draft = $event"
      />

      <!-- 确认门 / 模板菜单 / composer 只在已配置时出现（引导页已经把话说完了）。 -->
      <template v-if="configured">
        <!-- 确认门放在流内、输入框上方，而不是 absolute 浮层：
         浮层会盖住输入区与发送按钮，往回翻历史时还一直悬着（T-06）。
         这里是文档流，面板高度不够时压缩的是 transcript，输入框永远点得到。 -->
        <agent-confirm-card
          v-if="host.pendingConfirm"
          class="mx-4 mb-3"
          :confirm="host.pendingConfirm"
          @answer="host.answerConfirm($event)"
        />

        <!--
      T-177：这里原先还有一个 `@` 菜单（词内态，`帮我对一下 @淘宝`）。它是
      「换目标页」的**第二个入口** —— 与 composer 顶部那个 chip 下拉做同一件事，
      而且自己又渲染了一份标签页列表（与 AgentTabList 重复）。已整块删除：
      换页只留 chip 下拉一处。

      删除理由（不改回）：@ 选中后会把 `@淘宝` 从草稿里**摘掉**，正文不留任何
      痕迹 —— 形似「在句子里引用某页」，实为「悄悄改一个设置项」，且它展开的
      列表连「当前项是哪个」都不标。两处入口 + 两套列表 + 一处可见状态显示，
      收益只有「打字过滤」一条，不值。
    -->

        <!-- / 模板菜单（T-81a）：draft 以 / 开头时出现。放文档流里不盖正文，
         与确认卡同一立场（T-06）。回车/点击选中后整框替换为模板正文。 -->
        <div
          v-if="slashMenuOpen"
          class="mx-4 mb-1 rounded-card border border-line bg-surface shadow-sm"
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
          class="mx-4 mb-1 flex items-center gap-1 text-xs text-fg-2"
          data-test="pending-interjections"
        >
          <v-remixicon name="riStackLine" size="14" class="shrink-0" />
          {{
            t('workflow.agent.queuedPending', {
              n: host.pendingInterjections,
            })
          }}
        </p>

        <!--
          T-204：composer 上方的渐隐层。
          消息滚到输入区边界时是被一条 1px 实线切断的，看不出下面还有内容继续
          溢出 —— 尤其窄面板（320px）里那种「卡住了」的观感更明显。
          20px 高的渐变把硬切变成溶解：内容滚过去时颜色逐渐融进面板底色，
          「还有内容」这件事自己浮现，不用加任何提示文字。

          `-top-5` 是负偏移，让它悬在 composer 边界**上方**（盖住最后几像素的
          消息），`pointer-events-none` 保证不挡滚动与文本选择，
          `from-canvas` 取自面板底色（T-208 后正文区是 canvas 面）。
        -->
        <div
          class="pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-t from-canvas to-transparent"
          aria-hidden="true"
          data-test="composer-fade"
        />

        <form class="relative shrink-0 px-4 pb-2.5 pt-0" @submit.prevent="send">
          <!--
        T-213：删掉 composer 顶部的「Enter 发送 · Shift+Enter 换行」提示行。
        它是常驻的一行灰字，而信息本身只在**用户还没学会之前**有用 ——
        同一句在会话开始时讲一次就够，占着 14px 的常驻高度讲一辈子是浪费。
        现在这句话挂到发送键的 `title` 上（见底行 send-wrap），hover 才出现。
        代价：高度省 14px；收益：composer 顶边干净，卡片直接接在 fade 层下面。

        T-213：composer 卡片改成**凹陷面**（bg-field + border-line）。
        T-209/T-212 走的是「浮起」（bg-surface 无边框），但那让面板底 → 卡片
        也是 canvas → surface 的**升**，而卡片里的输入区又是 field 的**降**，
        一条竖线上出现「升→降」两次转折。改成凹陷之后：
          - 面板底 = canvas（最高）
          - composer = field（凹进去）
          - 输入区 = 透明（融进卡片的凹面，不再叠第三层）
        「输入区」不再是另一个矩形，而是卡片凹陷面里的一块空处 ——
        这正是参考实现 pie 的 Composer 形态（rounded-card border bg-field）。
        focus 时卡片的边转 accent，是「这里正在接收输入」的唯一强信号。
      -->
          <div
            class="rounded-card border border-line bg-field p-1.5 transition duration-fast ease-panel focus-within:border-accent"
          >
            <!--
              `!px-1 !py-1` 的感叹号不是随手写的：UiTextarea 根节点自带
              `px-4 py-2 bg-input`，而 Tailwind 生成的 CSS 按「工具组 + 刻度」排序 ——
              `.bg-input` 永远排在后面的工具组之后，`.px-4` 永远排在 `.px-1` 之后，
              同优先级下后来者赢。不加 `!` 的话这两项会被静默吃掉：
              左右各多 12px、上下各多 4px（量得出、看不出）。
              项目里已有 `!px-3` / `!py-2` 的用法（SettingsEvents.vue /
              EditorDebugging.vue），沿用同一手法。
              T-213：底色改回 `!bg-transparent` —— 卡片本身已经是 field 凹陷面，
              输入区再铺一层 field 等于同一个面画两次，看不出分层；透明之后
              「输入区」与卡片是同一个面，凹感由卡片整体提供。
              同时 `focus:!ring-0`：全局那条
              `input/textarea:focus { ring-2 ring-accent }` 会在卡片已经有
              focus-within 描边的情况下再套一圈内描边，两道线套在一起。

              2026-10-10 用户反馈「输入框留的位置太大」：未激活时收成**一行**，
              聚焦或有草稿再撑回 56px。实现踩在一个细节上 —— UiTextarea 开着
              autoresize，它会往元素上写**内联 height**（= scrollHeight），
              所以「一行」不能靠 h-9 这类 class（内联样式会盖掉它），而要靠
              **撤掉 min-h**：min-h-[56px] 一拿掉，内联 height 就是空内容的
              自然行高（约 32px）＝一行；min-h-[56px] 一加回，min-height 压过
              内联 height，自动撑开 —— 两条路都不用碰组件。状态是
              composerActive = 聚焦 ‖ 有草稿：失焦但留着字时保持撑开，
              否则删到一半时输入框突然塌掉很吓人。

              2026-10-10 再补：`resize-none` 收掉右下角的原生拖拽把手 ——
              高度已经由「塌缩/撑开 + autoresize」接管，手动拉伸和它打架
              （拉大之后 min-h-0 塌不回去、拉小又把激活态的 56px 废掉）。
              全局有条 `textarea { resize: vertical }` 基础规则，但那是元素
              选择器，类选择器天然赢它，不用加 `!`。
            -->
            <ui-textarea
              v-model="draft"
              autoresize
              class="w-full resize-none max-h-[128px] overflow-y-auto scroll scroll-xs !transition-[min-height] !duration-base !ease-panel !rounded-control !bg-transparent !px-2 !py-1.5 focus:!ring-0"
              :class="composerActive ? 'min-h-[56px]' : 'min-h-0'"
              :placeholder="t('workflow.agent.placeholder')"
              @focus="composerFocus = true"
              @blur="composerFocus = false"
              @keydown="onDraftKeydown"
            />

            <!--
          底行（T-213）：模型芯片 ——— flex-1 撑开 ——— 水位圆环 + 发送。

          **`flex-1` 那个空 div 是关键**：没有它时所有控件挤在左边，右侧留一大片
          空白（Automa 现状就是这样）；参考实现 pie 在这一行插了一个 flex-1，
          把圆环与发送键推到右边。这是本条里最容易看得出差别的一处。
        -->
            <div class="flex items-center gap-2">
              <!-- T-201 / T-213：模型选择器。放在最左（flex-1 之前），
                   芯片只剩等宽模型名 + 箭头，不带服务商图标（用户拍板）。 -->
              <agent-model-picker
                v-if="configured"
                class="min-w-0 shrink"
                :model="host.config.model"
                :provider="host.config.provider"
                :locked="host.busy"
                :catalog="host.modelCatalog"
                @pick="host.setModel($event)"
              />

              <!-- T-213：这个空 div 把右半边推开 —— 见上面注释。 -->
              <div class="flex-1" />

              <agent-dropdown
                v-if="contextVisible"
                v-model="contextOpen"
                align="right"
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
                <div class="p-2 text-xs text-fg-2">
                  <p>{{ contextHintLine }}</p>
                  <p class="mt-1">{{ usageLine }}</p>
                  <!-- T-163：完整那句「上下文将满，建议新建会话」从行内搬到这里 ——
                 行内改挂两个字的短词，整句会把底行挤换行。 -->
                  <p v-if="contextCritical" class="mt-1 text-danger">
                    {{ t('workflow.agent.contextCritical') }}
                  </p>
                  <hr class="my-2 border-line" />
                  <button
                    type="button"
                    class="hoverable flex w-full items-center gap-1.5 rounded-chip px-1 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="host.busy"
                    :title="
                      host.busy
                        ? t('workflow.agent.session.busyHint')
                        : undefined
                    "
                    @click="startNewSession"
                  >
                    <v-remixicon name="riAddLine" size="14" class="shrink-0" />
                    <span class="min-w-0 flex-1">{{
                      t('workflow.agent.session.new')
                    }}</span>
                  </button>
                  <p class="px-1 pt-0.5 text-[11px] text-fg-2">
                    {{ t('workflow.agent.contextNewNote') }}
                  </p>
                </div>
              </agent-dropdown>

              <!--
          发送 / 停止共用同一个图标按钮位（T-159 + 重设计）：
          - 空闲：→ 发送
          - 忙碌：■ 停止生成；**插话改由 Enter 提交** —— 输入框忙碌时仍可打字，
            send() 本来就放行插话队列（P3），排队的条数由上方常驻提示行报。
          原先忙碌时是「■ 停止 + 插话」两个按钮并排，8px gap 全从 textarea 身上扣，
          320px 侧栏里 textarea 只剩 144px（headless Chromium 实测），而忙碌恰恰是
          最要打字的时刻。合并成一个按钮位后，忙碌与空闲的 textarea 宽度一致。

          T-213：从 40px（ui-button icon 的 h-10）收到 32px。
          40px 是「主按钮」的量级；在一条 32px 高的底行里它比整行还高，
          把行撑起来、也把圆环衬得很小。现在两者同高，一行读齐。
        -->
              <!--
                T-200：停止是**两段式**（参考实现 sidepanel 的做法）。

                忙碌时这个按钮位正好在手指下面，而误杀一个跑了半分钟的任务代价
                很高 —— 一次点击就 abort 太便宜了。现在第一次点/按 Esc 只是
                armed：按钮变浓色、文案换成「再按一次停止」，2 秒内第二次才真的
                abort；超时自动解除，不会一直停在 armed 上骗人。
              -->
              <ui-button
                v-if="host.busy"
                :variant="stopArmed ? 'accent' : 'default'"
                icon
                type="button"
                class="!h-8 !w-8 !p-0"
                :title="stopTitle"
                :aria-label="stopTitle"
                data-test="stop-button"
                @click="requestStop"
              >
                <v-remixicon name="riStopLine" size="18" class="shrink-0" />
              </ui-button>

              <!--
                T-160：title 挂在**外层 span** 上，不是按钮上。
                按钮 disabled 时带 pointer-events-none，鼠标事件根本不落到它身上，
                挂在它上面的 title 永远弹不出来（T-11 已在会话列表里踩过这条）。
                span 不是 disabled 元素，事件正常，title 才说得出原因。
                T-213：原先这里还有「Enter 发送」提示行，现在整句并进 title ——
                提示行的 14px 常驻高度换成 hover 才付费。
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
                  class="!h-8 !w-8 !p-0"
                  :disabled="!canSend"
                  :aria-label="t('workflow.agent.send')"
                >
                  <v-remixicon
                    name="riArrowRightLine"
                    size="18"
                    class="shrink-0"
                  />
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
import AgentTranscript from './AgentTranscript.vue';
import AgentTabPicker from './AgentTabPicker.vue';
import AgentSessionList from './AgentSessionList.vue';
import AgentDropdown from './AgentDropdown.vue';
import AgentConfirmCard from './AgentConfirmCard.vue';
import AgentContextRing from './AgentContextRing.vue';
import AgentModelPicker from './AgentModelPicker.vue';

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

// 2026-10-10「输入框留得太大」反馈：composer 的展开态。
// 聚焦 **或** 已有草稿都算激活 —— 只判聚焦的话，失焦瞬间（比如点底行的
// 圆环）多行草稿会当场塌成一行；只判草稿的话，点进来还没打字时没有
// 「撑开迎接输入」的动作。两个条件取或，塌缩只发生在「失焦且已清空」。
const composerFocus = ref(false);
const composerActive = computed(
  () => composerFocus.value || draft.value.trim().length > 0
);

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
 * T-169：宿主形态。'wide' 时历史是左栏常驻，否则没有常驻历史。
 *
 * 只认 host.layout：**不许退回窗口宽度断点**。宿主形态是宿主声明的事实，
 * 面板宽度与视口宽度没有对应关系（侧栏可拖宽、独立页窗口可拖窄）。
 * 宿主没声明时按 narrow 兜底 —— 窄是更保守的那个（不占常驻横向空间）。
 *
 * 2026-10-10：原先窄宿主还有一套 view 切换（'chat' / 'history'）—— T-213
 * 让标题成了会话下拉之后，历史视图与下拉是同一份列表的两张脸（用户实证
 * 「重复了、没有用了」），连同入口图标一起撤掉。窄宿主的会话浏览、切换、
 * 删除全部走标题下拉；宽宿主继续走左栏常驻。
 */
const wide = computed(() => props.host.layout === 'wide');

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

/**
 * T-213：快捷键那句话说在 title 的第二行。
 *
 * 原先它是 composer 顶部一条常驻的灰字行，值 14px 的**永久**高度；而这句话
 * 只在用户还没学会之前有用。现在并进 title —— 想知道的人 hover 一下就有，
 * 已经会了的人不必每天看它。
 *
 * 忙碌时用 interjectHint 而不是 inputHint：那时候 Enter 进的是插话队列，
 * 照实说 —— 沿用「发送」会让用户以为点下去会打断当前这一轮。
 */
const hintLine = computed(() =>
  props.host.busy
    ? t('workflow.agent.interjectHint')
    : t('workflow.agent.inputHint')
);

const sendTitle = computed(() => {
  // 提示那句话**恒定**在 title 里，两种"点不动"的原因加在前面。
  // 反过来写（只在可发送时带提示）会让空草稿这个最常见的状态反而看不到
  // 「怎么把话送出去」—— 而那正是用户最需要知道的时候。
  let why = t('workflow.agent.send');
  if (!configured.value) why = t('workflow.agent.sendBlockedNoKey');
  else if (!draft.value.trim()) why = t('workflow.agent.sendBlockedEmpty');

  return [why, hintLine.value].join('\n');
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
 * T-200：停止的两段式（armed 窗口 2 秒）。
 *
 * 为什么是 2 秒而不是「等到用户再点一次」：armed 是个**会过期的承诺** ——
 * 过了窗口还保持 armed，按钮就变成「看起来已经确认过、其实只是没人来取消」
 * 的假状态。超时自动解除，所见即所得。
 */
const STOP_ARM_MS = 2000;
const stopArmed = ref(false);
let stopTimer = null;

/** 解除 armed。清 timer 与置 false 必须一起做，否则超时后还会补一枪。 */
function disarmStop() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  stopArmed.value = false;
}

/** 第一次点 = armed，第二次（窗口内）= 真的 abort。 */
function requestStop() {
  if (!props.host.busy) return;

  if (!stopArmed.value) {
    stopArmed.value = true;
    stopTimer = setTimeout(() => {
      stopTimer = null;
      stopArmed.value = false;
    }, STOP_ARM_MS);

    return;
  }

  disarmStop();
  props.host.abort();
}

const stopTitle = computed(() =>
  stopArmed.value ? t('workflow.agent.stopArmed') : t('workflow.agent.stop')
);

// 生成结束（自然结束或已 abort）后 armed 没有意义了 —— 按钮本身会消失，
// 但状态留着的话下一次忙碌会**直接**停在 armed 上，第一段保护被跳过。
watch(
  () => props.host.busy,
  (busy) => {
    if (!busy) disarmStop();
  }
);

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
 * 发出去的 false 走宿主的 dismissPendingConfirm（T-227 的单一出口，
 * 内部判空，重复发也安全），loop 拿到「用户拒绝」的 error 观察值照常收尾。
 */
onBeforeUnmount(() => {
  props.host.dismissPendingConfirm();
  // 面板被藏起来时 armed 的 timer 还在跑 —— 它挂的是 setTimeout 不是组件，
  // 不清的话两秒后会对一个已卸载的组件写 ref（且下一次忙碌的开局是 armed）
  disarmStop();
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
  props.host.openSession(id);
}

/**
 * T-213：标题下拉的开合。标题本身就是会话切换入口（切换 / 删除），
 * 所以「会话管理」不再单独占一行。
 */
const titleOpen = ref(false);

/**
 * T-213：从标题下拉里选一条会话。
 *
 * 与左栏 onSelectSession 的区别：这里必须**顺手关掉下拉** —— 选了会话之后
 * 浮层还开着，用户会以为没选中。左栏是常驻列表，不存在这个问题。
 */
function onPickSession(id) {
  titleOpen.value = false;
  onSelectSession(id);
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

// T-177：此处原有的「@ 目标页菜单」整段（触发状态、打开条件、底行补把手、
// 选中回填草稿）已删除。它做的是「换目标页」，与 composer 顶部的 chip 下拉
// 重复，且自带一份列表与一处状态显示重复 —— 换页现只有 chip 一条路。
//
// 载荷函数 tabPickPayload 仍留在目标页模块 src/agent/tab.js（AgentTabList
// 用它统一形状）：它与入口无关，所以入口没了它还在。

/**
 * 输入框键盘路由。`/` 菜单开着时 ↑↓ 移高亮、回车选中、Esc 关闭；
 * 没开时回车 = 发送（与原 @keydown.enter.exact.prevent 等价：
 * 带修饰键的回车留给换行/浏览器默认行为）。
 */
function onDraftKeydown(e) {
  // 输入法组合期间的按键不是最终文本：中文输入法下 `/` 可能还停在候选状态，
  // 这时就判定会让菜单闪一下再消失 —— compositionend 才是文本落定的时刻。
  if (e.isComposing) return;

  const plainEnter =
    e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;

  if (!slashMenuOpen.value) {
    // Esc = 停止，同样走两段式（与停止按钮共用 requestStop）。
    // 菜单关着时 Esc 原本没有任何作用，接过来不抢别的东西。
    if (e.key === 'Escape') {
      if (props.host.busy) {
        e.preventDefault();
        requestStop();
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
