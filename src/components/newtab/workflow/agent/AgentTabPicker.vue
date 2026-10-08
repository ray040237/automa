<template>
  <!-- side="top"：chip 贴着面板底部，往下展开在矮窗口里会被视口截断 -->
  <agent-dropdown v-model="open" align="left" side="top" width="w-72">
    <template #trigger>
      <!--
        T-164：chip 拆成「主体 + 解除」两个**并排的兄弟 button**（不嵌套 ——
        嵌套 button 是无效 HTML）。点解除必须 `@click.stop`：dropdown 是靠
        trigger 外面那个 div 的 @click 开合的，不拦掉冒泡会顺手把列表也打开。

        解除键只在 **pinned 且未失效** 时出现：
        - 自动跟随的页没什么可解除的（它是运行时解析出来的，不是用户选的）；
        - 失效态（页关了 / 漂到别的 origin）该做的是**重选**，不是解除。

        失效态（T-08）：页被关掉或跳去了别的 origin 时，这一行不再假装正常。
        「重新选择」就是同一个 trigger —— 点哪都开列表，不另套一个按钮。
      -->
      <div
        class="flex max-w-full items-center rounded-md"
        :class="stale ? 'bg-red-500/10' : 'bg-box-transparent'"
      >
        <button
          type="button"
          class="hoverable flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
          :title="t('workflow.agent.pickTab.title')"
        >
          <img
            v-if="faviconUrl && !faviconBroken"
            :src="faviconUrl"
            class="h-4 w-4 shrink-0 rounded-sm"
            :alt="t('workflow.agent.pickTab.faviconAlt')"
            @error="faviconBroken = true"
          />
          <v-remixicon
            v-else
            name="riEarthLine"
            class="shrink-0 text-gray-400"
          />

          <span
            class="truncate text-xs"
            :class="{ 'text-gray-400': !targetTab }"
          >
            {{ label }}
          </span>

          <span
            v-if="stale"
            class="shrink-0 rounded bg-red-500/15 px-1 text-[10px] text-red-600 dark:text-red-400"
          >
            {{ staleText }}
          </span>
          <span
            v-else
            class="shrink-0 rounded px-1 text-[10px] text-gray-500 dark:text-gray-400"
            :class="pinned ? 'bg-gray-500/15' : ''"
          >
            {{
              pinned
                ? t('workflow.agent.pickTab.pinned')
                : t('workflow.agent.pickTab.auto')
            }}
          </span>

          <span
            v-if="stale"
            class="shrink-0 text-[10px] text-red-600 underline dark:text-red-400"
          >
            {{ t('workflow.agent.pickTab.reselect') }}
          </span>

          <v-remixicon name="riArrowDownSLine" class="shrink-0 text-gray-400" />
        </button>

        <button
          v-if="showUnpin"
          type="button"
          class="mr-1 shrink-0 rounded p-1 text-gray-500 hover:bg-red-500/10 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-400"
          :title="t('workflow.agent.pickTab.unpin')"
          :aria-label="t('workflow.agent.pickTab.unpin')"
          data-test="unpin-target"
          @click.stop="emit('unpin')"
        >
          <v-remixicon name="riCloseLine" class="shrink-0" />
        </button>
      </div>
    </template>

    <agent-tab-list
      :groups="groups"
      :current-tab="targetTab"
      :loading="loading"
      @pick="onPick"
    />
  </agent-dropdown>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AgentDropdown from './AgentDropdown.vue';
import AgentTabList from './AgentTabList.vue';

/**
 * 目标页 chip：显示当前助手在读哪一页，点开是一份标签页列表。
 *
 * 这一格以前是「标题 + 一个按钮，按钮点开一个 512px 宽的 ui-modal」。
 * 而它在编辑器侧栏里的可用宽度只有 320px（`sidebarCss.width` 360 − padding 40）——
 * 弹窗比宿主还宽，所以「用弹窗」从来不是设计选择，是被逼的。
 *
 * 中间试过用项目现成的 `ui-popover`，实测三条症状：下拉顶出侧栏、压到 header
 * 的按钮、在输入区点开会把面板撑开（tippy 把内容挂到 body 上定位，脱离本列）。
 * 现在改用本文件夹里的 AgentDropdown（留在本列、absolute）。
 *
 * T-164：chip 现在有「✕ 解除」，但**只在 pinned 时**。早先完全不做的理由依然
 * 成立 —— `resolveTargetTab` 永远会解析出一个目标页（pinned → lastAccessed →
 * 当前窗口 → 其他窗口），「无目标」不是一个运行时支持的状态，硬造一个解除入口
 * 等于让 UI 显示一个假状态。解除键的真实语义是 **取消固定 → 回到自动跟随**：
 * 目标页照样有，只是不再由用户指定。所以它不能出现在自动态（没什么可解除的），
 * 也不能出现在失效态（那时候该做的是重选）。
 */
const props = defineProps({
  targetTab: { type: Object, default: null },
  // 由父组件注入，组件本身不必知道 browser API，也便于单测
  listTabs: { type: Function, required: true },
  // T-08：'ok' | 'closed' | 'drift' | 'none'，由宿主按 tab 事件判定
  state: { type: String, default: 'none' },
  // T-08：这一页是用户手选固定的，还是运行时自动解析的
  pinned: { type: Boolean, default: false },
});

const emit = defineEmits(['pick', 'no-target', 'unpin']);

const { t } = useI18n();

const groups = ref([]);
const loading = ref(false);
const open = ref(false);

const label = computed(() =>
  props.targetTab
    ? props.targetTab.title || props.targetTab.url
    : t('workflow.agent.noTarget')
);

/** T-08：图标拿不到（没有 favIconUrl、或加载失败）时退回地球图标 */
const faviconUrl = computed(() =>
  props.targetTab ? props.targetTab.favIconUrl || '' : ''
);
const faviconBroken = ref(false);

/** 换目标页后要让坏掉的图标重新试一次，否则图标永远停在地球上 */
watch(
  () => props.targetTab && props.targetTab.id,
  () => {
    faviconBroken.value = false;
  }
);

const stale = computed(
  () => props.state === 'closed' || props.state === 'drift'
);

/** T-164：解除键只在「用户固定的、且还活着」时出现 —— 理由见顶部注释。 */
const showUnpin = computed(() => props.pinned && !stale.value);
const staleText = computed(() =>
  props.state === 'closed'
    ? t('workflow.agent.pickTab.staleClosed')
    : t('workflow.agent.pickTab.staleDrift')
);

/**
 * 每次打开才拉一次。
 *
 * 一个可读页面都没有时照样把空列表显示出来（列表自带更具体的解释），
 * 同时发 no-target 让宿主弹 toast —— 原来那条路径是「先预检、为空就不开弹窗」，
 * 换成下拉之后已经开了，藏起来反而更别扭。
 */
async function load() {
  loading.value = true;

  try {
    groups.value = await props.listTabs();
    if (groups.value.length === 0) emit('no-target');
  } catch (e) {
    groups.value = [];
    emit('no-target');
  } finally {
    loading.value = false;
  }
}

// 打开时才拉一次。面板可能开着放很久，标签页状态随时会变
watch(open, (v) => {
  if (v) load();
});

function onPick(tab) {
  open.value = false;
  emit('pick', tab);
}
</script>
