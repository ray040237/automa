<template>
  <div class="scroll scroll-xs max-h-[60vh] w-64 max-w-[80vw] overflow-y-auto">
    <div v-if="loading" class="py-6 text-center text-sm text-gray-500">
      {{ t('workflow.agent.pickTab.loading') }}
    </div>

    <p
      v-else-if="groups.length === 0"
      class="px-2 py-6 text-center text-sm text-gray-500"
    >
      {{ t('workflow.agent.pickTab.empty') }}
    </p>

    <template v-else>
      <div v-for="g in groups" :key="g.windowId" class="mb-2 last:mb-0">
        <div class="mb-1 px-2 text-xs uppercase text-gray-400">
          {{ windowLabel(g.windowId) }}
        </div>
        <button
          v-for="tab in g.tabs"
          :key="tab.id"
          v-close-popover
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hoverable"
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
            class="shrink-0 text-gray-400"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate">{{ tab.title || tab.url }}</span>
            <span class="block truncate text-xs text-gray-400">
              {{ tab.url }}
            </span>
          </span>
          <v-remixicon
            v-if="isCurrent(tab)"
            name="riCheckLine"
            class="shrink-0 text-accent"
          />
        </button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, reactive } from 'vue';
import { useI18n } from 'vue-i18n';

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
  emit('pick', {
    id: tab.id,
    url: tab.url,
    title: tab.title || tab.url,
    windowId: tab.windowId,
    // T-08：带上图标，chip 上那一行才能显示同一个站点的图标
    favIconUrl: tab.favIconUrl || undefined,
  });
}
</script>
