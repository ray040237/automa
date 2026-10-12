<template>
  <!--
    side="top"：芯片在面板最底部，往下展开在矮窗口里会被视口截断。

    align="left"：芯片是底行**最左**一个元素（AgentPanel 里排在 flex-1 之前），
    右对齐（`right-0`）会让 288px 的弹层以芯片右缘为右边界往左铺 —— 实测在
    320px 侧栏里左溢出 79~171px，整块挂在侧栏外压到画布上（模型名越短外挂越
    多）。左对齐后弹层落在 23..311，完整在侧栏内、右侧留 9px。
    （2026-10-12 用户反馈「宽度没设置好」，登记 T-246。文件头原先写「它在底行
    偏右」，是从水位环那个真在右侧的下拉照抄来的 —— 与本条同源的另一处
    `align="right"` 是对的，不要一并改。）
  -->
  <agent-dropdown v-model="open" align="left" side="top" width="w-72">
    <template #trigger="{ aria }">
      <!--
        T-201 / T-213：模型芯片。

        形态由用户拍板：**不带服务商图标**，只剩等宽模型名 + 箭头。
        理由：一个只有 4 个连接、多数人只用 1 个的产品里，图标不承担辨识作用
        （用户记模型名而不是图标），却要占 16px —— 而那 16px 在 320px 侧栏的
        底行里是模型名最容易显示全的地方。

        `font-mono`：模型名是标识符（deepseek-chat / gpt-4o-mini），不是文案。
        等宽让「换了模型」这件事在字形上就能看出来 —— 比例字体下
        `Qwen/Qwen2.5-7B-Instruct` 与 `gpt-4o-mini` 的观感差别很小。

        流式期间锁定（disabled）：换模型只影响下一轮，但让用户在一轮跑一半时
        改配置、然后看到「这一轮的答案还是旧模型写的」，是自找的困惑。
        锁定期间 title 换成原因（与新建会话键同样的处理）。
      -->
      <button
        type="button"
        class="flex min-w-0 max-w-full items-center gap-1 rounded-chip px-1.5 py-1 text-left transition duration-fast ease-panel hover:bg-field disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        :disabled="locked"
        :title="locked ? t('workflow.agent.session.busyHint') : label"
        data-test="model-chip"
        v-bind="aria"
      >
        <span class="min-w-0 truncate font-mono text-[12px] text-fg-2">
          {{ label }}
        </span>
        <v-remixicon
          name="riArrowDownSLine"
          size="14"
          class="shrink-0 text-fg-3 transition duration-fast ease-panel"
          :class="open ? 'rotate-180' : ''"
        />
      </button>
    </template>

    <!-- 弹层：按连接分组，组内是模型。 -->
    <div class="max-h-[60vh] overflow-y-auto scroll scroll-xs py-1">
      <p
        v-if="catalog.length === 0"
        class="px-3 py-3 text-xs leading-relaxed text-fg-2"
        data-test="model-empty"
      >
        {{ t('workflow.agent.model.empty') }}
      </p>

      <template v-for="p in catalog" :key="p.id">
        <p
          class="px-3 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-fg-3"
        >
          {{ p.label }}
          <span v-if="!p.hasKey" class="font-normal normal-case">
            · {{ t('workflow.agent.model.noKey') }}
          </span>
        </p>

        <p v-if="p.models.length === 0" class="px-3 pb-1 text-[11px] text-fg-3">
          {{ t('workflow.agent.model.noModels') }}
        </p>

        <button
          v-for="m in p.models"
          :key="p.id + '/' + m"
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition duration-fast ease-panel hover:bg-field"
          :class="{ 'cursor-default': isCurrent(p.id, m) }"
          :data-test="'model-option-' + m"
          @click="pick(p.id, m)"
        >
          <span
            class="min-w-0 flex-1 truncate font-mono text-[12px]"
            :class="isCurrent(p.id, m) ? 'text-fg-1' : 'text-fg-2'"
            >{{ m }}</span
          >
          <v-remixicon
            v-if="isCurrent(p.id, m)"
            name="riCheckLine"
            size="14"
            class="shrink-0 text-accent"
          />
        </button>
      </template>
    </div>

    <!--
      T-213：**生效时机**的说明固定挂在弹层底部。

      用户拍板的原话是「弹层底部小字『下一轮生效』」。这里写全成一句，
      因为四个字的版本会让人以为「当前这一轮会重跑」或「要重启面板」——
      两者都不是事实。事实是：runtime 每轮 send 现读 config，
      所以写盘之后下一轮自然读新的，当前这轮不重放。
    -->
    <p
      class="border-t border-line px-3 py-2 text-[10.5px] leading-relaxed text-fg-3"
      data-test="model-effective-note"
    >
      {{ t('workflow.agent.model.effectiveNote') }}
    </p>
  </agent-dropdown>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AgentDropdown from './AgentDropdown.vue';

/**
 * 模型 / 连接选择器（T-201 落地）。
 *
 * 这是本票唯一**新增**的控件：Automa 之前完全没有「模型状态」的显示与切换 ——
 * 模型名只在会话列表底部出现一次，而且不可点。用户看不到自己在跟谁说话，
 * 也换不了。
 *
 * 「放哪」由 T-213 定案：composer 底行的左端（`flex-1` 撑开之前）。
 * 「长什么样」也由用户拍板：只用等宽模型名 + 箭头，**不用服务商图标**。
 */
const props = defineProps({
  /** 当前生效的模型名（host.config.model） */
  model: { type: String, default: '' },
  /** 当前生效的连接 id（host.config.provider） */
  provider: { type: String, default: '' },
  /** 流式期间锁定，见模板里的说明 */
  locked: { type: Boolean, default: false },
  /**
   * 候选列表：`[{ id, label, hasKey, models: string[] }]`。
   * 由宿主从**脱敏后的** config doc 上取（见 agentHost 的 modelCatalog）——
   * 组件本身碰不到密钥。
   */
  catalog: { type: Array, default: () => [] },
});

const emit = defineEmits(['pick']);

const { t } = useI18n();

const open = ref(false);

/** 没配模型时显示一个占位词，而不是空芯片 —— 空的看起来像没加载出来 */
const label = computed(() => props.model || t('workflow.agent.model.none'));

function isCurrent(providerId, modelId) {
  return props.provider === providerId && props.model === modelId;
}

function pick(providerId, modelId) {
  open.value = false;
  // 点当前那条等于「什么都不做」—— 但仍然要关掉弹层（用户点它是为了收起）
  if (isCurrent(providerId, modelId)) return;

  emit('pick', { providerId, modelId });
}
</script>
