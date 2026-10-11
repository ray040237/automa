<template>
  <!--
    方向用默认的 side="bottom"（向下展开）。
    side="top" 是本格还住在 composer 顶部（面板底部）时的旧设定 —— 那时往下弹
    会被视口截断。T-213 把整格搬进 header 第 2 行（面板**顶部**）后，往上弹
    就成了把列表顶出页面（2026-10-10 用户截图实证）。头部的东西一律向下弹，
    底部的东西（模型芯片、圆环明细）才向上弹 —— 方向跟随所在位置，不再逐个
    特调。
  -->
  <agent-dropdown v-model="open" align="left" width="w-72">
    <template #trigger="{ aria }">
      <!--
        T-164/T-214：chip =「主体 button + 状态徽标 + 箭头」三个**并排的兄弟**
        （不嵌套 —— 嵌套 button 是无效 HTML）。主体/箭头开列表；徽标在固定态
        自成一枚 button，必须 `@click.stop`：dropdown 是靠 trigger 外面那个
        div 的 @click 开合的，不拦掉冒泡会顺手把列表也打开。

        T-214 三态统一徽标（用户提议，设计稿 docs/agent-tab-picker-redesign.html v2.1）：
          ① 自动（默认）：「跟随」灰描边徽标，**只显示不可点** —— v2 之前
             自动态不贴标签，与固定态/失效态形成"有没有徽标"的断层；三个
             状态都把状态说出来，视觉才是连续谱。
          ② 已固定：「已固定 ✕」accent/15 实底徽标，hover 整块转 danger 红，
             点击 = 解除固定、回到自动跟随。解除动作**只有这一条路** ——
             T-164 的独立 ✕ 按钮删除（它与"徽标不可点"是三个同形状信号
             打架的根因）。
          ③ 失效：「已关闭 / 已跳转」danger/15 红徽标，只提示。「重新选择」
             文字删除：chip 本身点开就是列表，重选路径本来就在，行内 CTA
             是同一动作的第二张脸。

        徽标内不放状态图标（v2.1 修订）：三个徽标已有颜色深浅 / 文案 / 可点性
        三重区分，10px 小胶囊里再塞图标只有拥挤没有信息。✕ 是唯一例外 ——
        它不是状态图标，是"这个徽标能点"的动作线索，只出现在可点的固定态上。
      -->
      <div
        class="group/tab flex w-full items-center rounded-chip border transition duration-fast ease-panel"
        :class="[
          stale
            ? 'border-transparent bg-danger/15'
            : pinned
            ? 'border-line bg-surface hover:border-fg-3'
            : 'border-transparent bg-box-transparent hover:bg-field',
        ]"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1.5 rounded-chip px-2 py-1 text-left"
          :title="
            pinned
              ? t('workflow.agent.pickTab.pinnedHint')
              : t('workflow.agent.pickTab.autoHint')
          "
          v-bind="aria"
        >
          <img
            v-if="faviconUrl && !faviconBroken"
            :src="faviconUrl"
            class="h-4 w-4 shrink-0 rounded-sm"
            :alt="t('workflow.agent.pickTab.faviconAlt')"
            @error="faviconBroken = true"
          />
          <!-- 无 favicon 时的兜底：自动态用闪电（跟随是一个真实的状态，
               不该与地球"没有图标"的兜底形态长得一样）、其余用地球。 -->
          <v-remixicon
            v-else-if="!pinned && !stale"
            name="riFlashlightLine"
            size="14"
            class="shrink-0 text-fg-3"
          />
          <v-remixicon
            v-else
            name="riEarthLine"
            size="16"
            class="shrink-0 text-fg-3"
          />

          <span
            class="truncate text-xs"
            :class="stale ? 'text-danger' : pinned ? 'text-fg-1' : 'text-fg-2'"
          >
            {{ label }}
          </span>
        </button>

        <!-- 三态徽标：同一位置、同一套圆角字号，只有颜色深浅与可点性不同 -->
        <span
          v-if="stale"
          class="shrink-0 rounded-chip bg-danger/15 px-1 py-0.5 text-[10px] text-danger"
        >
          {{ staleText }}
        </span>
        <button
          v-else-if="pinned"
          type="button"
          class="group/badge flex shrink-0 items-center gap-0.5 rounded-chip bg-accent/15 px-1 py-0.5 text-[10px] text-accent transition duration-fast ease-panel hover:bg-danger/15 hover:text-danger"
          :title="t('workflow.agent.pickTab.unpin')"
          :aria-label="t('workflow.agent.pickTab.unpin')"
          data-test="unpin-target"
          @click.stop="emit('unpin')"
        >
          {{ t('workflow.agent.pickTab.pinned') }}
          <v-remixicon
            name="riCloseLine"
            size="12"
            class="shrink-0 opacity-55 transition duration-fast ease-panel group-hover/badge:opacity-100"
          />
        </button>
        <span
          v-else
          class="shrink-0 rounded-chip border border-line px-1 py-0.5 text-[10px] text-fg-3"
        >
          {{ t('workflow.agent.pickTab.followBadge') }}
        </span>

        <!-- T-213：箭头只在 hover / 键盘 focus 时出现（与 header 标题一致）。
             320px 里这 14px 等于标题多显示一两个字。T-214 后它是徽标的
             右邻兄弟（设计稿 §3 的 main → badge → chev 顺序）。 -->
        <v-remixicon
          name="riArrowDownSLine"
          size="14"
          class="mr-1.5 shrink-0 text-fg-3 opacity-0 transition duration-fast ease-panel group-hover/tab:opacity-100"
          :class="open ? 'rotate-180 opacity-100' : ''"
        />
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
 * T-214（用户提议）：chip 的三态由同一枚位置的**状态徽标**表达 —— 自动态
 * 「跟随」只显示、固定态「已固定 ✕」可点解除、失效态红徽标只提示。解除键的
 * 真实语义依然是 **取消固定 → 回到自动跟随**：目标页照样有，只是不再由用户
 * 指定。所以徽标在自动态不可点（没什么可解除的），失效态只提示（该做的是
 * 重选，点 chip 开列表就是）。
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
