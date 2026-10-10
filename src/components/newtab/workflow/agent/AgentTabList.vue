<template>
  <!--
    宽度不在此定：外壳（AgentDropdown 的 width，三个弹层统一 w-72）说了算，
    内容撑满即可。原先这里自带 w-64，塞进 w-72 外壳后右侧空出 32px ——
    三个弹层（会话 / 标签页 / 模型）里只有它「短一截」（2026-10-10 用户
    截图实证）。max-w-[80vw] 同理删除：外壳已经受本列宽度约束，内容再设
    上限只会更窄不更安全。
  -->
  <div class="scroll scroll-xs max-h-[60vh] overflow-y-auto">
    <div v-if="loading" class="py-6 text-center text-sm text-fg-2">
      {{ t('workflow.agent.pickTab.loading') }}
    </div>

    <p
      v-else-if="groups.length === 0"
      class="px-2 py-6 text-center text-sm text-fg-2"
    >
      {{ t('workflow.agent.pickTab.empty') }}
    </p>

    <template v-else>
      <!--
        T-214：节标只有一层「标签页 · N」，窗口不再作为分组层。原先按窗口
        分组（「窗口 3」组标）对绝大多数单窗口用户是纯噪音 —— 会话下拉与
        模型弹层都只有一层节标，这格"长长短短"的根因之一就是多了这一层。
        多窗口时窗口号降级为**行内右缀小徽标**，且首个窗口不打标（通常是
        当前窗口，无需自报家门）。
      -->
      <div
        class="px-3 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-fg-3"
      >
        {{ t('workflow.agent.pickTab.tabsLabel', { n: flatTabs.length }) }}
      </div>
      <button
        v-for="tab in flatTabs"
        :key="tab.id"
        type="button"
        class="flex w-full items-center gap-2 rounded-chip px-3 py-1.5 text-left text-sm hoverable"
        :class="{ 'bg-box-transparent': isCurrent(tab) }"
        @click="pick(tab)"
      >
        <!-- T-08：站点图标；拿不到就退回地球图标（faviconBroken 由 @error 置位） -->
        <img
          v-if="tab.favIconUrl && !brokenFavicons[tab.id]"
          :src="tab.favIconUrl"
          class="h-4 w-4 shrink-0 rounded-sm"
          :alt="t('workflow.agent.pickTab.faviconAlt')"
          @error="markBroken(tab.id)"
        />
        <v-remixicon
          v-else
          name="riEarthLine"
          size="16"
          class="shrink-0 text-fg-3"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate">{{ tab.title || tab.url }}</span>
          <span class="block truncate text-xs text-fg-3">
            {{ tab.url }}
          </span>
        </span>
        <!-- T-214：多窗口时的行内窗口徽标（首窗口不打标，见上） -->
        <span
          v-if="showWindowBadge(tab)"
          class="shrink-0 rounded-chip bg-box-transparent px-1 text-[10px] text-fg-3"
        >
          {{ windowLabel(tab.windowId) }}
        </span>
        <v-remixicon
          v-if="isCurrent(tab)"
          name="riCheckLine"
          size="14"
          class="shrink-0 text-accent"
        />
      </button>
    </template>
  </div>
</template>

<script setup>
import { computed, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { tabPickPayload } from '@/agent/tab';

/**
 * 标签页列表（无容器）：
 * 只管渲染，选中后 emit 出去 —— 外壳由调用方决定（面板用的是 ui-popover）。
 *
 * 之前这个列表内嵌在 AgentTabPicker 的 ui-modal 里，而那个 modal 宽 w-[32rem]
 * （512px），比它所在的 320px 侧栏还宽 —— 用弹窗是被逼的，不是设计选择。
 * 抽出来之后外壳换成 popover，列表本身一行没改。
 */
const props = defineProps({
  groups: { type: Array, default: () => [] },
  currentTab: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(['pick']);

const { t } = useI18n();

// 模板里直接用，省一层函数
const currentId = computed(() => (props.currentTab ? props.currentTab.id : -1));

/**
 * T-214：把按窗口分组的入参摊平成单层列表 —— 展示层不再按窗口分组，
 * 窗口号只在多窗口时以行内小徽标出现。
 */
const flatTabs = computed(() =>
  props.groups.flatMap((g) =>
    g.tabs.map((tab) => ({ ...tab, windowId: g.windowId }))
  )
);

/** 首个窗口（通常是当前窗口）不打标 —— 它不需要自报家门 */
const firstWindowId = computed(() =>
  props.groups.length ? props.groups[0].windowId : null
);

function showWindowBadge(tab) {
  return props.groups.length > 1 && tab.windowId !== firstWindowId.value;
}

function isCurrent(tab) {
  return currentId.value === tab.id;
}

/**
 * 加载失败的图标要记住（T-08）—— 否则每行每次重渲染都去请求同一个坏 URL。
 * 用 reactive 对象而不是数组，key 就是 tabId。
 */
const brokenFavicons = reactive({});
function markBroken(id) {
  brokenFavicons[id] = true;
}

//
// T-68：一律显示「窗口 {n}」。原来这里特判 `id === 1` 当主窗口，但 Chrome 的
// 窗口 id 不保证是 1 —— 会话恢复、先开后关都可能让主窗口拿到别的 id，于是标签
// 偶尔标错。
//
// 不去查 `browser.windows.getLastFocused` 拿真实主窗口 id：那个值每次开关窗口
// 都会变，为了一个显示标签引入一个必须跟着生命周期维护的状态不划算；而且
// 「主窗口」这个概念对用户几乎没什么用 —— 他关心的是「这一组是哪个窗口的标签」，
// 而 id 本身就在括号里明写着。
function windowLabel(id) {
  return t('workflow.agent.pickTab.window', { n: id });
}

function pick(tab) {
  // 载荷形状统一走 tabPickPayload（在 @/agent/tab，有单测）——
  // 各处自己拼一份的话，漏掉 favIconUrl 的那份会让 chip 永远显示地球图标。
  emit('pick', tabPickPayload(tab));
}
</script>
